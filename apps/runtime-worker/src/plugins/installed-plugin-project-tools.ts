import {
  CreativeProjectApplicationService,
  ProjectTextApplicationService,
  ProjectStructuredOutlineApplicationService,
  type PluginInstallationStore,
  type RunStore,
  type CreativeProjectAuthorizationPort,
} from "@crewon/application";
import type { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type { InstalledPluginRunContextDependencies } from "./installed-plugin-run-context.ts";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "../standalone-adapters.ts";
import {
  validateCreativeProjectActor,
  type ExtensionManifest,
  type PluginTaskAdmission,
  type PluginProfileScope,
  type ProjectStageRunAdmission,
  type ProjectTextPlanRunAdmission,
} from "@crewon/domain";
import type {
  PluginActivationCandidate,
  PluginExecutionPackageFailureOwner,
} from "@crewon/plugin-host";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type { InstalledPluginRuntimeResolverDependencies } from "./installed-plugin-runtime-resolver.ts";
import { installedPluginToolOperationPurpose } from "./installed-plugin-run-runtime.ts";
import {
  ProjectToolsServiceOwner,
  type ProjectToolsAuthorizationInvocation,
} from "./project-tools-service-owner.ts";

/** Historical observers retain their original service set; only genuine business Runs get this owner. */
export function createInstalledPluginProjectToolsOwner(
  input: Readonly<{
    dependencies: InstalledPluginProjectToolsDependencies | undefined;
    context: PluginToolRuntimeContext;
    stageAdmission?: ProjectStageRunAdmission | null;
    planAdmission?: ProjectTextPlanRunAdmission | null;
    mediaInputStageAdmission?:
      | import("@crewon/domain").ProjectMediaInputStageRunAdmission
      | null;
    admission: PluginTaskAdmission;
    assetStageAdmission?:
      | import("@crewon/domain").ProjectAssetStageRunAdmission
      | null;
    scope: PluginProfileScope;
    tools: ExtensionManifest["tools"];
    candidate(): PluginActivationCandidate | null;
    authorizeCurrent(
      invocation: ProjectToolsAuthorizationInvocation,
    ): Promise<void>;
    authorizePackage: InstalledPluginRuntimeResolverDependencies["authorizePackage"];
    assertActive(): void;
  }>,
): ProjectToolsServiceOwner | null {
  if (input.dependencies === undefined || input.context.run.source !== null)
    return null;
  const dependencies = input.dependencies;
  return new ProjectToolsServiceOwner({
    ...dependencies,
    context: input.context,
    ...(dependencies.assetTools === undefined
      ? {}
      : { assets: dependencies.assetTools(input.admission) }),
    stageAdmission: input.stageAdmission,
    mediaInputStageAdmission: input.mediaInputStageAdmission,
    assetStageAdmission: input.assetStageAdmission,
    planAdmission: input.planAdmission,
    admission: input.admission,
    tools: input.tools,
    authorizeCurrent: async (operation) => {
      await dependencies.authorizeService?.(input.admission, operation.signal);
      await input.authorizeCurrent(operation);
    },
    authorizeTransaction: async (operation) => {
      await dependencies.authorizeService?.(input.admission, operation.signal);
      const candidate = input.candidate();
      if (candidate === null)
        throw new Error("installed_plugin_runtime_candidate_missing");
      await assertInstalledPluginProjectToolsExternalCurrent({
        admission: input.admission,
        candidate,
        scope: input.scope,
        purpose: installedPluginToolOperationPurpose(operation),
        signal: operation.signal,
        resolveActor: dependencies.resolveActor,
        authorizePackage: input.authorizePackage,
        assertActive: input.assertActive,
      });
    },
    assertActive: input.assertActive,
  });
}

/** Keep a failed physical service owner quarantined with the package until a later close joins it. */
export async function closeInstalledPluginProjectToolsStartup(
  input: Readonly<{
    owner: Pick<ProjectToolsServiceOwner, "close"> | null;
    failureOwner: PluginExecutionPackageFailureOwner | null;
  }>,
): Promise<
  Readonly<{
    failureOwner: PluginExecutionPackageFailureOwner | null;
    error: unknown | null;
  }>
> {
  try {
    await input.owner?.close();
    return { failureOwner: input.failureOwner, error: null };
  } catch (error) {
    const failureOwner = input.failureOwner;
    return {
      error,
      failureOwner: {
        close: async () => {
          const outcomes = await Promise.allSettled([
            input.owner!.close(),
            failureOwner?.close(),
          ]);
          const failures = outcomes.filter(
            (value): value is PromiseRejectedResult =>
              value.status === "rejected",
          );
          if (failures.length > 0)
            throw new AggregateError(
              failures.map((value) => value.reason),
              "installed_plugin_runtime_close_failed",
            );
        },
      },
    };
  }
}

/** External checks only. Store-side Run/receipt/installation reads use its committing connection. */
export async function assertInstalledPluginProjectToolsExternalCurrent(
  input: Readonly<{
    admission: PluginTaskAdmission;
    assetStageAdmission?:
      | import("@crewon/domain").ProjectAssetStageRunAdmission
      | null;
    candidate: PluginActivationCandidate;
    scope: PluginProfileScope;
    purpose: "submit" | "observe";
    signal: AbortSignal;
    resolveActor: InstalledPluginRunContextDependencies["resolveActor"];
    authorizePackage: InstalledPluginRuntimeResolverDependencies["authorizePackage"];
    assertActive(): void;
  }>,
): Promise<void> {
  const owner = Object.freeze({
    tenantId: input.admission.tenantId,
    spaceId: input.admission.spaceId,
    actorId: input.admission.actorId,
  });
  const actor = async () => {
    input.signal.throwIfAborted();
    input.assertActive();
    const current = await input.resolveActor(owner, input.signal);
    if (current === null)
      throw new Error("installed_plugin_project_tools_actor_unavailable");
    const parsed = validateCreativeProjectActor(current);
    for (const key of [
      "tenantId",
      "spaceId",
      "principalId",
      "actorId",
    ] as const)
      if (parsed[key] !== input.admission[key])
        throw new Error("installed_plugin_project_tools_actor_mismatch");
    input.signal.throwIfAborted();
    input.assertActive();
  };
  await actor();
  if (
    (await input.authorizePackage(
      {
        candidate: input.candidate,
        scope: input.scope,
        purpose: input.purpose,
      },
      input.signal,
    )) !== "allow"
  )
    throw new Error("installed_plugin_runtime_publisher_denied");
  await actor();
}

/** Explicit trusted host deployment. It never grants project access to an ordinary chat Run. */
export type InstalledPluginProjectToolsConfig = Readonly<{
  version: "crewon.project-tools.v1";
  authorization: CreativeProjectAuthorizationPort;
  /** Optional package-specific deployment grant, independent of general Node execution approval. */
  authorizeService?(
    admission: PluginTaskAdmission,
    signal: AbortSignal,
  ): Promise<void>;
}>;
export type InstalledPluginProjectToolsDependencies = Readonly<{
  assetTools?(
    admission: PluginTaskAdmission,
  ): NonNullable<
    import("./project-tools-service-owner.ts").ProjectToolsServiceOwnerDependencies["assets"]
  >;
  projects: CreativeProjectApplicationService;
  texts: ProjectTextApplicationService;
  outlines?: Pick<
    ProjectStructuredOutlineApplicationService,
    "getOutline" | "getRevision" | "listRevisions"
  >;
  runs: Pick<RunStore, "loadRunInSpace">;
  installations: Pick<PluginInstallationStore, "loadSelection" | "loadPackage">;
  authorization: CreativeProjectAuthorizationPort;
  resolveActor: InstalledPluginRunContextDependencies["resolveActor"];
  authorizeService?: InstalledPluginProjectToolsConfig["authorizeService"];
}>;

/** Services share the composition's actual stores and policy, with no secondary runtime. */
export function composeInstalledPluginProjectToolsDependencies(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    config: InstalledPluginProjectToolsConfig;
    resolveActor: InstalledPluginRunContextDependencies["resolveActor"];
  }>,
): InstalledPluginProjectToolsDependencies {
  const config = captureInstalledPluginProjectToolsConfig(input.config);
  const projects = input.store.creativeProjectStore();
  const common = {
    authorization: config.authorization,
    clock: new SystemApplicationClock(),
    ids: new UuidV7ApplicationIdGenerator(),
    digester: new NodeSha256ContentDigester(),
  };
  return Object.freeze({
    projects: new CreativeProjectApplicationService({
      ...common,
      store: projects,
    }),
    texts: new ProjectTextApplicationService({
      ...common,
      projects,
      store: input.store.projectTextStore(),
    }),
    outlines: new ProjectStructuredOutlineApplicationService({
      ...common,
      projects,
      store: input.store.projectTextStore(),
      foundations: input.store.projectFoundationStore(),
    }),
    runs: input.store,
    installations: input.store.pluginInstallationStore(),
    authorization: config.authorization,
    resolveActor: input.resolveActor,
    ...(config.authorizeService === undefined
      ? {}
      : { authorizeService: config.authorizeService }),
  });
}

export function captureInstalledPluginProjectToolsConfig(
  input: InstalledPluginProjectToolsConfig,
): InstalledPluginProjectToolsConfig {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("installed_plugin_project_tools_configuration_invalid");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !==
      (Object.hasOwn(input, "authorizeService") ? 3 : 2) ||
    !fields.version?.enumerable ||
    !("value" in fields.version) ||
    fields.version.value !== "crewon.project-tools.v1" ||
    !fields.authorization?.enumerable ||
    !("value" in fields.authorization)
  )
    throw new Error("installed_plugin_project_tools_configuration_invalid");
  const service = fields.authorizeService;
  if (
    service !== undefined &&
    (!service.enumerable ||
      !("value" in service) ||
      typeof service.value !== "function")
  )
    throw new Error("installed_plugin_project_tools_configuration_invalid");
  const authorization: unknown = fields.authorization.value;
  if (authorization === null || typeof authorization !== "object")
    throw new Error("installed_plugin_project_tools_configuration_invalid");
  let cursor: object | null = authorization;
  for (let depth = 0; cursor !== null && depth < 8; depth++) {
    const method = Object.getOwnPropertyDescriptor(cursor, "authorize");
    if (method !== undefined) {
      if (!("value" in method) || typeof method.value !== "function") break;
      return Object.freeze({
        version: "crewon.project-tools.v1",
        ...(service === undefined
          ? {}
          : {
              authorizeService: (service.value as Function).bind(
                input,
              ) as NonNullable<
                InstalledPluginProjectToolsConfig["authorizeService"]
              >,
            }),
        authorization: Object.freeze({
          authorize: method.value.bind(authorization),
        }),
      });
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new Error("installed_plugin_project_tools_configuration_invalid");
}

/** Migrations are explicit and completed before the resolver opens any installed package. */
export async function prepareInstalledPluginProjectToolsStores(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    config: InstalledPluginProjectToolsConfig | undefined;
  }>,
): Promise<void> {
  if (input.config === undefined) return;
  captureInstalledPluginProjectToolsConfig(input.config);
  await input.store.creativeProjectStore().migrate();
  await input.store.projectTextStore().migrate();
}
