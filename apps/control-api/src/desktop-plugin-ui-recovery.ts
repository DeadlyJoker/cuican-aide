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

const selectionAction =
  "crewon.project-generation-selections.v1.selectConceptImage";
type Publication = Readonly<{ pluginId: string; packageDigest: string }>;
type Approval = Readonly<{
  configuration: PluginUiRecoveryConfiguration | undefined;
  publications: readonly Publication[];
  selectionUi: CreativeProjectPluginUiConfig | undefined;
}>;

/** Pure before registry or database startup. Recovery cannot lend execution authority. */
export function assertDesktopPluginUiRecoveryConfiguration(
  input: Approval,
): PluginUiRecoveryConfiguration | undefined {
  if (input.configuration === undefined) return undefined;
  try {
    const configuration = capturePluginUiRecoveryConfiguration(
      input.configuration,
    )!;
    const selectionUi = captureCreativeProjectPluginUiConfig(input.selectionUi);
    for (const publication of configuration.publications) {
      if (
        !input.publications.some(
          (approved) =>
            approved.pluginId === publication.pluginId &&
            approved.packageDigest === publication.packageDigest,
        ) ||
        !selectionUi?.publications.some(
          (approved) =>
            approved.pluginId === publication.pluginId &&
            approved.packageDigest === publication.packageDigest &&
            approved.contributionId === publication.contributionId,
        ) ||
        publication.actions.some((action) => action !== selectionAction)
      )
        invalid();
    }
    return configuration;
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
      clock: ApplicationClock;
      digester: ContentDigester;
      fallback?: PluginUiHostServiceAvailabilityPort;
      onDiagnostic(error: unknown): void;
    }>,
): Promise<DesktopPluginUiRecoveryRuntime | undefined> {
  const configuration = assertDesktopPluginUiRecoveryConfiguration(input);
  // Disabled recovery does not even acquire the schema adapter.
  if (configuration === undefined) return undefined;
  if (
    !(input.store instanceof SqliteRunStore) ||
    !(input.requests instanceof InstalledPluginRequestOwner) ||
    !isProjectGenerationSelectionPluginUiOwner(input.selection)
  )
    invalid();
  const store = input.store.pluginUiIntentJournalStore({
    verifier: createPluginUiIntentPayloadVerifier(input.digester),
  });
  await store.migratePluginUiIntentJournal();
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const assertActive = () => {
    if (lifetime.signal.aborted) unavailable();
    input.requests.currentSignal().throwIfAborted();
  };
  const assertCurrent = async (context: PluginUiActionContext) => {
    assertActive();
    await input.requests.assertCurrent();
    assertActive();
    if (
      extensionCanonicalJson(input.requests.currentActor()) !==
        extensionCanonicalJson(context.actor) ||
      extensionCanonicalJson(input.requests.currentScope()) !==
        extensionCanonicalJson(context.scope)
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
  const selectionAvailability = capturePluginUiHostServiceAvailability(
    input.selection.hostUiServices(),
  );
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
      const required = candidate.descriptor.requires.find(
        (item) =>
          item.service === "crewon.project-generation-selections" &&
          item.apiVersion === "1",
      );
      return (
        required !== undefined &&
        selectionAvailability?.isAvailable({
          scope,
          candidate,
          requirement: required,
        }) === true &&
        configuration.publications.some(
          (publication) =>
            publication.pluginId === candidate.descriptor.pluginId &&
            publication.packageDigest === candidate.packageDigest &&
            candidate.descriptor.contributions.some(
              (contribution) =>
                contribution.id === publication.contributionId &&
                contribution.kind === "module" &&
                contribution.slot === "main.content",
            ),
        )
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
      // Observe the physical promise, including a COMMIT confirmation after withdrawal.
      const physical = input.requests.run(
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
