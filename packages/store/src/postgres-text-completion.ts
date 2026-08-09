import {
  parseExecutionProviderCheckpoint,
  RunStoreError,
  type CommitTextRunCompletionInput,
  type CommitTextRunCompletionResult,
  type ModelHistoryAppend,
} from "@crewon/application";
import {
  reduceRunLifecycleEvent,
  reduceThreadLifecycleEvent,
  validateModelHistoryItem,
  type RunState,
  type RunLifecycleEvent,
  type ThreadGoal,
  type ThreadState,
} from "@crewon/domain";
import { type PoolClient } from "pg";

import { finishPostgresRunAttempt } from "./postgres-execution-authority.ts";
import {
  writePostgresOutbox,
  writePostgresRunEvents,
  writePostgresRunSnapshot,
  writePostgresWorkItems,
} from "./postgres-run-writer.ts";
import {
  createPostgresThreadContinuation,
  writePostgresThreadContinuation,
} from "./postgres-thread-continuation.ts";
import { writePostgresThreadModelState } from "./postgres-thread-model-state.ts";
import {
  writePostgresMessages,
  writePostgresModelHistory,
  writePostgresThreadEvents,
  writePostgresThreadSnapshot,
} from "./postgres-thread-writer.ts";
import {
  stableJson,
  applyRunTerminalGoalMutation,
  reduceGoalContinuationRun,
  textCompletionHistoryAppend,
  validateEvents,
  validateMessages,
  validateOutbox,
  validateWorkItems,
  validateThreadEvents,
  validateTextRunPlanCorrelation,
} from "./store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";

export type PostgresTextCompletionAuthority = Readonly<{
  validateLease(): Promise<void>;
  loadRun(): Promise<RunState | null>;
  loadThread(): Promise<ThreadState | null>;
  loadGoal(): Promise<ThreadGoal | null>;
  writeGoal(goal: ThreadGoal | null): Promise<void>;
  validateHistory(history: ModelHistoryAppend): Promise<void>;
  completeWorkItem(): Promise<void>;
}>;

type ExecutionReceiptRow = Readonly<{
  tenant_id: string;
  run_id: string;
  fingerprint: string;
  result_json: unknown;
}>;

export async function commitPostgresTextRunCompletion(
  client: PoolClient,
  schema: string,
  input: CommitTextRunCompletionInput,
  runId: string,
  threadId: string,
  authority: PostgresTextCompletionAuthority,
): Promise<CommitTextRunCompletionResult> {
  const completionHistory = textCompletionHistoryAppend(input);
  await advisoryLock(
    client,
    `idempotency:${input.idempotency.scope}:${input.idempotency.key}`,
  );
  await advisoryLock(client, `run:${input.tenantId}:${runId}`);
  await advisoryLock(client, `thread:${input.tenantId}:${threadId}`);
  const prior = await loadExecutionReceipt(client, schema, input, threadId);
  if (prior !== null) {
    return { ...prior, disposition: "replayed" };
  }

  await authority.validateLease();
  const currentRun = await authority.loadRun();
  const currentThread = await authority.loadThread();
  if (
    currentRun === null ||
    currentThread === null ||
    currentRun.threadId !== threadId ||
    currentRun.spaceId !== currentThread.spaceId ||
    currentRun.agentVersionId !== input.continuation.agentVersionId
  ) {
    throw new RunStoreError("execution_authority_mismatch");
  }
  if (
    currentRun.revision !== input.run.expectedRevision ||
    currentThread.revision !== input.thread.expectedRevision
  ) {
    throw new RunStoreError("revision_conflict");
  }
  validateTextRunPlanCorrelation(input, currentRun);

  const runEventIds = await existingIds(
    client,
    schema,
    "run_events",
    "event_id",
    input.run.events.map((event) => event.eventId),
  );
  const threadEventIds = await existingIds(
    client,
    schema,
    "thread_events",
    "event_id",
    input.thread.events.map((event) => event.eventId),
  );
  const messageIds = await existingIds(
    client,
    schema,
    "messages",
    "message_id",
    input.thread.messages.map((message) => message.messageId),
  );
  const outboxIds = await existingIds(
    client,
    schema,
    "outbox",
    "message_id",
    input.run.outbox.map((message) => message.messageId),
  );
  validateEvents(input.run.events, runId, (id) => runEventIds.has(id));
  validateThreadEvents(input.thread.events, threadId, (id) =>
    threadEventIds.has(id),
  );
  validateMessages(
    input.thread.messages,
    input.thread.events,
    threadId,
    input.tenantId,
    (id) => messageIds.has(id),
  );
  validateOutbox(input.run.outbox, runId, input.tenantId, (id) =>
    outboxIds.has(id),
  );
  if (input.history.items.some((item) => item.runId !== runId)) {
    throw new RunStoreError("model_history_run_id_mismatch");
  }
  await authority.validateHistory(completionHistory);

  let nextRun: RunState | null = currentRun;
  for (const event of input.run.events) {
    nextRun = reduceRunLifecycleEvent(nextRun, event);
  }
  let nextThread: ThreadState | null = currentThread;
  for (const event of input.thread.events) {
    nextThread = reduceThreadLifecycleEvent(nextThread, event);
  }
  if (nextRun === null || nextThread === null) {
    throw new RunStoreError("text_completion_state_invalid");
  }
  const currentGoal = await authority.loadGoal();
  const nextGoal = applyRunTerminalGoalMutation(
    currentGoal,
    input.goal,
    currentRun,
    input.run.events.at(-1) as Extract<
      RunLifecycleEvent,
      { type: "run.completed" }
    >,
    input.run.events,
  );
  const nextContinuationRun = reduceGoalContinuationRun(
    input.goalContinuation,
    nextGoal,
    currentRun,
    input.run.events.at(-1)!.occurredAt,
    input.history.items.at(-1)!.sequence + 1,
  );
  if (nextContinuationRun !== null) {
    const runConflict = await client.query(
      `SELECT 1 FROM ${schema}.run_snapshots
       WHERE tenant_id=$1 AND run_id=$2`,
      [input.tenantId, nextContinuationRun.runId],
    );
    if (runConflict.rowCount !== 0) {
      throw new RunStoreError("goal_continuation_run_conflict");
    }
    const continuationEventIds = await existingIds(
      client,
      schema,
      "run_events",
      "event_id",
      input.goalContinuation!.events.map((event) => event.eventId),
    );
    const continuationOutboxIds = await existingIds(
      client,
      schema,
      "outbox",
      "message_id",
      input.goalContinuation!.outbox.map((message) => message.messageId),
    );
    const continuationWorkItemIds = await existingIds(
      client,
      schema,
      "work_items",
      "work_item_id",
      input.goalContinuation!.workItems.map((item) => item.workItemId),
    );
    validateEvents(
      input.goalContinuation!.events,
      nextContinuationRun.runId,
      (id) => continuationEventIds.has(id),
    );
    validateOutbox(
      input.goalContinuation!.outbox,
      nextContinuationRun.runId,
      input.tenantId,
      (id) => continuationOutboxIds.has(id),
    );
    validateWorkItems(
      input.goalContinuation!.workItems,
      nextContinuationRun.runId,
      input.tenantId,
      1,
      (id) => continuationWorkItemIds.has(id),
      "goalContinuation",
    );
  }

  const execution = await finishPostgresRunAttempt(client, schema, {
    tenantId: input.tenantId,
    runId,
    workItemId: input.lease.workItemId,
    leaseEpoch: input.lease.leaseEpoch,
    attempt: { ...input.attempt, status: "completed" },
  });
  await writePostgresRunSnapshot(
    client,
    schema,
    currentRun,
    nextRun,
    input.run.expectedRevision,
  );
  await writePostgresRunEvents(
    client,
    schema,
    input.run.events,
    input.tenantId,
  );
  await writePostgresOutbox(client, schema, input.run.outbox);
  await writePostgresThreadSnapshot(
    client,
    schema,
    currentThread,
    nextThread,
    input.thread.expectedRevision,
  );
  await writePostgresThreadEvents(
    client,
    schema,
    input.thread.events,
    input.tenantId,
  );
  await writePostgresMessages(client, schema, input.thread.messages);
  await writePostgresModelHistory(client, schema, completionHistory.items);
  if (nextGoal !== currentGoal) {
    await authority.writeGoal(nextGoal);
  }
  if (nextContinuationRun !== null) {
    await writePostgresRunSnapshot(
      client,
      schema,
      null,
      nextContinuationRun,
      0,
    );
    await writePostgresRunEvents(
      client,
      schema,
      input.goalContinuation!.events,
      input.tenantId,
    );
    await writePostgresOutbox(client, schema, input.goalContinuation!.outbox);
    await writePostgresWorkItems(
      client,
      schema,
      input.goalContinuation!.workItems,
    );
  }
  const continuation = createPostgresThreadContinuation(input);
  await writePostgresThreadContinuation(client, schema, input, continuation);
  await writePostgresThreadModelState(client, schema, input.modelState);
  await authority.completeWorkItem();

  const result: CommitTextRunCompletionResult = {
    disposition: "committed",
    runState: nextRun,
    threadState: nextThread,
    goalState: nextGoal,
    goalContinuation:
      nextContinuationRun === null
        ? null
        : {
            runState: nextContinuationRun,
            historyItem: input.goalContinuation!.historyItem,
            runEvents: input.goalContinuation!.events,
            outbox: input.goalContinuation!.outbox,
            workItems: input.goalContinuation!.workItems,
          },
    runEvents: input.run.events,
    threadEvents: input.thread.events,
    messages: input.thread.messages,
    historyItems: completionHistory.items,
    outbox: input.run.outbox,
    continuation,
    modelState: input.modelState,
    step: execution.step,
    attempt: execution.attempt,
  };
  await client.query(
    `INSERT INTO ${schema}.idempotency_receipts
       (tenant_id, scope, idempotency_key, run_id, fingerprint, result_json)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      input.tenantId,
      input.idempotency.scope,
      input.idempotency.key,
      runId,
      input.idempotency.requestFingerprint,
      stableJson(result),
    ],
  );
  return structuredClone(result);
}

async function loadExecutionReceipt(
  client: PoolClient,
  schema: string,
  input: CommitTextRunCompletionInput,
  threadId: string,
): Promise<CommitTextRunCompletionResult | null> {
  const result = await client.query<ExecutionReceiptRow>(
    `SELECT tenant_id, run_id, fingerprint, result_json
     FROM ${schema}.idempotency_receipts
     WHERE scope=$1 AND idempotency_key=$2`,
    [input.idempotency.scope, input.idempotency.key],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if (row.tenant_id !== input.tenantId) {
    throw new RunStoreError("tenant_id_mismatch");
  }
  if (row.fingerprint !== input.idempotency.requestFingerprint) {
    throw new RunStoreError("idempotency_conflict");
  }
  const raw = storedObject<CommitTextRunCompletionResult>(
    row.result_json,
    "execution_idempotency_receipt_invalid",
  );
  const stored = {
    ...raw,
    runState: normalizeStoredRunState(
      raw.runState,
      "execution_idempotency_receipt_invalid",
    ),
    ...(Object.hasOwn(raw, "goalState") ? {} : { goalState: null }),
    goalContinuation: Object.hasOwn(raw, "goalContinuation")
      ? normalizeStoredGoalContinuation(raw.goalContinuation)
      : null,
  };
  validateExecutionReceipt(stored, row, threadId);
  return structuredClone(stored);
}

function validateExecutionReceipt(
  result: CommitTextRunCompletionResult,
  row: ExecutionReceiptRow,
  threadId: string,
): void {
  if (
    result.disposition !== "committed" ||
    !isPlainObject(result.runState) ||
    !isPlainObject(result.threadState) ||
    result.runState.tenantId !== row.tenant_id ||
    result.runState.runId !== row.run_id ||
    result.runState.threadId !== threadId ||
    result.threadState.tenantId !== row.tenant_id ||
    result.threadState.threadId !== threadId ||
    !Array.isArray(result.runEvents) ||
    !Array.isArray(result.threadEvents) ||
    !Array.isArray(result.messages) ||
    !Array.isArray(result.historyItems) ||
    !Array.isArray(result.outbox) ||
    !isPlainObject(result.step) ||
    !isPlainObject(result.attempt) ||
    result.step.tenantId !== row.tenant_id ||
    result.step.runId !== row.run_id ||
    result.step.status !== "completed" ||
    result.attempt.tenantId !== row.tenant_id ||
    result.attempt.runId !== row.run_id ||
    result.attempt.stepId !== result.step.stepId ||
    result.attempt.status !== "completed" ||
    (result.continuation !== null && !isPlainObject(result.continuation)) ||
    (result.goalContinuation !== null &&
      (!isPlainObject(result.goalContinuation) ||
        !isPlainObject(result.goalContinuation.runState) ||
        !isPlainObject(result.goalContinuation.historyItem) ||
        !Array.isArray(result.goalContinuation.runEvents) ||
        !Array.isArray(result.goalContinuation.outbox) ||
        !Array.isArray(result.goalContinuation.workItems) ||
        result.goalContinuation.runState.tenantId !== row.tenant_id ||
        result.goalContinuation.historyItem.runId !==
          result.goalContinuation.runState.runId))
  ) {
    throw new RunStoreError("execution_idempotency_receipt_invalid");
  }
  for (const item of result.historyItems) {
    try {
      validateModelHistoryItem(item);
    } catch (error) {
      throw new RunStoreError("execution_idempotency_receipt_invalid", {
        cause: error,
      });
    }
    if (
      item.tenantId !== row.tenant_id ||
      item.threadId !== result.threadState.threadId
    ) {
      throw new RunStoreError("execution_idempotency_receipt_invalid");
    }
  }
  if (result.continuation !== null) {
    try {
      parseExecutionProviderCheckpoint(result.continuation.checkpoint);
    } catch (error) {
      throw new RunStoreError("execution_idempotency_receipt_invalid", {
        cause: error,
      });
    }
  }
}

async function existingIds(
  client: PoolClient,
  schema: string,
  table: "run_events" | "thread_events" | "messages" | "outbox" | "work_items",
  column: "event_id" | "message_id" | "work_item_id",
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const result = await client.query<{ id: string }>(
    `SELECT ${column} AS id FROM ${schema}."${table}"
     WHERE ${column}=ANY($1::text[])`,
    [ids],
  );
  return new Set(result.rows.map((row) => row.id));
}

function normalizeStoredGoalContinuation(
  value: CommitTextRunCompletionResult["goalContinuation"],
): CommitTextRunCompletionResult["goalContinuation"] {
  return value === null || !isPlainObject(value.runState)
    ? value
    : {
        ...value,
        runState: normalizeStoredRunState(
          value.runState,
          "execution_idempotency_receipt_invalid",
        ),
      };
}

function storedObject<T>(value: unknown, code: string): T {
  try {
    stableJson(value);
  } catch (error) {
    throw new RunStoreError(code, { cause: error });
  }
  if (!isPlainObject(value)) throw new RunStoreError(code);
  return value as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function advisoryLock(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
}
