import { method, closeAll } from "./installed-plugin-task-runtime-support.ts";
import { prepareProjectHistoricalQueryResolver } from "@crewon/application";
import type { ProjectHistoricalQueryPublication } from "@crewon/domain";
import {
  pluginInstallationNamespaceId,
  pluginInstallationDigest,
} from "@crewon/domain";
import { InstalledPluginProjectHistoricalQueryOwner } from "./installed-plugin-project-historical-query-owner.ts";
import { assertProjectHistoricalQueryPluginPublications } from "./project-historical-query-plugin-configuration.ts";
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  ApplicationError,
  ExtensionConfigurationApplicationService,
  ExtensionReadApplicationService,
  ExtensionTaskApplicationService,
  PluginUiCommittedTaskAuthority,
  ProjectGenerationReadApplicationService,
  type ApplicationClock,
  type ApplicationIdGenerator,
  type AuthorizationPort,
  type ContentDigester,
  type ExtensionCreditQuotePort,
  type PluginTaskUnmeteredAuthorityPort,
  capturePluginTaskUnmeteredAuthority,
  type PluginInstallationHostProfilePort,
  type PluginUiAuthorizationPort,
} from "@crewon/application";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import { InstalledPluginProjectGenerationOwner } from "./installed-plugin-project-generation-owner.ts";
import { InstalledPluginProjectQueryOwner } from "./installed-plugin-project-query-owner.ts";
import {
  bindInstalledPluginRequestOwner,
  isInstalledPluginRequestOwner,
  InstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";
import {
  InstalledPluginTaskActionOwner,
  type InstalledPluginTaskActionOwnerDependencies,
} from "./installed-plugin-task-action-owner.ts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";
import { assertProjectGenerationPluginPublications } from "./project-generation-plugin-configuration.ts";
import { assertProjectQueryPluginPublications } from "./project-query-plugin-configuration.ts";
import {
  captureInstalledProjectMediaInputConfiguration,
  type InstalledProjectMediaInputConfiguration,
} from "./installed-project-media-input-configuration.ts";
import { InstalledProjectMediaInputRuntime } from "./installed-project-media-input-runtime.ts";

export type InstalledPluginTaskRuntimeCore = Readonly<{
  owner: InstalledPluginTaskActionOwner;
  projectGenerations?: InstalledPluginProjectGenerationOwner;
  projectQueries?: InstalledPluginProjectQueryOwner;
  historicalQueries?: InstalledPluginProjectHistoricalQueryOwner;
  projectGenerationReads?: ProjectGenerationReadApplicationService;
  projectMediaInputs?: InstalledProjectMediaInputRuntime;
  requests: InstalledPluginRequestOwner;
  extensions: ExtensionConfigurationApplicationService;
  extensionTasks: ExtensionTaskApplicationService;
  modelSelection?: import("@crewon/application").PluginTaskModelSelectionPort;
  extensionReads: ExtensionReadApplicationService;
  close(): Promise<void>;
}>;

export type InstalledPluginTaskRuntimeCoreInput = Readonly<{
  store: SqliteRunStore | PostgresDomainStore;
  requests: InstalledPluginRequestOwner;
  installRoot: string;
  maximumPackages: number;
  publications: readonly Readonly<{
    pluginId: string;
    packageDigest: string;
  }>[];
  profiles: PluginInstallationHostProfilePort;
  businessAuthorization: AuthorizationPort;
  uiAuthorization: PluginUiAuthorizationPort;
  authorizePackage: InstalledPluginTaskActionOwnerDependencies["authorizePackage"];
  creditQuotes?: ExtensionCreditQuotePort;
  unmeteredTasks?: PluginTaskUnmeteredAuthorityPort;
  modelSelection?: import("@crewon/application").PluginTaskModelSelectionPort;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
  creativeProjects?: PreparedCreativeProjects;
  projectMediaInputs?: InstalledProjectMediaInputConfiguration;
  /** Prepares only the original admission adapter. Does not authorize material I/O or expose a UI action. */
  projectMediaGenerationStorage?: Readonly<{
    version: "crewon.project-media-generation-storage.v1";
  }>;
  metadataHostUiServices?: PluginUiHostServiceAvailabilityPort;
  assertHistoricalTarget?(publication: ProjectHistoricalQueryPublication): void;
}>;

const coreBindings = new WeakMap<
  object,
  Readonly<{
    store: InstalledPluginTaskRuntimeCoreInput["store"];
    requests: InstalledPluginRequestOwner;
    assertActive(): void;
    authorizePackage: InstalledPluginTaskRuntimeCoreInput["authorizePackage"];
    uiAuthorization: PluginUiAuthorizationPort;
    publications: InstalledPluginTaskRuntimeCoreInput["publications"];
    installRoot: string;
    mediaGenerationStorage: boolean;
  }>
>();

/** A Native recovery borrower must retain this exact parent and issued request lifetime. */
export function assertInstalledPluginTaskRuntimeCoreBinding(
  core: unknown,
  input: Readonly<{
    store: InstalledPluginTaskRuntimeCoreInput["store"];
    requests: InstalledPluginRequestOwner;
  }>,
): asserts core is InstalledPluginTaskRuntimeCore {
  const binding =
    core !== null && typeof core === "object"
      ? coreBindings.get(core)
      : undefined;
  if (
    binding === undefined ||
    binding.store !== input.store ||
    binding.requests !== input.requests
  )
    invalid();
  binding.assertActive();
}

export function inheritInstalledPluginTaskRuntimeCoreBinding(
  alias: InstalledPluginTaskRuntimeCore,
  original: InstalledPluginTaskRuntimeCore,
): void {
  const binding = coreBindings.get(original);
  if (
    binding === undefined ||
    alias.requests !== original.requests ||
    alias.owner !== original.owner ||
    alias.extensionTasks !== original.extensionTasks ||
    alias.modelSelection !== original.modelSelection
  )
    invalid();
  binding.assertActive();
  coreBindings.set(alias, binding);
}

/** Only an issued, still-active Core can lend its actual current request/PDP callbacks. */
export function installedProjectConversationTaskAuthority(
  core: InstalledPluginTaskRuntimeCore,
) {
  const binding = coreBindings.get(core);
  if (binding === undefined) invalid();
  binding.assertActive();
  return Object.freeze({
    requests: binding.requests,
    authorizePackage: binding.authorizePackage,
    authorization: binding.uiAuthorization,
    assertActive: binding.assertActive,
  });
}

/** History result services borrow the original owner and store, without gaining generation admission. */
export function installedProjectMediaResultTaskAuthority(
  core: InstalledPluginTaskRuntimeCore,
) {
  const binding = coreBindings.get(core);
  if (binding === undefined) invalid();
  return Object.freeze({
    ...installedProjectConversationTaskAuthority(core),
    store: binding.store,
    publications: binding.publications,
  });
}

/** Internal media admission borrows this exact Core; storage preparation is still not a generation grant. */
export function installedProjectMediaGenerationTaskAuthority(
  core: InstalledPluginTaskRuntimeCore,
) {
  const binding = coreBindings.get(core);
  if (!binding?.mediaGenerationStorage) invalid();
  return Object.freeze({
    ...installedProjectConversationTaskAuthority(core),
    store: binding.store,
    installRoot: binding.installRoot,
    publications: binding.publications,
  });
}

/** Metadata approval is independent; every reviewed target must still belong to this original Core's publication. */
export function assertInstalledProjectMediaInputPublications(
  core: InstalledPluginTaskRuntimeCore,
  configuration: InstalledProjectMediaInputConfiguration,
): void {
  const binding = coreBindings.get(core);
  if (binding === undefined) invalid();
  binding.assertActive();
  if (
    configuration.reviews.some(
      (review) =>
        !binding.publications.some(
          (publication) =>
            publication.pluginId === review.targetIdentity.pluginId &&
            publication.packageDigest === review.targetIdentity.packageDigest,
        ),
    )
  )
    invalid();
}

/** Borrows an issued request owner and the real parent store; explicitly migrates execution, never identity, prices or funds. */
export async function createInstalledPluginTaskRuntimeCore(
  provided: InstalledPluginTaskRuntimeCoreInput,
): Promise<InstalledPluginTaskRuntimeCore> {
  if (
    provided === null ||
    typeof provided !== "object" ||
    Array.isArray(provided)
  )
    invalid();
  const input = pluginSecurityRecord(provided, [
    "store",
    "requests",
    "installRoot",
    "maximumPackages",
    "publications",
    "profiles",
    "businessAuthorization",
    "uiAuthorization",
    "authorizePackage",
    ...(Object.hasOwn(provided, "creditQuotes") ? ["creditQuotes"] : []),
    ...(Object.hasOwn(provided, "unmeteredTasks") ? ["unmeteredTasks"] : []),
    ...(Object.hasOwn(provided, "modelSelection") ? ["modelSelection"] : []),
    "clock",
    "ids",
    "digester",
    ...(Object.hasOwn(provided, "assertHistoricalTarget")
      ? ["assertHistoricalTarget"]
      : []),
    ...(Object.hasOwn(provided, "creativeProjects")
      ? ["creativeProjects"]
      : []),
    ...(Object.hasOwn(provided, "projectMediaInputs")
      ? ["projectMediaInputs"]
      : []),
    ...(Object.hasOwn(provided, "projectMediaGenerationStorage")
      ? ["projectMediaGenerationStorage"]
      : []),
    ...(Object.hasOwn(provided, "metadataHostUiServices")
      ? ["metadataHostUiServices"]
      : []),
  ]) as InstalledPluginTaskRuntimeCoreInput;
  const mediaInputs =
    input.projectMediaInputs === undefined
      ? undefined
      : captureInstalledProjectMediaInputConfiguration(
          input.projectMediaInputs,
        );
  if (
    input.projectMediaGenerationStorage !== undefined &&
    pluginSecurityRecord(input.projectMediaGenerationStorage, ["version"])
      .version !== "crewon.project-media-generation-storage.v1"
  )
    invalid();
  const publications = Object.freeze(
    input.publications.map((item) => {
      const r = pluginSecurityRecord(item, ["pluginId", "packageDigest"]);
      return Object.freeze({
        pluginId: pluginInstallationNamespaceId(r.pluginId),
        packageDigest: pluginInstallationDigest(r.packageDigest),
      });
    }),
  );
  if (
    (!(input.store instanceof SqliteRunStore) &&
      !(input.store instanceof PostgresDomainStore)) ||
    !isInstalledPluginRequestOwner(input.requests) ||
    typeof input.installRoot !== "string" ||
    !isAbsolute(input.installRoot) ||
    resolve(input.installRoot) !== input.installRoot ||
    input.installRoot.trim() !== input.installRoot ||
    input.installRoot.length > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.installRoot) ||
    !Number.isSafeInteger(input.maximumPackages) ||
    input.maximumPackages < 1 ||
    input.maximumPackages > 32
  )
    invalid();
  const generations = input.creativeProjects?.pluginGenerations;
  const queries = input.creativeProjects?.pluginQueries;
  const historical = input.creativeProjects?.historicalQueries;
  assertProjectHistoricalQueryPluginPublications(
    historical,
    input.publications,
  );
  assertProjectQueryPluginPublications(queries, input.publications);
  assertProjectGenerationPluginPublications(generations, input.publications);
  const resolveProfile = method(input.profiles, "resolve");
  const authorizeBusiness = method(input.businessAuthorization, "authorize");
  const authorizeUi = method(input.uiAuthorization, "authorize");
  const authorizePackage = method(input, "authorizePackage");
  if (
    (input.unmeteredTasks === undefined) ===
    (input.creditQuotes === undefined)
  )
    invalid();
  const quote =
    input.creditQuotes === undefined
      ? undefined
      : method(input.creditQuotes, "quoteGeneration");
  const projectConversationQuote =
    input.creditQuotes?.quoteProjectConversationGeneration === undefined
      ? undefined
      : method(input.creditQuotes, "quoteProjectConversationGeneration");
  const prepareUnmetered =
    input.unmeteredTasks === undefined
      ? undefined
      : method(input.unmeteredTasks, "prepareGeneration");
  const clock = Object.freeze({ now: method(input.clock, "now") });
  const ids = Object.freeze({ nextId: method(input.ids, "nextId") });
  const digester = Object.freeze({ sha256: method(input.digester, "sha256") });
  const requests = input.requests;
  const lifetime = new AbortController();
  const physical = new Set<Promise<unknown>>();
  const active = () => {
    if (lifetime.signal.aborted)
      throw new ApplicationError(
        "authorization",
        "installed_plugin_request_authority_unavailable",
      );
  };
  const profiles: PluginInstallationHostProfilePort = Object.freeze({
    resolve: async (
      actor: Parameters<PluginInstallationHostProfilePort["resolve"]>[0],
    ) => {
      active();
      const result = await resolveProfile(actor);
      active();
      return result;
    },
  });
  const businessAuthorization: AuthorizationPort = Object.freeze({
    authorize: async (
      request: Parameters<AuthorizationPort["authorize"]>[0],
    ) => {
      active();
      const result = await authorizeBusiness(request);
      active();
      return result;
    },
  });
  const uiAuthorization: PluginUiAuthorizationPort = Object.freeze({
    authorize: async (
      request: Parameters<PluginUiAuthorizationPort["authorize"]>[0],
    ) => {
      active();
      const result = await authorizeUi(request);
      active();
      return result;
    },
  });
  const packageAuthorization: InstalledPluginTaskActionOwnerDependencies["authorizePackage"] =
    async (request, signal) => {
      active();
      const result = await authorizePackage(
        request,
        AbortSignal.any([signal, lifetime.signal]),
      );
      active();
      return result;
    };
  const creditQuotes: ExtensionCreditQuotePort | undefined =
    quote === undefined
      ? undefined
      : Object.freeze({
          quoteGeneration: async (
            request: Parameters<ExtensionCreditQuotePort["quoteGeneration"]>[0],
          ) => {
            active();
            const result = await quote(request);
            active();
            return result;
          },
          ...(projectConversationQuote === undefined
            ? {}
            : {
                quoteProjectConversationGeneration: async (
                  request: Parameters<
                    NonNullable<
                      ExtensionCreditQuotePort["quoteProjectConversationGeneration"]
                    >
                  >[0],
                ) => {
                  active();
                  const result = await projectConversationQuote(request);
                  active();
                  return result;
                },
              }),
        });
  const unmeteredTasks: PluginTaskUnmeteredAuthorityPort | undefined =
    prepareUnmetered === undefined
      ? undefined
      : Object.freeze({
          prepareGeneration: async (
            request: Parameters<
              PluginTaskUnmeteredAuthorityPort["prepareGeneration"]
            >[0],
          ) => {
            active();
            const result = capturePluginTaskUnmeteredAuthority(
              await prepareUnmetered(request),
            );
            active();
            return Object.freeze({
              authorization: result.authorization,
              assertCurrent: async () => {
                active();
                await result.assertCurrent();
                active();
              },
              assertActive: () => {
                active();
                result.assertActive();
              },
            });
          },
        });
  type ServiceBehavior = "read" | "mutation";
  const track = <T>(
    work: () => Promise<T>,
    behavior: ServiceBehavior,
  ): Promise<T> => {
    active();
    const pending = Promise.resolve().then(async () => {
      active();
      const result = await work();
      // A plain read cannot survive withdrawal. Mutation COMMIT semantics remain with the Application.
      if (behavior === "read") active();
      return result;
    });
    physical.add(pending);
    void pending.then(
      () => physical.delete(pending),
      () => physical.delete(pending),
    );
    return pending;
  };
  const ownMethods = <T extends object>(
    service: T,
    behaviors: Readonly<Record<keyof T & string, ServiceBehavior>>,
  ): T => {
    for (const name of Object.keys(behaviors) as (keyof T & string)[]) {
      const original = method(service, name) as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>;
      Object.defineProperty(service, name, {
        value: async (...args: unknown[]) =>
          track(() => original(...args), behaviors[name]),
      });
    }
    return service;
  };
  let owner: InstalledPluginTaskActionOwner | undefined;
  let projectGenerations: InstalledPluginProjectGenerationOwner | undefined;
  let projectQueries: InstalledPluginProjectQueryOwner | undefined;
  let historicalQueries: InstalledPluginProjectHistoricalQueryOwner | undefined;
  try {
    // Migrate this actual adapter: project readiness flags belong to its instance, not another borrowed adapter.
    const ledger = input.store.pluginInstallationStore();
    await ledger.migrate();
    const extensions = input.store.extensionStore();
    await extensions.migrate();
    await extensions.migratePluginAdmissions();
    if (unmeteredTasks === undefined) {
      await extensions.migrateCredits();
    } else {
      await extensions.migrateUnmeteredPluginAdmissions();
    }
    if (generations !== undefined) await extensions.migrateProjectGenerations();
    if (input.projectMediaGenerationStorage !== undefined) {
      const assets = input.store.projectAssetStore();
      await assets.projectMediaInputStore().migrate();
      await assets.projectMaterialPreparationStore().migrate();
      await extensions.migrateProjectMediaGenerations();
    }
    if (queries !== undefined) {
      await extensions.migrateProjectQueries();
      await extensions.enableProjectGenerationReads();
    }
    if (historical !== undefined) {
      await extensions.migrateProjectHistoricalQueries();
      await extensions.enableProjectGenerationReads();
    }
    const operations = input.store.externalOperationStore();
    const reads = bindInstalledPluginRequestOwner(
      ownMethods(
        new ExtensionReadApplicationService({
          runs: input.store,
          agentVersions: input.store,
          extensions,
          operations,
          catalog: requests.catalog,
          host: requests.host,
          authorization: businessAuthorization,
          digester,
        }),
        { getCatalog: "read", getRuntime: "read", getTask: "read" },
      ),
      requests,
      { preparation: "configuration" },
    );
    const projectGenerationReads =
      queries === undefined && historical === undefined
        ? undefined
        : ownMethods(
            new ProjectGenerationReadApplicationService({
              projects: input.creativeProjects!.service,
              tasks: reads,
              extensions,
              digester,
            }),
            { getConceptGeneration: "read" },
          );
    const taskDependencies = {
      store: input.store,
      extensions,
      operations,
      catalog: requests.catalog,
      host: requests.host,
      pluginQueryHost: requests.pluginQueryHost,
      authorization: businessAuthorization,
      clock,
      ids,
      digester,
      ...(creditQuotes === undefined ? {} : { creditQuotes }),
      ...(unmeteredTasks === undefined ? {} : { unmeteredTasks }),
      ...(input.modelSelection === undefined
        ? {}
        : { modelSelection: input.modelSelection }),
      ...(projectGenerationReads === undefined
        ? {}
        : { projectGenerationReads }),
      ...(generations === undefined &&
      queries === undefined &&
      historical === undefined
        ? {}
        : {
            creativeProjects: {
              store: (generations ?? queries ?? historical)!.store,
              authorization: (generations ?? queries ?? historical)!
                .authorization,
            },
          }),
    };
    const tasks = ownMethods(
      new ExtensionTaskApplicationService(taskDependencies),
      {
        createProjectConversationTurnFromHost: "mutation",
        createProjectAssetStageTurnFromHost: "mutation",
        createProjectMediaInputStageTurnFromHost: "mutation",
        createProjectTextPlanTurnFromHost: "mutation",
        createProjectMediaTaskFromHost: "mutation",
        createTask: "mutation",
        createTaskFromPlugin: "mutation",
        createQueryTaskFromPlugin: "mutation",
        createPublishedProjectQueryTaskFromPlugin: "mutation",
        createHistoricalPublishedProjectQueryTaskFromPlugin: "mutation",
        createProjectTaskFromPlugin: "mutation",
        createPublishedProjectTaskFromPlugin: "mutation",
        getPublishedProjectGenerationReadiness: "read",
      },
    );
    const configurationService = bindInstalledPluginRequestOwner(
      ownMethods(
        new ExtensionConfigurationApplicationService({
          store: extensions,
          catalog: requests.catalog,
          host: requests.host,
          authorization: businessAuthorization,
          clock,
          digester,
        }),
        {
          getConfiguration: "read",
          getActivation: "read",
          saveConfiguration: "mutation",
          setActivation: "mutation",
        },
      ),
      requests,
      { preparation: "configuration" },
    );
    bindInstalledPluginRequestOwner(tasks, requests);
    const committedTasks = new PluginUiCommittedTaskAuthority({
      extensions,
      runs: input.store,
      digester,
      ...(historical === undefined
        ? {}
        : {
            projectHistoricalQueries: {
              publications: historical.publications,
              projects: historical.store,
              operations,
            },
          }),
      ...(queries === undefined
        ? {}
        : {
            projectQueries: {
              publications: queries.publications,
              projects: queries.store,
              operations,
            },
          }),
      ...(generations === undefined
        ? {}
        : {
            projectGenerations: {
              publications: generations.publications,
              projects: generations.store,
            },
          }),
    });
    const common = {
      installRoot: input.installRoot,
      installations: ledger,
      tasks,
      committedTasks,
      profiles,
      authorization: uiAuthorization,
      resolveActor: (
        identity: Parameters<InstalledPluginRequestOwner["resolveActor"]>[0],
        signal: AbortSignal,
      ) => {
        active();
        return requests.resolveActor(
          identity,
          AbortSignal.any([signal, lifetime.signal]),
        );
      },
      authorizePackage: packageAuthorization,
      clock,
      ids: { nextId: () => randomBytes(32).toString("base64url") },
    };
    owner = new InstalledPluginTaskActionOwner({
      ...common,
      maximumPackages: input.maximumPackages,
    });
    if (generations !== undefined)
      projectGenerations = new InstalledPluginProjectGenerationOwner(
        {
          ...common,
          publications: generations.publications,
          projects: generations.store,
          taskOwner: owner,
          requestSignal: () =>
            AbortSignal.any([requests.currentSignal(), lifetime.signal]),
          digester,
          maximumInvocations: input.maximumPackages,
        },
        input.metadataHostUiServices,
      );
    if (queries !== undefined)
      projectQueries = new InstalledPluginProjectQueryOwner(
        {
          ...common,
          publications: queries.publications,
          generationReads: projectGenerationReads!,
          taskOwner: owner,
          requestSignal: () =>
            AbortSignal.any([requests.currentSignal(), lifetime.signal]),
          digester,
          maximumInvocations: input.maximumPackages,
        },
        projectGenerations?.hostUiServices ?? input.metadataHostUiServices,
      );
    if (historical !== undefined)
      historicalQueries = new InstalledPluginProjectHistoricalQueryOwner(
        {
          ...common,
          publications: historical.publications,
          resolver: prepareProjectHistoricalQueryResolver(
            taskDependencies,
            historical.publications,
          ),
          taskOwner: owner,
          requestSignal: () =>
            AbortSignal.any([requests.currentSignal(), lifetime.signal]),
          digester,
          maximumInvocations: input.maximumPackages,
          ...(input.assertHistoricalTarget === undefined
            ? {}
            : {
                assertPreparedTarget: method(input, "assertHistoricalTarget"),
              }),
        },
        projectQueries?.hostUiServices ??
          projectGenerations?.hostUiServices ??
          input.metadataHostUiServices,
      );
    const actualHistorical = historicalQueries;
    const actualOwner = owner;
    const actualGenerations = projectGenerations;
    const actualQueries = projectQueries;
    let closing: Promise<void> | null = null;
    const core: InstalledPluginTaskRuntimeCore = Object.freeze({
      owner: actualOwner,
      ...(actualHistorical === undefined
        ? {}
        : { historicalQueries: actualHistorical }),
      ...(actualGenerations === undefined
        ? {}
        : { projectGenerations: actualGenerations }),
      ...(actualQueries === undefined ? {} : { projectQueries: actualQueries }),
      ...(projectGenerationReads === undefined
        ? {}
        : { projectGenerationReads }),
      requests,
      extensions: configurationService,
      extensionTasks: tasks,
      ...(input.modelSelection === undefined
        ? {}
        : { modelSelection: input.modelSelection }),
      extensionReads: reads,
      close: () => {
        lifetime.abort();
        return (closing ??= closeAll([
          () => actualHistorical?.close(),
          () => actualQueries?.close(),
          () => actualGenerations?.close(),
          () => actualOwner.close(),
          () => Promise.allSettled([...physical]).then(() => undefined),
        ]));
      },
    });
    coreBindings.set(
      core,
      Object.freeze({
        store: input.store,
        requests,
        assertActive: active,
        authorizePackage: packageAuthorization,
        uiAuthorization,
        publications,
        installRoot: input.installRoot,
        mediaGenerationStorage:
          input.projectMediaGenerationStorage !== undefined,
      }),
    );
    if (mediaInputs === undefined) return core;
    const projectMediaInputs = await InstalledProjectMediaInputRuntime.prepare({
      core,
      store: input.store,
      configuration: mediaInputs,
    });
    let mediaClosing: Promise<void> | undefined;
    const complete: InstalledPluginTaskRuntimeCore = Object.freeze({
      ...core,
      projectMediaInputs,
      close: () =>
        (mediaClosing ??= closeAll([
          () => projectMediaInputs.close(),
          () => core.close(),
        ])),
    });
    inheritInstalledPluginTaskRuntimeCoreBinding(complete, core);
    return complete;
  } catch (error) {
    lifetime.abort();
    try {
      await closeAll([
        () => historicalQueries?.close(),
        () => projectQueries?.close(),
        () => projectGenerations?.close(),
        () => owner?.close(),
        () => Promise.allSettled([...physical]).then(() => undefined),
      ]);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "installed_plugin_task_startup_cleanup_failed",
      );
    }
    throw error;
  }
}

function invalid(): never {
  throw new Error("installed_plugin_task_runtime_core_invalid");
}
