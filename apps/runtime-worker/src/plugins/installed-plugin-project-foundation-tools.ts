import {
  isProjectFoundationApplicationService,
  type CreativeProjectAuthorizationPort,
  type ProjectFoundationApplicationService,
} from "@crewon/application";
import type {
  ExtensionManifest,
  PluginProfileScope,
  PluginTaskAdmission,
  ProjectFoundationRunAdmission,
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
  ProjectFoundationToolsServiceOwner,
  type ProjectFoundationToolsServiceOwnerDependencies,
} from "./project-foundation-tools-service-owner.ts";
import {
  foundationOwnerBound as bound,
  foundationOwnerData as data,
  foundationOwnerDenied as denied,
} from "./project-foundation-owner-support.ts";

/** Deployment opt-in is independent of text tools, UI pin and prompt/skill guidance. */
export type InstalledPluginProjectFoundationToolsConfig = Readonly<{
  version: "crewon.project-foundation-tools.v1";
  createFoundations(
    input: Readonly<{ store: SqliteRunStore | PostgresDomainStore }>,
  ): ProjectFoundationApplicationService;
  authorization: CreativeProjectAuthorizationPort;
  authorizeService(
    admission: PluginTaskAdmission,
    signal: AbortSignal,
  ): Promise<void>;
}>;

export type InstalledPluginProjectFoundationToolsDependencies = Pick<
  ProjectFoundationToolsServiceOwnerDependencies,
  | "foundations"
  | "foundationRuns"
  | "conversations"
  | "runs"
  | "installations"
  | "authorization"
  | "resolveActor"
> &
  Readonly<{
    authorizeService: InstalledPluginProjectFoundationToolsConfig["authorizeService"];
  }>;

export function captureInstalledPluginProjectFoundationToolsConfig(
  input: InstalledPluginProjectFoundationToolsConfig,
): InstalledPluginProjectFoundationToolsConfig {
  const fields = data(input, [
    "version",
    "createFoundations",
    "authorization",
    "authorizeService",
  ]);
  if (fields.version !== "crewon.project-foundation-tools.v1") denied();
  const service = bound<
    InstalledPluginProjectFoundationToolsConfig["authorizeService"]
  >(input, "authorizeService");
  return Object.freeze({
    version: "crewon.project-foundation-tools.v1",
    createFoundations: bound<
      InstalledPluginProjectFoundationToolsConfig["createFoundations"]
    >(input, "createFoundations"),
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

/** Consume the actual parent stores. There is no second runtime, migration-on-read or fallback service. */
export function composeInstalledPluginProjectFoundationToolsDependencies(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    config: InstalledPluginProjectFoundationToolsConfig;
    resolveActor: InstalledPluginRunContextDependencies["resolveActor"];
  }>,
): InstalledPluginProjectFoundationToolsDependencies {
  const config = captureInstalledPluginProjectFoundationToolsConfig(
      input.config,
    ),
    foundations = config.createFoundations(
      Object.freeze({ store: input.store }),
    );
  if (!isProjectFoundationApplicationService(foundations)) denied();
  return Object.freeze({
    foundations,
    foundationRuns: input.store.projectFoundationRunStore(),
    conversations: input.store.projectConversationStore(),
    runs: input.store,
    installations: input.store.pluginInstallationStore(),
    authorization: config.authorization,
    resolveActor: input.resolveActor,
    authorizeService: config.authorizeService,
  });
}

export function createInstalledPluginProjectFoundationToolsOwner(
  input: Readonly<{
    dependencies: InstalledPluginProjectFoundationToolsDependencies | undefined;
    context: PluginToolRuntimeContext;
    stageAdmission: ProjectStageRunAdmission | null;
    foundationAdmission: ProjectFoundationRunAdmission | null;
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
): ProjectFoundationToolsServiceOwner | null {
  if (input.foundationAdmission === null) return null;
  if (
    !input.dependencies ||
    !input.stageAdmission ||
    input.context.run.source !== null
  )
    throw new Error("installed_plugin_project_foundation_services_unavailable");
  const d = input.dependencies;
  return new ProjectFoundationToolsServiceOwner({
    ...d,
    context: input.context,
    stageAdmission: input.stageAdmission,
    foundationAdmission: input.foundationAdmission,
    admission: input.admission,
    tools: input.tools,
    authorizeFoundationService: (signal) =>
      d.authorizeService(input.admission, signal),
    authorizeCurrent: input.authorizeCurrent,
    authorizeTransaction: async (operation) => {
      const candidate = input.candidate();
      if (candidate === null)
        throw new Error("installed_plugin_runtime_candidate_missing");
      // This callback executes within the committing native transaction; external policy only.
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

/** Explicitly migrate the existing project metadata and independent sidecar schema before loading Node. */
export async function prepareInstalledPluginProjectFoundationStores(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    config: InstalledPluginProjectFoundationToolsConfig | undefined;
  }>,
): Promise<void> {
  if (input.config === undefined) return;
  captureInstalledPluginProjectFoundationToolsConfig(input.config);
  await input.store.creativeProjectStore().migrate();
  await input.store.projectFoundationStore().migrate();
  await input.store.projectConversationStore().migrate();
}
