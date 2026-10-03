import {
  parsePluginUiRecoveryHint,
  parsePluginUiRecoveryHintsResponse,
  PLUGIN_UI_RECOVERY_VERSION,
  type PluginUiRecoveryHint,
  type PluginUiRecoveryRequest,
  type PluginUiRecoverySourcePin,
} from "@crewon/contracts/plugins";
import { PluginUiLoaderError, uiFailure } from "./pluginUiValidation";

export type InstalledPluginRecoveryRestorePlan = Readonly<{
  commit(): void;
  publish(): void;
}>;
export type InstalledPluginRecoveryHistory = {
  dispatchMayHaveOccurred: boolean;
  dispatchAttemptCount: number;
  unknownSeen: boolean;
  recoveryRevision: number;
};
export const freshPluginUiRecoveryHistory =
  (): InstalledPluginRecoveryHistory => ({
    dispatchMayHaveOccurred: false,
    dispatchAttemptCount: 0,
    unknownSeen: false,
    recoveryRevision: 0,
  });

type RestorableEntry = InstalledPluginRecoveryHistory & {
  familyKey: string;
  sourcePin: PluginUiRecoverySourcePin;
  input: Readonly<{ idempotencyKey: string }>;
  phase: "pending" | "uncertain" | "accepted" | "refused";
  receipt: unknown;
  reasonCode: string | null;
  blocked: boolean;
  physical?: unknown;
};
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/** COMMIT and replay are two observations of the same immutable business receipt. */
export function pluginUiRecoveryReceiptsMatch(
  left: unknown,
  right: unknown,
): boolean {
  if (left === null || right === null) return left === right;
  const logical = (input: unknown) => {
    const { disposition: _disposition, ...identity } = input as Record<
      string,
      unknown
    >;
    return identity;
  };
  return same(logical(left), logical(right));
}

/** A verified terminal stage acknowledgement is distinct from an HTTP conflict. */
export class PluginUiRecoveryRefusedError extends PluginUiLoaderError {
  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = "PluginUiRecoveryRefusedError";
  }
}

/** Prepare every lane before committing any lane. No request or observer is run here. */
export function preparePluginUiRecoveryRestore<
  E extends RestorableEntry,
>(options: {
  hints: readonly PluginUiRecoveryHint[];
  action: PluginUiRecoveryRequest["action"];
  entries: Map<string, E>;
  create(hint: PluginUiRecoveryHint): E;
  key(entry: E): string;
  checkCurrent(): void;
  captureSnapshot(): void;
  publish(entry: E): void;
  failureCode: string;
  limit: number;
}): InstalledPluginRecoveryRestorePlan {
  options.checkCurrent();
  const baseline = [...options.entries].map(([key, entry]) => ({
    key,
    entry,
    physical: entry.physical,
    identity: JSON.stringify({ ...entry, physical: undefined }),
  }));
  const next = new Map(options.entries);
  const replacements: Array<Readonly<{ original?: E; next: E }>> = [];
  const hints = parsePluginUiRecoveryHintsResponse({
    version: PLUGIN_UI_RECOVERY_VERSION,
    intents: options.hints,
  }).intents;
  for (const raw of hints) {
    const hint = parsePluginUiRecoveryHint(raw);
    if (hint.request.action !== options.action) continue;
    const candidate = options.create(hint);
    const key = options.key(candidate);
    const existing = next.get(key);
    if (existing !== undefined) {
      if (
        !same(existing.input, candidate.input) ||
        !same(existing.sourcePin, candidate.sourcePin) ||
        existing.familyKey !== candidate.familyKey ||
        (existing.phase === "accepted" &&
          (candidate.phase !== "accepted" ||
            !pluginUiRecoveryReceiptsMatch(
              existing.receipt,
              candidate.receipt,
            ))) ||
        (existing.phase === "refused" && candidate.phase !== "refused")
      )
        uiFailure(options.failureCode);
      if (hint.revision < existing.recoveryRevision) continue;
      if (existing.phase === "accepted") candidate.receipt = existing.receipt;
      candidate.dispatchMayHaveOccurred ||= existing.dispatchMayHaveOccurred;
      candidate.dispatchAttemptCount = Math.max(
        candidate.dispatchAttemptCount,
        existing.dispatchAttemptCount,
      );
      candidate.unknownSeen ||= existing.unknownSeen;
      candidate.blocked ||= existing.blocked;
      if (existing.physical !== undefined) {
        // A hydration response cannot replace an account-owned physical request.
        candidate.physical = existing.physical;
        if (candidate.phase !== "accepted" && candidate.phase !== "refused") {
          candidate.phase = existing.phase;
          candidate.receipt = existing.receipt;
          candidate.reasonCode = existing.reasonCode;
        }
      }
      replacements.push({ original: existing, next: candidate });
    } else {
      const unresolved = [...next.values()].find(
        (entry) =>
          entry.familyKey === candidate.familyKey &&
          (entry.phase === "pending" || entry.phase === "uncertain"),
      );
      if (unresolved !== undefined) uiFailure(options.failureCode);
      if (next.size >= options.limit) {
        const retired = [...next.values()].find(
          (entry) =>
            entry.physical === undefined &&
            (entry.phase === "accepted" || entry.phase === "refused"),
        );
        if (retired === undefined) uiFailure(options.failureCode);
        next.delete(options.key(retired));
      }
      replacements.push({ next: candidate });
    }
    next.set(key, candidate);
  }
  let committed = false;
  return Object.freeze({
    commit() {
      if (committed) uiFailure(options.failureCode);
      options.checkCurrent();
      if (
        options.entries.size !== baseline.length ||
        baseline.some(
          ({ key, entry, physical, identity }) =>
            options.entries.get(key) !== entry ||
            entry.physical !== physical ||
            JSON.stringify({ ...entry, physical: undefined }) !== identity,
        )
      )
        uiFailure(options.failureCode);
      for (const { original, next: candidate } of replacements) {
        if (original !== undefined) Object.assign(original, candidate);
      }
      options.entries.clear();
      for (const [key, candidate] of next) {
        const replacement = replacements.find(
          (item) => item.next === candidate,
        );
        options.entries.set(key, replacement?.original ?? candidate);
      }
      options.captureSnapshot();
      committed = true;
    },
    publish() {
      if (!committed) uiFailure(options.failureCode);
      for (const { original, next: candidate } of replacements)
        options.publish(original ?? candidate);
    },
  });
}

export function restorePluginUiRecoveryHistory(
  hint: PluginUiRecoveryHint,
): InstalledPluginRecoveryHistory {
  return {
    dispatchMayHaveOccurred: hint.dispatchMayHaveOccurred,
    dispatchAttemptCount: hint.dispatchAttemptCount,
    // Even a prepared record is restored as UNKNOWN, never as a fresh local attempt.
    unknownSeen: hint.phase === "prepared" || hint.phase === "dispatched",
    recoveryRevision: hint.revision,
  };
}

/** Staging itself does not increment the business dispatch count. */
export function mergePluginUiRecoveryStageHistory(
  entry: InstalledPluginRecoveryHistory,
  hint: PluginUiRecoveryHint,
): void {
  entry.dispatchMayHaveOccurred ||= hint.dispatchMayHaveOccurred;
  entry.dispatchAttemptCount = Math.max(
    entry.dispatchAttemptCount,
    hint.dispatchAttemptCount,
  );
  entry.unknownSeen ||= hint.dispatchMayHaveOccurred;
  entry.recoveryRevision = Math.max(entry.recoveryRevision, hint.revision);
}

export function capturePluginUiRecoveryStage(
  input: PluginUiRecoveryHint,
  request: PluginUiRecoveryRequest,
  sourcePin: PluginUiRecoverySourcePin,
): PluginUiRecoveryHint {
  const hint = parsePluginUiRecoveryHint(input);
  if (!same(hint.request, request) || !same(hint.sourcePin, sourcePin))
    uiFailure("plugin_ui_recovery_stage_mismatch");
  return hint;
}
