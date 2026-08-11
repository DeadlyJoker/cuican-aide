import {
  RunStoreError,
  type BeginRunAttemptInput,
  type BeginRunAttemptResult,
  type CheckpointRunAttemptInput,
  type CommitLeasedRunInput,
  type CommitLeasedRunTerminalInput,
  type CommitLeasedRunTerminalResult,
  type CommitContextCompactionInput,
  type CommitContextCompactionResult,
  type CommitRunResult,
  type CompleteRunAttemptInput,
  type RetryRunAttemptInput,
  type RunAttemptLocator,
  type RunAttemptTransitionResult,
  type RunStepLocator,
} from "@crewon/application";
import {
  reduceRunLifecycleEvent,
  validateThreadGoal,
  type RunAttemptState,
  type RunLifecycleEvent,
  type RunStepState,
  type ThreadGoal,
} from "@crewon/domain";
import { type PoolClient } from "pg";

import {
  beginPostgresRunAttempt,
  checkpointPostgresRunAttempt,
  finishPostgresRunAttempt,
  listPostgresRunAttempts,
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import {
  POSTGRES_EXECUTION_SCHEMA_VERSION,
  postgresExecutionSchemaSql,
} from "./postgres-execution-schema.ts";
import {
  decodePostgresRunReceipt,
  type PostgresRunReceiptRow,
} from "./postgres-run-codec.ts";
import { PostgresRunStore } from "./postgres-run-store.ts";
import {
  writePostgresOutbox,
  writePostgresRunEvents,
  writePostgresRunSnapshot,
} from "./postgres-run-writer.ts";
import {
  assertPostgresSchemaNotNewer,
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import { writePostgresModelHistory } from "./postgres-thread-writer.ts";
import { type PostgresThreadStoreOptions } from "./postgres-thread-store.ts";
import {
  stableJson,
  validateBeginRunAttemptInput,
  validateCompleteRunAttemptInput,
  validateContextCompactionInput,
  validateContextCompactionReplay,
  validateContextCompactionRunAuthority,
  validateLeasedRunTerminalInput,
  validateQueueLease,
  validateRetryRunAttemptInput,
  validateEvents,
  validateOutbox,
  validateRunHistoryCorrelation,
  validateRunAttemptLocator,
  validateRunAttemptPage,
  validateRunStepLocator,
  applyRunTerminalGoalMutation,
} from "./store-invariants.ts";

/** PostgreSQL Step/Attempt authority; compound terminal transactions follow separately. */
export class PostgresAttemptStore extends PostgresRunStore {
  static override async open(
    options: PostgresThreadStoreOptions,
  ): Promise<PostgresAttemptStore> {
    const store = new PostgresAttemptStore(options);
    try {
      await store.migrate();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  override async migrate(): Promise<void> {
    await super.migrate();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(client, `crewon:${this.schema}:execution-authority`);
      await assertPostgresSchemaNotNewer(
        client,
        this.schemaSql(),
        "execution_authority",
        POSTGRES_EXECUTION_SCHEMA_VERSION,
      );
      await client.query(postgresExecutionSchemaSql(this.schemaSql()));
      const result = await client.query<{ version: number }>(
        `SELECT version FROM ${this.schemaSql()}.schema_migrations
         WHERE component='execution_authority'`,
      );
      const version = result.rows[0]?.version;
      if (version !== POSTGRES_EXECUTION_SCHEMA_VERSION) {
        throw new RunStoreError(
          version !== undefined && version > POSTGRES_EXECUTION_SCHEMA_VERSION
            ? "postgres_schema_too_new"
            : "postgres_schema_version_unsupported",
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async loadRunStep(locator: RunStepLocator): Promise<RunStepState | null> {
    this.assertOpen();
    validateRunStepLocator(locator);
    try {
      return await loadPostgresRunStep(this.pool, this.schemaSql(), locator);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadRunAttempt(
    locator: RunAttemptLocator,
  ): Promise<RunAttemptState | null> {
    this.assertOpen();
    validateRunAttemptLocator(locator);
    try {
      return await loadPostgresRunAttempt(this.pool, this.schemaSql(), locator);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async listRunAttempts(
    locator: RunStepLocator,
    afterAttemptNumber: number,
    limit: number,
  ): Promise<readonly RunAttemptState[]> {
    this.assertOpen();
    validateRunAttemptPage(locator, afterAttemptNumber, limit);
    try {
      return await listPostgresRunAttempts(
        this.pool,
        this.schemaSql(),
        locator,
        afterAttemptNumber,
        limit,
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async beginRunAttempt(
    input: BeginRunAttemptInput,
  ): Promise<BeginRunAttemptResult> {
    this.assertOpen();
    validateBeginRunAttemptInput(input);
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
      const run = await this.loadRunWithin(
        client,
        { tenantId: input.tenantId, runId: input.runId },
        true,
      );
      if (run === null) throw new RunStoreError("execution_authority_mismatch");
      if (
        run.status !== "running" &&
        !(run.status === "reconciling" && input.mode === "reconcile")
      ) {
        throw new RunStoreError("run_not_running_conflict");
      }
      const result = await beginPostgresRunAttempt(
        client,
        this.schemaSql(),
        input,
      );
      await this.validateExecutionLeaseWithin(
        client,
        input.tenantId,
        input.runId,
        input.lease,
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

  async completeRunAttempt(
    input: CompleteRunAttemptInput,
  ): Promise<RunAttemptTransitionResult> {
    validateCompleteRunAttemptInput(input);
    return this.#finishAttempt(input, {
      ...input.attempt,
      status: "completed",
    });
  }

  async checkpointRunAttempt(
    input: CheckpointRunAttemptInput,
  ): Promise<RunAttemptState> {
    this.assertOpen();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.validateExecutionLeaseWithin(
        client,
        input.tenantId,
        input.runId,
        input.lease,
      );
      const result = await checkpointPostgresRunAttempt(
        client,
        this.schemaSql(),
        { tenantId: input.tenantId, runId: input.runId, ...input.attempt },
        input.lease.workItemId,
        input.lease.leaseEpoch,
        input.checkpoint,
        input.checkpointDigest,
        input.checkpointedAt,
      );
      await this.validateExecutionLeaseWithin(
        client,
        input.tenantId,
        input.runId,
        input.lease,
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

  async commitLeasedRun(input: CommitLeasedRunInput): Promise<CommitRunResult> {
    this.assertOpen();
    validateQueueLease(
      input.lease,
      input.lease.workItemId,
      "work_item_id_invalid",
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await this.commitRunWithin(client, input.commit, {
        executionLease: input.lease,
        ...(input.history === null ? {} : { history: input.history }),
      });
      await this.validateExecutionLeaseWithin(
        client,
        input.commit.tenantId,
        run.state.runId,
        input.lease,
      );
      await client.query("COMMIT");
      return run;
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async commitLeasedRunTerminal(
    input: CommitLeasedRunTerminalInput,
  ): Promise<CommitLeasedRunTerminalResult> {
    this.assertOpen();
    const runId = validateLeasedRunTerminalInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(
        client,
        `idempotency:${input.commit.idempotency.scope}:${input.commit.idempotency.key}`,
      );
      const prior = await this.loadRunReceiptWithin(client, input.commit);
      if (prior !== null) {
        if (prior.run_id !== runId) {
          throw new RunStoreError("run_terminal_receipt_invalid");
        }
        const result = decodePostgresRunTerminalReceipt(prior, input);
        await client.query("COMMIT");
        return structuredClone({
          ...result,
          run: { ...result.run, disposition: "replayed" },
        });
      }
      await advisoryLock(client, `run:${input.commit.tenantId}:${runId}`);
      await this.validateExecutionLeaseWithin(
        client,
        input.commit.tenantId,
        runId,
        input.lease,
      );
      const currentRun = await this.loadRunWithin(
        client,
        { tenantId: input.commit.tenantId, runId },
        true,
      );
      if (currentRun === null) throw new RunStoreError("run_not_found");
      if (currentRun.revision !== input.commit.expectedRevision) {
        throw new RunStoreError("revision_conflict");
      }
      await advisoryLock(
        client,
        `thread:${currentRun.tenantId}:${currentRun.threadId}`,
      );
      const thread = await this.loadThreadWithin(
        client,
        { tenantId: currentRun.tenantId, threadId: currentRun.threadId },
        true,
      );
      if (thread === null || thread.spaceId !== currentRun.spaceId) {
        throw new RunStoreError("thread_not_found");
      }
      const currentGoal = await this.loadThreadGoalWithin(
        client,
        {
          tenantId: currentRun.tenantId,
          threadId: currentRun.threadId,
        },
        true,
      );
      const eventIds = await existingIds(
        client,
        this.schemaSql(),
        "run_events",
        "event_id",
        input.commit.events.map((event) => event.eventId),
      );
      const outboxIds = await existingIds(
        client,
        this.schemaSql(),
        "outbox",
        "message_id",
        input.commit.outbox.map((message) => message.messageId),
      );
      validateEvents(input.commit.events, runId, (id) => eventIds.has(id));
      validateOutbox(input.commit.outbox, runId, input.commit.tenantId, (id) =>
        outboxIds.has(id),
      );
      if (input.history !== null) {
        if (input.history.items.some((item) => item.runId !== runId)) {
          throw new RunStoreError("model_history_run_id_mismatch");
        }
        await this.validateModelHistoryWithin(
          client,
          { tenantId: currentRun.tenantId, threadId: currentRun.threadId },
          input.history,
        );
      }
      validateRunHistoryCorrelation(input.commit.events, input.history);
      let nextRun = currentRun;
      for (const event of input.commit.events) {
        nextRun = reduceRunLifecycleEvent(nextRun, event);
      }
      const nextGoal = applyRunTerminalGoalMutation(
        currentGoal,
        input.goal,
        currentRun,
        input.commit.events.at(-1) as Extract<
          RunLifecycleEvent,
          { type: "run.failed" | "run.canceled" }
        >,
        input.commit.events,
      );
      const execution =
        input.attempt === null
          ? null
          : await finishPostgresRunAttempt(client, this.schemaSql(), {
              tenantId: input.commit.tenantId,
              runId,
              workItemId: input.lease.workItemId,
              leaseEpoch: input.lease.leaseEpoch,
              attempt: input.attempt,
            });
      await writePostgresRunSnapshot(
        client,
        this.schemaSql(),
        currentRun,
        nextRun,
        input.commit.expectedRevision,
      );
      await writePostgresRunEvents(
        client,
        this.schemaSql(),
        input.commit.events,
        input.commit.tenantId,
      );
      await writePostgresOutbox(client, this.schemaSql(), input.commit.outbox);
      if (input.history !== null) {
        await writePostgresModelHistory(
          client,
          this.schemaSql(),
          input.history.items,
        );
      }
      if (nextGoal !== currentGoal) {
        await this.writeTurnStartGoalWithin(client, input.goal, nextGoal, {
          tenantId: currentRun.tenantId,
          threadId: currentRun.threadId,
        });
      }
      await this.completeWorkItemWithin(
        client,
        input.commit.tenantId,
        runId,
        input.lease,
      );
      const run: CommitRunResult = {
        disposition: "committed",
        state: nextRun,
        events: input.commit.events,
        outbox: input.commit.outbox,
        workItems: input.commit.workItems,
      };
      const result: CommitLeasedRunTerminalResult = {
        run,
        goalState: nextGoal,
        step: execution?.step ?? null,
        attempt: execution?.attempt ?? null,
      };
      const receipt: PostgresRunTerminalReceipt = {
        ...run,
        terminal: {
          goalState: result.goalState,
          step: result.step,
          attempt: result.attempt,
        },
      };
      await client.query(
        `INSERT INTO ${this.schemaSql()}.idempotency_receipts
           (tenant_id, scope, idempotency_key, run_id, fingerprint, result_json)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          input.commit.tenantId,
          input.commit.idempotency.scope,
          input.commit.idempotency.key,
          runId,
          input.commit.idempotency.requestFingerprint,
          stableJson(receipt),
        ],
      );
      await client.query("COMMIT");
      return structuredClone(result);
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async commitContextCompaction(
    input: CommitContextCompactionInput,
  ): Promise<CommitContextCompactionResult> {
    this.assertOpen();
    const runId = validateContextCompactionInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(
        client,
        `idempotency:${input.commit.idempotency.scope}:${input.commit.idempotency.key}`,
      );
      const prior = await this.loadRunReceiptWithin(client, input.commit);
      if (prior !== null) {
        const run = {
          ...decodePostgresRunReceipt(prior),
          disposition: "replayed" as const,
        };
        const replay = validateContextCompactionReplay(
          input,
          await loadPostgresRunStep(
            client,
            this.schemaSql(),
            {
              tenantId: input.commit.tenantId,
              runId,
              stepId: input.attempt.stepId,
            },
            true,
          ),
          await loadPostgresRunAttempt(
            client,
            this.schemaSql(),
            {
              tenantId: input.commit.tenantId,
              runId,
              ...input.attempt,
            },
            true,
          ),
        );
        await client.query("COMMIT");
        return structuredClone({ run, ...replay });
      }
      await advisoryLock(client, `run:${input.commit.tenantId}:${runId}`);
      validateContextCompactionRunAuthority(
        input,
        await this.loadRunWithin(
          client,
          { tenantId: input.commit.tenantId, runId },
          true,
        ),
      );
      await this.validateExecutionLeaseWithin(
        client,
        input.commit.tenantId,
        runId,
        input.lease,
      );
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
      await this.validateExecutionLeaseWithin(
        client,
        input.commit.tenantId,
        runId,
        input.lease,
      );
      if (input.completion === "completeRun") {
        await this.completeWorkItemWithin(
          client,
          input.commit.tenantId,
          runId,
          input.lease,
        );
      }
      await client.query("COMMIT");
      return structuredClone({
        run,
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

  async retryRunAttempt(
    input: RetryRunAttemptInput,
  ): Promise<RunAttemptTransitionResult> {
    this.assertOpen();
    validateRetryRunAttemptInput(input);
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
      const result = await finishPostgresRunAttempt(client, this.schemaSql(), {
        tenantId: input.tenantId,
        runId: input.runId,
        workItemId: input.lease.workItemId,
        leaseEpoch: input.lease.leaseEpoch,
        attempt: { ...input.attempt, status: "failed" },
      });
      const retried = await client.query(
        `UPDATE ${this.schemaSql()}.work_items
         SET status='pending', available_at=clock_timestamp()+$2*interval '1 millisecond',
             lease_owner_id=NULL, lease_id=NULL, lease_expires_at=NULL,
             last_error_code=$3
         WHERE work_item_id=$1 AND lease_expires_at>clock_timestamp()`,
        [
          input.lease.workItemId,
          input.retryAfterMs,
          input.attempt.failure.code,
        ],
      );
      if (retried.rowCount !== 1) {
        throw new RunStoreError("queue_retry_conflict");
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async #finishAttempt(
    input: CompleteRunAttemptInput,
    attempt: Parameters<typeof finishPostgresRunAttempt>[2]["attempt"],
  ): Promise<RunAttemptTransitionResult> {
    this.assertOpen();
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
      const result = await finishPostgresRunAttempt(client, this.schemaSql(), {
        tenantId: input.tenantId,
        runId: input.runId,
        workItemId: input.lease.workItemId,
        leaseEpoch: input.lease.leaseEpoch,
        attempt,
      });
      await this.validateExecutionLeaseWithin(
        client,
        input.tenantId,
        input.runId,
        input.lease,
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
}

type PostgresRunTerminalReceipt = CommitRunResult &
  Readonly<{
    terminal: Readonly<{
      goalState: ThreadGoal | null;
      step: RunStepState | null;
      attempt: RunAttemptState | null;
    }>;
  }>;

function decodePostgresRunTerminalReceipt(
  row: PostgresRunReceiptRow,
  input: CommitLeasedRunTerminalInput,
): CommitLeasedRunTerminalResult {
  try {
    const stored = row.result_json;
    if (!isPlainObject(stored) || !isPlainObject(stored.terminal)) {
      throw new RunStoreError("run_terminal_receipt_invalid");
    }
    const decodedRun = decodePostgresRunReceipt(row) as CommitRunResult & {
      terminal?: unknown;
    };
    const { terminal: _terminal, ...run } = decodedRun;
    const terminal = stored.terminal;
    const terminalEvent = run.events.at(-1);
    const accountingEvent = run.events.at(-2);
    if (
      row.run_id !== terminalEvent?.identity.runId ||
      run.state.threadId.trim().length === 0 ||
      (terminalEvent.type !== "run.failed" &&
        terminalEvent.type !== "run.canceled") ||
      run.state.status !==
        (terminalEvent.type === "run.failed" ? "failed" : "canceled") ||
      run.state.revision !==
        input.commit.expectedRevision + input.commit.events.length ||
      run.state.lastSequence !== terminalEvent.sequence ||
      run.state.updatedAt !== terminalEvent.occurredAt ||
      run.state.terminalAt !== terminalEvent.occurredAt ||
      (terminalEvent.type === "run.failed" &&
        stableJson(run.state.failure) !== stableJson(terminalEvent.data)) ||
      (accountingEvent?.type === "run.goal.accounting.updated" &&
        stableJson(accountingEvent.data.next) !==
          stableJson(run.state.goalAccounting)) ||
      stableJson(run.events) !== stableJson(input.commit.events) ||
      stableJson(run.outbox) !== stableJson(input.commit.outbox) ||
      stableJson(run.workItems) !== stableJson(input.commit.workItems) ||
      (terminal.goalState !== null && !isPlainObject(terminal.goalState)) ||
      (terminal.step !== null && !isPlainObject(terminal.step)) ||
      (terminal.attempt !== null && !isPlainObject(terminal.attempt))
    ) {
      throw new RunStoreError("run_terminal_receipt_invalid");
    }
    const goalState = terminal.goalState as ThreadGoal | null;
    if (goalState !== null) validateThreadGoal(goalState);
    if (
      goalState !== null &&
      (goalState.tenantId !== row.tenant_id ||
        goalState.threadId !== run.state.threadId)
    ) {
      throw new RunStoreError("run_terminal_receipt_invalid");
    }
    if (
      (input.goal.kind === "set" &&
        stableJson(goalState) !== stableJson(input.goal.goal)) ||
      (input.goal.kind === "clear" && goalState !== null) ||
      (input.goal.kind === "keep" &&
        (goalState?.revision ?? null) !== input.goal.expectedRevision)
    ) {
      throw new RunStoreError("run_terminal_receipt_invalid");
    }
    const step = terminal.step as RunStepState | null;
    const attempt = terminal.attempt as RunAttemptState | null;
    if (
      (input.attempt === null) !== (step === null) ||
      (input.attempt === null) !== (attempt === null) ||
      (input.attempt !== null &&
        (step?.tenantId !== row.tenant_id ||
          step.runId !== row.run_id ||
          step.stepId !== input.attempt.stepId ||
          step.currentAttemptId !== input.attempt.attemptId ||
          step.status !== input.attempt.status ||
          step.terminalAt !== input.attempt.finishedAt ||
          attempt?.tenantId !== row.tenant_id ||
          attempt.runId !== row.run_id ||
          attempt.stepId !== input.attempt.stepId ||
          attempt.attemptId !== input.attempt.attemptId ||
          attempt.status !== input.attempt.status ||
          attempt.terminalAt !== input.attempt.finishedAt ||
          attempt.checkpointDigest !== input.attempt.checkpointDigest ||
          (input.attempt.status === "failed" &&
            stableJson(attempt.failure) !==
              stableJson(input.attempt.failure)) ||
          attempt.workItemId !== input.lease.workItemId ||
          attempt.leaseEpoch !== input.lease.leaseEpoch))
    ) {
      throw new RunStoreError("run_terminal_receipt_invalid");
    }
    return { run, goalState, step, attempt };
  } catch (error) {
    if (
      error instanceof RunStoreError &&
      error.code === "run_terminal_receipt_invalid"
    ) {
      throw error;
    }
    throw new RunStoreError("run_terminal_receipt_invalid", { cause: error });
  }
}

async function existingIds(
  client: PoolClient,
  schema: string,
  table: "run_events" | "outbox",
  column: "event_id" | "message_id",
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
