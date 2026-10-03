import {
  ProjectConceptSelectionApplicationService,
  captureProjectGenerationImageResultVerifier,
  type AuthorizationPort,
  type ApplicationClock,
  type ContentDigester,
  type ExtensionReadApplicationService,
  type ExtensionStore,
  type ExternalOperationStore,
  type ProjectConceptSelectionStore,
  type ProjectGenerationImageResultVerifier,
  type ProjectGenerationReadApplicationService,
} from "@crewon/application";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import type { CreativeProjectCompositionConfig } from "./creative-project-composition.ts";
import type { ProductionPostgresControlApiConfig } from "./production-composition.ts";
import { isProjectGenerationSelectionPluginUiOwner } from "./project-generation-selection-plugin-ui-owner.ts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";
import {
  assertCreativeProjectPluginPublications,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";

export type ProjectGenerationSelectionConfiguration = Readonly<{
  version: "crewon.project-concept-selection.v1";
  verifier: ProjectGenerationImageResultVerifier;
}>;
export type ProjectGenerationSelectionStore = ProjectConceptSelectionStore & {
  migrateConceptSelections(): Promise<void>;
  enableConceptSelectionReads(): Promise<void>;
};
export type ProjectGenerationSelectionStoreOwner = Readonly<{
  projectConceptSelectionStore(
    input: Readonly<{ verifier: ProjectGenerationImageResultVerifier }>,
  ): ProjectGenerationSelectionStore;
}>;

/** Capture the deployment's trusted pure adapter; no provider is selected implicitly. */
export function captureProjectGenerationSelectionConfiguration(
  input: unknown,
): ProjectGenerationSelectionConfiguration | undefined {
  if (input === undefined) return undefined;
  const value = pluginSecurityRecord(input, ["version", "verifier"]);
  if (value.version !== "crewon.project-concept-selection.v1")
    throw new Error("project_generation_selection_configuration_invalid");
  return Object.freeze({
    version: value.version,
    verifier: captureProjectGenerationImageResultVerifier(
      value.verifier as ProjectGenerationImageResultVerifier,
    ),
  });
}

export async function prepareProjectGenerationSelectionStore(
  owner: ProjectGenerationSelectionStoreOwner,
  configuration: ProjectGenerationSelectionConfiguration,
): Promise<ProjectGenerationSelectionStore> {
  const create = owner.projectConceptSelectionStore.bind(owner);
  const store = create({ verifier: configuration.verifier });
  await store.migrateConceptSelections();
  await store.enableConceptSelectionReads();
  return store;
}

export function composeProjectGenerationSelectionService(
  input: Readonly<{
    projects: PreparedCreativeProjects | undefined;
    generationReads: ProjectGenerationReadApplicationService | undefined;
    extensions: ExtensionStore;
    operations: ExternalOperationStore;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    digester: ContentDigester;
  }>,
): ProjectConceptSelectionApplicationService | undefined {
  const prepared = input.projects?.resultSelections;
  if (prepared === undefined) return undefined;
  if (input.generationReads === undefined)
    throw new Error("project_generation_selection_reader_required");
  return new ProjectConceptSelectionApplicationService({
    projects: prepared.projects,
    generationReads: input.generationReads,
    extensions: input.extensions,
    operations: input.operations,
    selections: prepared.store,
    authorization: input.authorization,
    verifier: prepared.verifier,
    clock: input.clock,
    digester: input.digester,
  });
}

/** The disabled branch does not even acquire a selection-related adapter. */
export function composeOwnedProjectGenerationSelectionService(
  input: Readonly<{
    projects: PreparedCreativeProjects | undefined;
    generationReads: ProjectGenerationReadApplicationService | undefined;
    owner: Readonly<{
      extensionStore(): ExtensionStore;
      externalOperationStore(): ExternalOperationStore;
    }>;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    digester: ContentDigester;
  }>,
): ProjectConceptSelectionApplicationService | undefined {
  if (input.projects?.resultSelections === undefined) return undefined;
  return composeProjectGenerationSelectionService({
    ...input,
    extensions: input.owner.extensionStore(),
    operations: input.owner.externalOperationStore(),
  });
}

/** Source UI grant is separate from result storage and all paid task capabilities. */
export function assertProjectGenerationSelectionUiComposition(
  input: Readonly<{
    configuration: CreativeProjectPluginUiConfig | undefined;
    publications:
      | readonly Readonly<{ pluginId: string; packageDigest: string }>[]
      | undefined;
    hasReader: boolean;
    ui: unknown;
    owned: unknown;
  }>,
): void {
  assertCreativeProjectPluginPublications(
    input.configuration,
    input.publications,
  );
  if (input.configuration === undefined) return;
  if (input.ui === undefined || !input.hasReader)
    throw new Error("project_generation_selection_ui_reader_required");
  if (input.owned !== undefined)
    throw new Error("project_generation_selection_ui_owner_conflict");
}

export function assertProductionProjectSelectionComposition(
  config: ProductionPostgresControlApiConfig,
  projects: CreativeProjectCompositionConfig | undefined,
): void {
  assertProjectGenerationSelectionUiComposition({
    configuration: projects?.selectionUi,
    publications: config.pluginUi?.configuration.publications,
    hasReader:
      config.pluginTasks !== undefined ||
      config.pluginConfiguration !== undefined,
    ui: config.pluginUi,
    owned: config.pluginUi?.ownedProjectSelectionActions,
  });
  if (
    projects?.resultSelections !== undefined &&
    config.pluginTasks === undefined &&
    config.pluginConfiguration === undefined
  )
    throw new Error("project_generation_selection_reader_required");
}

export async function closeProductionProjectSelectionOwner(
  value: unknown,
): Promise<void> {
  if (isProjectGenerationSelectionPluginUiOwner(value)) await value.close();
}
