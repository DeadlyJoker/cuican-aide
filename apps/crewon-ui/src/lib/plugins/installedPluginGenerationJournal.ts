import {
  CREWON_PROJECT_GENERATIONS_API_VERSION,
  CREWON_PROJECT_GENERATIONS_SERVICE,
  PROJECT_GENERATION_UI_ACTIONS,
  parsePluginUiLease,
  parseProjectGenerationUiActionRequest,
  parseProjectGenerationUiActionResponse,
  type PluginUiJsonValue,
  type PluginUiLease,
  type ProjectGenerationUiInput,
  type ProjectGenerationUiReceipt,
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

export type InstalledPluginGenerationSourcePin = Readonly<{
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  selectionRevision: number;
  contributionId: string;
}>;
export type InstalledPluginGenerationIntent = Readonly<{
  familyKey: string;
  sourcePin: InstalledPluginGenerationSourcePin;
  input: ProjectGenerationUiInput;
  phase: "pending" | "uncertain" | "accepted" | "refused";
  receipt: ProjectGenerationUiReceipt | null;
  retryable: boolean;
  reasonCode: string | null;
  physicallyPending: boolean;
}>;
export type InstalledPluginGenerationActionResponse = Readonly<{
  output: PluginUiJsonValue;
}>;
export type InstalledPluginGenerationJournal = Readonly<{
  snapshot(): readonly InstalledPluginGenerationIntent[];
  subscribe(
    listener: (intent: InstalledPluginGenerationIntent) => void,
  ): () => void;
  invalidate(): void;
  current(
    input: Readonly<{ lease: PluginUiLease; input?: ProjectGenerationUiInput }>,
  ): InstalledPluginGenerationIntent | null;
  register(
    input: Readonly<{ lease: PluginUiLease; input: ProjectGenerationUiInput }>,
  ): InstalledPluginGenerationIntent;
  invoke(
    input: Readonly<{
      lease: PluginUiLease;
      input: ProjectGenerationUiInput;
      signal: AbortSignal;
      request(
        signal: AbortSignal,
      ): Promise<InstalledPluginGenerationActionResponse>;
      assertCurrent?: () => void;
    }>,
  ): Promise<InstalledPluginGenerationActionResponse>;
  /** Account-owned creation intent holders survive component and mount replacement. */
  getOrCreatePreparationOwner<T>(familyKey: string, factory: () => T): T;
}>;

type Physical = {
  controller: AbortController;
  sent: boolean;
  settled: boolean;
  work: Promise<InstalledPluginGenerationActionResponse>;
  timer?: ReturnType<typeof setTimeout>;
};
type Entry = {
  familyKey: string;
  sourcePin: InstalledPluginGenerationSourcePin;
  input: ProjectGenerationUiInput;
  phase: InstalledPluginGenerationIntent["phase"];
  receipt: ProjectGenerationUiReceipt | null;
  reasonCode: string | null;
  blocked: boolean;
  physical?: Physical;
};
const MAX_INTENTS = 32;
const MAX_PHYSICAL = 16;

export function installedPluginGenerationFamilyKey(
  lease: PluginUiLease,
): string {
  const captured = parsePluginUiLease(lease);
  return JSON.stringify([
    captured.descriptor.pluginId,
    captured.contributionId,
  ]);
}

export function installedPluginGenerationSourcePin(
  input: PluginUiLease,
): InstalledPluginGenerationSourcePin {
  const lease = parsePluginUiLease(input);
  if (
    !lease.descriptor.requires.some(
      (requirement) =>
        requirement.service === CREWON_PROJECT_GENERATIONS_SERVICE &&
        requirement.apiVersion === CREWON_PROJECT_GENERATIONS_API_VERSION,
    )
  )
    uiFailure("plugin_ui_generation_family_unavailable");
  return Object.freeze({
    pluginId: lease.descriptor.pluginId,
    publisherId: lease.descriptor.publisherId,
    version: lease.descriptor.version,
    packageDigest: lease.packageDigest,
    selectionRevision: lease.selectionRevision,
    contributionId: lease.contributionId,
  });
}

/** One captured account owns the immutable intent, physical request and late acknowledgement. */
export function createInstalledPluginGenerationJournal(
  options: Readonly<{
    assertCurrent(): void;
    onDiagnostic(error: unknown): void;
  }>,
): InstalledPluginGenerationJournal {
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
    (intent: InstalledPluginGenerationIntent) => void
  >();
  let snapshot: readonly InstalledPluginGenerationIntent[] = Object.freeze([]);
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
    if (stopped) uiFailure("plugin_ui_generation_journal_inactive");
    try {
      assertPluginUiCurrent(assertCurrent);
      if (extra) assertPluginUiCurrent(extra);
    } catch (error) {
      invalidate();
      throw error;
    }
  };
  const view = (entry: Entry): InstalledPluginGenerationIntent =>
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
    });
  const publish = (entry: Entry) => {
    if (stopped || !entries.has(entry.input.idempotencyKey)) return;
    snapshot = Object.freeze([...entries.values()].reverse().map(view));
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
    if (entry.phase !== "accepted") entry.phase = "uncertain";
    entry.reasonCode = "plugin_ui_generation_intent_mismatch";
    publish(entry);
    return view(entry);
  };
  const requestFor = (input: ProjectGenerationUiInput) =>
    parseProjectGenerationUiActionRequest({
      action: PROJECT_GENERATION_UI_ACTIONS[0],
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
    raw?: ProjectGenerationUiInput,
  ): Entry | undefined => {
    const input = raw === undefined ? undefined : requestFor(raw).input;
    const familyKey = installedPluginGenerationFamilyKey(lease);
    const exact =
      input === undefined ? undefined : entries.get(input.idempotencyKey);
    const unresolved = activeFamily(familyKey);
    const found =
      exact ??
      unresolved ??
      [...entries.values()]
        .reverse()
        .find(
          (entry) =>
            entry.familyKey === familyKey &&
            (input === undefined ||
              (entry.phase === "accepted" &&
                same(entry.input.reference, input.reference))),
        );
    if (found === undefined) return undefined;
    let pin: InstalledPluginGenerationSourcePin;
    try {
      pin = installedPluginGenerationSourcePin(lease);
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
  }: Readonly<{ lease: PluginUiLease; input: ProjectGenerationUiInput }>) => {
    checkCurrent();
    const input = requestFor(raw).input;
    const existing = find(lease, input);
    if (existing !== undefined) {
      if (existing.blocked || !same(existing.input, input))
        uiFailure("plugin_ui_generation_intent_mismatch");
      return view(existing);
    }
    const sourcePin = installedPluginGenerationSourcePin(lease);
    if (entries.size >= MAX_INTENTS) {
      const retired = [...entries.values()].find(
        (entry) =>
          entry.physical === undefined &&
          (entry.phase === "accepted" || entry.phase === "refused"),
      );
      if (retired === undefined)
        uiFailure("plugin_ui_generation_journal_limit");
      entries.delete(retired.input.idempotencyKey);
    }
    const entry: Entry = {
      familyKey: installedPluginGenerationFamilyKey(lease),
      sourcePin,
      input,
      phase: "pending",
      receipt: null,
      reasonCode: null,
      blocked: false,
    };
    entries.set(input.idempotencyKey, entry);
    publish(entry);
    return view(entry);
  };
  const unknown = (entry: Entry) => {
    if (stopped || entry.phase === "accepted") return;
    entry.phase = "uncertain";
    if (!entry.blocked)
      entry.reasonCode = "plugin_ui_generation_result_unknown";
    publish(entry);
  };
  const refused = (entry: Entry, reasonCode: string) => {
    if (stopped || entry.phase === "accepted" || entry.blocked) return;
    entry.phase = "refused";
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
    current({ lease, input }) {
      checkCurrent();
      const found = find(lease, input);
      return found === undefined ? null : view(found);
    },
    register,
    getOrCreatePreparationOwner<T>(familyKey: string, factory: () => T): T {
      checkCurrent();
      if (
        typeof familyKey !== "string" ||
        familyKey.length < 1 ||
        familyKey.length > 512 ||
        typeof factory !== "function"
      )
        uiFailure("plugin_ui_generation_preparation_invalid");
      if (preparation.has(familyKey)) return preparation.get(familyKey) as T;
      if (preparation.size >= MAX_INTENTS)
        uiFailure("plugin_ui_generation_preparation_limit");
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
      const entry = entries.get(registered.input.idempotencyKey)!;
      if (
        entry.blocked ||
        !same(entry.input, checked.input) ||
        entry.input.idempotencyKey !== checked.input.idempotencyKey
      )
        uiFailure("plugin_ui_generation_intent_mismatch");
      if (entry.phase === "accepted")
        return { output: entry.receipt as PluginUiJsonValue };
      if (entry.phase === "refused")
        uiFailure("plugin_ui_generation_intent_refused");
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
          settled: false,
          work: undefined as unknown as Promise<InstalledPluginGenerationActionResponse>,
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
              uiFailure("plugin_ui_generation_lease_expired");
            let queuedPin: InstalledPluginGenerationSourcePin;
            try {
              queuedPin = installedPluginGenerationSourcePin(rawLease);
            } catch (error) {
              mismatch(entry);
              throw error;
            }
            if (!same(queuedPin, entry.sourcePin)) {
              mismatch(entry);
              uiFailure("plugin_ui_generation_intent_mismatch");
            }
            if (
              entries.get(entry.input.idempotencyKey) !== entry ||
              entry.blocked ||
              !same(parsePluginUiLease(rawLease), lease) ||
              !same(requestFor(raw).input, entry.input)
            )
              uiFailure("plugin_ui_generation_intent_mismatch");
            // Only this line transfers the request to the physical transport. Any subsequent error is UNKNOWN.
            actual.sent = true;
            const response = await request(actual.controller.signal);
            checkCurrent(extra);
            const receipt = parseProjectGenerationUiActionResponse(
              { action: PROJECT_GENERATION_UI_ACTIONS[0], input: entry.input },
              response.output,
            );
            entry.phase = "accepted";
            entry.receipt = receipt;
            entry.reasonCode = null;
            publish(entry);
            return { output: receipt };
          } catch (error) {
            if (actual.sent) unknown(entry);
            else
              refused(
                entry,
                error instanceof PluginUiLoaderError
                  ? error.code
                  : "plugin_ui_generation_pre_send_refused",
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
      return new Promise<InstalledPluginGenerationActionResponse>(
        (resolve, reject) => {
          let settled = false;
          const complete = (
            error: unknown,
            response?: InstalledPluginGenerationActionResponse,
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
