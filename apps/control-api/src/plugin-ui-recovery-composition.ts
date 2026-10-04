import { AsyncLocalStorage } from "node:async_hooks";
import {
  ApplicationError,
  PluginUiRecoveryApplicationService,
  capturePluginUiRecoveryPublications,
  createPluginUiIntentPayloadVerifier,
  type ActorContext,
  type ApplicationClock,
  type ContentDigester,
  type PluginUiActionContext,
  type PluginUiIntentJournalStore,
  type PluginUiIntentPayloadVerifier,
  type PluginUiRecoveryPublication,
  type PluginUiRecoveryPublicationMode,
} from "@crewon/application";
import {
  CREWON_PLUGIN_UI_RECOVERY_SERVICE,
  CREWON_PLUGIN_UI_RECOVERY_API_VERSION,
  PLUGIN_UI_RECOVERY_VERSION,
} from "@crewon/contracts";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  appendPluginUiRecoveryServiceAvailability,
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  ProductionControlApiIdentity,
  AbortSecurityDeadline,
} from "./production-security-adapters.ts";
import { AuthorityPluginHostProfile } from "./plugin-security-adapters.ts";
import { HttpPluginProfileAuthorityPort } from "./plugin-security-http-ports.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import type { ProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import type { ProductionPostgresControlApiConfig } from "./production-composition.ts";
import { composeProductionProjectHistoryPlugins } from "./production-project-history-plugin-composition.ts";
import {
  isInstalledPluginProjectGenerationOwner,
  type InstalledPluginProjectGenerationOwner,
} from "./installed-plugin-project-generation-owner.ts";
import {
  isInstalledPluginProjectQueryOwner,
  type InstalledPluginProjectQueryOwner,
} from "./installed-plugin-project-query-owner.ts";
import {
  isProjectGenerationSelectionPluginUiOwner,
  type ProjectGenerationSelectionPluginUiOwner,
} from "./project-generation-selection-plugin-ui-owner.ts";
import { closeResources } from "./production-control-resource-cleanup.ts";

export async function composeProductionPluginUiRecoveryHistory(
  input: Parameters<typeof composeProductionProjectHistoryPlugins>[0] &
    Readonly<{ config: ProductionPostgresControlApiConfig }>,
) {
  const history = await composeProductionProjectHistoryPlugins(input);
  try {
    const recovery = await prepareProductionPluginUiRecovery({
      configuration: input.config.uiRecovery,
      owner: input.store,
      identity: input.identity,
      ui: input.ui,
      clock: input.clock,
      digester: input.digester,
      owners: {
        generation: input.taskRuntime?.projectGenerations,
        query: input.taskRuntime?.projectQueries,
        selection: history.selectionRuntime?.owner,
      },
      ...(history.hostUiServices === undefined
        ? {}
        : { fallback: history.hostUiServices }),
      onDiagnostic: () => {
        process.emitWarning("plugin_ui_recovery_persistence_failed");
      },
    });
    return {
      ...history,
      recovery,
      hostUiServices: recovery?.hostUiServices ?? history.hostUiServices,
    };
  } catch (error) {
    try {
      await closeResources([
        () => history.selectionRuntime?.close(),
        () => history.readRuntime?.close(),
        () => history.configurationRuntime?.close(),
      ]);
    } catch (failure) {
      throw new AggregateError(
        [error, failure],
        "production_plugin_ui_recovery_startup_cleanup_failed",
      );
    }
    throw error;
  }
}

export type PluginUiRecoveryConfiguration = Readonly<{
  version: typeof PLUGIN_UI_RECOVERY_VERSION;
  publications: readonly PluginUiRecoveryPublication[];
}>;
export type PluginUiRecoveryStoreOwner = Readonly<{
  pluginUiIntentJournalStore(input: {
    verifier: PluginUiIntentPayloadVerifier;
  }): PluginUiIntentJournalStore & {
    migratePluginUiIntentJournal(): Promise<void>;
  };
}>;
export type ProductionPluginUiRecoveryRuntime = Readonly<{
  service: PluginUiRecoveryApplicationService;
  hostUiServices: PluginUiHostServiceAvailabilityPort;
  run<T>(
    request: ControlApiRequestContext,
    actor: ActorContext,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}>;

export function capturePluginUiRecoveryConfiguration(
  input: unknown,
  options: Readonly<{ publicationMode: PluginUiRecoveryPublicationMode }> = {
    publicationMode: "business-actions",
  },
): PluginUiRecoveryConfiguration | undefined {
  if (input === undefined) return undefined;
  const value = pluginSecurityRecord(input, ["version", "publications"]);
  if (value.version !== PLUGIN_UI_RECOVERY_VERSION) invalid();
  return Object.freeze({
    version: PLUGIN_UI_RECOVERY_VERSION,
    publications: capturePluginUiRecoveryPublications(
      value.publications,
      options,
    ),
  });
}

/** Pure before database startup. This allowlist only references independently approved business owners. */
export function assertProductionPluginUiRecoveryConfiguration(
  config: ProductionPostgresControlApiConfig,
  recovery: PluginUiRecoveryConfiguration | undefined,
): void {
  if (recovery === undefined) return;
  const ui = config.pluginUi?.configuration;
  if (
    ui === undefined ||
    !(config.identity instanceof ProductionControlApiIdentity)
  )
    invalid();
  const projects = config.creativeProjects;
  for (const publication of recovery.publications) {
    if (
      !ui.publications.some(
        (approved) =>
          approved.pluginId === publication.pluginId &&
          approved.packageDigest === publication.packageDigest,
      )
    )
      invalid();
    for (const action of publication.actions) {
      const sources =
        action === "crewon.project-generations.v1.generateConcept"
          ? projects?.pluginGenerations?.publications.map((item) => item.source)
          : action ===
              "crewon.project-generation-queries.v1.queryConceptGeneration"
            ? projects?.pluginQueries?.publications.map((item) => item.source)
            : projects?.selectionUi?.publications;
      if (
        !sources?.some(
          (source) =>
            source.pluginId === publication.pluginId &&
            source.packageDigest === publication.packageDigest &&
            source.contributionId === publication.contributionId,
        )
      )
        invalid();
    }
  }
}

/** Disabled recovery never acquires an adapter or reads/migrates its schema. */
export async function prepareProductionPluginUiRecovery(
  input: Readonly<{
    configuration: PluginUiRecoveryConfiguration | undefined;
    owner: PluginUiRecoveryStoreOwner;
    identity: ProductionControlApiIdentity;
    ui: ProductionPluginUiConfiguration | undefined;
    clock: ApplicationClock;
    digester: ContentDigester;
    owners: Readonly<{
      generation: InstalledPluginProjectGenerationOwner | undefined;
      query: InstalledPluginProjectQueryOwner | undefined;
      selection: ProjectGenerationSelectionPluginUiOwner | undefined;
    }>;
    fallback?: PluginUiHostServiceAvailabilityPort;
    onDiagnostic(error: unknown): void;
  }>,
): Promise<ProductionPluginUiRecoveryRuntime | undefined> {
  if (input.configuration === undefined) return undefined;
  const configuration = capturePluginUiRecoveryConfiguration(
    input.configuration,
  )!;
  if (
    !(input.identity instanceof ProductionControlApiIdentity) ||
    input.ui === undefined
  )
    invalid();
  for (const publication of configuration.publications)
    for (const action of publication.actions) {
      const ready =
        action === "crewon.project-generations.v1.generateConcept"
          ? isInstalledPluginProjectGenerationOwner(input.owners.generation)
          : action ===
              "crewon.project-generation-queries.v1.queryConceptGeneration"
            ? isInstalledPluginProjectQueryOwner(input.owners.query)
            : isProjectGenerationSelectionPluginUiOwner(input.owners.selection);
      if (!ready) invalid();
    }
  const store = input.owner.pluginUiIntentJournalStore({
    verifier: createPluginUiIntentPayloadVerifier(input.digester),
  });
  await store.migratePluginUiIntentJournal();
  const scope = new AsyncLocalStorage<
    Readonly<{
      request: ControlApiRequestContext;
      actor: ActorContext;
      signal: AbortSignal;
    }>
  >();
  const lifetime = new AbortController();
  const profiles = new AuthorityPluginHostProfile({
    authority: new HttpPluginProfileAuthorityPort(input.ui.profileAuthority),
    timeoutMs: input.ui.timeoutMs,
    deadline: new AbortSecurityDeadline(),
  });
  const resolve = input.identity.resolveCurrentActor.bind(input.identity);
  const assertActive = () => {
    const current = scope.getStore();
    if (!current || lifetime.signal.aborted || current.signal.aborted)
      unavailable();
  };
  const assertCurrent = async (context: PluginUiActionContext) => {
    const current = scope.getStore();
    if (!current || lifetime.signal.aborted || current.signal.aborted)
      unavailable();
    const actor = await resolve(current.request, current.signal);
    const profile = await profiles.resolve(actor);
    if (
      scope.getStore() !== current ||
      current.signal.aborted ||
      lifetime.signal.aborted ||
      extensionCanonicalJson(actor) !== extensionCanonicalJson(current.actor) ||
      extensionCanonicalJson(actor) !== extensionCanonicalJson(context.actor) ||
      extensionCanonicalJson(profile) !== extensionCanonicalJson(context.scope)
    )
      unavailable();
  };
  const service = new PluginUiRecoveryApplicationService({
    store,
    publications: configuration.publications,
    clock: input.clock,
    digester: input.digester,
    onDiagnostic: input.onDiagnostic,
    authorization: { assertCurrent, assertActive },
  });
  const ownerAvailability = {
    generation: capturePluginUiHostServiceAvailability(
      input.owners.generation?.hostUiServices,
    ),
    query: capturePluginUiHostServiceAvailability(
      input.owners.query?.hostUiServices,
    ),
    selection: capturePluginUiHostServiceAvailability(
      input.owners.selection?.hostUiServices(),
    ),
  };
  const recovery: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: ({ scope, candidate, requirement }) => {
      if (
        lifetime.signal.aborted ||
        requirement.service !== CREWON_PLUGIN_UI_RECOVERY_SERVICE ||
        requirement.apiVersion !== CREWON_PLUGIN_UI_RECOVERY_API_VERSION ||
        store.uiIntentJournalVersion !== "crewon.plugin-ui-intent-journal.v1" ||
        store.uiIntentJournalReadVersion !==
          "crewon.plugin-ui-intent-journal-read.v1" ||
        store.uiIntentJournalRealmId === undefined
      )
        return false;
      return configuration.publications.some(
        (publication) =>
          publication.pluginId === candidate.descriptor.pluginId &&
          publication.packageDigest === candidate.packageDigest &&
          candidate.descriptor.contributions.some(
            (contribution) =>
              contribution.id === publication.contributionId &&
              contribution.kind === "module" &&
              contribution.slot === "main.content",
          ) &&
          publication.actions.every((action) => {
            const lane =
              action === "crewon.project-generations.v1.generateConcept"
                ? "generation"
                : action ===
                    "crewon.project-generation-queries.v1.queryConceptGeneration"
                  ? "query"
                  : "selection";
            const service =
              lane === "generation"
                ? "crewon.project-generations"
                : lane === "query"
                  ? "crewon.project-generation-queries"
                  : "crewon.project-generation-selections";
            const required = candidate.descriptor.requires.find(
              (item) => item.service === service && item.apiVersion === "1",
            );
            return (
              required !== undefined &&
              ownerAvailability[lane]?.isAvailable({
                scope,
                candidate,
                requirement: required,
              }) === true
            );
          }),
      );
    },
  });
  return Object.freeze({
    service,
    hostUiServices: appendPluginUiRecoveryServiceAvailability({
      recovery,
      ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
    }),
    run: <T>(
      request: ControlApiRequestContext,
      actor: ActorContext,
      signal: AbortSignal | undefined,
      work: () => Promise<T>,
    ) => {
      if (lifetime.signal.aborted) unavailable();
      // No identity/profile/SQL IO until a declared recovery capability enters the actual service.
      return scope.run(
        Object.freeze({
          request,
          actor: pluginSecurityActor(actor),
          signal:
            signal === undefined
              ? lifetime.signal
              : AbortSignal.any([signal, lifetime.signal]),
        }),
        work,
      );
    },
    close: async () => {
      lifetime.abort();
    },
  });
}
function invalid(): never {
  throw new Error("production_plugin_ui_recovery_configuration_invalid");
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_ui_recovery_request_unavailable",
  );
}
