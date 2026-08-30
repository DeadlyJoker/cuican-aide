import type { RunView } from "@crewon/contracts";

const RUN_STATUSES = new Set([
  "queued",
  "running",
  "waitingApproval",
  "suspended",
  "reconciling",
  "completed",
  "failed",
  "canceled",
]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "canceled"]);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export class RunViewValidationError extends Error {
  constructor() {
    super("run_view_invalid");
    this.name = "RunViewValidationError";
  }
}

/** Strictly validates and normalizes one public Run projection. */
export function parseRunView(
  input: unknown,
  expectedThreadId?: string,
): RunView {
  if (!isPlainObject(input)) fail();
  const requiredKeys = [
    "cancelRequested",
    "collaborationMode",
    "createdAt",
    "failure",
    "goalBinding",
    "lastSequence",
    "outputRef",
    "revision",
    "runId",
    "status",
    "terminalAt",
    "threadId",
    "updatedAt",
    "waitingApproval",
    "workflowVersionBinding",
  ] as const;
  const actualKeys = Object.keys(input);
  if (
    requiredKeys.some((key) => !Object.hasOwn(input, key)) ||
    actualKeys.some(
      (key) =>
        key !== "purpose" && !(requiredKeys as readonly string[]).includes(key),
    )
  ) {
    fail();
  }

  const purpose = input.purpose ?? "turn";
  if (
    !isBoundedText(input.runId, 128) ||
    !isBoundedText(input.threadId, 128) ||
    (expectedThreadId !== undefined && input.threadId !== expectedThreadId) ||
    typeof input.status !== "string" ||
    !RUN_STATUSES.has(input.status) ||
    !Number.isSafeInteger(input.revision) ||
    Number(input.revision) < 1 ||
    !Number.isSafeInteger(input.lastSequence) ||
    input.lastSequence !== input.revision ||
    typeof input.cancelRequested !== "boolean" ||
    (input.collaborationMode !== "default" &&
      input.collaborationMode !== "plan") ||
    (purpose !== "turn" &&
      purpose !== "manualCompaction" &&
      purpose !== "workflow") ||
    !isTimestamp(input.createdAt) ||
    !isTimestamp(input.updatedAt) ||
    Date.parse(input.updatedAt) < Date.parse(input.createdAt)
  ) {
    fail();
  }

  validateWaitingApproval(input.waitingApproval, input.status);
  validateGoalBinding(input.goalBinding, input.collaborationMode, purpose);
  validateWorkflowVersionBinding(input.workflowVersionBinding, purpose);
  validateTerminalFields(input);

  return structuredClone({ ...input, purpose }) as RunView;
}

function validateWaitingApproval(value: unknown, status: unknown): void {
  if (value === null) {
    if (status === "waitingApproval") fail();
    return;
  }
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["approvalId"]) ||
    !isBoundedText(value.approvalId, 128) ||
    !["waitingApproval", "failed", "canceled"].includes(String(status))
  ) {
    fail();
  }
}

function validateGoalBinding(
  value: unknown,
  collaborationMode: unknown,
  purpose: unknown,
): void {
  if (purpose === "manualCompaction" && collaborationMode !== "default") {
    fail();
  }
  if (value === null) return;
  if (
    purpose !== "turn" ||
    collaborationMode !== "default" ||
    !isPlainObject(value) ||
    !hasExactKeys(value, ["goalId", "objectiveDigest", "revision"]) ||
    !isBoundedText(value.goalId, 128) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.objectiveDigest !== "string" ||
    !SHA256_PATTERN.test(value.objectiveDigest)
  ) {
    fail();
  }
}

/**
 * The workflow provenance is required and non-null exactly when the Run is a
 * workflow Run, mirroring the contract invariant.
 */
function validateWorkflowVersionBinding(value: unknown, purpose: unknown): void {
  if (purpose !== "workflow") {
    if (value !== null) fail();
    return;
  }
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["contentDigest", "workflowId", "workflowVersionId"]) ||
    !isBoundedText(value.workflowId, 128) ||
    !isBoundedText(value.workflowVersionId, 128) ||
    typeof value.contentDigest !== "string" ||
    !SHA256_PATTERN.test(value.contentDigest)
  ) {
    fail();
  }
}

function validateTerminalFields(input: Record<string, unknown>): void {
  const terminal = TERMINAL_RUN_STATUSES.has(String(input.status));
  if (
    (terminal && !isTimestamp(input.terminalAt)) ||
    (!terminal && input.terminalAt !== null) ||
    (terminal && input.terminalAt !== input.updatedAt) ||
    (input.outputRef !== null && !isBoundedText(input.outputRef, 512)) ||
    (input.status !== "completed" && input.outputRef !== null) ||
    (input.status === "canceled" && input.cancelRequested !== true) ||
    (["completed", "failed"].includes(String(input.status)) &&
      input.cancelRequested !== false)
  ) {
    fail();
  }
  if (input.status === "failed") {
    if (
      !isPlainObject(input.failure) ||
      !hasExactKeys(input.failure, ["code", "retryable"]) ||
      !isBoundedText(input.failure.code, 256) ||
      typeof input.failure.retryable !== "boolean"
    ) {
      fail();
    }
  } else if (input.failure !== null) {
    fail();
  }
}

function fail(): never {
  throw new RunViewValidationError();
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
