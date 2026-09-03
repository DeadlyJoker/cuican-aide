export const MAX_WORKSPACE_CHANGE_PATHS = 256;
export const MAX_WORKSPACE_CHANGE_PATH_BYTES = 4_096;
export const MAX_WORKSPACE_CHANGE_PATHS_BYTES = 64 * 1_024;
export const MAX_WORKSPACE_CHANGE_SUMMARY_BYTES = 16 * 1_024;
export const MAX_THREAD_TASK_CHANGE_RUNS = 1_000;
export const MAX_THREAD_TASK_CHANGE_EVENTS = 100_000;
export const MAX_THREAD_TASK_CHANGE_RUN_ID_BYTES = 512;
export const MAX_THREAD_TASK_CHANGE_RUN_IDS_BYTES = 128 * 1_024;
export const MAX_THREAD_TASK_CHANGE_RESPONSE_BYTES = 256 * 1_024;

export type WorkspaceChangeSummary = Readonly<{
  schemaVersion: "crewon.workspace-change-summary.v0";
  paths: string[];
  additions: number;
  deletions: number;
  statsComplete: boolean;
}>;

/**
 * A bounded, revision-bound projection of completed native Workspace mutations
 * belonging to the effective (post-rollback) history of one Thread.
 */
export type ThreadTaskChangeLedgerResponse = Readonly<{
  schemaVersion: "crewon.thread-task-change-ledger.v0";
  threadId: string;
  /** Thread lifecycle revision used by the projection. */
  threadRevision: number;
  /** Durable Model History head used by the projection. */
  historySequence: number;
  /** Mirrors summary.statsComplete for fail-closed consumers. */
  complete: boolean;
  summary: WorkspaceChangeSummary;
  /** Number of matched native Tool requested/completed events. */
  eventCount: number;
  /** Effective terminal Turn Runs, ordered by first effective-history use. */
  includedRunIds: string[];
}>;

/**
 * Validates the bounded Git-visible edit ledger attached to one Tool
 * completion. Binary paths are retained while their line contribution is zero.
 */
export function parseWorkspaceChangeSummary(
  input: unknown,
): WorkspaceChangeSummary {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, [
      "additions",
      "deletions",
      "paths",
      "schemaVersion",
      "statsComplete",
    ]) ||
    input.schemaVersion !== "crewon.workspace-change-summary.v0" ||
    !Array.isArray(input.paths) ||
    !isNonNegativeSafeInteger(input.additions) ||
    !isNonNegativeSafeInteger(input.deletions) ||
    typeof input.statsComplete !== "boolean"
  ) {
    throw new Error("workspace_change_summary_invalid");
  }
  if (input.paths.length > MAX_WORKSPACE_CHANGE_PATHS) {
    throw new Error("workspace_change_summary_invalid");
  }
  const paths: string[] = [];
  let pathBytes = 0;
  for (const path of input.paths) {
    if (
      typeof path !== "string" ||
      path.length < 1 ||
      path.startsWith("/") ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error("workspace_change_summary_invalid");
    }
    const bytes = new TextEncoder().encode(path).byteLength;
    if (bytes > MAX_WORKSPACE_CHANGE_PATH_BYTES) {
      throw new Error("workspace_change_summary_invalid");
    }
    pathBytes += bytes;
    paths.push(path);
  }
  if (
    pathBytes > MAX_WORKSPACE_CHANGE_PATHS_BYTES ||
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => index > 0 && paths[index - 1]! >= path) ||
    (!input.statsComplete &&
      (paths.length !== 0 || input.additions !== 0 || input.deletions !== 0))
  ) {
    throw new Error("workspace_change_summary_invalid");
  }
  const summary: WorkspaceChangeSummary = {
    schemaVersion: input.schemaVersion,
    paths,
    additions: input.additions,
    deletions: input.deletions,
    statsComplete: input.statsComplete,
  };
  if (
    new TextEncoder().encode(JSON.stringify(summary)).byteLength >
    MAX_WORKSPACE_CHANGE_SUMMARY_BYTES
  ) {
    throw new Error("workspace_change_summary_invalid");
  }
  return summary;
}

export function parseThreadTaskChangeLedgerResponse(
  input: unknown,
): ThreadTaskChangeLedgerResponse {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, [
      "complete",
      "eventCount",
      "historySequence",
      "includedRunIds",
      "schemaVersion",
      "summary",
      "threadId",
      "threadRevision",
    ]) ||
    input.schemaVersion !== "crewon.thread-task-change-ledger.v0" ||
    !isBoundedIdentifier(input.threadId, 512) ||
    !isPositiveSafeInteger(input.threadRevision) ||
    !isNonNegativeSafeInteger(input.historySequence) ||
    !isNonNegativeSafeInteger(input.eventCount) ||
    input.eventCount > MAX_THREAD_TASK_CHANGE_EVENTS ||
    !Array.isArray(input.includedRunIds) ||
    input.includedRunIds.length > MAX_THREAD_TASK_CHANGE_RUNS ||
    typeof input.complete !== "boolean"
  ) {
    throw new Error("thread_task_change_ledger_invalid");
  }
  const includedRunIds: string[] = [];
  let runIdBytes = 0;
  for (const runId of input.includedRunIds) {
    if (!isBoundedIdentifier(runId, MAX_THREAD_TASK_CHANGE_RUN_ID_BYTES)) {
      throw new Error("thread_task_change_ledger_invalid");
    }
    runIdBytes += new TextEncoder().encode(runId).byteLength;
    includedRunIds.push(runId);
  }
  if (
    runIdBytes > MAX_THREAD_TASK_CHANGE_RUN_IDS_BYTES ||
    new Set(includedRunIds).size !== includedRunIds.length
  ) {
    throw new Error("thread_task_change_ledger_invalid");
  }
  let summary: WorkspaceChangeSummary;
  try {
    summary = parseWorkspaceChangeSummary(input.summary);
  } catch {
    throw new Error("thread_task_change_ledger_invalid");
  }
  if (
    input.complete !== summary.statsComplete ||
    (!summary.statsComplete &&
      (input.eventCount !== 0 || includedRunIds.length !== 0)) ||
    (summary.statsComplete && input.eventCount % 2 !== 0)
  ) {
    throw new Error("thread_task_change_ledger_invalid");
  }
  const response: ThreadTaskChangeLedgerResponse = {
    schemaVersion: input.schemaVersion,
    threadId: input.threadId,
    threadRevision: input.threadRevision,
    historySequence: input.historySequence,
    complete: input.complete,
    summary,
    eventCount: input.eventCount,
    includedRunIds,
  };
  if (
    new TextEncoder().encode(JSON.stringify(response)).byteLength >
    MAX_THREAD_TASK_CHANGE_RESPONSE_BYTES
  ) {
    throw new Error("thread_task_change_ledger_invalid");
  }
  return response;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isBoundedIdentifier(
  value: unknown,
  maxBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}
