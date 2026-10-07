import {
  PROJECT_MEDIA_GENERATE_UI_ACTION,
  PROJECT_MEDIA_RECOVERY_UI_ACTION,
} from "@crewon/contracts/project-media-generations";
import { parseProjectMediaGenerationRecoveryResponse } from "@crewon/contracts/project-media-generation-recovery";
import {
  PLUGIN_UI_RECOVERY_VERSION,
  parsePluginUiRecoveryHint,
  parsePluginUiRecoveryHintsResponse,
  parsePluginUiRecoveryRequest,
  parseStagePluginUiRecoveryResponse,
  type PluginUiRecoveryHint,
  type PluginUiRecoveryRequest,
} from "@crewon/contracts";
import {
  extensionCanonicalJson,
  parsePluginUiIntentJournalAccount,
  parsePluginUiIntentRecord,
  pluginUiIntentIdentity,
  pluginUiIntentStablePin,
  PLUGIN_UI_INTENT_SELECTION_CONFLICTS,
  pluginInstallationNamespaceId,
  pluginInstallationOpaqueId,
  pluginInstallationDigest,
  type PluginTaskAdmissionPin,
  type PluginUiIntentJournalAccount,
  type PluginUiIntentRecord,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";
import type {
  ApplicationClock,
  ContentDigester,
} from "./application-runtime-ports.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type {
  PluginUiRecoveryDispatch,
  PluginUiRecoveryPort,
} from "./plugin-ui-recovery-ports.ts";
import type { PluginUiIntentJournalStore } from "./plugin-ui-intent-journal-store.ts";
import { pluginUiDeclaresRecovery } from "./plugin-ui-recovery-invocation.ts";
import { pluginUiRecoveryReceipt } from "./plugin-ui-recovery-codec.ts";

export type PluginUiRecoveryPublication = Readonly<{
  pluginId: string;
  packageDigest: string;
  contributionId: string;
  actions: readonly PluginUiRecoveryRequest["action"][];
}>;
export type PluginUiRecoveryPublicationMode =
  | "business-actions"
  | "metadata-read";
export type PluginUiRecoveryApplicationDependencies = Readonly<{
  store: PluginUiIntentJournalStore;
  publications: readonly PluginUiRecoveryPublication[];
  clock: ApplicationClock;
  digester: ContentDigester;
  onDiagnostic(error: unknown): void;
  /** Native metadata reads may bind an exact module without admitting any business action. */
  publicationMode?: PluginUiRecoveryPublicationMode;
  /** Actual HTTP identity/profile fence; it performs no Store reads. */
  authorization?: Readonly<{
    assertCurrent(context: PluginUiActionContext): Promise<void>;
    assertActive(context: PluginUiActionContext): void;
  }>;
}>;

const services = new WeakSet<object>();
export function isPluginUiRecoveryApplicationService(
  input: unknown,
): input is PluginUiRecoveryApplicationService {
  return input !== null && typeof input === "object" && services.has(input);
}

/** Durable original intent only. Actual business owners retain all execution and receipt authority. */
export class PluginUiRecoveryApplicationService
  implements PluginUiRecoveryPort
{
  readonly #store: PluginUiIntentJournalStore;
  readonly #publications: readonly PluginUiRecoveryPublication[];
  readonly #clock: ApplicationClock;
  readonly #digester: ContentDigester;
  readonly #realm: string;
  readonly #diagnostic: (error: unknown) => void;
  readonly #authorize:
    | ((context: PluginUiActionContext) => Promise<void>)
    | undefined;
  readonly #assertExternalActive:
    | ((context: PluginUiActionContext) => void)
    | undefined;

  constructor(dependencies: PluginUiRecoveryApplicationDependencies) {
    uiRecord(dependencies, [
      "store",
      "publications",
      "clock",
      "digester",
      "onDiagnostic",
      ...(Object.hasOwn(dependencies, "publicationMode")
        ? ["publicationMode"]
        : []),
      ...(Object.hasOwn(dependencies, "authorization")
        ? ["authorization"]
        : []),
    ]);
    const store = captureStore(dependencies.store);
    if (
      store.uiIntentJournalVersion !== "crewon.plugin-ui-intent-journal.v1" ||
      store.uiIntentJournalReadVersion !==
        "crewon.plugin-ui-intent-journal-read.v1" ||
      store.uiIntentJournalRealmId === undefined
    )
      unavailable();
    this.#realm = pluginInstallationOpaqueId(store.uiIntentJournalRealmId);
    this.#store = store;
    this.#publications = capturePluginUiRecoveryPublications(
      dependencies.publications,
      { publicationMode: dependencies.publicationMode ?? "business-actions" },
    );
    this.#clock = Object.freeze({ now: method(dependencies.clock, "now") });
    this.#digester = Object.freeze({
      sha256: method(dependencies.digester, "sha256"),
    });
    this.#diagnostic = method(dependencies, "onDiagnostic");
    this.#authorize =
      dependencies.authorization === undefined
        ? undefined
        : method(dependencies.authorization, "assertCurrent");
    this.#assertExternalActive =
      dependencies.authorization === undefined
        ? undefined
        : method(dependencies.authorization, "assertActive");
    services.add(this);
    Object.freeze(this);
  }

  async get(context: PluginUiActionContext) {
    const captured = this.#capture(context);
    if (
      captured.context.action !== "crewon.plugin-ui-recovery.v1.getRecovery" ||
      captured.context.input !== null
    )
      unavailable();
    await captured.authority.assertCurrent();
    const records = await this.#store.listUiIntentHints({
      account: captured.account,
    });
    await captured.authority.assertCurrent();
    if (!Array.isArray(records) || records.length > 32) invalid();
    const family = records
      .map((value) => this.#record(value, captured.account))
      .filter(
        (value) =>
          value.sourcePin.pluginId === captured.pin.pluginId &&
          value.sourcePin.contributionId === captured.pin.contributionId &&
          value.sourcePin.action !== PROJECT_MEDIA_GENERATE_UI_ACTION,
      );
    const intents: PluginUiRecoveryHint[] = [];
    for (const kind of ["generation", "query", "selection"] as const) {
      const lane = family
        .filter((value) => value.kind === kind)
        .sort((left, right) => right.sequence - left.sequence);
      const record =
        lane.find(
          (value) => value.phase === "prepared" || value.phase === "dispatched",
        ) ?? lane[0];
      if (record !== undefined) intents.push(this.#hint(record, captured.pin));
    }
    return parsePluginUiRecoveryHintsResponse({
      version: PLUGIN_UI_RECOVERY_VERSION,
      intents,
    });
  }

  async getMediaGenerationRecovery(context: PluginUiActionContext) {
    const captured = this.#capture(context);
    if (
      captured.context.action !== PROJECT_MEDIA_RECOVERY_UI_ACTION ||
      captured.context.input !== null
    )
      unavailable();
    this.#publication(captured.context, PROJECT_MEDIA_GENERATE_UI_ACTION);
    await captured.authority.assertCurrent();
    const records = await this.#store.listUiIntentHints({
      account: captured.account,
    });
    await captured.authority.assertCurrent();
    if (!Array.isArray(records) || records.length > 32) invalid();
    const family = records
      .map((value) => this.#record(value, captured.account))
      .filter(
        (value) =>
          value.sourcePin.pluginId === captured.pin.pluginId &&
          value.sourcePin.contributionId === captured.pin.contributionId &&
          value.sourcePin.action === PROJECT_MEDIA_GENERATE_UI_ACTION,
      )
      .sort((a, b) => b.sequence - a.sequence);
    const record =
      family.find(
        (value) => value.phase === "prepared" || value.phase === "dispatched",
      ) ?? family[0];
    return parseProjectMediaGenerationRecoveryResponse({
      intent: record ? this.#hint(record, captured.pin) : null,
    });
  }

  async stage(context: PluginUiActionContext) {
    const captured = this.#capture(context);
    const request = parsePluginUiRecoveryRequest({
      action: captured.context.action,
      input: captured.context.input,
    });
    this.#publication(captured.context, request.action);
    await captured.authority.assertCurrent();
    const result = await this.#store.stageUiIntent(
      {
        account: captured.account,
        sourcePin: captured.pin,
        requestJson: extensionCanonicalJson(request),
        at: this.#clock.now(),
      },
      { authority: captured.authority },
    );
    await captured.authority.assertCurrent();
    return parseStagePluginUiRecoveryResponse(
      {
        version: PLUGIN_UI_RECOVERY_VERSION,
        disposition: result.disposition,
        intent: this.#hint(
          this.#record(result.intent, captured.account),
          captured.pin,
        ),
      },
      request,
    );
  }

  async beginDispatch(
    context: PluginUiActionContext,
  ): Promise<PluginUiRecoveryDispatch> {
    const captured = this.#capture(context);
    const request = parsePluginUiRecoveryRequest({
      action: captured.context.action,
      input: captured.context.input,
    });
    this.#publication(captured.context, request.action);
    const requestJson = extensionCanonicalJson(request);
    await captured.authority.assertCurrent();
    const result = await this.#store.markUiIntentDispatched(
      {
        account: captured.account,
        intentId: pluginUiIntentIdentity(
          captured.account,
          captured.pin,
          request.input.idempotencyKey,
          this.#digester,
        ),
        sourcePin: captured.pin,
        requestJson,
        at: this.#clock.now(),
      },
      { authority: captured.authority },
    );
    const intent = this.#record(result.intent, captured.account);
    await captured.authority.assertCurrent();
    if (
      intent.requestJson !== requestJson ||
      pluginUiIntentStablePin(intent.sourcePin) !==
        pluginUiIntentStablePin(captured.pin)
    )
      invalid();
    let completed = false;
    return Object.freeze({
      confirmVerified: async (output) => {
        if (completed) invalid();
        completed = true;
        // The original opaque owner has already proved COMMIT. No live-lease/PDP fence follows it.
        try {
          const receipt = pluginUiRecoveryReceipt(request, output);
          await this.#store.confirmUiIntentAccepted({
            account: captured.account,
            intentId: intent.intentId,
            requestDigest: intent.requestDigest,
            receiptJson: extensionCanonicalJson(receipt),
            at: this.#clock.now(),
          });
        } catch (error) {
          this.#report(error);
        }
      },
      observeFailure: async (error) => {
        if (completed) invalid();
        completed = true;
        if (
          intent.kind !== "selection" ||
          !(error instanceof ApplicationError) ||
          error.category !== "conflict" ||
          !(PLUGIN_UI_INTENT_SELECTION_CONFLICTS as readonly string[]).includes(
            error.code,
          ) ||
          result.dispatchAttemptCount !== 1
        )
          return;
        try {
          await this.#store.refuseUiIntentFirstDispatch({
            account: captured.account,
            intentId: intent.intentId,
            requestDigest: intent.requestDigest,
            expectedDispatchAttemptCount: 1,
            reasonCode: error.code,
            at: this.#clock.now(),
          });
        } catch (failure) {
          this.#report(failure);
        }
      },
    });
  }

  #report(error: unknown): void {
    try {
      this.#diagnostic(error);
    } catch {
      /* Diagnostics never replace business results. */
    }
  }

  #capture(invocation: PluginUiActionContext) {
    const originalAuthority =
      capturePluginUiInvocationCommitAuthority(invocation);
    const captured = committedTaskContext(invocation);
    const callback = this.#authorize,
      active = this.#assertExternalActive;
    const assertActive = () => {
      originalAuthority.assertActive();
      if (active !== undefined) {
        const result: unknown = active(captured.context);
        if (result !== undefined) unavailable();
      }
      originalAuthority.assertActive();
    };
    const authorize =
      callback === undefined
        ? undefined
        : async () => {
            assertActive();
            const result: unknown = await callback(captured.context);
            if (result !== undefined) unavailable();
            assertActive();
          };
    const authority =
      authorize === undefined
        ? originalAuthority
        : Object.freeze({
            assertActive,
            assertCurrent: async () => {
              await authorize();
              await originalAuthority.assertCurrent();
              await authorize();
            },
            ...(originalAuthority.transaction === undefined
              ? {}
              : {
                  transaction: Object.freeze({
                    ...originalAuthority.transaction,
                    assertCurrent: async () => {
                      await authorize();
                      await originalAuthority.transaction!.assertCurrent();
                      await authorize();
                    },
                  }),
                }),
          });
    if (!pluginUiDeclaresRecovery(captured.context.lease)) unavailable();
    this.#publication(captured.context);
    const account = parsePluginUiIntentJournalAccount({
      controlRealmId: this.#realm,
      tenantId: captured.pin.tenantId,
      spaceId: captured.pin.spaceId,
      principalId: captured.pin.principalId,
    });
    return { ...captured, authority, account };
  }

  #publication(
    context: PluginUiActionContext,
    action?: PluginUiRecoveryRequest["action"],
  ) {
    if (
      !context.lease.descriptor.contributions.some(
        (item) =>
          item.id === context.lease.contributionId &&
          item.kind === "module" &&
          item.slot === "main.content",
      )
    )
      unavailable();
    if (action !== undefined) {
      const service =
        action === PROJECT_MEDIA_GENERATE_UI_ACTION
          ? "crewon.project-media-generations"
          : action === "crewon.project-generations.v1.generateConcept"
            ? "crewon.project-generations"
            : action ===
                "crewon.project-generation-queries.v1.queryConceptGeneration"
              ? "crewon.project-generation-queries"
              : "crewon.project-generation-selections";
      if (
        !context.lease.descriptor.requires.some(
          (item) => item.service === service && item.apiVersion === "1",
        )
      )
        unavailable();
    }
    if (
      !this.#publications.some(
        (value) =>
          value.pluginId === context.package.pluginId &&
          value.packageDigest === context.package.packageDigest &&
          value.contributionId === context.lease.contributionId &&
          (action === undefined || value.actions.includes(action)),
      )
    )
      unavailable();
  }

  #record(value: unknown, account: PluginUiIntentJournalAccount) {
    const record = parsePluginUiIntentRecord(value, this.#digester);
    if (
      extensionCanonicalJson(record.account) !== extensionCanonicalJson(account)
    )
      invalid();
    return record;
  }

  #hint(record: PluginUiIntentRecord, current: PluginTaskAdmissionPin) {
    const request = parsePluginUiRecoveryRequest(
      JSON.parse(record.requestJson),
    );
    const {
      pluginId,
      publisherId,
      version,
      packageDigest,
      selectionRevision,
      contributionId,
    } = record.sourcePin;
    const matched =
      pluginUiIntentStablePin(record.sourcePin) ===
        pluginUiIntentStablePin({
          ...current,
          action: record.sourcePin.action,
        }) &&
      (record.kind === "selection" ||
        record.sourcePin.selectionRevision === current.selectionRevision);
    const enabled = this.#publications.some(
      (value) =>
        value.pluginId === current.pluginId &&
        value.packageDigest === current.packageDigest &&
        value.contributionId === current.contributionId &&
        value.actions.includes(request.action),
    );
    const unresolved =
      record.phase === "prepared" || record.phase === "dispatched";
    return parsePluginUiRecoveryHint({
      sourcePin: {
        pluginId,
        publisherId,
        version,
        packageDigest,
        selectionRevision,
        contributionId,
      },
      request,
      revision: record.revision,
      phase: record.phase,
      dispatchMayHaveOccurred: record.dispatchMayHaveOccurred,
      dispatchAttemptCount: record.dispatchAttemptCount,
      receipt:
        record.receiptJson === null
          ? null
          : pluginUiRecoveryReceipt(request, JSON.parse(record.receiptJson)),
      retryable: unresolved && matched && enabled,
      reasonCode:
        record.phase === "accepted"
          ? null
          : (record.reasonCode ??
            (unresolved && (!matched || !enabled)
              ? "plugin_ui_recovery_source_changed"
              : null)),
    });
  }
}

export function capturePluginUiRecoveryPublications(
  input: unknown,
  options: Readonly<{ publicationMode: PluginUiRecoveryPublicationMode }> = {
    publicationMode: "business-actions",
  },
): readonly PluginUiRecoveryPublication[] {
  const mode = uiRecord(options, ["publicationMode"]).publicationMode;
  if (mode !== "business-actions" && mode !== "metadata-read") invalid();
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < 1 ||
    input.length > 32 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid();
  const seen = new Set<string>();
  const publications = Array.from({ length: input.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(input, String(index));
    if (!item || !Object.hasOwn(item, "value") || !item.enumerable) invalid();
    const value = uiRecord(item.value, [
      "pluginId",
      "packageDigest",
      "contributionId",
      "actions",
    ]);
    if (
      !Array.isArray(value.actions) ||
      Object.getPrototypeOf(value.actions) !== Array.prototype ||
      value.actions.length < (mode === "metadata-read" ? 0 : 1) ||
      value.actions.length > 4 ||
      Reflect.ownKeys(value.actions).length !== value.actions.length + 1
    )
      invalid();
    const actions = Array.from(
      { length: value.actions.length },
      (_, actionIndex) => {
        const action = Object.getOwnPropertyDescriptor(
          value.actions,
          String(actionIndex),
        );
        if (
          !action ||
          !Object.hasOwn(action, "value") ||
          !action.enumerable ||
          ![
            PROJECT_MEDIA_GENERATE_UI_ACTION,
            "crewon.project-generations.v1.generateConcept",
            "crewon.project-generation-queries.v1.queryConceptGeneration",
            "crewon.project-generation-selections.v1.selectConceptImage",
          ].includes(action.value)
        )
          invalid();
        return action.value as PluginUiRecoveryRequest["action"];
      },
    );
    if (new Set(actions).size !== actions.length) invalid();
    const result = Object.freeze({
      pluginId: pluginInstallationNamespaceId(value.pluginId),
      packageDigest: pluginInstallationDigest(value.packageDigest),
      contributionId: pluginInstallationNamespaceId(value.contributionId),
      actions: Object.freeze(actions),
    });
    const key = JSON.stringify([
      result.pluginId,
      result.packageDigest,
      result.contributionId,
    ]);
    if (seen.has(key)) invalid();
    seen.add(key);
    return result;
  });
  return Object.freeze(publications);
}

function method<T extends object, K extends keyof T>(owner: T, key: K): T[K] {
  let target: object | null = owner;
  for (let depth = 0; target !== null && depth < 32; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "function"
      )
        invalid();
      return descriptor.value.bind(owner) as T[K];
    }
    target = Object.getPrototypeOf(target);
  }
  return invalid();
}
function captureStore(
  store: PluginUiIntentJournalStore,
): PluginUiIntentJournalStore {
  return Object.freeze({
    uiIntentJournalVersion: store.uiIntentJournalVersion,
    uiIntentJournalReadVersion: store.uiIntentJournalReadVersion,
    uiIntentJournalRealmId: store.uiIntentJournalRealmId,
    stageUiIntent: method(store, "stageUiIntent"),
    listUiIntentHints: method(store, "listUiIntentHints"),
    markUiIntentDispatched: method(store, "markUiIntentDispatched"),
    confirmUiIntentAccepted: method(store, "confirmUiIntentAccepted"),
    refuseUiIntentFirstDispatch: method(store, "refuseUiIntentFirstDispatch"),
  });
}
function unavailable(): never {
  throw new ApplicationError("conflict", "plugin_ui_recovery_unavailable");
}
function invalid(): never {
  throw new ApplicationError("internal", "plugin_ui_recovery_record_invalid");
}
