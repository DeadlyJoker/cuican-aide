import {
  parseSelectConceptImageResponse,
  type SelectConceptImageResponse,
} from "@crewon/contracts";
import { ControlApiClientError } from "@crewon/control-client";
import {
  CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION,
  CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE,
  PROJECT_GENERATION_SELECTION_UI_ACTIONS,
  parsePluginUiLease,
  parseProjectGenerationSelectionUiActionRequest,
  type PluginUiJsonValue,
  type PluginUiLease,
  type PluginUiRecoveryHint,
  type ProjectGenerationSelectionUiInput,
} from "@crewon/contracts/plugins";
import {
  PLUGIN_UI_CONTROL_DEADLINE_MS,
  assertPluginUiCurrent,
} from "./controlPluginUiSupport";
import {
  abortedPluginUiOperation,
  PluginUiLoaderError,
  uiFailure,
} from "./pluginUiValidation";

import {
  capturePluginUiRecoveryStage,
  freshPluginUiRecoveryHistory,
  mergePluginUiRecoveryStageHistory,
  pluginUiRecoveryReceiptsMatch,
  preparePluginUiRecoveryRestore,
  restorePluginUiRecoveryHistory,
  PluginUiRecoveryRefusedError,
  type InstalledPluginRecoveryHistory,
  type InstalledPluginRecoveryRestorePlan,
} from "./installedPluginRecoveryJournalSupport";

export type InstalledPluginProjectSelectionSourcePin = Readonly<{
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  selectionRevision: number;
  contributionId: string;
}>;
export type InstalledPluginProjectSelectionIntent = Readonly<{
  familyKey: string;
  sourcePin: InstalledPluginProjectSelectionSourcePin;
  input: ProjectGenerationSelectionUiInput;
  phase: "pending" | "uncertain" | "accepted" | "refused";
  receipt: SelectConceptImageResponse | null;
  retryable: boolean;
  reasonCode: string | null;
  physicallyPending: boolean;
  dispatchMayHaveOccurred: boolean;
  dispatchAttemptCount: number;
}>;
export type InstalledPluginProjectSelectionActionResponse = Readonly<{
  output: PluginUiJsonValue;
}>;
export type InstalledPluginProjectSelectionJournal = Readonly<{
  snapshot(): readonly InstalledPluginProjectSelectionIntent[];
  subscribe(
    listener: (intent: InstalledPluginProjectSelectionIntent) => void,
  ): () => void;
  invalidate(): void;
  /** Trusted GET hints only; preparing the plan does not publish or send a request. */
  restore(
    hints: readonly PluginUiRecoveryHint[],
  ): InstalledPluginRecoveryRestorePlan;
  current(
    input: Readonly<{
      lease: PluginUiLease;
      input?: ProjectGenerationSelectionUiInput;
    }>,
  ): InstalledPluginProjectSelectionIntent | null;
  register(
    input: Readonly<{
      lease: PluginUiLease;
      input: ProjectGenerationSelectionUiInput;
    }>,
  ): InstalledPluginProjectSelectionIntent;
  invoke(
    input: Readonly<{
      lease: PluginUiLease;
      input: ProjectGenerationSelectionUiInput;
      signal: AbortSignal;
      request(
        signal: AbortSignal,
      ): Promise<InstalledPluginProjectSelectionActionResponse>;
      /** A durable ACK must precede the original mutation when recovery is declared. */
      stage?(signal: AbortSignal): Promise<PluginUiRecoveryHint>;
      assertCurrent?: () => void;
    }>,
  ): Promise<InstalledPluginProjectSelectionActionResponse>;
  /** Fences the captured account; this does not grant mutation authority. */
  assertCurrent(): void;
}>;

type Physical = {
  controller: AbortController;
  previouslyDispatched: boolean;
  sent: boolean;
  businessSent: boolean;
  settled: boolean;
  work: Promise<InstalledPluginProjectSelectionActionResponse>;
  timer?: ReturnType<typeof setTimeout>;
};
type Entry = InstalledPluginRecoveryHistory & {
  familyKey: string;
  sourcePin: InstalledPluginProjectSelectionSourcePin;
  input: ProjectGenerationSelectionUiInput;
  phase: InstalledPluginProjectSelectionIntent["phase"];
  receipt: SelectConceptImageResponse | null;
  reasonCode: string | null;
  blocked: boolean;
  physical?: Physical;
};
const MAX_INTENTS = 32;
const MAX_PHYSICAL = 16;
// These four conflicts arise before COMMIT in the selection use case/SQL plan.
// A response on a later retry cannot prove what happened to an earlier request.
const PRE_COMMIT_REVISION_CONFLICTS = new Set([
  "creative_project_revision_conflict",
  "creative_project_asset_revision_conflict",
  "concept_selection_operation_revision_conflict",
  "concept_selection_revision_conflict",
]);
function firstRevisionConflict(error: unknown, job: Physical): boolean {
  return (
    !job.previouslyDispatched &&
    job.businessSent &&
    error instanceof ControlApiClientError &&
    error.status === 409 &&
    error.category === "conflict" &&
    PRE_COMMIT_REVISION_CONFLICTS.has(error.code)
  );
}
const intentKey = (familyKey: string, key: string) =>
  JSON.stringify([familyKey, key]);

export function installedPluginProjectSelectionFamilyKey(
  lease: PluginUiLease,
): string {
  const captured = parsePluginUiLease(lease);
  return JSON.stringify([
    captured.descriptor.pluginId,
    captured.contributionId,
  ]);
}

export function installedPluginProjectSelectionSourcePin(
  input: PluginUiLease,
): InstalledPluginProjectSelectionSourcePin {
  const lease = parsePluginUiLease(input);
  if (
    !lease.descriptor.requires.some(
      (requirement) =>
        requirement.service === CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE &&
        requirement.apiVersion ===
          CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION,
    )
  )
    uiFailure("plugin_ui_project_selection_family_unavailable");
  return Object.freeze({
    pluginId: lease.descriptor.pluginId,
    publisherId: lease.descriptor.publisherId,
    version: lease.descriptor.version,
    packageDigest: lease.packageDigest,
    selectionRevision: lease.selectionRevision,
    contributionId: lease.contributionId,
  });
}

/** An original pin remains audit evidence; a fresh validated regrant may have a new selection revision. */
export function installedPluginProjectSelectionPinsMatch(
  left: InstalledPluginProjectSelectionSourcePin,
  right: InstalledPluginProjectSelectionSourcePin,
): boolean {
  return (
    [
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
      "contributionId",
    ] as const
  ).every((key) => left[key] === right[key]);
}

/** One captured account owns the immutable intent, physical request and late acknowledgement. */
export function createInstalledPluginProjectSelectionJournal(
  options: Readonly<{
    assertCurrent(): void;
    onDiagnostic(error: unknown): void;
  }>,
): InstalledPluginProjectSelectionJournal {
  const assertCurrent = options.assertCurrent.bind(options);
  const diagnostic = (error: unknown) => {
    try {
      options.onDiagnostic(error);
    } catch {
      /* Diagnostics cannot rewrite a commit. */
    }
  };
  const entries = new Map<string, Entry>();
  const physical = new Set<Physical>();
  const listeners = new Set<
    (intent: InstalledPluginProjectSelectionIntent) => void
  >();
  let snapshot: readonly InstalledPluginProjectSelectionIntent[] =
    Object.freeze([]);
  let stopped = false;
  const invalidate = () => {
    stopped = true;
    entries.clear();
    snapshot = Object.freeze([]);
    listeners.clear();
    for (const job of physical) {
      clearTimeout(job.timer);
      job.controller.abort();
    }
  };
  const checkCurrent = (extra?: () => void) => {
    if (stopped) uiFailure("plugin_ui_project_selection_journal_inactive");
    try {
      assertPluginUiCurrent(assertCurrent);
      if (extra) assertPluginUiCurrent(extra);
    } catch (error) {
      invalidate();
      throw error;
    }
  };
  const view = (entry: Entry): InstalledPluginProjectSelectionIntent =>
    Object.freeze({
      familyKey: entry.familyKey,
      sourcePin: entry.sourcePin,
      input: entry.input,
      phase: entry.phase,
      receipt: entry.receipt,
      retryable:
        !entry.blocked &&
        entry.physical === undefined &&
        entry.phase === "uncertain",
      reasonCode: entry.reasonCode,
      physicallyPending: entry.physical !== undefined,
      dispatchMayHaveOccurred: entry.dispatchMayHaveOccurred,
      dispatchAttemptCount: entry.dispatchAttemptCount,
    });
  const captureSnapshot = () => {
    snapshot = Object.freeze([...entries.values()].reverse().map(view));
  };
  const publish = (entry: Entry) => {
    if (
      stopped ||
      !entries.has(intentKey(entry.familyKey, entry.input.idempotencyKey))
    )
      return;
    captureSnapshot();
    const intent = view(entry);
    for (const listener of [...listeners]) {
      if (stopped) break;
      try {
        checkCurrent();
        listener(intent);
      } catch (error) {
        diagnostic(error);
      }
    }
  };
  const mismatch = (entry: Entry) => {
    entry.blocked = true;
    if (entry.phase !== "accepted" && entry.phase !== "refused")
      entry.phase = "uncertain";
    if (entry.phase !== "refused")
      entry.reasonCode = "plugin_ui_project_selection_intent_mismatch";
    publish(entry);
    return view(entry);
  };
  const requestFor = (input: ProjectGenerationSelectionUiInput) => {
    const checked = parseProjectGenerationSelectionUiActionRequest({
      action: PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
      input,
    });
    if (checked.action !== PROJECT_GENERATION_SELECTION_UI_ACTIONS[1])
      uiFailure("plugin_ui_project_selection_action_invalid");
    return checked;
  };
  const same = (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right);
  const activeFamily = (familyKey: string) =>
    [...entries.values()]
      .reverse()
      .find(
        (entry) =>
          entry.familyKey === familyKey &&
          (entry.phase === "pending" || entry.phase === "uncertain"),
      );
  const find = (
    lease: PluginUiLease,
    raw?: ProjectGenerationSelectionUiInput,
  ): Entry | undefined => {
    const input = raw === undefined ? undefined : requestFor(raw).input;
    const familyKey = installedPluginProjectSelectionFamilyKey(lease);
    const exact =
      input === undefined
        ? undefined
        : entries.get(intentKey(familyKey, input.idempotencyKey));
    const unresolved = activeFamily(familyKey);
    const found =
      exact ??
      unresolved ??
      [...entries.values()]
        .reverse()
        .find((entry) => entry.familyKey === familyKey && input === undefined);
    if (found === undefined) return undefined;
    let pin: InstalledPluginProjectSelectionSourcePin;
    try {
      pin = installedPluginProjectSelectionSourcePin(lease);
    } catch {
      mismatch(found);
      return found;
    }
    if (
      familyKey !== found.familyKey ||
      !installedPluginProjectSelectionPinsMatch(pin, found.sourcePin) ||
      (exact !== undefined && !same(input, found.input))
    )
      mismatch(found);
    return found;
  };
  const register = ({
    lease,
    input: raw,
  }: Readonly<{
    lease: PluginUiLease;
    input: ProjectGenerationSelectionUiInput;
  }>) => {
    checkCurrent();
    const input = requestFor(raw).input;
    const existing = find(lease, input);
    if (existing !== undefined) {
      if (existing.blocked || !same(existing.input, input))
        uiFailure("plugin_ui_project_selection_intent_mismatch");
      return view(existing);
    }
    const sourcePin = installedPluginProjectSelectionSourcePin(lease);
    if (entries.size >= MAX_INTENTS) {
      const retired = [...entries.values()].find(
        (entry) =>
          entry.physical === undefined &&
          (entry.phase === "accepted" || entry.phase === "refused"),
      );
      if (retired === undefined)
        uiFailure("plugin_ui_project_selection_journal_limit");
      entries.delete(
        intentKey(retired.familyKey, retired.input.idempotencyKey),
      );
    }
    const entry: Entry = {
      familyKey: installedPluginProjectSelectionFamilyKey(lease),
      sourcePin,
      input,
      phase: "pending",
      receipt: null,
      reasonCode: null,
      blocked: false,
      ...freshPluginUiRecoveryHistory(),
    };
    entries.set(intentKey(entry.familyKey, input.idempotencyKey), entry);
    publish(entry);
    return view(entry);
  };
  const unknown = (entry: Entry) => {
    if (stopped || entry.phase === "accepted" || entry.phase === "refused")
      return;
    entry.phase = "uncertain";
    entry.unknownSeen = true;
    if (!entry.blocked)
      entry.reasonCode = "plugin_ui_project_selection_result_unknown";
    publish(entry);
  };
  const refused = (entry: Entry, reasonCode: string) => {
    if (stopped || entry.phase === "accepted" || entry.blocked) return;
    entry.phase =
      entry.dispatchMayHaveOccurred || entry.unknownSeen
        ? "uncertain"
        : "refused";
    entry.reasonCode = reasonCode;
    publish(entry);
  };

  return Object.freeze({
    snapshot() {
      if (!stopped)
        try {
          checkCurrent();
        } catch {
          /* Old account data is already purged. */
        }
      return snapshot;
    },
    subscribe(listener) {
      if (stopped) return () => undefined;
      checkCurrent();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invalidate,
    restore(hints) {
      return preparePluginUiRecoveryRestore({
        hints,
        action: PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
        entries,
        checkCurrent,
        captureSnapshot,
        publish,
        limit: MAX_INTENTS,
        failureCode: "plugin_ui_project_selection_recovery_mismatch",
        key: (entry) => intentKey(entry.familyKey, entry.input.idempotencyKey),
        create(hint): Entry {
          if (
            hint.request.action !== PROJECT_GENERATION_SELECTION_UI_ACTIONS[1]
          )
            uiFailure("plugin_ui_project_selection_recovery_mismatch");
          return {
            familyKey: JSON.stringify([
              hint.sourcePin.pluginId,
              hint.sourcePin.contributionId,
            ]),
            sourcePin: hint.sourcePin,
            input: requestFor(hint.request.input).input,
            phase:
              hint.phase === "prepared" || hint.phase === "dispatched"
                ? "uncertain"
                : hint.phase,
            receipt: hint.receipt as SelectConceptImageResponse | null,
            reasonCode:
              hint.reasonCode ??
              (hint.receipt === null
                ? "plugin_ui_project_selection_result_unknown"
                : null),
            blocked:
              (hint.phase === "prepared" || hint.phase === "dispatched") &&
              !hint.retryable,
            ...restorePluginUiRecoveryHistory(hint),
          };
        },
      });
    },
    current({ lease, input }) {
      checkCurrent();
      const found = find(lease, input);
      return found === undefined ? null : view(found);
    },
    register,
    assertCurrent: checkCurrent,
    async invoke({
      lease: rawLease,
      input: raw,
      signal: caller,
      request,
      stage,
      assertCurrent: extra,
    }) {
      const registered = register({ lease: rawLease, input: raw });
      const checked = requestFor(raw);
      const entry = entries.get(
        intentKey(registered.familyKey, registered.input.idempotencyKey),
      )!;
      if (
        entry.blocked ||
        !same(entry.input, checked.input) ||
        entry.input.idempotencyKey !== checked.input.idempotencyKey
      )
        uiFailure("plugin_ui_project_selection_intent_mismatch");
      if (caller.aborted) {
        refused(entry, "plugin_ui_operation_aborted");
        throw abortedPluginUiOperation();
      }
      if (entry.phase === "accepted")
        return { output: entry.receipt as PluginUiJsonValue };
      if (entry.phase === "refused")
        uiFailure("plugin_ui_project_selection_intent_refused");
      const lease = parsePluginUiLease(rawLease);
      let job = entry.physical;
      if (job === undefined) {
        if (physical.size >= MAX_PHYSICAL) {
          refused(entry, "plugin_ui_inflight_limit");
          uiFailure("plugin_ui_inflight_limit");
        }
        job = {
          controller: new AbortController(),
          previouslyDispatched:
            entry.dispatchMayHaveOccurred || entry.unknownSeen,
          sent: false,
          businessSent: false,
          settled: false,
          work: undefined as unknown as Promise<InstalledPluginProjectSelectionActionResponse>,
        };
        const actual = job;
        entry.physical = actual;
        entry.phase = "pending";
        entry.reasonCode = null;
        physical.add(actual);
        actual.timer = setTimeout(() => {
          if (actual.sent) unknown(entry);
          actual.controller.abort();
        }, PLUGIN_UI_CONTROL_DEADLINE_MS);
        // This deferred boundary prevents reentrancy and repeats every guard after the queue.
        actual.work = Promise.resolve().then(async () => {
          try {
            checkCurrent(extra);
            if (caller.aborted || actual.controller.signal.aborted)
              throw abortedPluginUiOperation();
            if (Date.parse(lease.expiresAt) <= Date.now())
              uiFailure("plugin_ui_project_selection_lease_expired");
            let queuedPin: InstalledPluginProjectSelectionSourcePin;
            try {
              queuedPin = installedPluginProjectSelectionSourcePin(rawLease);
            } catch (error) {
              mismatch(entry);
              throw error;
            }
            if (
              !installedPluginProjectSelectionPinsMatch(
                queuedPin,
                entry.sourcePin,
              )
            ) {
              mismatch(entry);
              uiFailure("plugin_ui_project_selection_intent_mismatch");
            }
            if (
              entries.get(
                intentKey(entry.familyKey, entry.input.idempotencyKey),
              ) !== entry ||
              entry.blocked ||
              !same(parsePluginUiLease(rawLease), lease) ||
              !same(requestFor(raw).input, entry.input)
            )
              uiFailure("plugin_ui_project_selection_intent_mismatch");
            if (stage) {
              // A lost stage ACK preserves the original key without sending the business request.
              actual.sent = true;
              const hint = capturePluginUiRecoveryStage(
                await stage(actual.controller.signal),
                requestFor(entry.input),
                entry.sourcePin,
              );
              checkCurrent(extra);
              if (
                entries.get(
                  intentKey(entry.familyKey, entry.input.idempotencyKey),
                ) !== entry
              )
                uiFailure("plugin_ui_project_selection_intent_mismatch");
              mergePluginUiRecoveryStageHistory(entry, hint);
              actual.previouslyDispatched ||=
                entry.dispatchMayHaveOccurred || entry.unknownSeen;
              if (hint.phase === "accepted") {
                if (
                  entry.phase === "accepted" &&
                  !pluginUiRecoveryReceiptsMatch(entry.receipt, hint.receipt)
                )
                  uiFailure("plugin_ui_recovery_receipt_mismatch");
                entry.phase = "accepted";
                entry.receipt ??= hint.receipt as SelectConceptImageResponse;
                entry.reasonCode = null;
                publish(entry);
                return { output: entry.receipt as PluginUiJsonValue };
              }
              if (hint.phase === "refused") {
                if (entry.phase === "accepted")
                  uiFailure("plugin_ui_project_selection_recovery_mismatch");
                entry.phase = "refused";
                entry.reasonCode = hint.reasonCode;
                publish(entry);
                throw new PluginUiRecoveryRefusedError(hint.reasonCode!);
              }
              if (entry.phase === "accepted")
                return { output: entry.receipt as PluginUiJsonValue };
              if (entry.phase === "refused")
                throw new PluginUiRecoveryRefusedError(entry.reasonCode!);
              if (caller.aborted || actual.controller.signal.aborted)
                throw abortedPluginUiOperation();
              if (Date.parse(lease.expiresAt) <= Date.now())
                uiFailure("plugin_ui_project_selection_lease_expired");
              if (
                entry.blocked ||
                !same(parsePluginUiLease(rawLease), lease) ||
                !same(requestFor(raw).input, entry.input)
              )
                uiFailure("plugin_ui_project_selection_intent_mismatch");
              if (!hint.retryable) {
                mismatch(entry);
                uiFailure("plugin_ui_project_selection_intent_mismatch");
              }
            }
            // Business dispatch history excludes the preceding stage request.
            actual.sent = true;
            actual.businessSent = true;
            entry.dispatchMayHaveOccurred = true;
            if (entry.dispatchAttemptCount >= Number.MAX_SAFE_INTEGER)
              uiFailure("plugin_ui_recovery_dispatch_limit");
            entry.dispatchAttemptCount += 1;
            const response = await request(actual.controller.signal);
            checkCurrent(extra);
            const { idempotencyKey: _key, ...command } = entry.input;
            const receipt = parseSelectConceptImageResponse(
              response.output,
              command,
            );
            if (
              entry.phase === "accepted" &&
              !pluginUiRecoveryReceiptsMatch(entry.receipt, receipt)
            )
              uiFailure("plugin_ui_project_selection_recovery_mismatch");
            entry.phase = "accepted";
            entry.receipt ??= receipt;
            entry.reasonCode = null;
            publish(entry);
            return { output: entry.receipt };
          } catch (error) {
            if (error instanceof PluginUiRecoveryRefusedError) throw error;
            if (actual.sent) {
              if (
                firstRevisionConflict(error, actual) &&
                !entry.blocked &&
                entry.phase !== "accepted"
              ) {
                entry.phase = "refused";
                entry.reasonCode = (error as ControlApiClientError).code;
                publish(entry);
              } else unknown(entry);
            } else
              refused(
                entry,
                error instanceof PluginUiLoaderError
                  ? error.code
                  : "plugin_ui_project_selection_pre_send_refused",
              );
            throw error;
          } finally {
            actual.settled = true;
            clearTimeout(actual.timer);
            physical.delete(actual);
            if (entry.physical === actual) entry.physical = undefined;
            publish(entry);
          }
        });
        void actual.work.catch(() => undefined);
        publish(entry);
      }
      const actual = job;
      return new Promise<InstalledPluginProjectSelectionActionResponse>(
        (resolve, reject) => {
          let settled = false;
          const complete = (
            error: unknown,
            response?: InstalledPluginProjectSelectionActionResponse,
          ) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            caller.removeEventListener("abort", abort);
            if (response !== undefined) resolve(response);
            else reject(error);
          };
          const abort = () => {
            if (actual.sent) unknown(entry);
            complete(abortedPluginUiOperation());
          };
          const timer = setTimeout(() => {
            if (actual.sent) unknown(entry);
            actual.controller.abort();
            complete(new PluginUiLoaderError("plugin_ui_control_timeout"));
          }, PLUGIN_UI_CONTROL_DEADLINE_MS);
          caller.addEventListener("abort", abort, { once: true });
          if (caller.aborted) abort();
          void actual.work.then(
            (response) => complete(undefined, response),
            (error) => complete(error),
          );
        },
      );
    },
  });
}
