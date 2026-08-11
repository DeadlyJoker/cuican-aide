import {
  RunStoreError,
  type CommitThreadInput,
  type CommitThreadResult,
  type CommitThreadRollbackInput,
  type CommitThreadRollbackResult,
  type MessageRecord,
  type MessageView,
  type InvalidatedMessage,
  type ModelHistoryStore,
  type ThreadLocator,
  type ThreadSpaceLocator,
  type ThreadRollbackReceiptQuery,
  type ThreadRollbackStore,
  type ThreadListQuery,
  type ThreadGoalSnapshot,
  type ThreadGoalSnapshotStore,
  type ThreadGoalStore,
  type ThreadStore,
} from "@crewon/application";
import {
  reduceThreadLifecycleEvent,
  validateThreadGoal,
  validateThreadGoalEvent,
  type ModelHistoryHead,
  type ModelHistoryItem,
  type ThreadLifecycleEvent,
  type ThreadGoal,
  type ThreadGoalEvent,
  type ThreadState,
} from "@crewon/domain";
import { type Pool, type PoolClient } from "pg";

import {
  decodePostgresMessage,
  decodePostgresModelHistoryItem,
  decodePostgresThreadReceipt,
  decodePostgresThreadRollbackReceipt,
  decodePostgresThreadState,
  safeInteger,
  type PostgresMessageRow,
  type PostgresModelHistoryRow,
  type PostgresThreadReceiptRow,
  type PostgresThreadRow,
} from "./postgres-thread-codec.ts";
import { loadPostgresModelHistoryValidation } from "./postgres-model-history.ts";
import {
  POSTGRES_THREAD_SCHEMA_VERSION,
  postgresThreadSchemaSql,
} from "./postgres-thread-schema.ts";
import {
  writePostgresMessages,
  writePostgresModelHistory,
  writePostgresThreadEvents,
  writePostgresThreadSnapshot,
} from "./postgres-thread-writer.ts";
import {
  assertPostgresSchemaNotNewer,
  createPostgresPool,
  normalizePostgresError,
  rollbackPostgres,
  type PostgresConnectionOptions,
} from "./postgres-store-support.ts";
import {
  quotePostgresIdentifier,
  validatePostgresSchemaName,
} from "./postgres-queue-schema.ts";
import {
  stableJson,
  validateLimit,
  validateMessagePage,
  validateMessageView,
  validateMessages,
  validateModelHistoryAppendShape,
  validateModelHistoryPage,
  validateModelHistoryPairing,
  validateThreadCommitInput,
  validateThreadEvents,
  validateThreadReceiptResult,
  prepareThreadRollbackCommit,
  validateThreadRollbackReceiptQuery,
  validateThreadRollbackReceiptResult,
  validateThreadRollbackReceiptAuthority,
  validateThreadLocator,
  validateThreadSpaceLocator,
  validateThreadListQuery,
} from "./store-invariants.ts";
import {
  createThreadGoalEvent,
  validateStoredThreadGoalEventPage,
} from "./thread-goal-event-support.ts";
import {
  decodeStoredThreadEvent,
  validateStoredThreadEventPage,
} from "./thread-event-support.ts";

export type PostgresThreadStoreOptions = PostgresConnectionOptions &
  Readonly<{ schema?: string }>;

type PostgresThreadGoalRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  goal_id: string;
  revision: string | number;
  state_json: unknown;
  updated_at: Date | string;
}>;

type PostgresThreadGoalEventRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  sequence: string | number;
  event_id: string;
  event_type: string;
  event_json: unknown;
  occurred_at: Date | string;
}>;

type PostgresThreadEventRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  sequence: string | number;
  event_id: string;
  event_json: unknown;
}>;

type PostgresThreadGoalSnapshotRow = Readonly<{
  tenant_id: string | null;
  thread_id: string | null;
  goal_id: string | null;
  revision: string | number | null;
  state_json: unknown | null;
  updated_at: Date | string | null;
  event_sequence: string | number;
}>;

/** PostgreSQL Thread, Message and canonical Model History authority. */
export class PostgresThreadStore
  implements
    ThreadStore,
    ThreadRollbackStore,
    ThreadGoalStore,
    ThreadGoalSnapshotStore,
    ModelHistoryStore
{
  protected readonly pool: Pool;
  protected readonly schema: string;
  readonly #ownsPool: boolean;
  #closed = false;

  constructor(options: PostgresThreadStoreOptions) {
    this.schema = validatePostgresSchemaName(options.schema ?? "crewon");
    const connection = createPostgresPool(options, "crewon-thread-store");
    this.pool = connection.pool;
    this.#ownsPool = connection.ownsPool;
  }

  static async open(
    options: PostgresThreadStoreOptions,
  ): Promise<PostgresThreadStore> {
    const store = new PostgresThreadStore(options);
    try {
      await store.migrate();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async migrate(): Promise<void> {
    this.assertOpen();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `crewon:${this.schema}:thread-authority`,
      ]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSql()}`);
      await assertPostgresSchemaNotNewer(
        client,
        this.schemaSql(),
        "thread_authority",
        POSTGRES_THREAD_SCHEMA_VERSION,
      );
      await client.query(postgresThreadSchemaSql(this.schemaSql()));
      const result = await client.query<{ version: number }>(
        `SELECT version FROM ${this.schemaSql()}.schema_migrations
         WHERE component = 'thread_authority'`,
      );
      const version = result.rows[0]?.version;
      if (version !== POSTGRES_THREAD_SCHEMA_VERSION) {
        throw new RunStoreError(
          version !== undefined && version > POSTGRES_THREAD_SCHEMA_VERSION
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsPool) await this.pool.end();
  }

  async loadThread(locator: ThreadLocator): Promise<ThreadState | null> {
    this.assertOpen();
    validateThreadLocator(locator);
    try {
      return await this.loadThreadWithin(this.pool, locator);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadThreadInSpace(
    locator: ThreadSpaceLocator,
  ): Promise<ThreadState | null> {
    this.assertOpen();
    validateThreadSpaceLocator(locator);
    try {
      const result = await this.pool.query<PostgresThreadRow>(
        `SELECT tenant_id, space_id, thread_id, created_by_actor_id, title, status,
                revision, last_event_sequence, last_message_sequence, state_json,
                created_at, updated_at, archived_at, deleted_at,
                deleted_by_actor_id
         FROM ${this.#tableSql("threads")}
         WHERE tenant_id = $1 AND space_id = $2 AND thread_id = $3`,
        [locator.tenantId, locator.spaceId, locator.threadId],
      );
      const row = result.rows[0];
      return row === undefined ? null : decodePostgresThreadState(row, locator);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async listThreads(query: ThreadListQuery): Promise<readonly ThreadState[]> {
    this.assertOpen();
    validateThreadListQuery(query);
    try {
      const result = await this.pool.query<PostgresThreadRow>(
        `SELECT tenant_id, space_id, thread_id, created_by_actor_id, title, status,
                revision, last_event_sequence, last_message_sequence, state_json,
                created_at, updated_at, archived_at, deleted_at,
                deleted_by_actor_id
         FROM ${this.#tableSql("threads")}
         WHERE tenant_id = $1
           AND space_id = $2
           AND status != 'deleted'
           AND ($3::timestamptz IS NULL OR updated_at < $3::timestamptz
             OR (updated_at = $3::timestamptz AND thread_id < $4))
         ORDER BY updated_at DESC, thread_id DESC
         LIMIT $5`,
        [
          query.tenantId,
          query.spaceId,
          query.before?.updatedAt ?? null,
          query.before?.threadId ?? null,
          query.limit,
        ],
      );
      return result.rows.map((row) =>
        decodePostgresThreadState(row, {
          tenantId: query.tenantId,
          threadId: row.thread_id,
        }),
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadThreadGoal(locator: ThreadLocator): Promise<ThreadGoal | null> {
    this.assertOpen();
    validateThreadLocator(locator);
    try {
      return await this.loadThreadGoalWithin(this.pool, locator);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadThreadGoalSnapshot(
    locator: ThreadLocator,
  ): Promise<ThreadGoalSnapshot> {
    this.assertOpen();
    validateThreadLocator(locator);
    try {
      const result = await this.pool.query<PostgresThreadGoalSnapshotRow>(
        `SELECT
           goal.tenant_id,
           goal.thread_id,
           goal.goal_id,
           goal.revision,
           goal.state_json,
           goal.updated_at,
           COALESCE((
             SELECT MAX(event.sequence)
             FROM ${this.#tableSql("thread_goal_events")} AS event
             WHERE event.tenant_id = thread.tenant_id
               AND event.thread_id = thread.thread_id
           ), 0) AS event_sequence
         FROM ${this.#tableSql("threads")} AS thread
         LEFT JOIN ${this.#tableSql("thread_goals")} AS goal
           ON goal.tenant_id = thread.tenant_id
          AND goal.thread_id = thread.thread_id
         WHERE thread.tenant_id = $1 AND thread.thread_id = $2`,
        [locator.tenantId, locator.threadId],
      );
      const row = result.rows[0];
      if (row === undefined) return { goal: null, eventSequence: 0 };
      return {
        goal:
          row.state_json === null
            ? null
            : decodePostgresThreadGoal(row as PostgresThreadGoalRow, locator),
        eventSequence: safeInteger(row.event_sequence),
      };
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async listThreadGoalEvents(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ThreadGoalEvent[]> {
    this.assertOpen();
    validateThreadLocator(locator);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RunStoreError("after_sequence_invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RunStoreError("limit_invalid");
    }
    try {
      const result = await this.pool.query<PostgresThreadGoalEventRow>(
        `SELECT tenant_id, thread_id, sequence, event_id, event_type, event_json, occurred_at
         FROM ${this.#tableSql("thread_goal_events")}
         WHERE tenant_id=$1 AND thread_id=$2 AND sequence>$3
         ORDER BY sequence ASC
         LIMIT $4`,
        [locator.tenantId, locator.threadId, afterSequence, limit],
      );
      const events = result.rows.map((row) =>
        decodePostgresThreadGoalEvent(row, locator),
      );
      validateStoredThreadGoalEventPage(events, locator, afterSequence);
      return events;
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async commitThread(input: CommitThreadInput): Promise<CommitThreadResult> {
    this.assertOpen();
    const threadId = validateThreadCommitInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.#lockCommit(client, input, threadId);
      const prior = await this.#loadReceipt(client, input);
      if (prior !== null) {
        const result = decodePostgresThreadReceipt(prior);
        validateThreadReceiptResult(result, {
          tenantId: prior.tenant_id,
          threadId: prior.thread_id,
        });
        await client.query("COMMIT");
        return {
          ...result,
          disposition: "replayed",
        };
      }
      await this.#validateSourceFence(client, input);
      const locator = { tenantId: input.tenantId, threadId };
      const current = await this.loadThreadWithin(client, locator, true);
      if ((current?.revision ?? 0) !== input.expectedRevision) {
        throw new RunStoreError("revision_conflict");
      }
      if (input.tombstone !== undefined) {
        await this.#assertNoActiveRun(client, input.tenantId, threadId);
        const currentGoal = await this.loadThreadGoalWithin(
          client,
          { tenantId: input.tenantId, threadId },
          true,
        );
        if (
          (currentGoal?.revision ?? null) !==
          input.tombstone.expectedGoalRevision
        ) {
          throw new RunStoreError("goal_revision_conflict");
        }
      }

      const eventIds = await this.#existingIds(
        client,
        "thread_events",
        "event_id",
        input.events.map((event) => event.eventId),
      );
      const messageIds = await this.#existingIds(
        client,
        "messages",
        "message_id",
        input.messages.map((message) => message.messageId),
      );
      validateThreadEvents(input.events, threadId, (id) => eventIds.has(id));
      validateMessages(
        input.messages,
        input.events,
        threadId,
        input.tenantId,
        (id) => messageIds.has(id),
      );
      await this.validateModelHistoryWithin(client, locator, input.history);

      let next = current;
      for (const event of input.events) {
        next = reduceThreadLifecycleEvent(next, event);
      }
      if (next === null) throw new RunStoreError("thread_events_empty");
      await writePostgresThreadSnapshot(
        client,
        this.schemaSql(),
        current,
        next,
        input.expectedRevision,
      );
      await writePostgresThreadEvents(
        client,
        this.schemaSql(),
        input.events,
        input.tenantId,
      );
      await writePostgresMessages(client, this.schemaSql(), input.messages);
      await writePostgresModelHistory(
        client,
        this.schemaSql(),
        input.history.items,
      );
      if (input.tombstone !== undefined) {
        await this.writeTurnStartGoalWithin(
          client,
          {
            kind: "clear",
            expectedRevision: input.tombstone.expectedGoalRevision,
            occurredAt: input.tombstone.occurredAt,
          },
          null,
          { tenantId: input.tenantId, threadId },
        );
      }

      const result: CommitThreadResult = {
        disposition: "committed",
        state: next,
        events: input.events,
        messages: input.messages,
        historyItems: input.history.items,
      };
      await client.query(
        `INSERT INTO ${this.#tableSql("thread_idempotency_receipts")}
           (tenant_id, scope, idempotency_key, thread_id, fingerprint, result_json)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          threadId,
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

  async loadThreadRollbackReceipt(
    query: ThreadRollbackReceiptQuery,
  ): Promise<CommitThreadRollbackResult | null> {
    this.assertOpen();
    validateThreadRollbackReceiptQuery(query);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const result = await client.query<PostgresThreadReceiptRow>(
        `SELECT tenant_id, thread_id, fingerprint, result_json
         FROM ${this.#tableSql("thread_idempotency_receipts")}
         WHERE scope = $1 AND idempotency_key = $2`,
        [query.idempotency.scope, query.idempotency.key],
      );
      const row = result.rows[0];
      if (row === undefined) {
        await client.query("COMMIT");
        return null;
      }
      if (row.tenant_id !== query.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (row.fingerprint !== query.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      const receipt = decodePostgresThreadRollbackReceipt(row);
      validateThreadRollbackReceiptResult(receipt, query);
      await this.#validateStoredRollbackReceiptAuthority(client, receipt);
      await client.query("COMMIT");
      return { ...receipt, disposition: "replayed" };
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async commitThreadRollback(
    input: CommitThreadRollbackInput,
  ): Promise<CommitThreadRollbackResult> {
    this.assertOpen();
    const threadId = input.event.identity.threadId;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(
        client,
        `idempotency:${input.idempotency.scope}:${input.idempotency.key}`,
      );
      const receiptRows = await client.query<PostgresThreadReceiptRow>(
        `SELECT tenant_id, thread_id, fingerprint, result_json
         FROM ${this.#tableSql("thread_idempotency_receipts")}
         WHERE scope = $1 AND idempotency_key = $2`,
        [input.idempotency.scope, input.idempotency.key],
      );
      const prior = receiptRows.rows[0];
      if (prior !== undefined) {
        if (prior.tenant_id !== input.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.fingerprint !== input.idempotency.requestFingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const receipt = decodePostgresThreadRollbackReceipt(prior);
        validateThreadRollbackReceiptResult(receipt, {
          tenantId: prior.tenant_id,
          threadId: prior.thread_id,
        });
        await this.#validateStoredRollbackReceiptAuthority(client, receipt);
        await client.query("COMMIT");
        return { ...receipt, disposition: "replayed" };
      }

      await advisoryLock(client, threadLockKey(input.tenantId, threadId));
      await this.#assertNoActiveRun(client, input.tenantId, threadId);
      const locator = { tenantId: input.tenantId, threadId };
      const current = await this.loadThreadWithin(client, locator, true);
      const historyRows = await client.query<PostgresModelHistoryRow>(
        `SELECT tenant_id, thread_id, sequence, item_id, run_id, segment_id,
                call_id, tool_kind, item_type, item_json, created_at
         FROM ${this.#tableSql("model_history_items")}
         WHERE tenant_id = $1 AND thread_id = $2
         ORDER BY sequence ASC`,
        [input.tenantId, threadId],
      );
      const history = historyRows.rows.map((row) =>
        decodePostgresModelHistoryItem(row, locator),
      );
      const messageRows = await client.query<PostgresMessageRow>(
        `SELECT tenant_id, thread_id, sequence, message_id, role, content,
                content_digest, created_at, message_json
         FROM ${this.#tableSql("messages")}
         WHERE tenant_id = $1 AND thread_id = $2
         ORDER BY sequence ASC`,
        [input.tenantId, threadId],
      );
      const messages = messageRows.rows.map((row) =>
        decodePostgresMessage(row, locator),
      );
      const prepared = prepareThreadRollbackCommit(
        input,
        current,
        history,
        messages,
      );
      const eventIds = await this.#existingIds(
        client,
        "thread_events",
        "event_id",
        [input.event.eventId],
      );
      validateThreadEvents([input.event], threadId, (id) => eventIds.has(id));
      await this.validateModelHistoryWithin(client, locator, {
        expectedLastSequence: input.expectedHistorySequence,
        items: [input.marker],
      });

      await writePostgresThreadSnapshot(
        client,
        this.schemaSql(),
        current,
        prepared.state,
        input.expectedThreadRevision,
      );
      await writePostgresThreadEvents(
        client,
        this.schemaSql(),
        [input.event],
        input.tenantId,
      );
      await writePostgresModelHistory(client, this.schemaSql(), [input.marker]);
      for (const invalidated of prepared.invalidatedMessages) {
        await client.query(
          `INSERT INTO ${this.#tableSql("message_invalidations")} (
             tenant_id, thread_id, message_sequence, history_sequence,
             rollback_id, marker_item_id, marker_history_sequence,
             invalidated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            input.tenantId,
            threadId,
            invalidated.messageSequence,
            invalidated.invalidation.historySequence,
            invalidated.invalidation.rollbackId,
            invalidated.invalidation.markerItemId,
            input.marker.sequence,
            invalidated.invalidation.invalidatedAt,
          ],
        );
      }

      const continuationTable = await client.query<{
        table_name: string | null;
      }>("SELECT to_regclass($1) AS table_name", [
        `${this.schema}.thread_continuations`,
      ]);
      let invalidatedContinuationCount = 0;
      if (continuationTable.rows[0]?.table_name != null) {
        const deleted = await client.query(
          `DELETE FROM ${this.#tableSql("thread_continuations")}
           WHERE tenant_id = $1 AND thread_id = $2`,
          [input.tenantId, threadId],
        );
        invalidatedContinuationCount = deleted.rowCount ?? 0;
      }
      const modelStateTable = await client.query<{
        table_name: string | null;
      }>("SELECT to_regclass($1) AS table_name", [
        `${this.schema}.thread_model_states`,
      ]);
      let invalidatedModelState = false;
      if (modelStateTable.rows[0]?.table_name != null) {
        const deleted = await client.query(
          `DELETE FROM ${this.#tableSql("thread_model_states")}
           WHERE tenant_id = $1 AND thread_id = $2`,
          [input.tenantId, threadId],
        );
        invalidatedModelState = deleted.rowCount === 1;
      }

      const result: CommitThreadRollbackResult = {
        disposition: "committed",
        state: prepared.state,
        event: input.event,
        marker: input.marker,
        invalidatedMessages: prepared.invalidatedMessages,
        invalidatedContinuationCount,
        invalidatedModelState,
      };
      await client.query(
        `INSERT INTO ${this.#tableSql("thread_rollback_commits")} (
           tenant_id, thread_id, rollback_id, event_sequence,
           marker_history_sequence, invalidated_continuation_count,
           invalidated_model_state, committed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          input.tenantId,
          threadId,
          input.marker.rollbackId,
          input.event.sequence,
          input.marker.sequence,
          invalidatedContinuationCount,
          invalidatedModelState,
          input.event.occurredAt,
        ],
      );
      await client.query(
        `INSERT INTO ${this.#tableSql("thread_idempotency_receipts")}
           (tenant_id, scope, idempotency_key, thread_id, fingerprint,
            result_json)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          threadId,
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

  async listMessages(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
    view: MessageView = "standard",
  ): Promise<readonly MessageRecord[]> {
    this.assertOpen();
    validateMessagePage(locator, afterSequence, limit);
    validateMessageView(view);
    try {
      const result = await this.pool.query<PostgresMessageRow>(
        `SELECT messages.tenant_id, messages.thread_id, messages.sequence,
                messages.message_id, messages.role, messages.content,
                messages.content_digest, messages.created_at,
                messages.message_json, invalidations.rollback_id,
                invalidations.marker_item_id, invalidations.history_sequence,
                invalidations.invalidated_at
         FROM ${this.#tableSql("messages")} AS messages
         LEFT JOIN ${this.#tableSql("message_invalidations")} AS invalidations
           ON invalidations.tenant_id = messages.tenant_id
          AND invalidations.thread_id = messages.thread_id
          AND invalidations.message_sequence = messages.sequence
         WHERE messages.tenant_id = $1
           AND messages.thread_id = $2
           AND messages.sequence > $3
           AND ($4::text = 'audit' OR invalidations.message_sequence IS NULL)
         ORDER BY messages.sequence ASC LIMIT $5`,
        [locator.tenantId, locator.threadId, afterSequence, view, limit],
      );
      return result.rows.map((row) =>
        decodePostgresMessage(row, locator, view),
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async listThreadEvents(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ThreadLifecycleEvent[]> {
    this.assertOpen();
    validateThreadLocator(locator);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RunStoreError("after_sequence_invalid");
    }
    validateLimit(limit);
    try {
      const result = await this.pool.query<PostgresThreadEventRow>(
        `SELECT tenant_id, thread_id, sequence, event_id, event_json
         FROM ${this.#tableSql("thread_events")}
         WHERE tenant_id = $1 AND thread_id = $2 AND sequence > $3
         ORDER BY sequence ASC LIMIT $4`,
        [locator.tenantId, locator.threadId, afterSequence, limit],
      );
      const events = result.rows.map((row) =>
        decodeStoredThreadEvent(
          {
            tenantId: row.tenant_id,
            threadId: row.thread_id,
            sequence: row.sequence,
            eventId: row.event_id,
            eventJson: row.event_json,
          },
          locator,
        ),
      );
      validateStoredThreadEventPage(events, locator, afterSequence);
      return events;
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadModelHistoryHead(
    locator: ThreadLocator,
  ): Promise<ModelHistoryHead | null> {
    this.assertOpen();
    validateThreadLocator(locator);
    try {
      const result = await this.pool.query<{ last_sequence: string | number }>(
        `SELECT COALESCE(MAX(history.sequence), 0) AS last_sequence
         FROM ${this.#tableSql("threads")} AS thread
         LEFT JOIN ${this.#tableSql("model_history_items")} AS history
           ON history.tenant_id = thread.tenant_id AND history.thread_id = thread.thread_id
         WHERE thread.tenant_id = $1 AND thread.thread_id = $2
         GROUP BY thread.thread_id`,
        [locator.tenantId, locator.threadId],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : {
            tenantId: locator.tenantId,
            threadId: locator.threadId,
            lastSequence: safeInteger(row.last_sequence),
          };
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async listModelHistoryItems(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ModelHistoryItem[]> {
    this.assertOpen();
    validateModelHistoryPage(locator, afterSequence, limit);
    try {
      const rows = await this.#loadModelHistory(
        this.pool,
        locator,
        afterSequence,
        limit,
      );
      return rows.map((row) => decodePostgresModelHistoryItem(row, locator));
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async #validateStoredRollbackReceiptAuthority(
    client: PoolClient,
    result: CommitThreadRollbackResult,
  ): Promise<void> {
    const locator = {
      tenantId: result.state.tenantId,
      threadId: result.state.threadId,
    };
    const historyRows = await client.query<PostgresModelHistoryRow>(
      `SELECT tenant_id, thread_id, sequence, item_id, run_id, segment_id,
              call_id, tool_kind, item_type, item_json, created_at
       FROM ${this.#tableSql("model_history_items")}
       WHERE tenant_id = $1 AND thread_id = $2
       ORDER BY sequence ASC`,
      [locator.tenantId, locator.threadId],
    );
    const history = historyRows.rows.map((row) =>
      decodePostgresModelHistoryItem(row, locator),
    );
    const messageRows = await client.query<PostgresMessageRow>(
      `SELECT messages.tenant_id, messages.thread_id, messages.sequence,
              messages.message_id, messages.role, messages.content,
              messages.content_digest, messages.created_at,
              messages.message_json, invalidations.rollback_id,
              invalidations.marker_item_id, invalidations.history_sequence,
              invalidations.invalidated_at
       FROM ${this.#tableSql("messages")} AS messages
       LEFT JOIN ${this.#tableSql("message_invalidations")} AS invalidations
         ON invalidations.tenant_id = messages.tenant_id
        AND invalidations.thread_id = messages.thread_id
        AND invalidations.message_sequence = messages.sequence
       WHERE messages.tenant_id = $1 AND messages.thread_id = $2
       ORDER BY messages.sequence ASC`,
      [locator.tenantId, locator.threadId],
    );
    const auditMessages = messageRows.rows.map((row) =>
      decodePostgresMessage(row, locator, "audit"),
    );
    const messages: MessageRecord[] = auditMessages.map((message) => {
      const { invalidation: _invalidation, ...stored } = message;
      return stored;
    });
    const invalidatedMessages: InvalidatedMessage[] = auditMessages.flatMap(
      (message) => {
        const invalidation = message.invalidation;
        if (invalidation?.rollbackId !== result.marker.rollbackId) return [];
        if (
          Date.parse(invalidation.invalidatedAt) !==
          Date.parse(result.event.occurredAt)
        ) {
          throw new RunStoreError("thread_rollback_receipt_authority_invalid");
        }
        return [
          {
            messageId: message.messageId,
            messageSequence: message.sequence,
            invalidation: {
              ...invalidation,
              invalidatedAt: result.event.occurredAt,
            },
          },
        ];
      },
    );
    const effectsRows = await client.query<{
      invalidated_continuation_count: string | number;
      invalidated_model_state: boolean;
    }>(
      `SELECT invalidated_continuation_count, invalidated_model_state
       FROM ${this.#tableSql("thread_rollback_commits")}
       WHERE tenant_id = $1 AND thread_id = $2 AND rollback_id = $3`,
      [locator.tenantId, locator.threadId, result.marker.rollbackId],
    );
    const effects = effectsRows.rows[0];
    if (effects === undefined) {
      throw new RunStoreError("thread_rollback_receipt_authority_invalid");
    }
    validateThreadRollbackReceiptAuthority(
      result,
      history,
      messages,
      invalidatedMessages,
      {
        invalidatedContinuationCount: safeInteger(
          effects.invalidated_continuation_count,
        ),
        invalidatedModelState: effects.invalidated_model_state,
      },
    );
  }

  async #lockCommit(
    client: PoolClient,
    input: CommitThreadInput,
    threadId: string,
  ): Promise<void> {
    await advisoryLock(
      client,
      `idempotency:${input.idempotency.scope}:${input.idempotency.key}`,
    );
    const aggregateKeys = [threadLockKey(input.tenantId, threadId)];
    if (input.sourceFence !== undefined) {
      aggregateKeys.push(
        threadLockKey(input.tenantId, input.sourceFence.threadId),
      );
    }
    for (const key of [...new Set(aggregateKeys)].sort()) {
      await advisoryLock(client, key);
    }
  }

  async #loadReceipt(
    client: PoolClient,
    input: CommitThreadInput,
  ): Promise<PostgresThreadReceiptRow | null> {
    const result = await client.query<PostgresThreadReceiptRow>(
      `SELECT tenant_id, thread_id, fingerprint, result_json
       FROM ${this.#tableSql("thread_idempotency_receipts")}
       WHERE scope = $1 AND idempotency_key = $2`,
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

  async #validateSourceFence(
    client: PoolClient,
    input: CommitThreadInput,
  ): Promise<void> {
    if (input.sourceFence === undefined) return;
    const source = await this.loadThreadWithin(
      client,
      { tenantId: input.tenantId, threadId: input.sourceFence.threadId },
      true,
    );
    if (
      source?.spaceId !== input.sourceFence.spaceId ||
      source.revision !== input.sourceFence.expectedRevision
    ) {
      throw new RunStoreError("thread_fork_source_revision_conflict");
    }
  }

  async #assertNoActiveRun(
    client: PoolClient,
    tenantId: string,
    threadId: string,
  ): Promise<void> {
    const authority = await client.query<{ table_name: string | null }>(
      "SELECT to_regclass($1) AS table_name",
      [`${this.schema}.run_snapshots`],
    );
    if (authority.rows[0]?.table_name == null) return;
    const active = await client.query<{ run_id: string }>(
      `SELECT snapshots.run_id
       FROM ${this.#tableSql("run_snapshots")} AS snapshots
       JOIN ${this.#tableSql("run_thread_bindings")} AS bindings
         ON bindings.tenant_id = snapshots.tenant_id
        AND bindings.run_id = snapshots.run_id
       WHERE snapshots.tenant_id = $1
         AND bindings.thread_id = $2
         AND snapshots.state_json->>'status'
             NOT IN ('completed', 'failed', 'canceled')`,
      [tenantId, threadId],
    );
    if (active.rows.length > 1) {
      throw new RunStoreError("thread_active_run_invariant");
    }
    if (active.rows.length !== 0) {
      throw new RunStoreError("thread_active_run_conflict");
    }
    const unsettledWork = await client.query<{ work_item_id: string }>(
      `SELECT work.work_item_id
       FROM ${this.#tableSql("work_items")} AS work
       JOIN ${this.#tableSql("run_thread_bindings")} AS bindings
         ON bindings.tenant_id = work.tenant_id
        AND bindings.run_id = work.run_id
       WHERE work.tenant_id = $1
         AND bindings.thread_id = $2
         AND work.status != 'completed'`,
      [tenantId, threadId],
    );
    if (unsettledWork.rows.length !== 0) {
      throw new RunStoreError("thread_active_work_conflict");
    }
  }

  protected async loadThreadWithin(
    connection: Pool | PoolClient,
    locator: ThreadLocator,
    lock = false,
  ): Promise<ThreadState | null> {
    const result = await connection.query<PostgresThreadRow>(
      `SELECT tenant_id, space_id, thread_id, created_by_actor_id, title, status,
              revision, last_event_sequence, last_message_sequence, state_json,
              created_at, updated_at, archived_at, deleted_at,
              deleted_by_actor_id
       FROM ${this.#tableSql("threads")}
       WHERE tenant_id = $1 AND thread_id = $2${lock ? " FOR UPDATE" : ""}`,
      [locator.tenantId, locator.threadId],
    );
    const row = result.rows[0];
    return row === undefined ? null : decodePostgresThreadState(row, locator);
  }

  protected async loadThreadGoalWithin(
    connection: Pool | PoolClient,
    locator: ThreadLocator,
    lock = false,
  ): Promise<ThreadGoal | null> {
    const result = await connection.query<PostgresThreadGoalRow>(
      `SELECT tenant_id, thread_id, goal_id, revision, state_json, updated_at
       FROM ${this.#tableSql("thread_goals")}
       WHERE tenant_id = $1 AND thread_id = $2${lock ? " FOR UPDATE" : ""}`,
      [locator.tenantId, locator.threadId],
    );
    const row = result.rows[0];
    return row === undefined ? null : decodePostgresThreadGoal(row, locator);
  }

  protected async writeTurnStartGoalWithin(
    client: PoolClient,
    mutation: import("@crewon/application").TurnStartGoalMutation,
    next: ThreadGoal | null,
    locator: ThreadLocator,
  ): Promise<void> {
    if (mutation.kind === "keep") return;
    const current = await this.loadThreadGoalWithin(client, locator, true);
    if (mutation.kind === "clear") {
      if (mutation.expectedRevision === null) return;
      const deleted = await client.query(
        `DELETE FROM ${this.#tableSql("thread_goals")}
         WHERE tenant_id=$1 AND thread_id=$2 AND revision=$3`,
        [locator.tenantId, locator.threadId, mutation.expectedRevision],
      );
      if (deleted.rowCount !== 1) {
        throw new RunStoreError("goal_revision_conflict");
      }
      await this.#writeThreadGoalEventWithin(
        client,
        current,
        null,
        mutation.occurredAt,
        locator,
      );
      return;
    }
    if (next === null) throw new RunStoreError("goal_mutation_invalid");
    if (mutation.expectedRevision === null) {
      await client.query(
        `INSERT INTO ${this.#tableSql("thread_goals")}
           (tenant_id, thread_id, goal_id, revision, state_json, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          locator.tenantId,
          locator.threadId,
          next.goalId,
          next.revision,
          JSON.stringify(next),
          next.updatedAt,
        ],
      );
      await this.#writeThreadGoalEventWithin(
        client,
        current,
        next,
        next.updatedAt,
        locator,
      );
      return;
    }
    const updated = await client.query(
      `UPDATE ${this.#tableSql("thread_goals")}
       SET goal_id=$1, revision=$2, state_json=$3, updated_at=$4
       WHERE tenant_id=$5 AND thread_id=$6 AND revision=$7`,
      [
        next.goalId,
        next.revision,
        JSON.stringify(next),
        next.updatedAt,
        locator.tenantId,
        locator.threadId,
        mutation.expectedRevision,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new RunStoreError("goal_revision_conflict");
    }
    await this.#writeThreadGoalEventWithin(
      client,
      current,
      next,
      next.updatedAt,
      locator,
    );
  }

  async #writeThreadGoalEventWithin(
    client: PoolClient,
    current: ThreadGoal | null,
    next: ThreadGoal | null,
    occurredAt: string,
    locator: ThreadLocator,
  ): Promise<void> {
    const head = await client.query<{ last_sequence: string | number }>(
      `SELECT COALESCE(MAX(sequence), 0) AS last_sequence
       FROM ${this.#tableSql("thread_goal_events")}
       WHERE tenant_id=$1 AND thread_id=$2`,
      [locator.tenantId, locator.threadId],
    );
    const lastSequence = safeInteger(head.rows[0]?.last_sequence ?? 0);
    const event = createThreadGoalEvent({
      current,
      next,
      lastSequence,
      occurredAt,
      tenantId: locator.tenantId,
      threadId: locator.threadId,
    });
    if (event === null) return;
    await client.query(
      `INSERT INTO ${this.#tableSql("thread_goal_events")}
         (tenant_id, thread_id, sequence, event_id, event_type, event_json, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        locator.tenantId,
        locator.threadId,
        event.sequence,
        event.eventId,
        event.type,
        event,
        event.occurredAt,
      ],
    );
  }

  protected async validateModelHistoryWithin(
    client: PoolClient,
    locator: ThreadLocator,
    append: CommitThreadInput["history"],
  ): Promise<void> {
    const itemIds = await this.#existingIds(
      client,
      "model_history_items",
      "item_id",
      append.items.map((item) => item.itemId),
    );
    const validation = await loadPostgresModelHistoryValidation(
      client,
      this.schemaSql(),
      locator,
      append.items,
    );
    validateModelHistoryAppendShape(
      append,
      locator,
      validation.lastSequence,
      (id) => itemIds.has(id),
    );
    for (const item of append.items) {
      if (
        item.type === "tool_call" &&
        validation.existingToolCallKeys.has(toolCallKey(item))
      ) {
        throw new RunStoreError("model_history_tool_call_duplicate");
      }
    }
    validateModelHistoryPairing([
      ...validation.pendingToolCalls,
      ...append.items,
    ]);
  }

  async #loadModelHistory(
    connection: Pool | PoolClient,
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<PostgresModelHistoryRow[]> {
    const result = await connection.query<PostgresModelHistoryRow>(
      `SELECT tenant_id, thread_id, sequence, item_id, run_id, segment_id,
              call_id, tool_kind, item_type, item_json, created_at
       FROM ${this.#tableSql("model_history_items")}
       WHERE tenant_id = $1 AND thread_id = $2 AND sequence > $3
       ORDER BY sequence ASC LIMIT $4`,
      [locator.tenantId, locator.threadId, afterSequence, limit],
    );
    return result.rows;
  }

  async #existingIds(
    client: PoolClient,
    table: "thread_events" | "messages" | "model_history_items",
    column: "event_id" | "message_id" | "item_id",
    ids: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set();
    const result = await client.query<{ id: string }>(
      `SELECT ${column} AS id FROM ${this.#tableSql(table)}
       WHERE ${column} = ANY($1::text[])`,
      [ids],
    );
    return new Set(result.rows.map((row) => row.id));
  }

  protected schemaSql(): string {
    return quotePostgresIdentifier(this.schema);
  }

  #tableSql(table: string): string {
    return `${this.schemaSql()}."${table}"`;
  }

  protected assertOpen(): void {
    if (this.#closed) throw new RunStoreError("store_closed");
  }
}

function decodePostgresThreadGoal(
  row: PostgresThreadGoalRow,
  locator: ThreadLocator,
): ThreadGoal {
  try {
    const goal = (
      typeof row.state_json === "string"
        ? JSON.parse(row.state_json)
        : row.state_json
    ) as ThreadGoal;
    validateThreadGoal(goal);
    const storedUpdatedAt =
      row.updated_at instanceof Date
        ? row.updated_at.getTime()
        : Date.parse(row.updated_at);
    if (
      goal.tenantId !== row.tenant_id ||
      goal.tenantId !== locator.tenantId ||
      goal.threadId !== row.thread_id ||
      goal.threadId !== locator.threadId ||
      goal.goalId !== row.goal_id ||
      goal.revision !== safeInteger(row.revision) ||
      !Number.isFinite(storedUpdatedAt) ||
      Date.parse(goal.updatedAt) !== storedUpdatedAt
    ) {
      throw new Error("thread_goal_columns_mismatch");
    }
    return structuredClone(goal);
  } catch (error) {
    throw new RunStoreError("stored_thread_goal_invalid", { cause: error });
  }
}

function decodePostgresThreadGoalEvent(
  row: PostgresThreadGoalEventRow,
  locator: ThreadLocator,
): ThreadGoalEvent {
  try {
    const event = (
      typeof row.event_json === "string"
        ? JSON.parse(row.event_json)
        : row.event_json
    ) as ThreadGoalEvent;
    validateThreadGoalEvent(event);
    const occurredAt =
      row.occurred_at instanceof Date
        ? row.occurred_at.getTime()
        : Date.parse(row.occurred_at);
    if (
      row.tenant_id !== locator.tenantId ||
      row.thread_id !== locator.threadId ||
      event.tenantId !== row.tenant_id ||
      event.threadId !== row.thread_id ||
      event.sequence !== safeInteger(row.sequence) ||
      event.eventId !== row.event_id ||
      event.type !== row.event_type ||
      !Number.isFinite(occurredAt) ||
      Date.parse(event.occurredAt) !== occurredAt
    ) {
      throw new Error("thread_goal_event_columns_mismatch");
    }
    return structuredClone(event);
  } catch (error) {
    throw new RunStoreError("stored_thread_goal_event_invalid", {
      cause: error,
    });
  }
}

async function advisoryLock(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
}

function threadLockKey(tenantId: string, threadId: string): string {
  return `thread:${tenantId}:${threadId}`;
}

function toolCallKey(
  item: Extract<ModelHistoryItem, { type: "tool_call" }>,
): string {
  return `${item.runId}\0${item.callId}`;
}
