import {
  RunStoreError,
  type CommitRunInput,
  type CommitRunResult,
  type CommitTurnStartInput,
  type CommitTurnStartResult,
  type CommitThreadGoalMutationInput,
  type CommitThreadGoalMutationResult,
  type ModelHistoryAppend,
  type OutboxClaim,
  type OutboxLeaseInput,
  type OutboxMessage,
  type OutboxRetryInput,
  type QueueClaimInput,
  type QueueLease,
  type RunLocator,
  type RunReceiptQuery,
  type ThreadRunListQuery,
  type TurnStartReceiptQuery,
  type RunStore,
  type WorkItem,
  type WorkItemClaim,
  type WorkItemLeaseInput,
  type WorkItemRenewInput,
  type WorkItemRetryInput,
} from "@crewon/application";
import {
  reduceRunLifecycleEvent,
  reduceThreadLifecycleEvent,
  threadGoalContinuationPrompt,
  validateModelHistoryItem,
  validateThreadGoal,
  type RunLifecycleEvent,
  type RunState,
  type ThreadGoal,
  type ThreadState,
} from "@crewon/domain";
import { type Pool, type PoolClient } from "pg";

import { PostgresQueueStore } from "./postgres-queue-store.ts";
import { assertPostgresProviderSettingsAdmissionOpen } from "./postgres-model-provider-settings-store.ts";
import {
  decodePostgresRunEvent,
  decodePostgresRunReceipt,
  decodePostgresRunState,
  type PostgresRunEventRow,
  type PostgresRunReceiptRow,
  type PostgresRunRow,
} from "./postgres-run-codec.ts";
import {
  POSTGRES_RUN_SCHEMA_VERSION,
  postgresRunSchemaSql,
} from "./postgres-run-schema.ts";
import {
  writePostgresOutbox,
  writePostgresRunEvents,
  writePostgresRunSnapshot,
  writePostgresWorkItems,
} from "./postgres-run-writer.ts";
import {
  writePostgresMessages,
  writePostgresModelHistory,
  writePostgresThreadEvents,
  writePostgresThreadSnapshot,
} from "./postgres-thread-writer.ts";
import {
  assertPostgresSchemaNotNewer,
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import {
  PostgresThreadStore,
  type PostgresThreadStoreOptions,
} from "./postgres-thread-store.ts";
import {
  stableJson,
  validateCommitInput,
  validateEventPage,
  validateEvents,
  validateOutbox,
  validateRunLocator,
  validateRunReceiptQuery,
  validateManualCompactionAdmissionState,
  validateMessages,
  validateThreadLocator,
  validateThreadEvents,
  validateThreadRunListQuery,
  validateTurnStartInput,
  validateTurnStartReceiptQuery,
  applyTurnStartGoalMutation,
  reduceThreadGoalContinuation,
  reduceThreadGoalQueuedRunCancellation,
  reduceThreadGoalRetainedRunUpdate,
  shouldCancelQueuedRunForGoal,
  validateThreadGoalActiveRunFence,
  validateThreadGoalMutationInput,
  validateThreadGoalRetainedRunReceipt,
  validateRunHistoryCorrelation,
  validateTurnStartGoalBinding,
  validateWorkItems,
} from "./store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";

type WorkLeaseRow = Readonly<{
  tenant_id: string;
  run_id: string;
  status: string;
  lease_owner_id: string | null;
  lease_id: string | null;
  lease_epoch: string | number;
  lease_expires_at: Date | string | null;
  database_now: Date | string;
}>;

type TurnStartReceiptRow = Readonly<{
  tenant_id: string;
  run_id: string;
  fingerprint: string;
  result_json: unknown;
}>;

type ThreadGoalMutationReceiptRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  fingerprint: string;
  result_json: unknown;
}>;

/** PostgreSQL Run authority with atomic queue handoff. */
export class PostgresRunStore extends PostgresThreadStore implements RunStore {
  readonly #queue: PostgresQueueStore;

  constructor(options: PostgresThreadStoreOptions) {
    super(options);
    this.#queue = new PostgresQueueStore({
      pool: this.pool,
      schema: this.schema,
    });
  }

  static override async open(
    options: PostgresThreadStoreOptions,
  ): Promise<PostgresRunStore> {
    const store = new PostgresRunStore(options);
    try {
      await store.migrate();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  override async migrate(): Promise<void> {
    this.assertOpen();
    const legacyRunAuthority = await this.#preflightLegacyRunAuthority();
    if (legacyRunAuthority) {
      // Cut over an existing Run authority before migrating dependencies. The
      // final audit and table lock stay inside this Run-only transaction, so a
      // rejection cannot strand Thread or Queue on a newer schema and no Run
      // lock is held while acquiring another component's migration lock.
      await this.#migrateRunAuthority();
    }
    await super.migrate();
    await this.#queue.migrate();
    if (!legacyRunAuthority) {
      await this.#migrateRunAuthority();
    }
  }

  async #preflightLegacyRunAuthority(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const registry = await client.query<{ registry: string | null }>(
        "SELECT to_regclass($1) AS registry",
        [`${this.schema}.schema_migrations`],
      );
      if (registry.rows[0]?.registry === null) {
        await client.query("COMMIT");
        return false;
      }
      const storedVersion = await client.query<{ version: number }>(
        `SELECT version FROM ${this.schemaSql()}.schema_migrations
         WHERE component = 'run_authority'`,
      );
      const version = storedVersion.rows[0]?.version;
      if (version === undefined) {
        await client.query("COMMIT");
        return false;
      }
      if (version > POSTGRES_RUN_SCHEMA_VERSION) {
        throw new RunStoreError("postgres_schema_too_new");
      }
      if (version !== 1 && version !== POSTGRES_RUN_SCHEMA_VERSION) {
        throw new RunStoreError("postgres_schema_version_unsupported");
      }
      if (version === 1) {
        await this.#assertLegacyGoalRunsDrained(client);
      }
      await client.query("COMMIT");
      return version === 1;
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async #migrateRunAuthority(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(client, `crewon:${this.schema}:run-authority`);
      await assertPostgresSchemaNotNewer(
        client,
        this.schemaSql(),
        "run_authority",
        POSTGRES_RUN_SCHEMA_VERSION,
      );
      const storedVersion = await client.query<{ version: number }>(
        `SELECT version FROM ${this.schemaSql()}.schema_migrations
         WHERE component = 'run_authority'`,
      );
      if (storedVersion.rows[0]?.version === 1) {
        await client.query(
          `LOCK TABLE ${this.schemaSql()}.run_snapshots
           IN SHARE ROW EXCLUSIVE MODE`,
        );
        await this.#assertLegacyGoalRunsDrained(client);
      }
      await client.query(postgresRunSchemaSql(this.schemaSql()));
      const result = await client.query<{ version: number }>(
        `SELECT version FROM ${this.schemaSql()}.schema_migrations
         WHERE component = 'run_authority'`,
      );
      const version = result.rows[0]?.version;
      if (version !== POSTGRES_RUN_SCHEMA_VERSION) {
        throw new RunStoreError(
          version !== undefined && version > POSTGRES_RUN_SCHEMA_VERSION
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

  async #assertLegacyGoalRunsDrained(client: PoolClient): Promise<void> {
    const legacyGoalRun = await client.query<{ run_id: string }>(
      `SELECT run_id
       FROM ${this.schemaSql()}.run_snapshots
       WHERE state_json->>'status'
               IN ('queued', 'running', 'waitingApproval', 'suspended', 'reconciling')
         AND state_json ? 'goalBinding'
         AND state_json->'goalBinding' <> 'null'::jsonb
         AND jsonb_typeof(state_json->'goalAccounting') IS DISTINCT FROM 'object'
       LIMIT 1`,
    );
    if (legacyGoalRun.rowCount !== 0) {
      throw new RunStoreError("legacy_goal_run_requires_drain");
    }
  }

  override async close(): Promise<void> {
    await this.#queue.close();
    await super.close();
  }

  async loadRun(locator: RunLocator): Promise<RunState | null> {
    this.assertOpen();
    validateRunLocator(locator);
    try {
      return await this.loadRunWithin(this.pool, locator);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadRunReceipt(
    query: RunReceiptQuery,
  ): Promise<CommitRunResult | null> {
    this.assertOpen();
    validateRunReceiptQuery(query);
    try {
      const result = await this.pool.query<PostgresRunReceiptRow>(
        `SELECT tenant_id, run_id, fingerprint, result_json
         FROM ${this.schemaSql()}.idempotency_receipts
         WHERE scope=$1 AND idempotency_key=$2`,
        [query.idempotency.scope, query.idempotency.key],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      if (row.tenant_id !== query.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (row.fingerprint !== query.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      const receipt = decodePostgresRunReceipt(row);
      if (receipt.state.threadId !== query.threadId) {
        throw new RunStoreError("idempotency_receipt_invalid");
      }
      return { ...receipt, disposition: "replayed" };
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async listThreadRuns(
    query: ThreadRunListQuery,
  ): Promise<readonly RunState[]> {
    this.assertOpen();
    validateThreadRunListQuery(query);
    try {
      const result = await this.pool.query<PostgresRunRow>(
        `SELECT snapshots.tenant_id, snapshots.space_id, snapshots.run_id,
                snapshots.revision, snapshots.last_sequence, snapshots.state_json,
                snapshots.updated_at, bindings.thread_id
         FROM ${this.schemaSql()}.run_snapshots AS snapshots
         JOIN ${this.schemaSql()}.run_thread_bindings AS bindings
           ON bindings.tenant_id = snapshots.tenant_id
          AND bindings.run_id = snapshots.run_id
         WHERE snapshots.tenant_id = $1
           AND snapshots.space_id = $2
           AND bindings.thread_id = $3
           AND ($4::timestamptz IS NULL OR snapshots.updated_at < $4::timestamptz
             OR (snapshots.updated_at = $4::timestamptz AND snapshots.run_id < $5))
         ORDER BY snapshots.updated_at DESC, snapshots.run_id DESC
         LIMIT $6`,
        [
          query.tenantId,
          query.spaceId,
          query.threadId,
          query.before?.updatedAt ?? null,
          query.before?.runId ?? null,
          query.limit,
        ],
      );
      return result.rows.map((row) =>
        decodePostgresRunState(row, {
          tenantId: query.tenantId,
          runId: row.run_id,
        }),
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadThreadGoalMutationReceipt(input: {
    tenantId: string;
    threadId: string;
    idempotency: import("@crewon/application").IdempotencyDescriptor;
  }): Promise<CommitThreadGoalMutationResult | null> {
    this.assertOpen();
    validateThreadLocator(input);
    try {
      const result = await this.pool.query<ThreadGoalMutationReceiptRow>(
        `SELECT tenant_id, thread_id, fingerprint, result_json
         FROM ${this.schemaSql()}.thread_idempotency_receipts
         WHERE scope=$1 AND idempotency_key=$2`,
        [input.idempotency.scope, input.idempotency.key],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      if (row.tenant_id !== input.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (row.thread_id !== input.threadId) {
        throw new RunStoreError("goal_mutation_receipt_invalid");
      }
      if (row.fingerprint !== input.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      return {
        ...decodeThreadGoalMutationReceipt(row),
        disposition: "replayed",
      };
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadThreadActiveRun(locator: {
    tenantId: string;
    threadId: string;
  }): Promise<import("@crewon/application").ThreadGoalActiveRun | null> {
    this.assertOpen();
    validateThreadLocator(locator);
    try {
      const result = await this.pool.query<PostgresRunRow>(
        `SELECT snapshots.tenant_id, snapshots.space_id, snapshots.run_id,
                snapshots.revision, snapshots.last_sequence,
                snapshots.state_json, snapshots.updated_at,
                bindings.thread_id
         FROM ${this.schemaSql()}.run_snapshots AS snapshots
         JOIN ${this.schemaSql()}.run_thread_bindings AS bindings
           ON bindings.tenant_id = snapshots.tenant_id
          AND bindings.run_id = snapshots.run_id
         WHERE snapshots.tenant_id=$1 AND bindings.thread_id=$2
           AND snapshots.state_json->>'status'
               NOT IN ('completed', 'failed', 'canceled')`,
        [locator.tenantId, locator.threadId],
      );
      if (result.rows.length > 1) {
        throw new RunStoreError("thread_active_run_invariant");
      }
      if (result.rows[0] === undefined) return null;
      const state = decodePostgresRunState(result.rows[0], {
        tenantId: locator.tenantId,
        runId: result.rows[0].run_id,
      });
      const work = await this.pool.query<{ trigger: string | null }>(
        `SELECT work_item_json->'payload'->>'trigger' AS trigger
         FROM ${this.schemaSql()}.work_items
         WHERE tenant_id=$1 AND run_id=$2 AND status!='completed'`,
        [locator.tenantId, state.runId],
      );
      if (work.rows.length > 1) {
        throw new RunStoreError("goal_active_run_work_item_invariant");
      }
      const trigger = work.rows[0]?.trigger;
      return {
        state,
        trigger:
          trigger === "goalContinuation" || trigger === "goalActivation"
            ? trigger
            : "default",
      };
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async commitThreadGoalMutation(
    input: CommitThreadGoalMutationInput,
  ): Promise<CommitThreadGoalMutationResult> {
    this.assertOpen();
    validateThreadGoalMutationInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(
        client,
        `idempotency:${input.idempotency.scope}:${input.idempotency.key}`,
      );
      const receipt = await client.query<ThreadGoalMutationReceiptRow>(
        `SELECT tenant_id, thread_id, fingerprint, result_json
         FROM ${this.schemaSql()}.thread_idempotency_receipts
         WHERE scope=$1 AND idempotency_key=$2`,
        [input.idempotency.scope, input.idempotency.key],
      );
      const prior = receipt.rows[0];
      if (prior !== undefined) {
        if (prior.tenant_id !== input.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.thread_id !== input.threadId) {
          throw new RunStoreError("goal_mutation_receipt_invalid");
        }
        if (prior.fingerprint !== input.idempotency.requestFingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const result = decodeThreadGoalMutationReceipt(prior);
        await client.query("COMMIT");
        return { ...result, disposition: "replayed" };
      }

      if (input.continuation !== null) {
        await assertPostgresProviderSettingsAdmissionOpen(
          client,
          this.schemaSql(),
          input.tenantId,
        );
      }

      let fencedWorkRows: readonly {
        work_item_id: string;
        trigger: string | null;
      }[] = [];
      if (input.expectedActiveRun !== null) {
        await advisoryLock(
          client,
          `run:${input.tenantId}:${input.expectedActiveRun.runId}`,
        );
        await this.loadRunWithin(
          client,
          {
            tenantId: input.tenantId,
            runId: input.expectedActiveRun.runId,
          },
          true,
        );
        fencedWorkRows = (
          await client.query<{
            work_item_id: string;
            trigger: string | null;
          }>(
            `SELECT work_item_id,
                    work_item_json->'payload'->>'trigger' AS trigger
             FROM ${this.schemaSql()}.work_items
             WHERE tenant_id=$1 AND run_id=$2 AND status!='completed'
             FOR UPDATE`,
            [input.tenantId, input.expectedActiveRun.runId],
          )
        ).rows;
        if (fencedWorkRows.length > 1) {
          throw new RunStoreError("goal_active_run_work_item_invariant");
        }
      }
      await advisoryLock(client, `thread:${input.tenantId}:${input.threadId}`);

      const thread = await this.loadThreadWithin(
        client,
        { tenantId: input.tenantId, threadId: input.threadId },
        true,
      );
      if (thread === null || thread.status !== "active") {
        throw new RunStoreError("thread_not_found");
      }
      const activeRows = await client.query<PostgresRunRow>(
        `SELECT snapshots.tenant_id, snapshots.space_id, snapshots.run_id,
                snapshots.revision, snapshots.last_sequence,
                snapshots.state_json, snapshots.updated_at,
                bindings.thread_id
         FROM ${this.schemaSql()}.run_snapshots AS snapshots
         JOIN ${this.schemaSql()}.run_thread_bindings AS bindings
           ON bindings.tenant_id = snapshots.tenant_id
          AND bindings.run_id = snapshots.run_id
         WHERE snapshots.tenant_id=$1 AND bindings.thread_id=$2
           AND snapshots.state_json->>'status'
               NOT IN ('completed', 'failed', 'canceled')
         `,
        [input.tenantId, input.threadId],
      );
      if (activeRows.rows.length > 1) {
        throw new RunStoreError("thread_active_run_invariant");
      }
      const activeRun =
        activeRows.rows[0] === undefined
          ? null
          : decodePostgresRunState(activeRows.rows[0], {
              tenantId: input.tenantId,
              runId: activeRows.rows[0].run_id,
            });
      validateThreadGoalActiveRunFence(input.expectedActiveRun, activeRun);

      const currentGoal = await this.loadThreadGoalWithin(
        client,
        { tenantId: input.tenantId, threadId: input.threadId },
        true,
      );
      const nextGoal = applyTurnStartGoalMutation(currentGoal, input.goal, {
        tenantId: input.tenantId,
        threadId: input.threadId,
      });
      const activeWorkRows = activeRun === null ? [] : fencedWorkRows;
      if (activeWorkRows.length > 1) {
        throw new RunStoreError("goal_active_run_work_item_invariant");
      }
      const activeTrigger = activeWorkRows[0]?.trigger;
      const shouldCancel = shouldCancelQueuedRunForGoal(
        activeRun,
        nextGoal,
        activeTrigger === "goalContinuation" ||
          activeTrigger === "goalActivation"
          ? activeTrigger
          : "default",
      );
      let canceledRunState: RunState | null = null;
      let canceledWorkItemId: string | null = null;
      const pendingEventIds = new Set<string>();
      const pendingOutboxIds = new Set<string>();
      if (shouldCancel) {
        if (activeRun === null || input.queuedRunCancellation === null) {
          throw new RunStoreError("goal_queued_run_cancellation_missing");
        }
        const eventIds = await this.#existingIds(
          client,
          "run_events",
          "event_id",
          input.queuedRunCancellation.events.map((event) => event.eventId),
        );
        const outboxIds = await this.#existingIds(
          client,
          "outbox",
          "message_id",
          input.queuedRunCancellation.outbox.map(
            (message) => message.messageId,
          ),
        );
        canceledRunState = reduceThreadGoalQueuedRunCancellation(
          input.queuedRunCancellation,
          activeRun,
          (eventId) => eventIds.has(eventId),
          (messageId) => outboxIds.has(messageId),
        );
        for (const event of input.queuedRunCancellation.events) {
          pendingEventIds.add(event.eventId);
        }
        for (const message of input.queuedRunCancellation.outbox) {
          pendingOutboxIds.add(message.messageId);
        }
        if (activeWorkRows.length !== 1) {
          throw new RunStoreError("goal_queued_run_work_item_invalid");
        }
        canceledWorkItemId = activeWorkRows[0]!.work_item_id;
      } else if (input.queuedRunCancellation !== null) {
        throw new RunStoreError("goal_queued_run_cancellation_unexpected");
      }

      const shouldUpdateRetainedRun =
        activeRun !== null &&
        !shouldCancel &&
        activeRun.collaborationMode === "default" &&
        input.goal.kind !== "keep";
      let retainedRunState: RunState | null = null;
      if (shouldUpdateRetainedRun) {
        if (activeRun === null || input.retainedRunUpdate === null) {
          throw new RunStoreError("goal_retained_run_update_missing");
        }
        const eventIds = await this.#existingIds(
          client,
          "run_events",
          "event_id",
          input.retainedRunUpdate.events.map((event) => event.eventId),
        );
        const outboxIds = await this.#existingIds(
          client,
          "outbox",
          "message_id",
          input.retainedRunUpdate.outbox.map((message) => message.messageId),
        );
        retainedRunState = reduceThreadGoalRetainedRunUpdate(
          input.retainedRunUpdate,
          activeRun,
          currentGoal,
          nextGoal,
          (eventId) => pendingEventIds.has(eventId) || eventIds.has(eventId),
          (messageId) =>
            pendingOutboxIds.has(messageId) || outboxIds.has(messageId),
        );
        for (const event of input.retainedRunUpdate.events) {
          pendingEventIds.add(event.eventId);
        }
        for (const message of input.retainedRunUpdate.outbox) {
          pendingOutboxIds.add(message.messageId);
        }
      } else if (input.retainedRunUpdate !== null) {
        throw new RunStoreError("goal_retained_run_update_unexpected");
      }

      const shouldContinue =
        nextGoal?.status === "active" && (activeRun === null || shouldCancel);
      let continuationResult: CommitThreadGoalMutationResult["continuation"] =
        null;
      if (shouldContinue) {
        if (nextGoal === null || input.continuation === null) {
          throw new RunStoreError("goal_activation_missing");
        }
        await this.validateModelHistoryWithin(
          client,
          { tenantId: input.tenantId, threadId: input.threadId },
          input.continuation.history,
        );
        const eventIds = await this.#existingIds(
          client,
          "run_events",
          "event_id",
          input.continuation.events.map((event) => event.eventId),
        );
        const outboxIds = await this.#existingIds(
          client,
          "outbox",
          "message_id",
          input.continuation.outbox.map((message) => message.messageId),
        );
        const workItemIds = await this.#existingIds(
          client,
          "work_items",
          "work_item_id",
          input.continuation.workItems.map((item) => item.workItemId),
        );
        const continuation = reduceThreadGoalContinuation(
          input.continuation,
          nextGoal,
          thread,
          (eventId) => pendingEventIds.has(eventId) || eventIds.has(eventId),
          (messageId) =>
            pendingOutboxIds.has(messageId) || outboxIds.has(messageId),
          (workItemId) => workItemIds.has(workItemId),
        );
        if (continuation.runState.runId === activeRun?.runId) {
          throw new RunStoreError("goal_activation_run_conflict");
        }
        continuationResult = {
          historyItem: continuation.historyItem,
          runState: continuation.runState,
          runEvents: input.continuation.events,
          outbox: input.continuation.outbox,
          workItems: input.continuation.workItems,
        };
      } else if (input.continuation !== null) {
        throw new RunStoreError("goal_activation_unexpected");
      }

      await this.writeTurnStartGoalWithin(client, input.goal, nextGoal, {
        tenantId: input.tenantId,
        threadId: input.threadId,
      });
      if (canceledRunState !== null && input.queuedRunCancellation !== null) {
        await writePostgresRunSnapshot(
          client,
          this.schemaSql(),
          activeRun,
          canceledRunState,
          activeRun!.revision,
        );
        await writePostgresRunEvents(
          client,
          this.schemaSql(),
          input.queuedRunCancellation.events,
          input.tenantId,
        );
        await writePostgresOutbox(
          client,
          this.schemaSql(),
          input.queuedRunCancellation.outbox,
        );
        const completed = await client.query(
          `UPDATE ${this.schemaSql()}.work_items
           SET status='completed', lease_owner_id=NULL, lease_id=NULL,
               lease_expires_at=NULL, completed_at=$2,
               last_error_code='goal_mutated'
           WHERE work_item_id=$1 AND status!='completed'`,
          [canceledWorkItemId, canceledRunState.updatedAt],
        );
        if (completed.rowCount !== 1) {
          throw new RunStoreError("goal_queued_run_work_item_conflict");
        }
      }
      if (retainedRunState !== null && input.retainedRunUpdate !== null) {
        await writePostgresRunSnapshot(
          client,
          this.schemaSql(),
          activeRun,
          retainedRunState,
          activeRun!.revision,
        );
        await writePostgresRunEvents(
          client,
          this.schemaSql(),
          input.retainedRunUpdate.events,
          input.tenantId,
        );
        await writePostgresOutbox(
          client,
          this.schemaSql(),
          input.retainedRunUpdate.outbox,
        );
      }
      if (continuationResult !== null && input.continuation !== null) {
        await writePostgresModelHistory(
          client,
          this.schemaSql(),
          input.continuation.history.items,
        );
        await writePostgresRunSnapshot(
          client,
          this.schemaSql(),
          null,
          continuationResult.runState,
          0,
        );
        await writePostgresRunEvents(
          client,
          this.schemaSql(),
          input.continuation.events,
          input.tenantId,
        );
        await writePostgresOutbox(
          client,
          this.schemaSql(),
          input.continuation.outbox,
        );
        await writePostgresWorkItems(
          client,
          this.schemaSql(),
          input.continuation.workItems,
        );
      }
      const result: CommitThreadGoalMutationResult = {
        disposition: "committed",
        goalChanged: stableJson(currentGoal) !== stableJson(nextGoal),
        goalState: nextGoal,
        canceledRunState,
        retainedRun:
          retainedRunState === null || input.retainedRunUpdate === null
            ? null
            : {
                runState: retainedRunState,
                runEvents: input.retainedRunUpdate.events,
                outbox: input.retainedRunUpdate.outbox,
              },
        continuation: continuationResult,
      };
      await client.query(
        `INSERT INTO ${this.schemaSql()}.thread_idempotency_receipts
           (tenant_id, scope, idempotency_key, thread_id, fingerprint,
            result_json)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          input.threadId,
          input.idempotency.requestFingerprint,
          stableJson(result),
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

  async loadTurnStartReceipt(
    query: TurnStartReceiptQuery,
  ): Promise<CommitTurnStartResult | null> {
    this.assertOpen();
    validateTurnStartReceiptQuery(query);
    try {
      const result = await this.#loadTurnStartReceipt(this.pool, query);
      return result === null ? null : { ...result, disposition: "replayed" };
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async commitTurnStart(
    input: CommitTurnStartInput,
  ): Promise<CommitTurnStartResult> {
    this.assertOpen();
    const { runId, threadId } = validateTurnStartInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(
        client,
        `idempotency:${input.idempotency.scope}:${input.idempotency.key}`,
      );
      const prior = await this.#loadTurnStartReceipt(client, {
        tenantId: input.tenantId,
        threadId,
        idempotency: input.idempotency,
      });
      if (prior !== null) {
        await client.query("COMMIT");
        return { ...prior, disposition: "replayed" };
      }
      await assertPostgresProviderSettingsAdmissionOpen(
        client,
        this.schemaSql(),
        input.tenantId,
      );
      await advisoryLock(client, `run:${input.tenantId}:${runId}`);
      await advisoryLock(client, `thread:${input.tenantId}:${threadId}`);

      const currentThread = await this.loadThreadWithin(
        client,
        { tenantId: input.tenantId, threadId },
        true,
      );
      if (currentThread === null) {
        throw new RunStoreError("thread_not_found");
      }
      if (currentThread.revision !== input.thread.expectedRevision) {
        throw new RunStoreError("revision_conflict");
      }
      if (currentThread.status !== "active") {
        throw new RunStoreError("thread_not_active");
      }
      const activeRun = await client.query(
        `SELECT 1
         FROM ${this.schemaSql()}.run_snapshots AS snapshots
         JOIN ${this.schemaSql()}.run_thread_bindings AS bindings
           ON bindings.tenant_id = snapshots.tenant_id
          AND bindings.run_id = snapshots.run_id
         WHERE snapshots.tenant_id = $1
           AND bindings.thread_id = $2
           AND snapshots.state_json->>'status'
               NOT IN ('completed', 'failed', 'canceled')
         LIMIT 1`,
        [input.tenantId, threadId],
      );
      if (activeRun.rowCount !== 0) {
        throw new RunStoreError("thread_active_run_conflict");
      }
      if (
        (await this.loadRunWithin(
          client,
          { tenantId: input.tenantId, runId },
          true,
        )) !== null
      ) {
        throw new RunStoreError("revision_conflict");
      }
      const nextGoal = applyTurnStartGoalMutation(
        await this.loadThreadGoalWithin(
          client,
          { tenantId: input.tenantId, threadId },
          true,
        ),
        input.goal,
        { tenantId: input.tenantId, threadId },
      );
      validateTurnStartGoalBinding(nextGoal, input);

      const threadEventIds = await this.#existingIds(
        client,
        "thread_events",
        "event_id",
        input.thread.events.map((event) => event.eventId),
      );
      const messageIds = await this.#existingIds(
        client,
        "messages",
        "message_id",
        input.thread.messages.map((message) => message.messageId),
      );
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
      await this.validateModelHistoryWithin(
        client,
        { tenantId: input.tenantId, threadId },
        input.thread.history,
      );
      let nextThread: ThreadState | null = currentThread;
      for (const event of input.thread.events) {
        nextThread = reduceThreadLifecycleEvent(nextThread, event);
      }
      if (nextThread === null) {
        throw new RunStoreError("thread_events_empty");
      }

      const runEventIds = await this.#existingIds(
        client,
        "run_events",
        "event_id",
        input.run.events.map((event) => event.eventId),
      );
      const outboxIds = await this.#existingIds(
        client,
        "outbox",
        "message_id",
        input.run.outbox.map((message) => message.messageId),
      );
      const workItemIds = await this.#existingIds(
        client,
        "work_items",
        "work_item_id",
        input.run.workItems.map((item) => item.workItemId),
      );
      validateEvents(input.run.events, runId, (id) => runEventIds.has(id));
      let nextRun: RunState | null = null;
      for (const event of input.run.events) {
        nextRun = reduceRunLifecycleEvent(nextRun, event);
      }
      if (
        nextRun === null ||
        nextRun.tenantId !== input.tenantId ||
        nextRun.threadId !== threadId ||
        nextRun.spaceId !== nextThread.spaceId
      ) {
        throw new RunStoreError("turn_start_authority_mismatch");
      }
      validateOutbox(input.run.outbox, runId, input.tenantId, (id) =>
        outboxIds.has(id),
      );
      validateWorkItems(
        input.run.workItems,
        runId,
        input.tenantId,
        input.run.events.at(-1)?.sequence ?? 0,
        (id) => workItemIds.has(id),
      );

      await writePostgresThreadSnapshot(
        client,
        this.schemaSql(),
        currentThread,
        nextThread,
        input.thread.expectedRevision,
      );
      await writePostgresThreadEvents(
        client,
        this.schemaSql(),
        input.thread.events,
        input.tenantId,
      );
      await writePostgresMessages(
        client,
        this.schemaSql(),
        input.thread.messages,
      );
      await writePostgresModelHistory(
        client,
        this.schemaSql(),
        input.thread.history.items,
      );
      await this.writeTurnStartGoalWithin(client, input.goal, nextGoal, {
        tenantId: input.tenantId,
        threadId,
      });
      await writePostgresRunSnapshot(
        client,
        this.schemaSql(),
        null,
        nextRun,
        input.run.expectedRevision,
      );
      await writePostgresRunEvents(
        client,
        this.schemaSql(),
        input.run.events,
        input.tenantId,
      );
      await writePostgresOutbox(client, this.schemaSql(), input.run.outbox);
      await writePostgresWorkItems(
        client,
        this.schemaSql(),
        input.run.workItems,
      );
      const result: CommitTurnStartResult = {
        disposition: "committed",
        threadState: nextThread,
        runState: nextRun,
        goalState: nextGoal,
        threadEvents: input.thread.events,
        messages: input.thread.messages,
        historyItems: input.thread.history.items,
        runEvents: input.run.events,
        outbox: input.run.outbox,
        workItems: input.run.workItems,
      };
      await client.query(
        `INSERT INTO ${this.schemaSql()}.idempotency_receipts
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
      await client.query("COMMIT");
      return structuredClone(result);
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async commitRun(input: CommitRunInput): Promise<CommitRunResult> {
    this.assertOpen();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.commitRunWithin(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  protected async commitRunWithin(
    client: PoolClient,
    input: CommitRunInput,
    options: Readonly<{
      executionLease?: WorkItemLeaseInput;
      history?: ModelHistoryAppend;
      beforeWrite?: (
        authority: Readonly<{
          current: RunState | null;
          next: RunState;
          thread: ThreadState;
        }>,
      ) => Promise<void>;
    }> = {},
  ): Promise<CommitRunResult> {
    const runId = validateCommitInput(input);
    await advisoryLock(
      client,
      `idempotency:${input.idempotency.scope}:${input.idempotency.key}`,
    );
    const prior = await this.loadRunReceiptWithin(client, input);
    if (prior !== null) {
      return {
        ...decodePostgresRunReceipt(prior),
        disposition: "replayed",
      };
    }
    const isNewRun =
      input.expectedRevision === 0 && input.events[0]?.type === "run.created";
    if (isNewRun) {
      await assertPostgresProviderSettingsAdmissionOpen(
        client,
        this.schemaSql(),
        input.tenantId,
      );
    }
    await advisoryLock(client, `run:${input.tenantId}:${runId}`);
    if (options.executionLease !== undefined) {
      await this.validateExecutionLeaseWithin(
        client,
        input.tenantId,
        runId,
        options.executionLease,
      );
    }
    const locator = { tenantId: input.tenantId, runId };
    const current = await this.loadRunWithin(client, locator, true);
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      throw new RunStoreError("revision_conflict");
    }
    const eventIds = await this.#existingIds(
      client,
      "run_events",
      "event_id",
      input.events.map((event) => event.eventId),
    );
    const outboxIds = await this.#existingIds(
      client,
      "outbox",
      "message_id",
      input.outbox.map((message) => message.messageId),
    );
    const workItemIds = await this.#existingIds(
      client,
      "work_items",
      "work_item_id",
      input.workItems.map((item) => item.workItemId),
    );
    validateEvents(input.events, runId, (id) => eventIds.has(id));
    let next = current;
    for (const event of input.events)
      next = reduceRunLifecycleEvent(next, event);
    if (next === null) throw new RunStoreError("events_empty");
    await advisoryLock(client, `thread:${next.tenantId}:${next.threadId}`);
    const thread = await this.loadThreadWithin(
      client,
      { tenantId: next.tenantId, threadId: next.threadId },
      true,
    );
    if (thread === null || thread.spaceId !== next.spaceId) {
      throw new RunStoreError("thread_not_found");
    }
    if (current === null && thread.status !== "active") {
      throw new RunStoreError("thread_not_active");
    }
    if (input.threadAdmission !== undefined) {
      const historyHead = await client.query<{
        last_sequence: string | number;
      }>(
        `SELECT COALESCE(MAX(sequence), 0) AS last_sequence
         FROM ${this.schemaSql()}.model_history_items
         WHERE tenant_id=$1 AND thread_id=$2`,
        [next.tenantId, next.threadId],
      );
      const activeRun = await client.query(
        `SELECT 1
         FROM ${this.schemaSql()}.run_snapshots AS snapshots
         JOIN ${this.schemaSql()}.run_thread_bindings AS bindings
           ON bindings.tenant_id = snapshots.tenant_id
          AND bindings.run_id = snapshots.run_id
         WHERE snapshots.tenant_id=$1
           AND bindings.thread_id=$2
           AND snapshots.state_json->>'status'
               NOT IN ('completed', 'failed', 'canceled')
         LIMIT 1`,
        [next.tenantId, next.threadId],
      );
      validateManualCompactionAdmissionState(input, {
        currentRun: current,
        nextRun: next,
        thread,
        historySequence: Number(historyHead.rows[0]?.last_sequence ?? 0),
        goal: await this.loadThreadGoalWithin(
          client,
          { tenantId: next.tenantId, threadId: next.threadId },
          true,
        ),
        hasActiveRun: activeRun.rowCount !== 0,
      });
    }
    if (options.history !== undefined) {
      if (options.history.items.some((item) => item.runId !== runId)) {
        throw new RunStoreError("model_history_run_id_mismatch");
      }
      await this.validateModelHistoryWithin(
        client,
        { tenantId: next.tenantId, threadId: next.threadId },
        options.history,
      );
    }
    validateRunHistoryCorrelation(input.events, options.history ?? null);
    validateOutbox(input.outbox, runId, input.tenantId, (id) =>
      outboxIds.has(id),
    );
    validateWorkItems(
      input.workItems,
      runId,
      input.tenantId,
      input.events.at(-1)?.sequence ?? 0,
      (id) => workItemIds.has(id),
      input.threadAdmission === undefined ? "default" : "manualCompaction",
    );
    await options.beforeWrite?.({ current, next, thread });
    await writePostgresRunSnapshot(
      client,
      this.schemaSql(),
      current,
      next,
      input.expectedRevision,
    );
    await writePostgresRunEvents(
      client,
      this.schemaSql(),
      input.events,
      input.tenantId,
    );
    await writePostgresOutbox(client, this.schemaSql(), input.outbox);
    await writePostgresWorkItems(client, this.schemaSql(), input.workItems);
    if (options.history !== undefined) {
      await writePostgresModelHistory(
        client,
        this.schemaSql(),
        options.history.items,
      );
    }
    const result: CommitRunResult = {
      disposition: "committed",
      state: next,
      events: input.events,
      outbox: input.outbox,
      workItems: input.workItems,
    };
    await client.query(
      `INSERT INTO ${this.schemaSql()}.idempotency_receipts
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

  async listRunEvents(
    locator: RunLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly RunLifecycleEvent[]> {
    this.assertOpen();
    validateEventPage(locator, afterSequence, limit);
    try {
      const result = await this.pool.query<PostgresRunEventRow>(
        `SELECT tenant_id, run_id, sequence, event_id, event_json
         FROM ${this.schemaSql()}.run_events
         WHERE tenant_id=$1 AND run_id=$2 AND sequence>$3
         ORDER BY sequence ASC LIMIT $4`,
        [locator.tenantId, locator.runId, afterSequence, limit],
      );
      return result.rows.map((row) => decodePostgresRunEvent(row, locator));
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  listPendingOutbox(limit: number): Promise<readonly OutboxMessage[]> {
    return this.#queue.listPendingOutbox(limit);
  }
  claimNextOutbox(input: QueueClaimInput): Promise<OutboxClaim | null> {
    return this.#queue.claimNextOutbox(input);
  }
  acknowledgeOutbox(input: OutboxLeaseInput): Promise<void> {
    return this.#queue.acknowledgeOutbox(input);
  }
  retryOutbox(input: OutboxRetryInput): Promise<void> {
    return this.#queue.retryOutbox(input);
  }
  listPendingWorkItems(limit: number): Promise<readonly WorkItem[]> {
    return this.#queue.listPendingWorkItems(limit);
  }
  claimNextWorkItem(input: QueueClaimInput): Promise<WorkItemClaim | null> {
    return this.#queue.claimNextWorkItem(input);
  }
  renewWorkItemLease(input: WorkItemRenewInput): Promise<QueueLease> {
    return this.#queue.renewWorkItemLease(input);
  }
  completeWorkItem(input: WorkItemLeaseInput): Promise<void> {
    return this.#queue.completeWorkItem(input);
  }
  retryWorkItem(input: WorkItemRetryInput): Promise<void> {
    return this.#queue.retryWorkItem(input);
  }

  protected async validateExecutionLeaseWithin(
    client: PoolClient,
    tenantId: string,
    runId: string,
    lease: WorkItemLeaseInput,
  ): Promise<void> {
    const result = await client.query<WorkLeaseRow>(
      `SELECT tenant_id, run_id, status, lease_owner_id, lease_id, lease_epoch,
              lease_expires_at, clock_timestamp() AS database_now
       FROM ${this.schemaSql()}.work_items WHERE work_item_id=$1 FOR UPDATE`,
      [lease.workItemId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new RunStoreError("queue_item_not_found");
    if (row.tenant_id !== tenantId || row.run_id !== runId) {
      throw new RunStoreError("work_item_scope_mismatch");
    }
    if (row.status === "completed") {
      throw new RunStoreError("queue_item_already_settled");
    }
    if (
      row.status !== "leased" ||
      row.lease_owner_id !== lease.ownerId ||
      row.lease_id !== lease.leaseId ||
      safeInteger(row.lease_epoch) !== lease.leaseEpoch
    ) {
      throw new RunStoreError("stale_lease");
    }
    if (
      row.lease_expires_at === null ||
      timestamp(row.lease_expires_at) <= timestamp(row.database_now)
    ) {
      throw new RunStoreError("lease_expired");
    }
  }

  protected async completeWorkItemWithin(
    client: PoolClient,
    tenantId: string,
    runId: string,
    lease: WorkItemLeaseInput,
  ): Promise<void> {
    await this.validateExecutionLeaseWithin(client, tenantId, runId, lease);
    const completed = await client.query(
      `UPDATE ${this.schemaSql()}.work_items
       SET status='completed', lease_owner_id=NULL, lease_id=NULL,
           lease_expires_at=NULL, completed_at=clock_timestamp()
       WHERE work_item_id=$1 AND lease_expires_at>clock_timestamp()`,
      [lease.workItemId],
    );
    if (completed.rowCount !== 1) {
      throw new RunStoreError("queue_settlement_conflict");
    }
  }

  protected async retryWorkItemWithin(
    client: PoolClient,
    tenantId: string,
    runId: string,
    lease: WorkItemLeaseInput,
    retryAfterMs: number,
    reasonCode: string,
  ): Promise<void> {
    await this.validateExecutionLeaseWithin(client, tenantId, runId, lease);
    const retried = await client.query(
      `UPDATE ${this.schemaSql()}.work_items
       SET status='pending',
           available_at=clock_timestamp()+$2*interval '1 millisecond',
           lease_owner_id=NULL, lease_id=NULL, lease_expires_at=NULL,
           last_error_code=$3
       WHERE work_item_id=$1 AND lease_expires_at>clock_timestamp()`,
      [lease.workItemId, retryAfterMs, reasonCode],
    );
    if (retried.rowCount !== 1) {
      throw new RunStoreError("queue_retry_conflict");
    }
  }

  protected async loadRunWithin(
    connection: typeof this.pool | PoolClient,
    locator: RunLocator,
    lock = false,
  ): Promise<RunState | null> {
    const result = await connection.query<PostgresRunRow>(
      `SELECT snapshots.tenant_id, snapshots.space_id, snapshots.run_id,
              snapshots.revision, snapshots.last_sequence, snapshots.state_json,
              snapshots.updated_at, bindings.thread_id
       FROM ${this.schemaSql()}.run_snapshots AS snapshots
       LEFT JOIN ${this.schemaSql()}.run_thread_bindings AS bindings
         ON bindings.tenant_id=snapshots.tenant_id AND bindings.run_id=snapshots.run_id
       WHERE snapshots.tenant_id=$1 AND snapshots.run_id=$2${lock ? " FOR UPDATE OF snapshots" : ""}`,
      [locator.tenantId, locator.runId],
    );
    const row = result.rows[0];
    return row === undefined ? null : decodePostgresRunState(row, locator);
  }

  protected async loadRunReceiptWithin(
    client: PoolClient,
    input: CommitRunInput,
  ): Promise<PostgresRunReceiptRow | null> {
    const result = await client.query<PostgresRunReceiptRow>(
      `SELECT tenant_id, run_id, fingerprint, result_json
       FROM ${this.schemaSql()}.idempotency_receipts
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
    return row;
  }

  async #existingIds(
    client: PoolClient,
    table:
      | "run_events"
      | "thread_events"
      | "messages"
      | "outbox"
      | "work_items",
    column: "event_id" | "message_id" | "work_item_id",
    ids: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set();
    const result = await client.query<{ id: string }>(
      `SELECT ${column} AS id FROM ${this.schemaSql()}."${table}"
       WHERE ${column}=ANY($1::text[])`,
      [ids],
    );
    return new Set(result.rows.map((row) => row.id));
  }

  async #loadTurnStartReceipt(
    client: PoolClient | Pool,
    query: TurnStartReceiptQuery,
  ): Promise<CommitTurnStartResult | null> {
    const result = await client.query<TurnStartReceiptRow>(
      `SELECT tenant_id, run_id, fingerprint, result_json
       FROM ${this.schemaSql()}.idempotency_receipts
       WHERE scope=$1 AND idempotency_key=$2`,
      [query.idempotency.scope, query.idempotency.key],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.tenant_id !== query.tenantId) {
      throw new RunStoreError("tenant_id_mismatch");
    }
    if (row.fingerprint !== query.idempotency.requestFingerprint) {
      throw new RunStoreError("idempotency_conflict");
    }
    validateTurnStartReceipt(row.result_json, row, query.threadId);
    return structuredClone(
      normalizeTurnStartReceipt(row.result_json as CommitTurnStartResult),
    );
  }
}

async function advisoryLock(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
}

function decodeThreadGoalMutationReceipt(
  row: ThreadGoalMutationReceiptRow,
): CommitThreadGoalMutationResult {
  try {
    stableJson(row.result_json);
    const value = row.result_json as CommitThreadGoalMutationResult;
    if (
      !isPlainObject(value) ||
      value.disposition !== "committed" ||
      typeof value.goalChanged !== "boolean" ||
      (value.goalState !== null && !isPlainObject(value.goalState)) ||
      (value.canceledRunState !== null &&
        !isPlainObject(value.canceledRunState)) ||
      (value.retainedRun !== null &&
        (!isPlainObject(value.retainedRun) ||
          !isPlainObject(value.retainedRun.runState) ||
          !Array.isArray(value.retainedRun.runEvents) ||
          !Array.isArray(value.retainedRun.outbox))) ||
      (value.continuation !== null &&
        (!isPlainObject(value.continuation) ||
          !isPlainObject(value.continuation.runState) ||
          !isPlainObject(value.continuation.historyItem) ||
          !Array.isArray(value.continuation.runEvents) ||
          !Array.isArray(value.continuation.outbox) ||
          !Array.isArray(value.continuation.workItems)))
    ) {
      throw new RunStoreError("goal_mutation_receipt_invalid");
    }

    const goalState = decodeThreadGoalMutationReceiptGoal(value.goalState, row);
    const canceledRunState =
      value.canceledRunState === null
        ? null
        : normalizeStoredRunState(
            value.canceledRunState,
            "goal_mutation_receipt_invalid",
          );
    if (
      canceledRunState !== null &&
      (canceledRunState.tenantId !== row.tenant_id ||
        canceledRunState.threadId !== row.thread_id ||
        canceledRunState.status !== "canceled")
    ) {
      throw new RunStoreError("goal_mutation_receipt_invalid");
    }
    const retainedRun =
      value.retainedRun === null
        ? null
        : {
            ...value.retainedRun,
            runState: normalizeStoredRunState(
              value.retainedRun.runState,
              "goal_mutation_receipt_invalid",
            ),
          };
    if (retainedRun !== null) {
      validateThreadGoalRetainedRunReceipt(
        retainedRun,
        retainedRun.runState,
        goalState,
        { tenantId: row.tenant_id, threadId: row.thread_id },
      );
    }
    const continuation = decodeThreadGoalMutationReceiptContinuation(
      value.continuation,
      goalState,
      row,
    );
    if (
      canceledRunState !== null &&
      continuation?.runState.runId === canceledRunState.runId
    ) {
      throw new RunStoreError("goal_mutation_receipt_invalid");
    }
    return structuredClone({
      ...value,
      goalState,
      canceledRunState,
      retainedRun,
      continuation,
    });
  } catch (error) {
    if (
      error instanceof RunStoreError &&
      error.code === "goal_mutation_receipt_invalid"
    ) {
      throw error;
    }
    throw new RunStoreError("goal_mutation_receipt_invalid", { cause: error });
  }
}

function decodeThreadGoalMutationReceiptGoal(
  goal: ThreadGoal | null,
  row: ThreadGoalMutationReceiptRow,
): ThreadGoal | null {
  if (goal === null) return null;
  validateThreadGoal(goal);
  if (goal.tenantId !== row.tenant_id || goal.threadId !== row.thread_id) {
    throw new RunStoreError("goal_mutation_receipt_invalid");
  }
  return structuredClone(goal);
}

function decodeThreadGoalMutationReceiptContinuation(
  continuation: CommitThreadGoalMutationResult["continuation"],
  goal: ThreadGoal | null,
  row: ThreadGoalMutationReceiptRow,
): CommitThreadGoalMutationResult["continuation"] {
  if (continuation === null) return null;
  if (
    goal === null ||
    goal.status !== "active" ||
    continuation.runEvents.length !== 1 ||
    continuation.outbox.length !== 1 ||
    continuation.workItems.length !== 1
  ) {
    throw new RunStoreError("goal_mutation_receipt_invalid");
  }

  const runState = normalizeStoredRunState(
    continuation.runState,
    "goal_mutation_receipt_invalid",
  );
  validateModelHistoryItem(continuation.historyItem);
  validateEvents(continuation.runEvents, runState.runId, () => false);
  let reduced: RunState | null = null;
  for (const event of continuation.runEvents) {
    reduced = reduceRunLifecycleEvent(reduced, event);
  }
  validateOutbox(
    continuation.outbox,
    runState.runId,
    row.tenant_id,
    () => false,
  );
  validateWorkItems(
    continuation.workItems,
    runState.runId,
    row.tenant_id,
    runState.lastSequence,
    () => false,
    "goalActivation",
  );

  const event = continuation.runEvents[0]!;
  const outbox = continuation.outbox[0]!;
  const workItem = continuation.workItems[0]!;
  const prompt = threadGoalContinuationPrompt(goal);
  if (
    event.type !== "run.created" ||
    reduced === null ||
    stableJson(reduced) !== stableJson(runState) ||
    runState.tenantId !== row.tenant_id ||
    runState.threadId !== row.thread_id ||
    runState.status !== "queued" ||
    runState.collaborationMode !== "default" ||
    runState.goalBinding?.goalId !== goal.goalId ||
    runState.goalBinding.revision !== goal.revision ||
    continuation.historyItem.type !== "message" ||
    continuation.historyItem.role !== "user" ||
    continuation.historyItem.source !== "goal_continuation" ||
    continuation.historyItem.tenantId !== row.tenant_id ||
    continuation.historyItem.threadId !== row.thread_id ||
    continuation.historyItem.runId !== runState.runId ||
    continuation.historyItem.segmentId !== null ||
    continuation.historyItem.createdAt !== event.occurredAt ||
    continuation.historyItem.content !== prompt ||
    outbox.topic !== "run.updated" ||
    outbox.createdAt !== event.occurredAt ||
    stableJson(outbox.payload) !==
      stableJson({
        eventId: event.eventId,
        eventType: event.type,
        throughSequence: event.sequence,
      }) ||
    workItem.createdAt !== event.occurredAt ||
    stableJson(workItem.payload) !==
      stableJson({
        throughSequence: 1,
        trigger: "goalActivation",
        goalId: goal.goalId,
        goalRevision: goal.revision,
      })
  ) {
    throw new RunStoreError("goal_mutation_receipt_invalid");
  }

  return structuredClone({
    ...continuation,
    runState,
  });
}

function validateTurnStartReceipt(
  value: unknown,
  row: TurnStartReceiptRow,
  threadId: string,
): asserts value is CommitTurnStartResult {
  if (
    !isPlainObject(value) ||
    value.disposition !== "committed" ||
    !isPlainObject(value.runState) ||
    !isPlainObject(value.threadState) ||
    value.runState.tenantId !== row.tenant_id ||
    value.runState.runId !== row.run_id ||
    value.runState.threadId !== threadId ||
    value.threadState.tenantId !== row.tenant_id ||
    value.threadState.threadId !== threadId ||
    !Array.isArray(value.runEvents) ||
    !Array.isArray(value.threadEvents) ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.historyItems) ||
    !Array.isArray(value.outbox) ||
    !Array.isArray(value.workItems)
  ) {
    throw new RunStoreError("turn_start_idempotency_receipt_invalid");
  }
}

function normalizeTurnStartReceipt(
  result: CommitTurnStartResult,
): CommitTurnStartResult {
  return {
    ...result,
    runState: normalizeStoredRunState(
      result.runState,
      "turn_start_idempotency_receipt_invalid",
    ),
    ...(Object.hasOwn(result, "goalState") ? {} : { goalState: null }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RunStoreError("stored_integer_invalid");
  }
  return parsed;
}

function timestamp(value: Date | string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new RunStoreError("postgres_timestamp_invalid");
  }
  return parsed;
}
