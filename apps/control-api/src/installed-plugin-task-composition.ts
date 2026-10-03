import { randomBytes } from "node:crypto";
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
  type PluginInstallationHostProfilePort,
  type PluginUiAuthorizationPort,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginProfileScope,
} from "@crewon/domain";
import { PostgresDomainStore } from "@crewon/store";
import { InstalledPluginConfigurationMetadata } from "./installed-plugin-configuration-metadata.ts";
import type { PluginActivationCandidate } from "@crewon/plugin-host";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import type { ActorContext } from "@crewon/application";
import type { PluginProfileScope } from "@crewon/domain";
import { InstalledPluginTaskActionOwner } from "./installed-plugin-task-action-owner.ts";
import { InstalledPluginProjectQueryOwner } from "./installed-plugin-project-query-owner.ts";
import { assertProjectQueryPluginPublications } from "./project-query-plugin-configuration.ts";
import { InstalledPluginProjectGenerationOwner } from "./installed-plugin-project-generation-owner.ts";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import { assertProjectGenerationPluginPublications } from "./project-generation-plugin-configuration.ts";
import {
  bindInstalledPluginRequestOwner,
  InstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";
import { InstalledPluginPeerClient } from "./installed-plugin-peer-client.ts";
import {
  InstalledPluginCreditQuoteAuthority,
  InstalledPluginTaskHttpAuthority,
} from "./installed-plugin-credit-quote-authority.ts";
import {
  assertInstalledPluginTaskConfiguration,
  type InstalledPluginTaskConfiguration,
} from "./installed-plugin-task-environment.ts";
import {
  parseProductionPluginUiConfiguration,
  type ProductionPluginUiConfiguration,
} from "./production-plugin-ui-environment.ts";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
  pluginSecurityUiDecision,
  pluginSecurityUiRequest,
} from "./plugin-security-validation.ts";

export type InstalledPluginTaskRuntime = Readonly<{
  owner: InstalledPluginTaskActionOwner;
  projectGenerations?: InstalledPluginProjectGenerationOwner;
  projectQueries?: InstalledPluginProjectQueryOwner;
  projectGenerationReads?: ProjectGenerationReadApplicationService;
  requests: InstalledPluginRequestOwner;
  extensions: ExtensionConfigurationApplicationService;
  extensionTasks: ExtensionTaskApplicationService;
  extensionReads: ExtensionReadApplicationService;
  close(): Promise<void>;
}>;

/** Uses the same real parent store as ordinary Runs. This neither funds accounts nor publishes deployments. */
export async function createInstalledPluginTaskRuntime(
  input: Readonly<{
    configuration: InstalledPluginTaskConfiguration;
    uiConfiguration: ProductionPluginUiConfiguration;
  }>,
  dependencies: Readonly<{
    store: PostgresDomainStore;
    identity: ProductionControlApiIdentity;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
    digester: ContentDigester;
    fetch?: typeof globalThis.fetch;
    creativeProjects?: PreparedCreativeProjects;
    metadataHostUiServices?: PluginUiHostServiceAvailabilityPort;
  }>,
): Promise<InstalledPluginTaskRuntime> {
  assertInstalledPluginTaskConfiguration(input.configuration);
  const configuration = input.configuration;
  const ui = parseProductionPluginUiConfiguration(input.uiConfiguration);
  const generations = dependencies.creativeProjects?.pluginGenerations;
  const queries = dependencies.creativeProjects?.pluginQueries;
  assertProjectQueryPluginPublications(queries, ui.publications);
  assertProjectGenerationPluginPublications(generations, ui.publications);
  if (
    !(dependencies.store instanceof PostgresDomainStore) ||
    !(dependencies.identity instanceof ProductionControlApiIdentity) ||
    ui.installRoot !== configuration.installRoot
  )
    throw new Error("installed_plugin_task_composition_invalid");
  const http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: configuration.timeoutMs,
    fetch: dependencies.fetch,
  });
  const peer = new InstalledPluginPeerClient(
    { ...configuration.peer, deadlineMs: configuration.timeoutMs },
    { fetch: dependencies.fetch },
  );
  let requests: InstalledPluginRequestOwner | undefined;
  let owner: InstalledPluginTaskActionOwner | undefined;
  let projectGenerations: InstalledPluginProjectGenerationOwner | undefined;
  let projectQueries: InstalledPluginProjectQueryOwner | undefined;
  let metadata: InstalledPluginConfigurationMetadata | undefined;
  try {
    const ledger = dependencies.store.pluginInstallationStore();
    await ledger.migrate();
    const extensions = dependencies.store.extensionStore();
    await extensions.migrate();
    await extensions.migratePluginAdmissions();
    await extensions.migrateCredits();
    if (generations !== undefined) await extensions.migrateProjectGenerations();
    if (queries !== undefined) {
      await extensions.migrateProjectQueries();
      await extensions.enableProjectGenerationReads();
    }
    const current = () => {
      if (requests === undefined)
        throw new Error("installed_plugin_request_authority_unavailable");
      return requests;
    };
    const profiles: PluginInstallationHostProfilePort = Object.freeze({
      resolve: async (
        input: Parameters<PluginInstallationHostProfilePort["resolve"]>[0],
      ) => {
        const actor = pluginSecurityActor(input);
        if (!same(actor, current().currentActor())) denied();
        const scope = parsePluginProfileScope(
          await http.post(
            ui.profileAuthority,
            { actor },
            current().currentSignal(),
          ),
        );
        if (
          scope.tenantId !== actor.tenantId ||
          scope.spaceId !== actor.spaceId
        )
          denied();
        return scope;
      },
    });
    const authorizePackage = async (
      {
        actor,
        scope,
        candidate,
        purpose,
      }: Readonly<{
        actor: ActorContext;
        scope: PluginProfileScope;
        candidate: PluginActivationCandidate;
        purpose: "read" | "submit";
      }>,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (!same(pluginSecurityActor(actor), current().currentActor())) denied();
      await current().assertCurrent();
      const response = pluginSecurityRecord(
        await http.post(
          configuration.packageAuthority,
          {
            schemaVersion: "crewon.plugin-execution-package.v1",
            identity: {
              pluginId: candidate.descriptor.pluginId,
              publisherId: candidate.descriptor.publisherId,
              version: candidate.descriptor.version,
              packageDigest: candidate.packageDigest,
            },
            scope,
            purpose,
          },
          AbortSignal.any([signal, current().currentSignal()]),
        ),
        ["outcome"],
      );
      await current().assertCurrent();
      if (response.outcome !== "allow" && response.outcome !== "deny") denied();
      return response.outcome;
    };
    metadata = new InstalledPluginConfigurationMetadata({
      installRoot: configuration.installRoot,
      installations: ledger,
      maximumPackages: configuration.maximumPackages,
      authorizeRead: (input, signal) =>
        authorizePackage({ ...input, purpose: "read" }, signal),
    });
    requests = new InstalledPluginRequestOwner({
      identity: dependencies.identity,
      profiles,
      peer,
      metadata,
    });
    const authorizeBusiness = dependencies.authorization.authorize.bind(
      dependencies.authorization,
    );
    const businessAuthorization: AuthorizationPort = Object.freeze({
      authorize: async (
        input: Parameters<AuthorizationPort["authorize"]>[0],
      ) => {
        if (!same(pluginSecurityActor(input.actor), current().currentActor()))
          denied();
        await current().assertCurrent();
        const decision = await authorizeBusiness(input);
        await current().assertCurrent();
        return decision;
      },
    });
    const authorization: PluginUiAuthorizationPort = Object.freeze({
      authorize: async (
        input: Parameters<PluginUiAuthorizationPort["authorize"]>[0],
      ) => {
        const request = pluginSecurityUiRequest(input);
        if (
          !same(request.actor, current().currentActor()) ||
          request.actor.tenantId !== request.resource.tenantId ||
          request.actor.spaceId !== request.resource.spaceId
        )
          denied();
        await current().assertCurrent();
        const response = await http.post(
          ui.policyAuthority,
          { ...request, action: `pluginUi:${request.action}` },
          current().currentSignal(),
        );
        await current().assertCurrent();
        return pluginSecurityUiDecision(response);
      },
    });
    const quotes = new InstalledPluginCreditQuoteAuthority({
      endpoint: configuration.quoteAuthority,
      http,
      digester: dependencies.digester,
      currentSignal: () => current().currentSignal(),
      assertCurrent: () => current().assertCurrent(),
    });
    const reads = bindInstalledPluginRequestOwner(
      new ExtensionReadApplicationService({
        runs: dependencies.store,
        agentVersions: dependencies.store,
        extensions,
        operations: dependencies.store.externalOperationStore(),
        catalog: requests.catalog,
        host: requests.host,
        authorization: businessAuthorization,
        digester: dependencies.digester,
      }),
      requests,
      { preparation: "configuration" },
    );
    const projectGenerationReads =
      queries === undefined
        ? undefined
        : new ProjectGenerationReadApplicationService({
            projects: dependencies.creativeProjects!.service,
            tasks: reads,
            extensions,
            digester: dependencies.digester,
          });
    const tasks = new ExtensionTaskApplicationService({
      store: dependencies.store,
      extensions,
      operations: dependencies.store.externalOperationStore(),
      catalog: requests.catalog,
      host: requests.host,
      pluginQueryHost: requests.pluginQueryHost,
      authorization: businessAuthorization,
      clock: dependencies.clock,
      ids: dependencies.ids,
      digester: dependencies.digester,
      creditQuotes: quotes,
      ...(projectGenerationReads === undefined
        ? {}
        : { projectGenerationReads }),
      ...(generations === undefined && queries === undefined
        ? {}
        : {
            creativeProjects: {
              store: (generations ?? queries)!.store,
              authorization: (generations ?? queries)!.authorization,
            },
          }),
    });
    const configurationService = bindInstalledPluginRequestOwner(
      new ExtensionConfigurationApplicationService({
        store: extensions,
        catalog: requests.catalog,
        host: requests.host,
        authorization: businessAuthorization,
        clock: dependencies.clock,
        digester: dependencies.digester,
      }),
      requests,
      { preparation: "configuration" },
    );
    bindInstalledPluginRequestOwner(tasks, requests);
    const committedTasks = new PluginUiCommittedTaskAuthority({
      extensions,
      runs: dependencies.store,
      digester: dependencies.digester,
      ...(queries === undefined
        ? {}
        : {
            projectQueries: {
              publications: queries.publications,
              projects: queries.store,
              operations: dependencies.store.externalOperationStore(),
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
    owner = new InstalledPluginTaskActionOwner({
      installRoot: configuration.installRoot,
      installations: ledger,
      tasks,
      committedTasks,
      profiles,
      authorization,
      resolveActor: (identity, signal) =>
        current().resolveActor(identity, signal),
      authorizePackage,
      clock: dependencies.clock,
      ids: { nextId: () => randomBytes(32).toString("base64url") },
      maximumPackages: configuration.maximumPackages,
    });
    if (generations !== undefined)
      projectGenerations = new InstalledPluginProjectGenerationOwner(
        {
          installRoot: configuration.installRoot,
          publications: generations.publications,
          installations: ledger,
          projects: generations.store,
          tasks,
          taskOwner: owner,
          committedTasks,
          profiles,
          authorization,
          resolveActor: (identity, signal) =>
            current().resolveActor(identity, signal),
          authorizePackage,
          requestSignal: () => current().currentSignal(),
          clock: dependencies.clock,
          ids: { nextId: () => randomBytes(32).toString("base64url") },
          digester: dependencies.digester,
          maximumInvocations: configuration.maximumPackages,
        },
        dependencies.metadataHostUiServices,
      );
    if (queries !== undefined)
      projectQueries = new InstalledPluginProjectQueryOwner(
        {
          installRoot: configuration.installRoot,
          publications: queries.publications,
          installations: ledger,
          generationReads: projectGenerationReads!,
          tasks,
          taskOwner: owner,
          committedTasks,
          profiles,
          authorization,
          resolveActor: (identity, signal) =>
            current().resolveActor(identity, signal),
          authorizePackage,
          requestSignal: () => current().currentSignal(),
          clock: dependencies.clock,
          ids: { nextId: () => randomBytes(32).toString("base64url") },
          digester: dependencies.digester,
          maximumInvocations: configuration.maximumPackages,
        },
        projectGenerations?.hostUiServices ??
          dependencies.metadataHostUiServices,
      );
    const actualOwner = owner,
      actualRequests = requests,
      actualMetadata = metadata;
    const actualGenerations = projectGenerations;
    const actualQueries = projectQueries;
    let closing: Promise<void> | null = null;
    return Object.freeze({
      owner: actualOwner,
      ...(actualGenerations === undefined
        ? {}
        : { projectGenerations: actualGenerations }),
      ...(actualQueries === undefined ? {} : { projectQueries: actualQueries }),
      ...(projectGenerationReads === undefined
        ? {}
        : { projectGenerationReads }),
      requests: actualRequests,
      extensions: configurationService,
      extensionTasks: tasks,
      extensionReads: reads,
      close: () =>
        (closing ??= closeAll([
          // Withdraw request authority synchronously before joining the actual task/Node owner.
          () => actualRequests.close(),
          () => actualQueries?.close(),
          () => actualGenerations?.close(),
          () => actualOwner.close(),
          () => actualMetadata.close(),
          () => peer.close(),
          () => http.close(),
        ])),
    });
  } catch (error) {
    try {
      await closeAll([
        () => requests?.close(),
        () => projectQueries?.close(),
        () => projectGenerations?.close(),
        () => owner?.close(),
        () => metadata?.close(),
        () => peer.close(),
        () => http.close(),
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

async function closeAll(
  actions: readonly (() => Promise<void> | undefined)[],
): Promise<void> {
  const failures: unknown[] = [];
  // Start every withdrawal immediately; no blocked request may prevent its HTTP abort/physical join.
  const results = await Promise.allSettled(
    actions.map((action) => {
      try {
        return Promise.resolve(action());
      } catch (error) {
        return Promise.reject(error);
      }
    }),
  );
  for (const result of results)
    if (result.status === "rejected") failures.push(result.reason);
  if (failures.length)
    throw new AggregateError(failures, "installed_plugin_task_cleanup_failed");
}
function same(a: unknown, b: unknown) {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "installed_plugin_task_authority_denied",
  );
}
