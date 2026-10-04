import {
  ApplicationError,
  PluginUiRecoveryApplicationService,
  createPluginUiIntentPayloadVerifier,
  type ActorContext,
  type ApplicationClock,
  type ContentDigester,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  CREWON_PLUGIN_UI_RECOVERY_SERVICE,
  CREWON_PLUGIN_UI_RECOVERY_API_VERSION,
} from "@crewon/contracts";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  appendPluginUiRecoveryServiceAvailability,
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import {
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import {
  capturePluginUiRecoveryConfiguration,
  type PluginUiRecoveryConfiguration,
} from "./plugin-ui-recovery-composition.ts";
import {
  isProjectGenerationSelectionPluginUiOwner,
  type ProjectGenerationSelectionPluginUiOwner,
} from "./project-generation-selection-plugin-ui-owner.ts";
import {
  captureProjectGenerationPluginConfiguration,
  type ProjectGenerationPluginConfiguration,
} from "./project-generation-plugin-configuration.ts";
import {
  captureProjectQueryPluginConfiguration,
  type ProjectQueryPluginConfiguration,
} from "./project-query-plugin-configuration.ts";
import { isInstalledPluginProjectGenerationOwner } from "./installed-plugin-project-generation-owner.ts";
import { isInstalledPluginProjectQueryOwner } from "./installed-plugin-project-query-owner.ts";
import {
  assertInstalledPluginTaskRuntimeCoreBinding,
  type InstalledPluginTaskRuntimeCore,
} from "./installed-plugin-task-runtime-core.ts";

const generationAction = "crewon.project-generations.v1.generateConcept";
const queryAction =
  "crewon.project-generation-queries.v1.queryConceptGeneration";
const selectionAction =
  "crewon.project-generation-selections.v1.selectConceptImage";
type Publication = Readonly<{ pluginId: string; packageDigest: string }>;
type Approval = Readonly<{
  configuration: PluginUiRecoveryConfiguration | undefined;
  publications: readonly Publication[];
  metadataUi?: CreativeProjectPluginUiConfig;
  selectionUi: CreativeProjectPluginUiConfig | undefined;
  pluginGenerations?: ProjectGenerationPluginConfiguration;
  pluginQueries?: ProjectQueryPluginConfiguration;
}>;

/** Pure before registry or database startup. Recovery cannot lend execution authority. */
export function assertDesktopPluginUiRecoveryConfiguration(
  input: Approval,
): PluginUiRecoveryConfiguration | undefined {
  return captureApproval(input)?.configuration;
}

function captureApproval(input: Approval) {
  if (input.configuration === undefined) return undefined;
  try {
    const configuration = capturePluginUiRecoveryConfiguration(
      input.configuration,
      { publicationMode: "metadata-read" },
    )!;
    const metadataUi = captureCreativeProjectPluginUiConfig(input.metadataUi);
    const selectionUi = captureCreativeProjectPluginUiConfig(input.selectionUi);
    const generations = captureProjectGenerationPluginConfiguration(
      input.pluginGenerations,
    );
    const queries = captureProjectQueryPluginConfiguration(input.pluginQueries);
    for (const publication of configuration.publications) {
      if (
        !input.publications.some(
          (approved) =>
            approved.pluginId === publication.pluginId &&
            approved.packageDigest === publication.packageDigest,
        ) ||
        (publication.actions.length === 0 &&
          !metadataUi?.publications.some(
            (approved) =>
              approved.pluginId === publication.pluginId &&
              approved.packageDigest === publication.packageDigest &&
              approved.contributionId === publication.contributionId,
          )) ||
        publication.actions.some((action) => {
          const sources =
            action === generationAction
              ? generations?.publications.map(({ source }) => source)
              : action === queryAction
                ? queries?.publications.map(({ source }) => source)
                : action === selectionAction
                  ? selectionUi?.publications
                  : undefined;
          return !sources?.some(
            (approved) =>
              approved.pluginId === publication.pluginId &&
              approved.packageDigest === publication.packageDigest &&
              approved.contributionId === publication.contributionId,
          );
        })
      )
        invalid();
    }
    return { configuration, generations, queries, selectionUi };
  } catch {
    invalid();
  }
}

export type DesktopPluginUiRecoveryRuntime = Readonly<{
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

/** Borrows the actual Native request owner and SQLite parent; neither is closed here. */
export async function prepareDesktopPluginUiRecovery(
  input: Approval &
    Readonly<{
      store: SqliteRunStore;
      requests: InstalledPluginRequestOwner;
      selection: ProjectGenerationSelectionPluginUiOwner | undefined;
      tasks?: InstalledPluginTaskRuntimeCore;
      clock: ApplicationClock;
      digester: ContentDigester;
      fallback?: PluginUiHostServiceAvailabilityPort;
      onDiagnostic(error: unknown): void;
    }>,
): Promise<DesktopPluginUiRecoveryRuntime | undefined> {
  const configuration = captureApproval(input)?.configuration;
  // Disabled recovery does not even acquire the schema adapter.
  if (configuration === undefined) return undefined;
  if (
    !(input.store instanceof SqliteRunStore) ||
    !(input.requests instanceof InstalledPluginRequestOwner)
  )
    invalid();
  const parent = input.store;
  const requests = input.requests;
  const tasks = input.tasks;
  const selection = input.selection;
  const clock = Object.freeze({ now: input.clock.now.bind(input.clock) });
  const digester = Object.freeze({
    sha256: input.digester.sha256.bind(input.digester),
  });
  const onDiagnostic = input.onDiagnostic.bind(input);
  const actions = new Set(
    configuration.publications.flatMap(({ actions }) => actions),
  );
  const execution = actions.has(generationAction) || actions.has(queryAction);
  const assertOwners = () => {
    try {
      if (execution)
        assertInstalledPluginTaskRuntimeCoreBinding(tasks, {
          store: parent,
          requests,
        });
      if (
        actions.has(generationAction) &&
        (tasks === undefined ||
          !isInstalledPluginProjectGenerationOwner(tasks.projectGenerations) ||
          tasks.projectGenerations.taskOwner !== tasks.owner)
      )
        invalid();
      if (
        actions.has(queryAction) &&
        (tasks === undefined ||
          !isInstalledPluginProjectQueryOwner(tasks.projectQueries) ||
          tasks.projectQueries.taskOwner !== tasks.owner)
      )
        invalid();
      if (
        actions.has(selectionAction) &&
        !isProjectGenerationSelectionPluginUiOwner(selection)
      )
        invalid();
    } catch {
      invalid();
    }
  };
  // No journal adapter is acquired until each configured lane has its genuine current owner.
  assertOwners();
  const ownerAvailability = {
    generation: capturePluginUiHostServiceAvailability(
      actions.has(generationAction)
        ? tasks?.projectGenerations?.hostUiServices
        : undefined,
    ),
    query: capturePluginUiHostServiceAvailability(
      actions.has(queryAction)
        ? tasks?.projectQueries?.hostUiServices
        : undefined,
    ),
    selection: capturePluginUiHostServiceAvailability(
      actions.has(selectionAction) ? selection?.hostUiServices() : undefined,
    ),
  };
  const store = parent.pluginUiIntentJournalStore({
    verifier: createPluginUiIntentPayloadVerifier(digester),
  });
  await store.migratePluginUiIntentJournal();
  assertOwners();
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const assertActive = () => {
    if (lifetime.signal.aborted) unavailable();
    if (execution) {
      try {
        assertOwners();
      } catch {
        unavailable();
      }
    }
    requests.currentSignal().throwIfAborted();
  };
  const assertCurrent = async (context: PluginUiActionContext) => {
    assertActive();
    await requests.assertCurrent();
    assertActive();
    if (
      extensionCanonicalJson(requests.currentActor()) !==
        extensionCanonicalJson(context.actor) ||
      extensionCanonicalJson(requests.currentScope()) !==
        extensionCanonicalJson(context.scope)
    )
      unavailable();
  };
  const service = new PluginUiRecoveryApplicationService({
    store,
    publicationMode: "metadata-read",
    publications: configuration.publications,
    clock,
    digester,
    onDiagnostic,
    authorization: { assertCurrent, assertActive },
  });
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
      if (execution) {
        try {
          assertOwners();
        } catch {
          return false;
        }
      }
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
              action === generationAction
                ? "generation"
                : action === queryAction
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
    ): Promise<T> => {
      if (lifetime.signal.aborted) unavailable();
      if (execution) {
        try {
          assertOwners();
        } catch {
          unavailable();
        }
      }
      // Observe the physical promise, including a COMMIT confirmation after withdrawal.
      const physical = requests.run(
        {
          request,
          actor,
          preparation: "configuration",
          signal:
            signal === undefined
              ? lifetime.signal
              : AbortSignal.any([signal, lifetime.signal]),
        },
        work,
      );
      pending.add(physical);
      void physical.then(
        () => pending.delete(physical),
        () => pending.delete(physical),
      );
      // Ordinary results have Application current fences. Only opaque COMMIT can return late.
      return physical;
    },
    close: () => {
      lifetime.abort();
      return (closing ??= Promise.allSettled([...pending]).then(() => {}));
    },
  });
}

function invalid(): never {
  throw new Error("desktop_plugin_ui_recovery_configuration_invalid");
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_ui_recovery_request_unavailable",
  );
}
