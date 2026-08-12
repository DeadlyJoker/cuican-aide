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
import {
  ExecutionLifecycleError,
  finishRunAttempt,
  startRunAttempt,
  type RunAttemptState,
  type RunStepState,
  validateProviderTurnState,
} from "@crewon/domain";
import { type Pool, type PoolClient } from "pg";

import { stableJson } from "./store-invariants.ts";

type RunStepRow = Readonly<{
  tenant_id: string;
  run_id: string;
  step_id: string;
  kind: string;
  status: string;
  revision: string | number;
  current_attempt_id: string | null;
  attempt_count: string | number;
  state_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  terminal_at: Date | string | null;
}>;

type RunAttemptRow = Readonly<{
  tenant_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  work_item_id: string;
  attempt_number: string | number;
  retry_of_attempt_id: string | null;
  lease_epoch: string | number;
  status: string;
  state_json: unknown;
  started_at: Date | string;
  updated_at: Date | string;
  terminal_at: Date | string | null;
}>;

const STEP_COLUMNS = `tenant_id, run_id, step_id, kind, status, revision,
  current_attempt_id, attempt_count, state_json, created_at, updated_at, terminal_at`;
const ATTEMPT_COLUMNS = `tenant_id, run_id, step_id, attempt_id, work_item_id,
  attempt_number, retry_of_attempt_id, lease_epoch, status, state_json,
  started_at, updated_at, terminal_at`;

export async function loadPostgresRunStep(
  connection: Pool | PoolClient,
  schema: string,
  locator: RunStepLocator,
  lock = false,
): Promise<RunStepState | null> {
  const result = await connection.query<RunStepRow>(
    `SELECT ${STEP_COLUMNS} FROM ${table(schema, "run_steps")}
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3${lock ? " FOR UPDATE" : ""}`,
    [locator.tenantId, locator.runId, locator.stepId],
  );
  return result.rows[0] === undefined
    ? null
    : decodeRunStep(result.rows[0], locator);
}

export async function loadPostgresRunAttempt(
  connection: Pool | PoolClient,
  schema: string,
  locator: RunAttemptLocator,
  lock = false,
): Promise<RunAttemptState | null> {
  const result = await connection.query<RunAttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM ${table(schema, "run_attempts")}
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND attempt_id=$4${lock ? " FOR UPDATE" : ""}`,
    [locator.tenantId, locator.runId, locator.stepId, locator.attemptId],
  );
  return result.rows[0] === undefined
    ? null
    : decodeRunAttempt(result.rows[0], locator);
}

export async function listPostgresRunAttempts(
  connection: Pool | PoolClient,
  schema: string,
  locator: RunStepLocator,
  afterAttemptNumber: number,
  limit: number,
): Promise<readonly RunAttemptState[]> {
  const result = await connection.query<RunAttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM ${table(schema, "run_attempts")}
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND attempt_number>$4
     ORDER BY attempt_number ASC LIMIT $5`,
    [
      locator.tenantId,
      locator.runId,
      locator.stepId,
      afterAttemptNumber,
      limit,
    ],
  );
  return result.rows.map((row) =>
    decodeRunAttempt(row, { ...locator, attemptId: row.attempt_id }),
  );
}

export async function loadPostgresRunProviderTurnState(
  connection: Pool | PoolClient,
  schema: string,
  locator: Readonly<{ tenantId: string; runId: string }>,
): Promise<string | null> {
  const result = await connection.query<RunAttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM ${table(schema, "run_attempts")}
     WHERE tenant_id=$1 AND run_id=$2
     ORDER BY step_id ASC, attempt_number ASC`,
    [locator.tenantId, locator.runId],
  );
  const values = new Set<string>();
  for (const row of result.rows) {
    const state = decodeRunAttempt(row, {
      ...locator,
      stepId: row.step_id,
      attemptId: row.attempt_id,
    });
    if (state.providerTurnState !== null) values.add(state.providerTurnState);
  }
  if (values.size > 1) throw new RunStoreError("stored_run_attempt_invalid");
  return values.values().next().value ?? null;
}

export async function beginPostgresRunAttempt(
  client: PoolClient,
  schema: string,
  input: BeginRunAttemptInput,
): Promise<BeginRunAttemptResult> {
  const conflict = await client.query(
    `SELECT 1 FROM ${table(schema, "run_attempts")} WHERE attempt_id=$1`,
    [input.attemptId],
  );
  if (conflict.rowCount !== 0) throw new RunStoreError("attempt_id_conflict");
  const locator = {
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.stepId,
  };
  const currentStep = await loadPostgresRunStep(client, schema, locator, true);
  const currentAttempt =
    currentStep?.currentAttemptId === null || currentStep === null
      ? null
      : await loadPostgresRunAttempt(
          client,
          schema,
          { ...locator, attemptId: currentStep.currentAttemptId },
          true,
        );
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
  await writeRunStep(client, schema, currentStep, started.step);
  if (started.abandonedAttempt !== null) {
    await updateRunAttempt(client, schema, started.abandonedAttempt);
  }
  await insertRunAttempt(client, schema, started.attempt);
  return structuredClone(started);
}

export async function finishPostgresRunAttempt(
  client: PoolClient,
  schema: string,
  input: Readonly<{
    tenantId: string;
    runId: string;
    workItemId: string;
    leaseEpoch: number;
    attempt: RunAttemptTerminalMutation;
  }>,
): Promise<RunAttemptTransitionResult> {
  const locator = {
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.attempt.stepId,
    attemptId: input.attempt.attemptId,
  };
  const step = await loadPostgresRunStep(client, schema, locator, true);
  const attempt = await loadPostgresRunAttempt(client, schema, locator, true);
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
  await writeRunStep(client, schema, step, finished.step);
  await updateRunAttempt(client, schema, finished.attempt);
  return structuredClone(finished);
}

async function writeRunStep(
  client: PoolClient,
  schema: string,
  current: RunStepState | null,
  next: RunStepState,
): Promise<void> {
  if (current === null) {
    await client.query(
      `INSERT INTO ${table(schema, "run_steps")} (${STEP_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      stepValues(next),
    );
    return;
  }
  const updated = await client.query(
    `UPDATE ${table(schema, "run_steps")}
     SET status=$1, revision=$2, current_attempt_id=$3, attempt_count=$4,
         state_json=$5, updated_at=$6, terminal_at=$7
     WHERE tenant_id=$8 AND run_id=$9 AND step_id=$10 AND revision=$11`,
    [
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
    ],
  );
  if (updated.rowCount !== 1) {
    throw new RunStoreError("run_step_revision_conflict");
  }
}

async function insertRunAttempt(
  client: PoolClient,
  schema: string,
  attempt: RunAttemptState,
): Promise<void> {
  await client.query(
    `INSERT INTO ${table(schema, "run_attempts")} (${ATTEMPT_COLUMNS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    attemptValues(attempt),
  );
}

async function updateRunAttempt(
  client: PoolClient,
  schema: string,
  attempt: RunAttemptState,
): Promise<void> {
  const updated = await client.query(
    `UPDATE ${table(schema, "run_attempts")}
     SET status=$1, state_json=$2, updated_at=$3, terminal_at=$4
     WHERE tenant_id=$5 AND run_id=$6 AND step_id=$7 AND attempt_id=$8
       AND status='running'`,
    [
      attempt.status,
      stableJson(attempt),
      attempt.updatedAt,
      attempt.terminalAt,
      attempt.tenantId,
      attempt.runId,
      attempt.stepId,
      attempt.attemptId,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new RunStoreError("run_attempt_revision_conflict");
  }
}

export async function checkpointPostgresRunAttempt(
  client: PoolClient,
  schema: string,
  locator: RunAttemptLocator,
  workItemId: string,
  leaseEpoch: number,
  checkpoint: RunAttemptState["providerCheckpoint"],
  checkpointDigest: string,
  checkpointedAt: string,
): Promise<RunAttemptState> {
  const attempt = await loadPostgresRunAttempt(client, schema, locator, true);
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
  await updateRunAttempt(client, schema, next);
  return next;
}

export async function recordPostgresRunAttemptProviderTurnState(
  client: PoolClient,
  schema: string,
  locator: RunAttemptLocator,
  workItemId: string,
  leaseEpoch: number,
  providerTurnState: string,
  observedAt: string,
): Promise<RunAttemptState> {
  try {
    validateProviderTurnState(providerTurnState);
  } catch (error) {
    throw new RunStoreError("attempt_provider_turn_state_invalid", {
      cause: error,
    });
  }
  const attempt = await loadPostgresRunAttempt(client, schema, locator, true);
  if (attempt === null || attempt.status !== "running") {
    throw new RunStoreError("run_attempt_not_running");
  }
  if (attempt.workItemId !== workItemId || attempt.leaseEpoch !== leaseEpoch) {
    throw new RunStoreError("stale_attempt_epoch");
  }
  if (
    attempt.providerTurnState !== null &&
    attempt.providerTurnState !== providerTurnState
  ) {
    throw new RunStoreError("attempt_provider_turn_state_conflict");
  }
  if (attempt.providerTurnState === providerTurnState) return attempt;
  const next = { ...attempt, providerTurnState, updatedAt: observedAt };
  await updateRunAttempt(client, schema, next);
  return next;
}

function decodeRunStep(row: RunStepRow, locator: RunStepLocator): RunStepState {
  const state = stateObject<RunStepState>(row.state_json);
  if (
    state.schemaVersion !== "crewon.run-step.v0" ||
    state.tenantId !== row.tenant_id ||
    state.tenantId !== locator.tenantId ||
    state.runId !== row.run_id ||
    state.runId !== locator.runId ||
    state.stepId !== row.step_id ||
    state.stepId !== locator.stepId ||
    state.kind !== row.kind ||
    state.status !== row.status ||
    state.revision !== safeInteger(row.revision) ||
    state.currentAttemptId !== row.current_attempt_id ||
    state.attemptCount !== safeInteger(row.attempt_count) ||
    !sameTimestamp(state.createdAt, row.created_at) ||
    !sameTimestamp(state.updatedAt, row.updated_at) ||
    !sameNullableTimestamp(state.terminalAt, row.terminal_at)
  ) {
    throw new RunStoreError("stored_run_step_invalid");
  }
  return structuredClone(state);
}

function decodeRunAttempt(
  row: RunAttemptRow,
  locator: RunAttemptLocator,
): RunAttemptState {
  const parsed = stateObject<RunAttemptState>(row.state_json);
  const state = {
    ...parsed,
    providerCheckpoint: parsed.providerCheckpoint ?? null,
    providerTurnState: validateStoredProviderTurnState(
      parsed.providerTurnState,
    ),
  };
  if (
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
    state.attemptNumber !== safeInteger(row.attempt_number) ||
    state.retryOfAttemptId !== row.retry_of_attempt_id ||
    state.leaseEpoch !== safeInteger(row.lease_epoch) ||
    state.status !== row.status ||
    !validProviderCheckpoint(state.providerCheckpoint) ||
    !sameTimestamp(state.startedAt, row.started_at) ||
    !sameTimestamp(state.updatedAt, row.updated_at) ||
    !sameNullableTimestamp(state.terminalAt, row.terminal_at)
  ) {
    throw new RunStoreError("stored_run_attempt_invalid");
  }
  return structuredClone(state);
}

function validateStoredProviderTurnState(value: unknown): string | null {
  try {
    return validateProviderTurnState(value);
  } catch {
    throw new RunStoreError("stored_run_attempt_invalid");
  }
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

function stepValues(step: RunStepState): unknown[] {
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

function attemptValues(attempt: RunAttemptState): unknown[] {
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

function stateObject<T>(value: unknown): T {
  try {
    stableJson(value);
  } catch (error) {
    throw new RunStoreError("stored_execution_state_invalid", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunStoreError("stored_execution_state_invalid");
  }
  return value as T;
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

function safeInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RunStoreError("stored_integer_invalid");
  }
  return parsed;
}

function sameTimestamp(value: string, stored: Date | string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed === timestamp(stored);
}

function sameNullableTimestamp(
  value: string | null,
  stored: Date | string | null,
): boolean {
  return value === null
    ? stored === null
    : stored !== null && sameTimestamp(value, stored);
}

function timestamp(value: Date | string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new RunStoreError("postgres_timestamp_invalid");
  }
  return parsed;
}

function normalizeExecutionLifecycleError(error: unknown): Error {
  return error instanceof ExecutionLifecycleError
    ? new RunStoreError(error.code, { cause: error })
    : error instanceof Error
      ? error
      : new RunStoreError("execution_lifecycle_error", { cause: error });
}

function table(schema: string, name: string): string {
  return `${schema}."${name}"`;
}
