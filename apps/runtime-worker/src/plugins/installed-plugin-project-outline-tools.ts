import {
  ProjectStructuredOutlineApplicationService,
  type CreativeProjectAuthorizationPort,
} from "@crewon/application";
import type {
  ExtensionManifest,
  PluginProfileScope,
  PluginTaskAdmission,
  ProjectStageRunAdmission,
} from "@crewon/domain";
import type { PluginActivationCandidate } from "@crewon/plugin-host";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type { InstalledPluginRunContextDependencies } from "./installed-plugin-run-context.ts";
import type { InstalledPluginRuntimeResolverDependencies } from "./installed-plugin-runtime-resolver.ts";
import { installedPluginToolOperationPurpose } from "./installed-plugin-run-runtime.ts";
import { assertInstalledPluginProjectToolsExternalCurrent } from "./installed-plugin-project-tools.ts";
import type { ProjectToolsAuthorizationInvocation } from "./project-tools-service-owner.ts";
import {
  ProjectOutlineToolsServiceOwner,
  type ProjectOutlineToolsServiceOwnerDependencies,
} from "./project-outline-tools-service-owner.ts";
import {
  foundationOwnerBound as bound,
  foundationOwnerData as data,
} from "./project-foundation-owner-support.ts";

/** Structured writes have their own deployment declaration. Existing text/read/UI services stay unchanged. */
export type InstalledPluginProjectOutlineToolsConfig = Readonly<{
  version: "crewon.project-outline-tools.v2";
  createOutlines(
    input: Readonly<{ store: SqliteRunStore | PostgresDomainStore }>,
  ): ProjectStructuredOutlineApplicationService;
  authorization: CreativeProjectAuthorizationPort;
  authorizeService(
    admission: PluginTaskAdmission,
    signal: AbortSignal,
  ): Promise<void>;
}>;
export type InstalledPluginProjectOutlineToolsDependencies = Pick<
  ProjectOutlineToolsServiceOwnerDependencies,
  | "outlines"
  | "conversations"
  | "runs"
  | "installations"
  | "authorization"
  | "resolveActor"
> &
  Readonly<{
    authorizeService: InstalledPluginProjectOutlineToolsConfig["authorizeService"];
  }>;

export function captureInstalledPluginProjectOutlineToolsConfig(
  input: InstalledPluginProjectOutlineToolsConfig,
): InstalledPluginProjectOutlineToolsConfig {
  const fields = data(input, [
    "version",
    "createOutlines",
    "authorization",
    "authorizeService",
  ]);
  if (fields.version !== "crewon.project-outline-tools.v2") denied();
  const service = bound<
    InstalledPluginProjectOutlineToolsConfig["authorizeService"]
  >(input, "authorizeService");
  return Object.freeze({
    version: "crewon.project-outline-tools.v2",
    createOutlines: bound<
      InstalledPluginProjectOutlineToolsConfig["createOutlines"]
    >(input, "createOutlines"),
    authorization: Object.freeze({
      authorize: bound<CreativeProjectAuthorizationPort["authorize"]>(
        fields.authorization,
        "authorize",
      ),
    }),
    authorizeService: async (admission, signal) => {
      if ((await service(admission, signal)) !== undefined) denied();
    },
  });
}
export function composeInstalledPluginProjectOutlineToolsDependencies(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    config: InstalledPluginProjectOutlineToolsConfig;
    resolveActor: InstalledPluginRunContextDependencies["resolveActor"];
  }>,
): InstalledPluginProjectOutlineToolsDependencies {
  const config = captureInstalledPluginProjectOutlineToolsConfig(input.config),
    outlines = config.createOutlines(Object.freeze({ store: input.store }));
  if (!(outlines instanceof ProjectStructuredOutlineApplicationService))
    denied();
  return Object.freeze({
    outlines,
    conversations: input.store.projectConversationStore(),
    runs: input.store,
    installations: input.store.pluginInstallationStore(),
    authorization: config.authorization,
    resolveActor: input.resolveActor,
    authorizeService: config.authorizeService,
  });
}
export function createInstalledPluginProjectOutlineToolsOwner(
  input: Readonly<{
    dependencies: InstalledPluginProjectOutlineToolsDependencies | undefined;
    context: PluginToolRuntimeContext;
    stageAdmission: ProjectStageRunAdmission | null;
    admission: PluginTaskAdmission;
    scope: PluginProfileScope;
    tools: ExtensionManifest["tools"];
    candidate(): PluginActivationCandidate | null;
    authorizeCurrent(
      invocation: ProjectToolsAuthorizationInvocation,
    ): Promise<void>;
    authorizePackage: InstalledPluginRuntimeResolverDependencies["authorizePackage"];
    assertActive(): void;
  }>,
): ProjectOutlineToolsServiceOwner | null {
  if (input.stageAdmission?.stage.kind !== "outline") return null;
  if (!input.dependencies || input.context.run.source !== null)
    throw new Error("installed_plugin_project_outline_services_unavailable");
  const d = input.dependencies;
  return new ProjectOutlineToolsServiceOwner({
    ...d,
    context: input.context,
    stageAdmission: input.stageAdmission,
    admission: input.admission,
    tools: input.tools,
    authorizeOutlineService: (signal) =>
      d.authorizeService(input.admission, signal),
    authorizeCurrent: input.authorizeCurrent,
    authorizeTransaction: async (operation) => {
      const candidate = input.candidate();
      if (candidate === null)
        throw new Error("installed_plugin_runtime_candidate_missing");
      // External-only callback within the native transaction; original Store qualifies persisted facts.
      await assertInstalledPluginProjectToolsExternalCurrent({
        admission: input.admission,
        candidate,
        scope: input.scope,
        purpose: installedPluginToolOperationPurpose(operation),
        signal: operation.signal,
        resolveActor: d.resolveActor,
        authorizePackage: input.authorizePackage,
        assertActive: input.assertActive,
      });
    },
    assertActive: input.assertActive,
  });
}
export async function prepareInstalledPluginProjectOutlineStores(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    config: InstalledPluginProjectOutlineToolsConfig | undefined;
  }>,
): Promise<void> {
  if (input.config === undefined) return;
  captureInstalledPluginProjectOutlineToolsConfig(input.config);
  await input.store.creativeProjectStore().migrate();
  await input.store.projectTextStore().migrate();
  await input.store.projectFoundationStore().migrate();
  await input.store.projectConversationStore().migrate();
}
function denied(): never {
  throw new Error("installed_plugin_project_outline_configuration_invalid");
}
