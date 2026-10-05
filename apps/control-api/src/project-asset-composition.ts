import {
  ProjectAssetApplicationService,
  PluginProjectAssetRecoveryApplicationService,
  captureProjectGenerationImageResultVerifier,
  type CreativeProjectAuthorizationPort,
  type CreativeProjectStore,
  type ProjectTextStore,
  type ProjectAssetStore,
  type ProjectGenerationImageResultVerifier,
  type ProjectAssetUiIntentJournalStore,
} from "@crewon/application";
import {
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

export type ProjectAssetCompositionConfig = Readonly<{
  assetArtifacts?: Readonly<{ version: "crewon.project-asset.v1" }>;
  assetUi?: CreativeProjectPluginUiConfig;
  assetRecovery?: CreativeProjectPluginUiConfig;
  assetStages?: CreativeProjectPluginUiConfig &
    Readonly<{ version: "crewon.project-asset-stages.v1" }>;
  assetReferences?: Readonly<{
    version: "crewon.project-asset-reference.v1";
    verifier: ProjectGenerationImageResultVerifier;
  }>;
}>;
export type ProjectAssetStoreOwner = Readonly<{
  projectAssetUiIntentJournalStore?(
    input: Readonly<{ verifier?: ProjectGenerationImageResultVerifier }>,
  ): ProjectAssetUiIntentJournalStore;
  projectAssetStore?(
    input: Readonly<{ verifier?: ProjectGenerationImageResultVerifier }>,
  ): ProjectAssetStore & { migrate(): Promise<void> };
}>;
export type PreparedProjectAssets = Readonly<{
  assetService: ProjectAssetApplicationService;
  assetStore: ProjectAssetStore;
  assetRecoveryService?: PluginProjectAssetRecoveryApplicationService;
}>;

/** New metadata protocols require their own explicit opt-ins. Old text or planning grants imply nothing. */
export function captureProjectAssetCompositionConfig(
  input: object,
  textArtifacts: unknown,
): ProjectAssetCompositionConfig {
  const read = (field: keyof ProjectAssetCompositionConfig) => {
    const value = Object.getOwnPropertyDescriptor(input, field);
    if (
      value !== undefined &&
      (!value.enumerable || !Object.hasOwn(value, "value"))
    )
      throw new Error("project_asset_configuration_invalid");
    return value?.value as unknown;
  };
  const artifacts = read("assetArtifacts"),
    references = read("assetReferences"),
    stages = read("assetStages");
  let assetArtifacts: ProjectAssetCompositionConfig["assetArtifacts"],
    assetReferences: ProjectAssetCompositionConfig["assetReferences"];
  if (artifacts !== undefined) {
    const value = pluginSecurityRecord(artifacts, ["version"]);
    if (
      value.version !== "crewon.project-asset.v1" ||
      textArtifacts === undefined
    )
      throw new Error("project_asset_text_store_required");
    assetArtifacts = Object.freeze({ version: value.version });
  }
  const assetUi = captureCreativeProjectPluginUiConfig(read("assetUi")),
    assetRecovery = captureCreativeProjectPluginUiConfig(read("assetRecovery"));
  if (references !== undefined) {
    const value = pluginSecurityRecord(references, ["version", "verifier"]);
    if (value.version !== "crewon.project-asset-reference.v1")
      throw new Error("project_asset_reference_configuration_invalid");
    assetReferences = Object.freeze({
      version: value.version,
      verifier: captureProjectGenerationImageResultVerifier(
        value.verifier as ProjectGenerationImageResultVerifier,
      ),
    });
  }
  if (
    (assetUi !== undefined ||
      assetRecovery !== undefined ||
      assetReferences !== undefined) &&
    assetArtifacts === undefined
  )
    throw new Error("project_asset_store_required");
  if (
    assetRecovery !== undefined &&
    (assetUi === undefined ||
      assetRecovery.publications.some(
        (item) =>
          !assetUi.publications.some(
            (parent) =>
              parent.pluginId === item.pluginId &&
              parent.packageDigest === item.packageDigest &&
              parent.contributionId === item.contributionId,
          ),
      ))
  )
    throw new Error("project_asset_recovery_publication_required");
  let assetStages: ProjectAssetCompositionConfig["assetStages"];
  if (stages !== undefined) {
    const value = pluginSecurityRecord(stages, ["version", "publications"]);
    if (value.version !== "crewon.project-asset-stages.v1")
      throw new Error("project_asset_stage_configuration_invalid");
    const grant = captureCreativeProjectPluginUiConfig({
      publications: value.publications,
    });
    const conversations = captureCreativeProjectPluginUiConfig(
      Object.getOwnPropertyDescriptor(input, "conversations")?.value,
    );
    if (
      grant === undefined ||
      grant.publications.some((item) =>
        [assetUi, conversations].some(
          (parent) =>
            !parent?.publications.some(
              (entry) =>
                entry.pluginId === item.pluginId &&
                entry.packageDigest === item.packageDigest &&
                entry.contributionId === item.contributionId,
            ),
        ),
      )
    )
      throw new Error("project_asset_stage_publication_required");
    assetStages = Object.freeze({
      version: "crewon.project-asset-stages.v1",
      publications: grant.publications,
    });
  }
  return Object.freeze({
    ...(assetArtifacts === undefined ? {} : { assetArtifacts }),
    ...(assetUi === undefined ? {} : { assetUi }),
    ...(assetRecovery === undefined ? {} : { assetRecovery }),
    ...(assetStages === undefined ? {} : { assetStages }),
    ...(assetReferences === undefined ? {} : { assetReferences }),
  });
}

/** The disabled path never acquires or migrates an asset adapter. Parent Store lifetime stays with its creator. */
export async function prepareProjectAssets(
  owner: ProjectAssetStoreOwner,
  input: Readonly<{
    configuration: ProjectAssetCompositionConfig;
    projects: CreativeProjectStore;
    texts: ProjectTextStore | undefined;
    authorization: CreativeProjectAuthorizationPort;
  }>,
): Promise<PreparedProjectAssets | undefined> {
  if (input.configuration.assetArtifacts === undefined) return undefined;
  if (input.texts === undefined || owner.projectAssetStore === undefined)
    throw new Error("project_asset_composition_required");
  const store = owner.projectAssetStore(
    input.configuration.assetReferences === undefined
      ? {}
      : { verifier: input.configuration.assetReferences.verifier },
  );
  await store.migrate();
  let assetRecoveryService:
    | PluginProjectAssetRecoveryApplicationService
    | undefined;
  if (input.configuration.assetRecovery !== undefined) {
    if (owner.projectAssetUiIntentJournalStore === undefined)
      throw new Error("project_asset_recovery_store_required");
    const journal = owner.projectAssetUiIntentJournalStore(
      input.configuration.assetReferences === undefined
        ? {}
        : { verifier: input.configuration.assetReferences.verifier },
    );
    await journal.migrate();
    assetRecoveryService = new PluginProjectAssetRecoveryApplicationService({
      journal,
      projects: input.projects,
      authorization: input.authorization,
      publications: input.configuration.assetRecovery.publications,
      clock: new SystemApplicationClock(),
      digester: new NodeSha256ContentDigester(),
    });
  }
  return Object.freeze({
    assetStore: store,
    ...(assetRecoveryService === undefined ? {} : { assetRecoveryService }),
    assetService: new ProjectAssetApplicationService({
      store,
      projects: input.projects,
      texts: input.texts,
      authorization: input.authorization,
      clock: new SystemApplicationClock(),
      ids: new UuidV7ApplicationIdGenerator(),
      digester: new NodeSha256ContentDigester(),
    }),
  });
}
