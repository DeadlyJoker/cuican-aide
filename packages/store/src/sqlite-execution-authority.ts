import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  ExecutionLifecycleError,
  finishRunAttempt,
  startRunAttempt,
  type RunAttemptState,
  type RunStepState,
} from "@crewon/domain";
import {
  parseExecutionProviderCheckpoint,
  RunStoreError,
  type BeginRunAttemptInput,
  type BeginRunAttemptResult,
  type RunAttemptLocator,
  type RunAttemptTerminalMutation,
  type RunAttemptTransitionResult,
  type RunStepLocator,
} from "@crewon/application";

import { stableJson } from "./store-invariants.ts";

type RunStepRow = Readonly<{
  tenant_id: string;
  run_id: string;
  step_id: string;
  kind: string;
  status: string;
  revision: number;
  current_attempt_id: string | null;
  attempt_count: number;
  state_json: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}>;

type RunAttemptRow = Readonly<{
  tenant_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  work_item_id: string;
  attempt_number: number;
  retry_of_attempt_id: string | null;
  lease_epoch: number;
  status: string;
  state_json: string;
  started_at: string;
  updated_at: string;
  terminal_at: string | null;
}>;

const STEP_COLUMNS = `
  tenant_id,
  run_id,
  step_id,
  kind,
  status,
  revision,
  current_attempt_id,
  attempt_count,
  state_json,
  created_at,
  updated_at,
  terminal_at`;

const ATTEMPT_COLUMNS = `
  tenant_id,
  run_id,
  step_id,
  attempt_id,
  work_item_id,
  attempt_number,
  retry_of_attempt_id,
  lease_epoch,
  status,
  state_json,
  started_at,
  updated_at,
  terminal_at`;

export function loadSqliteRunStep(
  database: DatabaseSync,
  locator: RunStepLocator,
): RunStepState | null {
  const row = database
    .prepare(
      `SELECT ${STEP_COLUMNS}
       FROM run_steps
       WHERE tenant_id = ? AND run_id = ? AND step_id = ?`,
    )
    .get(locator.tenantId, locator.runId, locator.stepId) as
    | RunStepRow
    | undefined;
  return row === undefined ? null : decodeRunStep(row, locator);
}

export function loadSqliteRunAttempt(
  database: DatabaseSync,
  locator: RunAttemptLocator,
): RunAttemptState | null {
  const row = database
    .prepare(
      `SELECT ${ATTEMPT_COLUMNS}
       FROM run_attempts
       WHERE tenant_id = ? AND run_id = ? AND step_id = ? AND attempt_id = ?`,
    )
    .get(locator.tenantId, locator.runId, locator.stepId, locator.attemptId) as
    | RunAttemptRow
    | undefined;
  return row === undefined ? null : decodeRunAttempt(row, locator);
}

export function listSqliteRunAttempts(
  database: DatabaseSync,
  locator: RunStepLocator,
  afterAttemptNumber: number,
  limit: number,
): readonly RunAttemptState[] {
  const rows = database
    .prepare(
      `SELECT ${ATTEMPT_COLUMNS}
       FROM run_attempts
       WHERE tenant_id = ?
         AND run_id = ?
         AND step_id = ?
         AND attempt_number > ?
       ORDER BY attempt_number ASC
       LIMIT ?`,
    )
    .all(
      locator.tenantId,
      locator.runId,
      locator.stepId,
      afterAttemptNumber,
      limit,
    ) as unknown as RunAttemptRow[];
  return rows.map((row) =>
    decodeRunAttempt(row, { ...locator, attemptId: row.attempt_id }),
  );
}

export function loadSqliteRunProviderTurnState(
  database: DatabaseSync,
  locator: Readonly<{ tenantId: string; runId: string }>,
): string | null {
  const rows = database
    .prepare(
      `SELECT ${ATTEMPT_COLUMNS} FROM run_attempts
       WHERE tenant_id = ? AND run_id = ?
       ORDER BY updated_at DESC, attempt_id DESC`,
    )
    .all(locator.tenantId, locator.runId) as unknown as RunAttemptRow[];
  for (const row of rows) {
    const state = decodeRunAttempt(row, {
      ...locator,
      stepId: row.step_id,
      attemptId: row.attempt_id,
    });
    if (state.providerTurnState !== null) return state.providerTurnState;
  }
  return null;
}

export function beginSqliteRunAttempt(
  database: DatabaseSync,
  input: BeginRunAttemptInput,
): BeginRunAttemptResult {
  if (
    database
      .prepare("SELECT 1 FROM run_attempts WHERE attempt_id = ?")
      .get(input.attemptId) !== undefined
  ) {
    throw new RunStoreError("attempt_id_conflict");
  }
  const locator: RunStepLocator = {
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.stepId,
  };
  const currentStep = loadSqliteRunStep(database, locator);
  const currentAttempt =
    currentStep?.currentAttemptId === null || currentStep === null
      ? null
      : loadSqliteRunAttempt(database, {
          ...locator,
          attemptId: currentStep.currentAttemptId,
        });
  if (currentStep !== null && currentAttempt === null) {
    throw new RunStoreError("stored_run_attempt_invalid");
  }

  let started: BeginRunAttemptResult;
  try {
    started = startRunAttempt(currentStep, currentAttempt, {
      tenantId: input.tenantId,
      runId: input.runId,
      stepId: input.stepId,
      kind: input.kind,
      attemptId: input.attemptId,
      workItemId: input.lease.workItemId,
      leaseEpoch: input.lease.leaseEpoch,
      startedAt: input.startedAt,
    });
  } catch (error) {
    throw normalizeExecutionLifecycleError(error);
  }

  writeRunStep(database, currentStep, started.step);
  if (started.abandonedAttempt !== null) {
    updateRunAttempt(database, started.abandonedAttempt);
  }
  insertRunAttempt(database, started.attempt);
  return started;
}

export function finishSqliteRunAttempt(
  database: DatabaseSync,
  input: Readonly<{
    tenantId: string;
    runId: string;
    workItemId: string;
    leaseEpoch: number;
    attempt: RunAttemptTerminalMutation;
  }>,
): RunAttemptTransitionResult {
  const locator: RunAttemptLocator = {
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.attempt.stepId,
    attemptId: input.attempt.attemptId,
  };
  const step = loadSqliteRunStep(database, locator);
  const attempt = loadSqliteRunAttempt(database, locator);
  if (step === null || attempt === null) {
    throw new RunStoreError("run_attempt_not_found");
  }
  if (
    attempt.leaseEpoch !== input.leaseEpoch ||
    attempt.workItemId !== input.workItemId
  ) {
    throw new RunStoreError("stale_attempt_epoch");
  }
  let finished: RunAttemptTransitionResult;
  try {
    finished = finishRunAttempt(
      step,
      {
        ...attempt,
        providerTurnState:
          input.attempt.providerTurnState ?? attempt.providerTurnState,
      },
      terminalInput(input.attempt),
    );
  } catch (error) {
    throw normalizeExecutionLifecycleError(error);
  }
  writeRunStep(database, step, finished.step);
  updateRunAttempt(database, finished.attempt);
  return finished;
}

function writeRunStep(
  database: DatabaseSync,
  current: RunStepState | null,
  next: RunStepState,
): void {
  if (current === null) {
    database
      .prepare(
        `INSERT INTO run_steps (${STEP_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...runStepValues(next));
    return;
  }
  const update = database
    .prepare(
      `UPDATE run_steps
       SET
         status = ?,
         revision = ?,
         current_attempt_id = ?,
         attempt_count = ?,
         state_json = ?,
         updated_at = ?,
         terminal_at = ?
       WHERE tenant_id = ? AND run_id = ? AND step_id = ? AND revision = ?`,
    )
    .run(
      next.status,
      next.revision,
      next.currentAttemptId,
      next.attemptCount,
      stableJson(next),
      next.updatedAt,
      next.terminalAt,
      next.tenantId,
      next.runId,
      next.stepId,
      current.revision,
    );
  if (update.changes !== 1) {
    throw new RunStoreError("run_step_revision_conflict");
  }
}

function insertRunAttempt(
  database: DatabaseSync,
  attempt: RunAttemptState,
): void {
  database
    .prepare(
      `INSERT INTO run_attempts (${ATTEMPT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...runAttemptValues(attempt));
}

function updateRunAttempt(
  database: DatabaseSync,
  attempt: RunAttemptState,
): void {
  const update = database
    .prepare(
      `UPDATE run_attempts
       SET status = ?, state_json = ?, updated_at = ?, terminal_at = ?
       WHERE tenant_id = ?
         AND run_id = ?
         AND step_id = ?
         AND attempt_id = ?
         AND status = 'running'`,
    )
    .run(
      attempt.status,
      stableJson(attempt),
      attempt.updatedAt,
      attempt.terminalAt,
      attempt.tenantId,
      attempt.runId,
      attempt.stepId,
      attempt.attemptId,
    );
  if (update.changes !== 1) {
    throw new RunStoreError("run_attempt_revision_conflict");
  }
}

export function checkpointSqliteRunAttempt(
  database: DatabaseSync,
  locator: RunAttemptLocator,
  workItemId: string,
  leaseEpoch: number,
  checkpoint: RunAttemptState["providerCheckpoint"],
  checkpointDigest: string,
  checkpointedAt: string,
): RunAttemptState {
  const attempt = loadSqliteRunAttempt(database, locator);
  if (attempt === null || attempt.status !== "running") {
    throw new RunStoreError("run_attempt_not_running");
  }
  if (attempt.workItemId !== workItemId || attempt.leaseEpoch !== leaseEpoch) {
    throw new RunStoreError("stale_attempt_epoch");
  }
  if (attempt.providerCheckpoint !== null) {
    throw new RunStoreError("attempt_provider_checkpoint_conflict");
  }
  const next = {
    ...attempt,
    providerCheckpoint: checkpoint,
    checkpointDigest,
    updatedAt: checkpointedAt,
  };
  updateRunAttempt(database, next);
  return next;
}

function runStepValues(step: RunStepState): readonly SQLInputValue[] {
  return [
    step.tenantId,
    step.runId,
    step.stepId,
    step.kind,
    step.status,
    step.revision,
    step.currentAttemptId,
    step.attemptCount,
    stableJson(step),
    step.createdAt,
    step.updatedAt,
    step.terminalAt,
  ];
}

function runAttemptValues(attempt: RunAttemptState): readonly SQLInputValue[] {
  return [
    attempt.tenantId,
    attempt.runId,
    attempt.stepId,
    attempt.attemptId,
    attempt.workItemId,
    attempt.attemptNumber,
    attempt.retryOfAttemptId,
    attempt.leaseEpoch,
    attempt.status,
    stableJson(attempt),
    attempt.startedAt,
    attempt.updatedAt,
    attempt.terminalAt,
  ];
}

function decodeRunStep(row: RunStepRow, locator: RunStepLocator): RunStepState {
  const state = parseState<RunStepState>(row.state_json);
  if (
    !isRecord(state) ||
    state.schemaVersion !== "crewon.run-step.v0" ||
    state.tenantId !== row.tenant_id ||
    state.tenantId !== locator.tenantId ||
    state.runId !== row.run_id ||
    state.runId !== locator.runId ||
    state.stepId !== row.step_id ||
    state.stepId !== locator.stepId ||
    state.kind !== row.kind ||
    state.status !== row.status ||
    state.revision !== row.revision ||
    state.currentAttemptId !== row.current_attempt_id ||
    state.attemptCount !== row.attempt_count ||
    state.createdAt !== row.created_at ||
    state.updatedAt !== row.updated_at ||
    state.terminalAt !== row.terminal_at ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 1 ||
    !Number.isSafeInteger(state.attemptCount) ||
    state.attemptCount < 0 ||
    (state.attemptCount === 0) !== (state.currentAttemptId === null) ||
    (state.currentAttemptId !== null &&
      !isNonEmptyString(state.currentAttemptId)) ||
    !isTimestamp(state.createdAt) ||
    !isTimestamp(state.updatedAt) ||
    !validStepTerminal(state.status, state.terminalAt)
  ) {
    throw new RunStoreError("stored_run_step_invalid");
  }
  return state;
}

function decodeRunAttempt(
  row: RunAttemptRow,
  locator: RunAttemptLocator,
): RunAttemptState {
  const parsed = parseState<RunAttemptState>(row.state_json);
  const state = {
    ...parsed,
    providerCheckpoint: parsed.providerCheckpoint ?? null,
    providerTurnState: parsed.providerTurnState ?? null,
  };
  if (
    !isRecord(state) ||
    state.schemaVersion !== "crewon.run-attempt.v0" ||
    state.tenantId !== row.tenant_id ||
    state.tenantId !== locator.tenantId ||
    state.runId !== row.run_id ||
    state.runId !== locator.runId ||
    state.stepId !== row.step_id ||
    state.stepId !== locator.stepId ||
    state.attemptId !== row.attempt_id ||
    state.attemptId !== locator.attemptId ||
    state.workItemId !== row.work_item_id ||
    state.attemptNumber !== row.attempt_number ||
    state.retryOfAttemptId !== row.retry_of_attempt_id ||
    state.leaseEpoch !== row.lease_epoch ||
    state.status !== row.status ||
    state.startedAt !== row.started_at ||
    state.updatedAt !== row.updated_at ||
    state.terminalAt !== row.terminal_at ||
    !Number.isSafeInteger(state.attemptNumber) ||
    state.attemptNumber < 1 ||
    (state.attemptNumber === 1) !== (state.retryOfAttemptId === null) ||
    (state.retryOfAttemptId !== null &&
      !isNonEmptyString(state.retryOfAttemptId)) ||
    !Number.isSafeInteger(state.leaseEpoch) ||
    state.leaseEpoch < 1 ||
    !validCheckpointDigest(state.checkpointDigest) ||
    !validProviderCheckpoint(state.providerCheckpoint) ||
    !validAttemptFailure(state.status, state.failure) ||
    !isTimestamp(state.startedAt) ||
    !isTimestamp(state.updatedAt) ||
    (state.status === "running") !== (state.terminalAt === null) ||
    (state.terminalAt !== null && !isTimestamp(state.terminalAt))
  ) {
    throw new RunStoreError("stored_run_attempt_invalid");
  }
  return state;
}

function validProviderCheckpoint(value: unknown): boolean {
  if (value === null) return true;
  try {
    parseExecutionProviderCheckpoint(value);
    return true;
  } catch {
    return false;
  }
}

function parseState<T>(json: string): T {
  try {
    const parsed: unknown = JSON.parse(json);
    stableJson(parsed);
    return parsed as T;
  } catch (error) {
    throw new RunStoreError("stored_execution_state_invalid", {
      cause: error,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.endsWith("Z") &&
    !Number.isNaN(Date.parse(value))
  );
}

function validCheckpointDigest(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value))
  );
}

function validAttemptFailure(status: string, value: unknown): boolean {
  if (status !== "failed") {
    return value === null;
  }
  return (
    isRecord(value) &&
    isNonEmptyString(value.code) &&
    typeof value.retryable === "boolean" &&
    Object.keys(value).length === 2
  );
}

function validStepTerminal(status: string, terminalAt: unknown): boolean {
  const terminal =
    status === "completed" ||
    status === "failed" ||
    status === "skipped" ||
    status === "canceled";
  return terminal ? isTimestamp(terminalAt) : terminalAt === null;
}

function normalizeExecutionLifecycleError(error: unknown): Error {
  return error instanceof ExecutionLifecycleError
    ? new RunStoreError(error.code, { cause: error })
    : error instanceof Error
      ? error
      : new RunStoreError("execution_lifecycle_error", { cause: error });
}

function terminalInput(
  input: RunAttemptTerminalMutation,
): Parameters<typeof finishRunAttempt>[2] {
  return input.status === "failed"
    ? {
        status: input.status,
        finishedAt: input.finishedAt,
        checkpointDigest: input.checkpointDigest,
        failure: input.failure,
      }
    : {
        status: input.status,
        finishedAt: input.finishedAt,
        checkpointDigest: input.checkpointDigest,
      };
}
