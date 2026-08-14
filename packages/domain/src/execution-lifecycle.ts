import { validateProviderTurnState } from "./provider-turn-state.ts";

export const RUN_STEP_KINDS = [
  "model",
  "tool",
  "agent",
  "workflowNode",
  "gate",
  "verification",
] as const;

export type RunStepKind = (typeof RUN_STEP_KINDS)[number];
export type RunStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "waitingApproval"
  | "completed"
  | "failed"
  | "skipped"
  | "canceled";
export type RunAttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "abandoned";

type RunAttemptCheckpointJsonValue =
  | null
  | boolean
  | number
  | string
  | RunAttemptCheckpointJsonValue[]
  | { [key: string]: RunAttemptCheckpointJsonValue };

/** Provider recovery checkpoint retained by the Domain execution authority. */
export type RunAttemptProviderCheckpoint = Readonly<{
  schemaVersion: "crewon.provider-checkpoint.v0";
  adapterName: string;
  adapterVersion: string;
  modelId: string;
  opaquePayload: Readonly<Record<string, RunAttemptCheckpointJsonValue>>;
}>;

export type RunStepState = Readonly<{
  schemaVersion: "crewon.run-step.v0";
  stepId: string;
  tenantId: string;
  runId: string;
  kind: RunStepKind;
  status: RunStepStatus;
  revision: number;
  currentAttemptId: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}>;

export type RunAttemptState = Readonly<{
  schemaVersion: "crewon.run-attempt.v0";
  attemptId: string;
  tenantId: string;
  runId: string;
  stepId: string;
  workItemId: string;
  attemptNumber: number;
  retryOfAttemptId: string | null;
  leaseEpoch: number;
  status: RunAttemptStatus;
  checkpointDigest: string | null;
  providerCheckpoint: RunAttemptProviderCheckpoint | null;
  providerTurnState: string | null;
  failure: Readonly<{ code: string; retryable: boolean }> | null;
  startedAt: string;
  updatedAt: string;
  terminalAt: string | null;
}>;

export class ExecutionLifecycleError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ExecutionLifecycleError";
    this.code = code;
  }
}

export function startRunAttempt(
  currentStep: RunStepState | null,
  currentAttempt: RunAttemptState | null,
  input: Readonly<{
    tenantId: string;
    runId: string;
    stepId: string;
    kind: RunStepKind;
    attemptId: string;
    workItemId: string;
    leaseEpoch: number;
    startedAt: string;
  }>,
): Readonly<{
  step: RunStepState;
  attempt: RunAttemptState;
  abandonedAttempt: RunAttemptState | null;
}> {
  validateStartInput(input);
  if (currentStep !== null) {
    validateCurrent(currentStep, currentAttempt, input);
  } else if (currentAttempt !== null) {
    throw new ExecutionLifecycleError("attempt_without_step");
  }
  const attemptNumber = (currentStep?.attemptCount ?? 0) + 1;
  const retryOfAttemptId = currentAttempt?.attemptId ?? null;
  const abandonedAttempt =
    currentAttempt?.status === "running"
      ? {
          ...currentAttempt,
          status: "abandoned" as const,
          updatedAt: input.startedAt,
          terminalAt: input.startedAt,
        }
      : null;
  const step: RunStepState = {
    schemaVersion: "crewon.run-step.v0",
    stepId: input.stepId,
    tenantId: input.tenantId,
    runId: input.runId,
    kind: input.kind,
    status: "running",
    revision: (currentStep?.revision ?? 0) + 1,
    currentAttemptId: input.attemptId,
    attemptCount: attemptNumber,
    createdAt: currentStep?.createdAt ?? input.startedAt,
    updatedAt: input.startedAt,
    terminalAt: null,
  };
  const attempt: RunAttemptState = {
    schemaVersion: "crewon.run-attempt.v0",
    attemptId: input.attemptId,
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.stepId,
    workItemId: input.workItemId,
    attemptNumber,
    retryOfAttemptId,
    leaseEpoch: input.leaseEpoch,
    status: "running",
    checkpointDigest: null,
    providerCheckpoint: null,
    providerTurnState: null,
    failure: null,
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
    terminalAt: null,
  };
  return { step, attempt, abandonedAttempt };
}

export function finishRunAttempt(
  step: RunStepState,
  attempt: RunAttemptState,
  input:
    | Readonly<{
        status: "completed" | "canceled";
        finishedAt: string;
        checkpointDigest: string | null;
      }>
    | Readonly<{
        status: "failed";
        finishedAt: string;
        checkpointDigest: string | null;
        failure: Readonly<{ code: string; retryable: boolean }>;
      }>,
): Readonly<{ step: RunStepState; attempt: RunAttemptState }> {
  try {
    validateProviderTurnState(attempt.providerTurnState);
  } catch {
    throw new ExecutionLifecycleError("attempt_provider_turn_state_invalid");
  }
  if (
    step.status !== "running" ||
    attempt.status !== "running" ||
    step.currentAttemptId !== attempt.attemptId ||
    step.stepId !== attempt.stepId ||
    step.runId !== attempt.runId ||
    step.tenantId !== attempt.tenantId
  ) {
    throw new ExecutionLifecycleError("attempt_not_current");
  }
  requireTimestamp(input.finishedAt, "attempt_finished_at_invalid");
  if (
    input.checkpointDigest !== null &&
    !/^sha256:[a-f0-9]{64}$/.test(input.checkpointDigest)
  ) {
    throw new ExecutionLifecycleError("attempt_checkpoint_digest_invalid");
  }
  const failure =
    input.status === "failed"
      ? {
          code: requireNonEmpty(input.failure.code, "attempt_failure_invalid"),
          retryable: input.failure.retryable,
        }
      : null;
  const stepStatus: RunStepStatus =
    input.status === "failed" && failure?.retryable ? "ready" : input.status;
  return {
    step: {
      ...step,
      status: stepStatus,
      revision: step.revision + 1,
      updatedAt: input.finishedAt,
      terminalAt: stepStatus === "ready" ? null : input.finishedAt,
    },
    attempt: {
      ...attempt,
      status: input.status,
      checkpointDigest: input.checkpointDigest,
      failure,
      updatedAt: input.finishedAt,
      terminalAt: input.finishedAt,
    },
  };
}

function validateCurrent(
  step: RunStepState,
  attempt: RunAttemptState | null,
  input: Parameters<typeof startRunAttempt>[2],
): void {
  if (
    step.tenantId !== input.tenantId ||
    step.runId !== input.runId ||
    step.stepId !== input.stepId ||
    step.kind !== input.kind ||
    step.currentAttemptId !== attempt?.attemptId ||
    step.attemptCount !== attempt.attemptNumber
  ) {
    throw new ExecutionLifecycleError("step_attempt_identity_mismatch");
  }
  if (step.status !== "running" && step.status !== "ready") {
    throw new ExecutionLifecycleError("step_terminal");
  }
  if (
    (attempt.status !== "running" && attempt.status !== "failed") ||
    (input.workItemId === attempt.workItemId &&
      input.leaseEpoch <= attempt.leaseEpoch)
  ) {
    throw new ExecutionLifecycleError("attempt_epoch_not_advanced");
  }
}

function validateStartInput(
  input: Parameters<typeof startRunAttempt>[2],
): void {
  for (const value of [
    input.tenantId,
    input.runId,
    input.stepId,
    input.attemptId,
    input.workItemId,
  ]) {
    requireNonEmpty(value, "attempt_identity_invalid");
  }
  if (!RUN_STEP_KINDS.includes(input.kind)) {
    throw new ExecutionLifecycleError("step_kind_invalid");
  }
  if (!Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch < 1) {
    throw new ExecutionLifecycleError("attempt_lease_epoch_invalid");
  }
  requireTimestamp(input.startedAt, "attempt_started_at_invalid");
}

function requireNonEmpty(value: string, code: string): string {
  if (value.trim().length === 0) {
    throw new ExecutionLifecycleError(code);
  }
  return value;
}

function requireTimestamp(value: string, code: string): void {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw new ExecutionLifecycleError(code);
  }
}
