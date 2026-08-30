import {
  RunStoreError,
  evaluateGoalToolCall,
  type CommitToolExecutionCompletionInput,
  type CommitToolExecutionCompletionResult,
  type CommitToolExecutionUnknownOutcomeInput,
  type CommitToolExecutionUnknownOutcomeResult,
  type CommitTextRunCompletionInput,
  type CommitTextRunCompletionResult,
  type PrepareToolExecutionInput,
  type ThreadContinuationCheckpoint,
  type ThreadContinuationLocator,
  type ThreadModelState,
  type ToolExecutionActionLocator,
  type ToolExecutionReceiptLocator,
  type TransitionToolExecutionInput,
  type RunExecutionStore,
  type GoalToolExecutionInput,
  type GoalToolExecutionResult,
  type GoalToolStore,
  type ToolExecutionStore,
} from "@crewon/application";
import {
  ThreadGoalError,
  validateThreadGoal,
  type RunState,
  type ThreadGoal,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import type { PoolClient } from "pg";

import { PostgresAttemptStore } from "./postgres-attempt-store.ts";
import {
  finishPostgresRunAttempt,
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import { type PostgresThreadStoreOptions } from "./postgres-thread-store.ts";
import {
  decodePostgresRunEvent,
  type PostgresRunEventRow,
  type PostgresRunReceiptRow,
} from "./postgres-run-codec.ts";
import { commitPostgresTextRunCompletion } from "./postgres-text-completion.ts";
import { loadPostgresThreadContinuation } from "./postgres-thread-continuation.ts";
import { loadPostgresThreadModelState } from "./postgres-thread-model-state.ts";
import {
  writePostgresOutbox,
  writePostgresRunEvents,
  writePostgresRunSnapshot,
} from "./postgres-run-writer.ts";
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import {
  insertPostgresToolExecutionReceipt,
  loadPostgresToolExecutionReceipt,
  loadPostgresToolExecutionReceiptByAction,
  updatePostgresToolExecutionReceipt,
} from "./postgres-tool-execution.ts";
import {
  applyToolExecutionTransition,
  applyToolExecutionUnknownOutcome,
  applyToolCompletionGoalMutation,
  applyTurnStartGoalMutation,
  prepareGoalToolAccounting,
  stableJson,
  validateEvents,
  validateGoalToolExecutionInput,
  validateGoalToolRequestedEvent,
  validateOutbox,
  validatePrepareToolExecutionInput,
  validateTextRunCompletionInput,
  validateThreadContinuationLocator,
  validateToolExecutionActionLocator,
  validateToolExecutionCompletionInput,
  validateToolExecutionCompletionReplay,
  validateToolExecutionReceiptLocator,
  validateToolExecutionUnknownOutcomeInput,
  validateTransitionToolExecutionInput,
} from "./store-invariants.ts";

/** PostgreSQL compound execution authority consumed by Runtime Workers. */
export class PostgresExecutionStore
  extends PostgresAttemptStore
  implements RunExecutionStore, ToolExecutionStore, GoalToolStore
{
  static override async open(
    options: PostgresThreadStoreOptions,
  ): Promise<PostgresExecutionStore> {
    const store = new PostgresExecutionStore(options);
    try {
      await store.migrate();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async loadThreadModelState(
    locator: Readonly<{ tenantId: string; threadId: string }>,
  ): Promise<ThreadModelState | null> {
    this.assertOpen();
    if (
      locator.tenantId.trim().length === 0 ||
      locator.threadId.trim().length === 0
    ) {
      throw new RunStoreError("thread_model_state_locator_invalid");
    }
    try {
      return await loadPostgresThreadModelState(
        this.pool,
        this.schemaSql(),
        locator,
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadThreadContinuation(
    locator: ThreadContinuationLocator,
  ): Promise<ThreadContinuationCheckpoint | null> {
    this.assertOpen();
    validateThreadContinuationLocator(locator);
    try {
      return await loadPostgresThreadContinuation(
        this.pool,
        this.schemaSql(),
        locator,
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async executeGoalTool(
    input: GoalToolExecutionInput,
  ): Promise<GoalToolExecutionResult> {
    this.assertOpen();
    validateGoalToolExecutionInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(
        client,
        `idempotency:${input.idempotency.scope}:${input.idempotency.key}`,
      );
      const receipt = await client.query<PostgresRunReceiptRow>(
        `SELECT tenant_id, run_id, fingerprint, result_json
         FROM ${this.schemaSql()}.idempotency_receipts
         WHERE scope=$1 AND idempotency_key=$2`,
        [input.idempotency.scope, input.idempotency.key],
      );
      const prior = receipt.rows[0];
      if (prior !== undefined) {
        if (prior.tenant_id !== input.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.run_id !== input.runId) {
          throw new RunStoreError("goal_tool_receipt_invalid");
        }
        if (prior.fingerprint !== input.idempotency.requestFingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const result = decodePostgresGoalToolResult(prior, {
          runId: input.runId,
          threadId: input.threadId,
        });
        await client.query("COMMIT");
        return structuredClone({ ...result, disposition: "replayed" });
      }
      await advisoryLock(client, `run:${input.tenantId}:${input.runId}`);
      await this.validateExecutionLeaseWithin(
        client,
        input.tenantId,
        input.runId,
        input.lease,
      );
      const run = await this.loadRunWithin(
        client,
        { tenantId: input.tenantId, runId: input.runId },
        true,
      );
      if (run === null || run.threadId !== input.threadId) {
        throw new RunStoreError("run_not_found");
      }
      await advisoryLock(client, `thread:${run.tenantId}:${run.threadId}`);
      const events = await client.query<PostgresRunEventRow>(
        `SELECT tenant_id, run_id, sequence, event_id, event_json
         FROM ${this.schemaSql()}.run_events
         WHERE tenant_id=$1 AND run_id=$2
         ORDER BY sequence ASC`,
        [input.tenantId, input.runId],
      );
      const requested = events.rows
        .map((row) =>
          decodePostgresRunEvent(row, {
            tenantId: input.tenantId,
            runId: input.runId,
          }),
        )
        .find(
          (event) =>
            event.type === "tool.requested" &&
            event.data.callId === input.request.callId,
        );
      validateGoalToolRequestedEvent(input, requested ?? null);
      const current = await this.loadThreadGoalWithin(
        client,
        { tenantId: input.tenantId, threadId: input.threadId },
        true,
      );
      const evaluation = evaluateGoalToolCall(
        current,
        run,
        input.request.name,
        input.request.input,
        input.occurredAt,
        input.proposedGoalId,
      );
      const next = applyTurnStartGoalMutation(current, evaluation.mutation, {
        tenantId: input.tenantId,
        threadId: input.threadId,
      });
      const accounting = prepareGoalToolAccounting(input, run, evaluation);
      validateEvents(accounting.runEvents, run.runId, () => false);
      validateOutbox(accounting.outbox, run.runId, run.tenantId, () => false);
      await this.writeTurnStartGoalWithin(client, evaluation.mutation, next, {
        tenantId: input.tenantId,
        threadId: input.threadId,
      });
      if (accounting.runEvents.length > 0) {
        await writePostgresRunSnapshot(
          client,
          this.schemaSql(),
          run,
          accounting.runState,
          run.revision,
        );
        await writePostgresRunEvents(
          client,
          this.schemaSql(),
          accounting.runEvents,
          input.tenantId,
        );
        await writePostgresOutbox(client, this.schemaSql(), accounting.outbox);
      }
      const result: GoalToolExecutionResult = {
        disposition: "committed",
        goalState: next,
        runState: accounting.runState,
        runEvents: accounting.runEvents,
        outbox: accounting.outbox,
        output: evaluation.output,
        isError: evaluation.isError,
      };
      await client.query(
        `INSERT INTO ${this.schemaSql()}.idempotency_receipts
           (tenant_id, scope, idempotency_key, run_id, fingerprint, result_json)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          input.runId,
          input.idempotency.requestFingerprint,
          stableJson(result),
        ],
      );
      await client.query("COMMIT");
      return structuredClone(result);
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(
        error instanceof ThreadGoalError
          ? new RunStoreError(error.code, { cause: error })
          : error,
      );
    } finally {
      client.release();
    }
  }

  async commitTextRunCompletion(
    input: CommitTextRunCompletionInput,
  ): Promise<CommitTextRunCompletionResult> {
    this.assertOpen();
    const { runId, threadId } = validateTextRunCompletionInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await commitPostgresTextRunCompletion(
        client,
        this.schemaSql(),
        input,
        runId,
        threadId,
        {
          validateLease: () =>
            this.validateExecutionLeaseWithin(
              client,
              input.tenantId,
              runId,
              input.lease,
            ),
          loadRun: () =>
            this.loadRunWithin(
              client,
              { tenantId: input.tenantId, runId },
              true,
            ),
          loadThread: () =>
            this.loadThreadWithin(
              client,
              { tenantId: input.tenantId, threadId },
              true,
            ),
          loadGoal: () =>
            this.loadThreadGoalWithin(
              client,
              { tenantId: input.tenantId, threadId },
              true,
            ),
          writeGoal: (goal) =>
            this.writeTurnStartGoalWithin(client, input.goal, goal, {
              tenantId: input.tenantId,
              threadId,
            }),
          validateHistory: (history) =>
            this.validateModelHistoryWithin(
              client,
              { tenantId: input.tenantId, threadId },
              history,
            ),
          completeWorkItem: () =>
            this.completeWorkItemWithin(
              client,
              input.tenantId,
              runId,
              input.lease,
            ),
        },
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async loadToolExecutionReceipt(
    locator: ToolExecutionReceiptLocator,
  ): Promise<ToolExecutionReceiptState | null> {
    this.assertOpen();
    validateToolExecutionReceiptLocator(locator);
    try {
      return await loadPostgresToolExecutionReceipt(
        this.pool,
        this.schemaSql(),
        locator,
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadToolExecutionReceiptByAction(
    locator: ToolExecutionActionLocator,
  ): Promise<ToolExecutionReceiptState | null> {
    this.assertOpen();
    validateToolExecutionActionLocator(locator);
    try {
      return await loadPostgresToolExecutionReceiptByAction(
        this.pool,
        this.schemaSql(),
        locator,
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async prepareToolExecution(
    input: PrepareToolExecutionInput,
  ): Promise<ToolExecutionReceiptState> {
    this.assertOpen();
    validatePrepareToolExecutionInput(input);
    const { receipt } = input;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(client, `run:${receipt.tenantId}:${receipt.runId}`);
      await this.validateExecutionLeaseWithin(
        client,
        receipt.tenantId,
        receipt.runId,
        input.lease,
      );
      const step = await loadPostgresRunStep(
        client,
        this.schemaSql(),
        receipt,
        true,
      );
      const attempt = await loadPostgresRunAttempt(
        client,
        this.schemaSql(),
        receipt,
        true,
      );
      if (
        step?.currentAttemptId !== receipt.attemptId ||
        attempt?.status !== "running" ||
        attempt.workItemId !== receipt.workItemId
      ) {
        throw new RunStoreError("tool_receipt_attempt_not_current");
      }
      await insertPostgresToolExecutionReceipt(
        client,
        this.schemaSql(),
        receipt,
      );
      await this.validateExecutionLeaseWithin(
        client,
        receipt.tenantId,
        receipt.runId,
        input.lease,
      );
      await client.query("COMMIT");
      return structuredClone(receipt);
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async transitionToolExecution(
    input: TransitionToolExecutionInput,
  ): Promise<ToolExecutionReceiptState> {
    this.assertOpen();
    validateTransitionToolExecutionInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(client, `run:${input.tenantId}:${input.runId}`);
      await this.validateExecutionLeaseWithin(
        client,
        input.tenantId,
        input.runId,
        input.lease,
      );
      const current = await loadPostgresToolExecutionReceipt(
        client,
        this.schemaSql(),
        input,
        true,
      );
      if (current === null) {
        throw new RunStoreError("tool_receipt_not_found");
      }
      const next = applyToolExecutionTransition(current, input);
      await updatePostgresToolExecutionReceipt(
        client,
        this.schemaSql(),
        current,
        next,
      );
      await client.query("COMMIT");
      return structuredClone(next);
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async commitToolExecutionCompletion(
    input: CommitToolExecutionCompletionInput,
  ): Promise<CommitToolExecutionCompletionResult> {
    this.assertOpen();
    const runId = validateToolExecutionCompletionInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPostgresRunCommit(client, input.commit);
      await this.validateExecutionLeaseWithin(
        client,
        input.commit.tenantId,
        runId,
        input.lease,
      );
      const current = await loadPostgresToolExecutionReceipt(
        client,
        this.schemaSql(),
        input.receipt,
        true,
      );
      if (current === null) {
        throw new RunStoreError("tool_receipt_not_found");
      }
      validateCompletionAttempt(current, input);
      const prior = await this.loadRunReceiptWithin(client, input.commit);
      if (prior !== null) {
        const run = await this.commitRunWithin(client, input.commit, {
          executionLease: input.lease,
          history: input.history,
        });
        const replay = validateToolExecutionCompletionReplay(
          input,
          current,
          await loadPostgresRunStep(client, this.schemaSql(), current, true),
          await loadPostgresRunAttempt(client, this.schemaSql(), current, true),
        );
        await client.query("COMMIT");
        return structuredClone({ run, receipt: current, ...replay });
      }
      const currentRun = await this.loadRunWithin(
        client,
        { tenantId: input.commit.tenantId, runId },
        true,
      );
      if (currentRun === null) throw new RunStoreError("run_not_found");
      await advisoryLock(
        client,
        `thread:${currentRun.tenantId}:${currentRun.threadId}`,
      );
      const currentGoal = await this.loadThreadGoalWithin(
        client,
        {
          tenantId: currentRun.tenantId,
          threadId: currentRun.threadId,
        },
        true,
      );
      const nextGoal = applyToolCompletionGoalMutation(
        currentGoal,
        input,
        currentRun,
      );
      const receipt = applyToolExecutionTransition(current, {
        tenantId: input.receipt.tenantId,
        runId: input.receipt.runId,
        receiptId: input.receipt.receiptId,
        lease: input.lease,
        expectedRevision: input.receipt.expectedRevision,
        transition: {
          kind: "complete",
          occurredAt: input.receipt.resolvedAt,
          providerReceiptId: input.receipt.providerReceiptId,
          result: input.receipt.result,
        },
      });
      const execution = await finishPostgresRunAttempt(
        client,
        this.schemaSql(),
        {
          tenantId: input.commit.tenantId,
          runId,
          workItemId: input.lease.workItemId,
          leaseEpoch: input.lease.leaseEpoch,
          attempt: {
            ...input.attempt,
            status: "completed",
            checkpointDigest: null,
          },
        },
      );
      const run = await this.commitRunWithin(client, input.commit, {
        executionLease: input.lease,
        history: input.history,
      });
      if (run.disposition === "committed" && nextGoal !== currentGoal) {
        await this.writeTurnStartGoalWithin(client, input.goal, nextGoal, {
          tenantId: currentRun.tenantId,
          threadId: currentRun.threadId,
        });
      }
      await updatePostgresToolExecutionReceipt(
        client,
        this.schemaSql(),
        current,
        receipt,
      );
      await client.query("COMMIT");
      return structuredClone({
        run,
        receipt,
        step: execution.step,
        attempt: execution.attempt,
      });
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async commitToolExecutionUnknownOutcome(
    input: CommitToolExecutionUnknownOutcomeInput,
  ): Promise<CommitToolExecutionUnknownOutcomeResult> {
    this.assertOpen();
    const runId = validateToolExecutionUnknownOutcomeInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPostgresRunCommit(client, input.commit);
      await this.validateExecutionLeaseWithin(
        client,
        input.commit.tenantId,
        runId,
        input.lease,
      );
      const current = await loadPostgresToolExecutionReceipt(
        client,
        this.schemaSql(),
        input.receipt,
        true,
      );
      if (current === null) {
        throw new RunStoreError("tool_receipt_not_found");
      }
      const receipt = applyToolExecutionUnknownOutcome(current, input);
      const execution = await finishPostgresRunAttempt(
        client,
        this.schemaSql(),
        {
          tenantId: input.commit.tenantId,
          runId,
          workItemId: input.lease.workItemId,
          leaseEpoch: input.lease.leaseEpoch,
          attempt: {
            ...input.attempt,
            status: "failed",
            checkpointDigest: null,
            failure: { code: "tool_outcome_unknown", retryable: true },
          },
        },
      );
      const run = await this.commitRunWithin(client, input.commit, {
        executionLease: input.lease,
      });
      if (receipt !== current) {
        await updatePostgresToolExecutionReceipt(
          client,
          this.schemaSql(),
          current,
          receipt,
        );
      }
      await this.retryWorkItemWithin(
        client,
        input.commit.tenantId,
        runId,
        input.lease,
        input.retryAfterMs,
        "tool_outcome_unknown",
      );
      await client.query("COMMIT");
      return structuredClone({
        run,
        receipt,
        step: execution.step,
        attempt: execution.attempt,
      });
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }
}

function validateCompletionAttempt(
  current: ToolExecutionReceiptState,
  input: CommitToolExecutionCompletionInput,
): void {
  const completed = input.commit.events.find(
    (event) => event.type === "tool.completed",
  );
  if (
    current.stepId !== input.attempt.stepId ||
    completed?.type !== "tool.completed" ||
    current.call.segmentId !== completed.data.segmentId ||
    current.call.callId !== completed.data.callId ||
    current.call.kind !== completed.data.kind ||
    current.call.name !== completed.data.name
  ) {
    throw new RunStoreError("tool_completion_attempt_mismatch");
  }
}

function decodePostgresGoalToolResult(
  row: PostgresRunReceiptRow,
  expected: Readonly<{ runId: string; threadId: string }>,
): GoalToolExecutionResult {
  try {
    stableJson(row.result_json);
  } catch (error) {
    throw new RunStoreError("goal_tool_receipt_invalid", { cause: error });
  }
  const value = row.result_json;
  if (
    !isPlainObject(value) ||
    value.disposition !== "committed" ||
    typeof value.output !== "string" ||
    new TextEncoder().encode(value.output).byteLength > 40_000 ||
    typeof value.isError !== "boolean" ||
    !isPlainObject(value.runState) ||
    value.runState.tenantId !== row.tenant_id ||
    value.runState.runId !== row.run_id ||
    value.runState.runId !== expected.runId ||
    value.runState.threadId !== expected.threadId ||
    !Array.isArray(value.runEvents) ||
    !Array.isArray(value.outbox) ||
    (value.goalState !== null &&
      (!isPlainObject(value.goalState) ||
        value.goalState.tenantId !== row.tenant_id ||
        value.goalState.threadId !== expected.threadId))
  ) {
    throw new RunStoreError("goal_tool_receipt_invalid");
  }
  if (value.goalState !== null) {
    try {
      validateThreadGoal(value.goalState as ThreadGoal);
    } catch (error) {
      throw new RunStoreError("goal_tool_receipt_invalid", { cause: error });
    }
  }
  const runState = normalizeStoredRunState(
    value.runState as RunState,
    "goal_tool_receipt_invalid",
  );
  validateEvents(
    value.runEvents as GoalToolExecutionResult["runEvents"],
    runState.runId,
    () => false,
  );
  validateOutbox(
    value.outbox as GoalToolExecutionResult["outbox"],
    runState.runId,
    row.tenant_id,
    () => false,
  );
  const runEvents = value.runEvents as GoalToolExecutionResult["runEvents"];
  const outbox = value.outbox as GoalToolExecutionResult["outbox"];
  const accountingEvent = runEvents[0];
  const accountingOutbox = outbox[0];
  if (
    runEvents.length !== outbox.length ||
    runEvents.length > 1 ||
    (accountingEvent !== undefined &&
      (accountingEvent.type !== "run.goal.accounting.updated" ||
        accountingEvent.sequence !== runState.lastSequence ||
        stableJson(accountingEvent.data.next) !==
          stableJson(runState.goalAccounting) ||
        accountingOutbox?.topic !== "run.updated" ||
        accountingOutbox.createdAt !== accountingEvent.occurredAt ||
        stableJson(accountingOutbox.payload) !==
          stableJson({
            eventId: accountingEvent.eventId,
            eventType: accountingEvent.type,
            throughSequence: accountingEvent.sequence,
          })))
  ) {
    throw new RunStoreError("goal_tool_receipt_invalid");
  }
  return structuredClone({ ...value, runState } as GoalToolExecutionResult);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export async function lockPostgresRunCommit(
  client: PoolClient,
  input: CommitToolExecutionCompletionInput["commit"],
): Promise<void> {
  await advisoryLock(
    client,
    `idempotency:${input.idempotency.scope}:${input.idempotency.key}`,
  );
  const runId = input.events[0]?.identity.runId;
  if (runId === undefined) throw new RunStoreError("events_empty");
  await advisoryLock(client, `run:${input.tenantId}:${runId}`);
}

async function advisoryLock(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
}
