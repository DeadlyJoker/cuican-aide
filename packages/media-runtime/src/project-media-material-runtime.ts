import {
  createAdoptedMediaMaterialSources,
  type AdoptedMediaMaterialRuntimeInput,
} from "./adopted-media-material-runtime.ts";
import { randomUUID, createHash } from "node:crypto";
import { types } from "node:util";
import {
  ApplicationError,
  CreativeProjectApplicationService,
  ExtensionConfigurationApplicationService,
  PluginInstallationApplicationService,
  ProjectAssetApplicationService,
  ProjectAssetReferenceImageApplicationService,
  type ProjectMediaReferenceImageApplicationService,
  ProjectMaterialTargetApplicationService,
  captureProjectMediaInputAuthorization,
  captureProjectMediaWorkflowReviews,
  captureProjectGenerationImageResultVerifier,
  materialPreparationFields,
  mediaInputSame,
  projectMediaInputBound as bound,
  type ApplicationClock,
  type CreativeProjectAuthorizationPort,
  type PluginInstallationAuthorizationPort,
  type PluginInstallationHostProfilePort,
  type ProjectGenerationImageResultVerifier,
  type ProjectMediaInputAuthorizationPort,
  type ProjectMediaWorkflowReview,
  type ProjectReferenceMaterialSourceAdapter,
  type ProjectReferenceMaterialReadAuthorizationPort,
  type ProjectReferenceMaterialFreezeAuthorizationPort,
  type ProjectMaterialPreparationAuthorizationPort,
} from "@crewon/application";
import { FilesystemProjectMaterialArchive } from "@crewon/artifacts";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { ProjectReferenceMaterialReader } from "./project-reference-material-reader.ts";
import { ProjectReferenceMaterialFreezer } from "./project-reference-material-freezer.ts";
import { ProjectMaterialPreparer } from "./project-material-preparer.ts";
import { ProjectMediaMaterialPreparer } from "./project-media-material-preparer.ts";
import type { NetworkDnsResolver } from "./network-egress.ts";
import type { PinnedHttpPort } from "./pinned-node-http.ts";

/** Host-only dependencies. Network ports are replaceable boundaries, never plugin parameters. */
export type ProjectMediaMaterialRuntimeInput = Readonly<{
  store: SqliteRunStore | PostgresDomainStore;
  configurations: ExtensionConfigurationApplicationService;
  profiles: PluginInstallationHostProfilePort;
  projects: CreativeProjectAuthorizationPort;
  installations: PluginInstallationAuthorizationPort;
  metadata: ProjectMediaInputAuthorizationPort;
  read: ProjectReferenceMaterialReadAuthorizationPort;
  freeze: ProjectReferenceMaterialFreezeAuthorizationPort;
  preparation: ProjectMaterialPreparationAuthorizationPort;
  sourceAdapter: ProjectReferenceMaterialSourceAdapter;
  verifier: ProjectGenerationImageResultVerifier;
  reviews: readonly ProjectMediaWorkflowReview[];
  archive: ConstructorParameters<typeof FilesystemProjectMaterialArchive>[0];
  clock: ApplicationClock;
  signal: AbortSignal;
  adoptedMedia?: AdoptedMediaMaterialRuntimeInput;
  network?: Readonly<{
    dns?: NetworkDnsResolver;
    source?: PinnedHttpPort;
    upload?: PinnedHttpPort;
    observation?: PinnedHttpPort;
  }>;
}>;
export type ProjectMediaMaterialRuntime = Readonly<{
  materials: ProjectMediaMaterialPreparer;
  sources:
    | ProjectAssetReferenceImageApplicationService
    | ProjectMediaReferenceImageApplicationService;
  /** Caller must first join its commands/Worker dispatches. This owner closes only its archive. */
  close(): Promise<void>;
}>;

/** One actual parent and one encrypted source archive for Control and Worker compositions.
 * This grants no permission, executes no generation, and makes no network request at startup.
 */
export async function createProjectMediaMaterialRuntime(
  provided: ProjectMediaMaterialRuntimeInput,
): Promise<ProjectMediaMaterialRuntime> {
  if (
    provided === null ||
    typeof provided !== "object" ||
    types.isProxy(provided)
  )
    invalid();
  const r = materialPreparationFields(provided, [
    "store",
    "configurations",
    "profiles",
    "projects",
    "installations",
    "metadata",
    "read",
    "freeze",
    "preparation",
    "sourceAdapter",
    "verifier",
    "reviews",
    "archive",
    "clock",
    "signal",
    ...(Object.hasOwn(provided, "network") ? ["network"] : []),
    ...(Object.hasOwn(provided, "adoptedMedia") ? ["adoptedMedia"] : []),
  ]);
  const input = r as ProjectMediaMaterialRuntimeInput;
  if (
    types.isProxy(input.store) ||
    types.isProxy(input.configurations) ||
    !(
      input.store instanceof SqliteRunStore ||
      input.store instanceof PostgresDomainStore
    ) ||
    !(
      input.configurations instanceof ExtensionConfigurationApplicationService
    ) ||
    !(input.signal instanceof AbortSignal) ||
    types.isProxy(input.signal)
  )
    invalid();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  const active = () => signal.throwIfAborted();
  active();
  const clock = { now: bound<ApplicationClock["now"]>(input.clock, "now") };
  const metadata = captureProjectMediaInputAuthorization(input.metadata);
  const verifier = captureProjectGenerationImageResultVerifier(input.verifier);
  const reviews = captureProjectMediaWorkflowReviews(input.reviews);
  const reviewedTargets = new Map<
    string,
    ProjectMediaWorkflowReview["targetIdentity"]
  >();
  for (const { targetIdentity: identity } of reviews) {
    const prior = reviewedTargets.get(identity.packageDigest);
    if (prior && !mediaInputSame(prior, identity)) invalid();
    reviewedTargets.set(identity.packageDigest, identity);
  }
  if (input.network !== undefined && types.isProxy(input.network)) invalid();
  const sourceAdapter = Object.freeze({
    deriveReadDestination: bound<
      ProjectReferenceMaterialSourceAdapter["deriveReadDestination"]
    >(input.sourceAdapter, "deriveReadDestination"),
  });
  const projectAuthorize = bound<CreativeProjectAuthorizationPort["authorize"]>(
    input.projects,
    "authorize",
  );
  const installationAuthorize = bound<
    PluginInstallationAuthorizationPort["authorize"]
  >(input.installations, "authorize");
  const profile = bound<PluginInstallationHostProfilePort["resolve"]>(
    input.profiles,
    "resolve",
  );
  const read = bound<
    ProjectReferenceMaterialReadAuthorizationPort["authorize"]
  >(input.read, "authorize");
  const freeze = bound<
    ProjectReferenceMaterialFreezeAuthorizationPort["authorize"]
  >(input.freeze, "authorize");
  const preparation = bound<
    ProjectMaterialPreparationAuthorizationPort["authorize"]
  >(input.preparation, "authorize");
  const preparationActive = bound<
    ProjectMaterialPreparationAuthorizationPort["assertActive"]
  >(input.preparation, "assertActive");
  const network =
    input.network === undefined
      ? {}
      : (materialPreparationFields(input.network, [
          ...(["dns", "source", "upload", "observation"] as const).filter((k) =>
            Object.hasOwn(input.network!, k),
          ),
        ]) as NonNullable<ProjectMediaMaterialRuntimeInput["network"]>);
  const archiveConfig = materialPreparationFields(input.archive, [
    "archiveId",
    "rootDirectory",
    "encryptionKey",
    "keyId",
  ]);
  if (
    types.isProxy(archiveConfig.encryptionKey) ||
    !(archiveConfig.encryptionKey instanceof Uint8Array) ||
    archiveConfig.encryptionKey.byteLength !== 32
  )
    invalid();
  const key = Buffer.from(archiveConfig.encryptionKey);
  let archive: FilesystemProjectMaterialArchive | undefined;
  try {
    const common = {
      clock,
      ids: { nextId: () => randomUUID() },
      digester: {
        sha256: (value: string) =>
          "sha256:" + createHash("sha256").update(value).digest("hex"),
      },
    };
    const projectAuthorization: CreativeProjectAuthorizationPort = {
      authorize: async (p) => {
        active();
        if (p.action !== "creativeProject:read") denied();
        const result = await projectAuthorize(p);
        active();
        return result;
      },
    };
    const projectStore = input.store.creativeProjectStore(),
      assets = input.store.projectAssetStore({ verifier }),
      journal = assets.projectMaterialPreparationStore(),
      mediaInputs = assets.projectMediaInputStore();
    const projectService = new CreativeProjectApplicationService({
      ...common,
      store: projectStore,
      authorization: projectAuthorization,
    });
    const assetService = new ProjectAssetApplicationService({
      ...common,
      store: assets,
      projects: projectStore,
      texts: input.store.projectTextStore(),
      authorization: projectAuthorization,
    });
    const sources = new ProjectAssetReferenceImageApplicationService({
      projects: projectService,
      assets: assetService,
      store: assets,
      digester: common.digester,
    });
    const unavailable = async (): Promise<never> => denied();
    const installations = new PluginInstallationApplicationService({
      store: input.store.pluginInstallationStore(),
      ...common,
      profiles: {
        resolve: async (actor) => {
          active();
          const result = await profile(actor);
          active();
          return result;
        },
      },
      authorization: {
        authorize: async (p) => {
          active();
          if (p.action !== "pluginInstallation:read") denied();
          const result = await installationAuthorize(p);
          active();
          return result;
        },
      },
      host: { install: unavailable, prepareSelection: unavailable },
    });
    const targets = new ProjectMaterialTargetApplicationService({
      installations,
      configurations: input.configurations,
    });
    // Existing project/input schemas remain the original metadata owner's responsibility.
    await journal.migrate();
    active();
    await mediaInputs.migrate();
    active();
    archive = new FilesystemProjectMaterialArchive({
      archiveId: archiveConfig.archiveId as string,
      rootDirectory: archiveConfig.rootDirectory as string,
      keyId: archiveConfig.keyId as string,
      encryptionKey: key,
    });
    const reader = new ProjectReferenceMaterialReader({
      sources,
      adapter: sourceAdapter,
      clock,
      authorization: {
        authorize: async (p) => {
          active();
          const result = await read(p);
          active();
          return result;
        },
      },
      ...(network.dns === undefined ? {} : { dns: network.dns }),
      ...(network.source === undefined ? {} : { transport: network.source }),
    });
    const freezer = new ProjectReferenceMaterialFreezer({
      sources,
      reader,
      archive,
      authorization: {
        authorize: async (p) => {
          active();
          const result = await freeze(p);
          active();
          return result;
        },
      },
    });
    const preparationDependencies = {
      freezer,
      targets,
      journal,
      clock,
      reviewedTargets: [...reviewedTargets.values()],
      authorization: {
        authorize: async (p) => {
          active();
          const result = await preparation(p);
          active();
          return result;
        },
        assertActive: (p) => {
          active();
          const result = preparationActive(p);
          active();
          return result;
        },
      },
      ...(network.dns === undefined ? {} : { dns: network.dns }),
      ...(network.upload === undefined
        ? {}
        : { uploadTransport: network.upload }),
      ...(network.observation === undefined
        ? {}
        : { observationTransport: network.observation }),
    } satisfies ConstructorParameters<typeof ProjectMaterialPreparer>[0];
    const preparer = new ProjectMaterialPreparer(preparationDependencies),
      adopted =
        input.adoptedMedia === undefined
          ? null
          : await createAdoptedMediaMaterialSources({
              config: input.adoptedMedia,
              store: input.store,
              projects: projectService,
              assets: assetService,
              concepts: sources,
              archive,
              signal,
            });
    active();
    const materials = new ProjectMediaMaterialPreparer({
      store: mediaInputs,
      preparer,
      ...(adopted === null
        ? {}
        : {
            adoptedPreparer: new ProjectMaterialPreparer({
              ...preparationDependencies,
              freezer: adopted.freezer,
            }),
          }),
      reviews,
      authorization: {
        authorize: async (p) => {
          active();
          const result = await metadata.authorize(p);
          active();
          return result;
        },
        authorizeTransaction: async (p) => {
          active();
          const result = await (
            metadata.authorizeTransaction ?? metadata.authorize
          )(p);
          active();
          return result;
        },
        assertActive: (p) => {
          active();
          const result = metadata.assertActive(p);
          active();
          return result;
        },
      },
    });
    active();
    const owned = archive;
    return Object.freeze({
      materials,
      sources: adopted?.sources ?? sources,
      close: async () => {
        lifetime.abort();
        owned.close();
      },
    });
  } catch (error) {
    lifetime.abort();
    archive?.close();
    throw error;
  } finally {
    key.fill(0);
  }
}
function invalid(): never {
  throw new Error("project_media_material_runtime_invalid");
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_media_material_runtime_denied",
  );
}
