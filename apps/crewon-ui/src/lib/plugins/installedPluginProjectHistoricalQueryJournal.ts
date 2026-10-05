import {
  CREWON_PROJECT_HISTORICAL_QUERIES_API_VERSION,
  CREWON_PROJECT_HISTORICAL_QUERIES_SERVICE,
  PROJECT_HISTORICAL_QUERY_UI_ACTIONS,
  parseProjectHistoricalQueryUiActionRequest,
  parseProjectHistoricalQueryUiActionResponse,
  type ProjectHistoricalQueryUiInput,
  type ProjectHistoricalQueryUiReceipt,
} from "@crewon/contracts/project-historical-queries";
import {
  parsePluginUiLease,
  type PluginUiJsonValue,
  type PluginUiLease,
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

export type InstalledPluginProjectHistoricalQuerySourcePin = Readonly<{
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  selectionRevision: number;
  contributionId: string;
}>;
export type InstalledPluginProjectHistoricalQueryIntent = Readonly<{
  familyKey: string;
  sourcePin: InstalledPluginProjectHistoricalQuerySourcePin;
  input: ProjectHistoricalQueryUiInput;
  phase: "pending" | "uncertain" | "accepted" | "refused";
  receipt: ProjectHistoricalQueryUiReceipt | null;
  retryable: boolean;
  reasonCode: string | null;
  physicallyPending: boolean;
  dispatchMayHaveOccurred: boolean;
  dispatchAttemptCount: number;
}>;
export type InstalledPluginProjectHistoricalQueryActionResponse = Readonly<{
  output: PluginUiJsonValue;
}>;
export type InstalledPluginProjectHistoricalQueryJournal = Readonly<{
  snapshot(): readonly InstalledPluginProjectHistoricalQueryIntent[];
  subscribe(
    listener: (intent: InstalledPluginProjectHistoricalQueryIntent) => void,
  ): () => void;
  invalidate(): void;
  close(): Promise<void>;
  current(
    input: Readonly<{
      lease: PluginUiLease;
      input?: ProjectHistoricalQueryUiInput;
    }>,
  ): InstalledPluginProjectHistoricalQueryIntent | null;
  register(
    input: Readonly<{
      lease: PluginUiLease;
      input: ProjectHistoricalQueryUiInput;
    }>,
  ): InstalledPluginProjectHistoricalQueryIntent;
  invoke(
    input: Readonly<{
      lease: PluginUiLease;
      input: ProjectHistoricalQueryUiInput;
      signal: AbortSignal;
      request(
        signal: AbortSignal,
      ): Promise<InstalledPluginProjectHistoricalQueryActionResponse>;
      assertCurrent?: () => void;
    }>,
  ): Promise<InstalledPluginProjectHistoricalQueryActionResponse>;
  /** Account-owned query context holders survive component and mount replacement. */
  getOrCreateContextOwner<T>(familyKey: string, factory: () => T): T;
}>;

type Physical = {
  controller: AbortController;
  sent: boolean;
  work: Promise<InstalledPluginProjectHistoricalQueryActionResponse>;
  timer?: ReturnType<typeof setTimeout>;
};
type Entry = {
  unknownSeen: boolean;
  dispatchMayHaveOccurred: boolean;
  dispatchAttemptCount: number;
  familyKey: string;
  sourcePin: InstalledPluginProjectHistoricalQuerySourcePin;
  input: ProjectHistoricalQueryUiInput;
  phase: InstalledPluginProjectHistoricalQueryIntent["phase"];
  receipt: ProjectHistoricalQueryUiReceipt | null;
  reasonCode: string | null;
  blocked: boolean;
  physical?: Physical;
};
const MAX_INTENTS = 32;
const MAX_PHYSICAL = 16;
const intentKey = (familyKey: string, key: string) =>
  JSON.stringify([familyKey, key]);

export function installedPluginProjectHistoricalQueryFamilyKey(
  lease: PluginUiLease,
): string {
  const captured = parsePluginUiLease(lease);
  return JSON.stringify([
    captured.descriptor.pluginId,
    captured.contributionId,
  ]);
}

export function installedPluginProjectHistoricalQuerySourcePin(
  input: PluginUiLease,
): InstalledPluginProjectHistoricalQuerySourcePin {
  const lease = parsePluginUiLease(input);
  if (
    !lease.descriptor.requires.some(
      (requirement) =>
        requirement.service === CREWON_PROJECT_HISTORICAL_QUERIES_SERVICE &&
        requirement.apiVersion ===
          CREWON_PROJECT_HISTORICAL_QUERIES_API_VERSION,
    )
  )
    uiFailure("plugin_ui_project_historical_query_family_unavailable");
  return Object.freeze({
    pluginId: lease.descriptor.pluginId,
    publisherId: lease.descriptor.publisherId,
    version: lease.descriptor.version,
    packageDigest: lease.packageDigest,
    selectionRevision: lease.selectionRevision,
    contributionId: lease.contributionId,
  });
}

/** Session-only immutable historical-query intent. No old SDK stage or cold restore authority is accepted. */
export function createInstalledPluginProjectHistoricalQueryJournal(
  options: Readonly<{
    assertCurrent(): void;
    onDiagnostic(error: unknown): void;
  }>,
): InstalledPluginProjectHistoricalQueryJournal {
  const assertCurrent = options.assertCurrent.bind(options);
  const diagnostic = (error: unknown) => {
    try {
      options.onDiagnostic(error);
    } catch {
      /* Diagnostics cannot rewrite a commit. */
    }
  };
  const entries = new Map<string, Entry>();
  const preparation = new Map<string, unknown>();
  const physical = new Set<Physical>();
  const listeners = new Set<
    (intent: InstalledPluginProjectHistoricalQueryIntent) => void
  >();
  let snapshot: readonly InstalledPluginProjectHistoricalQueryIntent[] =
    Object.freeze([]);
  let stopped = false;
  const invalidate = () => {
    stopped = true;
    entries.clear();
    preparation.clear();
    snapshot = Object.freeze([]);
    listeners.clear();
    for (const job of physical) {
      clearTimeout(job.timer);
      job.controller.abort();
    }
  };
  const checkCurrent = (extra?: () => void) => {
    if (stopped)
      uiFailure("plugin_ui_project_historical_query_journal_inactive");
    try {
      assertPluginUiCurrent(assertCurrent);
      if (extra) assertPluginUiCurrent(extra);
    } catch (error) {
      invalidate();
      throw error;
    }
  };
  const view = (entry: Entry): InstalledPluginProjectHistoricalQueryIntent =>
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
      entry.reasonCode = "plugin_ui_project_historical_query_intent_mismatch";
    publish(entry);
    return view(entry);
  };
  const requestFor = (input: ProjectHistoricalQueryUiInput) =>
    parseProjectHistoricalQueryUiActionRequest({
      action: PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0],
      input,
    });
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
    raw?: ProjectHistoricalQueryUiInput,
  ): Entry | undefined => {
    const input = raw === undefined ? undefined : requestFor(raw).input;
    const familyKey = installedPluginProjectHistoricalQueryFamilyKey(lease);
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
    let pin: InstalledPluginProjectHistoricalQuerySourcePin;
    try {
      pin = installedPluginProjectHistoricalQuerySourcePin(lease);
    } catch {
      mismatch(found);
      return found;
    }
    if (
      familyKey !== found.familyKey ||
      !same(pin, found.sourcePin) ||
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
    input: ProjectHistoricalQueryUiInput;
  }>) => {
    checkCurrent();
    const input = requestFor(raw).input;
    const existing = find(lease, input);
    if (existing !== undefined) {
      if (existing.blocked || !same(existing.input, input))
        uiFailure("plugin_ui_project_historical_query_intent_mismatch");
      return view(existing);
    }
    const sourcePin = installedPluginProjectHistoricalQuerySourcePin(lease);
    if (entries.size >= MAX_INTENTS) {
      const retired = [...entries.values()].find(
        (entry) =>
          entry.physical === undefined &&
          (entry.phase === "accepted" || entry.phase === "refused"),
      );
      if (retired === undefined)
        uiFailure("plugin_ui_project_historical_query_journal_limit");
      entries.delete(
        intentKey(retired.familyKey, retired.input.idempotencyKey),
      );
    }
    const entry: Entry = {
      familyKey: installedPluginProjectHistoricalQueryFamilyKey(lease),
      sourcePin,
      input,
      phase: "pending",
      receipt: null,
      reasonCode: null,
      blocked: false,
      unknownSeen: false,
      dispatchMayHaveOccurred: false,
      dispatchAttemptCount: 0,
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
      entry.reasonCode = "plugin_ui_project_historical_query_result_unknown";
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
      if (typeof listener !== "function")
        uiFailure("plugin_ui_project_historical_query_listener_invalid");
      if (listeners.size >= MAX_INTENTS)
        uiFailure("plugin_ui_project_historical_query_listener_limit");
      if (stopped) return () => undefined;
      checkCurrent();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invalidate,
    async close() {
      invalidate();
      await Promise.allSettled([...physical].map((job) => job.work));
    },
    current({ lease, input }) {
      checkCurrent();
      const found = find(lease, input);
      return found === undefined ? null : view(found);
    },
    register,
    getOrCreateContextOwner<T>(familyKey: string, factory: () => T): T {
      checkCurrent();
      if (
        typeof familyKey !== "string" ||
        familyKey.length < 1 ||
        familyKey.length > 512 ||
        typeof factory !== "function"
      )
        uiFailure("plugin_ui_project_historical_query_preparation_invalid");
      if (preparation.has(familyKey)) return preparation.get(familyKey) as T;
      if (preparation.size >= MAX_INTENTS)
        uiFailure("plugin_ui_project_historical_query_preparation_limit");
      const created = factory();
      checkCurrent();
      if (preparation.has(familyKey)) return preparation.get(familyKey) as T;
      preparation.set(familyKey, created);
      return created;
    },
    async invoke({
      lease: rawLease,
      input: raw,
      signal: caller,
      request,
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
        uiFailure("plugin_ui_project_historical_query_intent_mismatch");
      if (entry.phase === "accepted")
        return { output: entry.receipt as PluginUiJsonValue };
      if (entry.phase === "refused")
        uiFailure("plugin_ui_project_historical_query_intent_refused");
      const lease = parsePluginUiLease(rawLease);
      let job = entry.physical;
      if (job === undefined) {
        if (physical.size >= MAX_PHYSICAL) {
          refused(entry, "plugin_ui_inflight_limit");
          uiFailure("plugin_ui_inflight_limit");
        }
        job = {
          controller: new AbortController(),
          sent: false,
          work: undefined as unknown as Promise<InstalledPluginProjectHistoricalQueryActionResponse>,
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
              uiFailure("plugin_ui_project_historical_query_lease_expired");
            let queuedPin: InstalledPluginProjectHistoricalQuerySourcePin;
            try {
              queuedPin =
                installedPluginProjectHistoricalQuerySourcePin(rawLease);
            } catch (error) {
              mismatch(entry);
              throw error;
            }
            if (!same(queuedPin, entry.sourcePin)) {
              mismatch(entry);
              uiFailure("plugin_ui_project_historical_query_intent_mismatch");
            }
            if (
              entries.get(
                intentKey(entry.familyKey, entry.input.idempotencyKey),
              ) !== entry ||
              entry.blocked ||
              !same(parsePluginUiLease(rawLease), lease) ||
              !same(requestFor(raw).input, entry.input)
            )
              uiFailure("plugin_ui_project_historical_query_intent_mismatch");
            // This lane has no durable UI staging. Only this actual namespace is dispatched.
            actual.sent = true;
            entry.dispatchMayHaveOccurred = true;
            if (entry.dispatchAttemptCount >= Number.MAX_SAFE_INTEGER)
              uiFailure("plugin_ui_project_historical_query_dispatch_limit");
            entry.dispatchAttemptCount += 1;
            const response = await request(actual.controller.signal);
            checkCurrent(extra);
            const receipt = parseProjectHistoricalQueryUiActionResponse(
              {
                action: PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0],
                input: entry.input,
              },
              response.output,
            );
            if (entry.phase === "accepted" && !same(entry.receipt, receipt))
              uiFailure("plugin_ui_project_historical_query_receipt_mismatch");
            entry.phase = "accepted";
            entry.receipt ??= receipt;
            entry.reasonCode = null;
            publish(entry);
            return { output: entry.receipt };
          } catch (error) {
            if (actual.sent) unknown(entry);
            else
              refused(
                entry,
                error instanceof PluginUiLoaderError
                  ? error.code
                  : "plugin_ui_project_historical_query_pre_send_refused",
              );
            throw error;
          } finally {
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
      return new Promise<InstalledPluginProjectHistoricalQueryActionResponse>(
        (resolve, reject) => {
          let settled = false;
          const complete = (
            error: unknown,
            response?: InstalledPluginProjectHistoricalQueryActionResponse,
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
