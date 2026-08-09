import { DatabaseSync } from "node:sqlite";

import { RunStoreError } from "@crewon/application";

export const SQLITE_SCHEMA_VERSION = 20;

type LegacyRunRow = Readonly<{
  tenant_id: string;
  space_id: string;
  run_id: string;
  state_json: string;
}>;

type BackfilledThread = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  createdByActorId: string;
  createdAt: string;
  updatedAt: string;
}>;

export function configureAndMigrateSqlite(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");

  const version = readUserVersion(database);
  if (version > SQLITE_SCHEMA_VERSION) {
    throw new RunStoreError("sqlite_schema_too_new");
  }
  if (version === SQLITE_SCHEMA_VERSION) {
    return;
  }

  const migratingExistingSchema = version !== 0;
  if (migratingExistingSchema) {
    database.exec("PRAGMA foreign_keys = OFF");
  }
  try {
    database.exec("BEGIN IMMEDIATE");
    if (version === 0) {
      createCurrentSchema(database);
    } else if (version === 1) {
      migrateVersionOne(database);
      migrateVersionTwo(database);
      migrateVersionThree(database);
      migrateVersionFour(database);
      migrateVersionFive(database);
      migrateVersionSix(database);
      migrateVersionSeven(database);
      migrateVersionEight(database);
    } else if (version === 2) {
      migrateVersionTwo(database);
      migrateVersionThree(database);
      migrateVersionFour(database);
      migrateVersionFive(database);
      migrateVersionSix(database);
      migrateVersionSeven(database);
      migrateVersionEight(database);
    } else if (version === 3) {
      migrateVersionThree(database);
      migrateVersionFour(database);
      migrateVersionFive(database);
      migrateVersionSix(database);
      migrateVersionSeven(database);
      migrateVersionEight(database);
    } else if (version === 4) {
      migrateVersionFour(database);
      migrateVersionFive(database);
      migrateVersionSix(database);
      migrateVersionSeven(database);
      migrateVersionEight(database);
    } else if (version === 5) {
      migrateVersionFive(database);
      migrateVersionSix(database);
      migrateVersionSeven(database);
      migrateVersionEight(database);
    } else if (version === 6) {
      migrateVersionSix(database);
      migrateVersionSeven(database);
      migrateVersionEight(database);
    } else if (version === 7) {
      migrateVersionSeven(database);
      migrateVersionEight(database);
    } else if (version === 8) {
      migrateVersionEight(database);
    } else if (version === 9) {
      // Version 9 has the current tables but predates persisted ActionIntent.
    } else if (version === 10) {
      // Version 10 has ActionIntent but predates durable Tool approvals.
    } else if (version === 11) {
      // Version 11 has Tool approvals but predates Thread model state.
    } else if (version === 12) {
      // Version 12 has Thread model state but predates AgentVersion assets.
    } else if (version === 13) {
      // Version 13 has AgentVersion assets but predates durable deployments.
    } else if (version === 14) {
      // Version 14 has deployments but predates atomic release bundles.
    } else if (version === 15) {
      // Version 15 has release bundles but predates persistent Thread Goals.
    } else if (version === 16) {
      // Version 16 has persistent Thread Goals but predates their event log.
    } else if (version === 17) {
      // Version 17 has Goal events but predates Thread lifecycle tombstones.
    } else if (version === 18) {
      // Version 18 has lifecycle tombstones but predates append-only rollback.
    } else if (version === 19) {
      // Version 19 has append-only rollback but predates Provider settings.
    } else {
      throw new RunStoreError("sqlite_schema_version_unsupported");
    }
    if (version !== 0 && version <= 9) {
      migrateVersionNine(database);
    }
    if (version !== 0 && version <= 10) {
      migrateVersionTen(database);
    }
    if (version !== 0 && version <= 11) {
      migrateVersionEleven(database);
    }
    if (version !== 0 && version <= 12) {
      migrateVersionTwelve(database);
    }
    if (version !== 0 && version <= 13) {
      migrateVersionThirteen(database);
    }
    if (version !== 0 && version <= 14) {
      migrateVersionFourteen(database);
    }
    if (version !== 0 && version <= 15) {
      migrateVersionFifteen(database);
    }
    if (version !== 0 && version <= 16) {
      migrateVersionSixteen(database);
    }
    if (version !== 0 && version <= 17) {
      migrateVersionSeventeen(database);
    }
    if (version !== 0 && version <= 18) {
      migrateVersionEighteen(database);
    }
    if (version !== 0 && version <= 19) {
      migrateVersionNineteen(database);
    }
    database.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  } finally {
    if (migratingExistingSchema) {
      database.exec("PRAGMA foreign_keys = ON");
    }
  }
}

export function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  if (row === undefined || !Number.isSafeInteger(row.user_version)) {
    throw new RunStoreError("sqlite_schema_version_invalid");
  }
  return row.user_version;
}

export function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The original error is authoritative when no transaction is active.
  }
}

function createCurrentSchema(database: DatabaseSync): void {
  database.exec(`
    ${threadAuthorityTablesSql()}

    ${threadGoalsTableSql()}

    ${threadGoalEventsTableSql()}

    ${modelHistoryTableSql()}

    ${messageInvalidationsTableSql()}

    CREATE TABLE run_snapshots (
      tenant_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      run_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 1),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, run_id)
    ) STRICT;

    ${runThreadBindingsTableSql()}

    ${threadContinuationsTableSql()}

    ${threadModelStatesTableSql()}

    ${agentVersionsTableSql()}

    ${agentVersionDeploymentsTableSql()}

    ${agentVersionReleaseTablesSql()}

    ${modelProviderSettingsTablesSql()}

    CREATE TABLE run_events (
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      event_id TEXT NOT NULL UNIQUE,
      event_json TEXT NOT NULL CHECK (json_valid(event_json)),
      PRIMARY KEY (run_id, sequence),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE
    ) STRICT;

    ${outboxTableSql()}

    ${workItemsTableSql()}

    ${executionAuthorityTablesSql()}

    ${toolExecutionReceiptsTableSql()}

    ${toolApprovalsTableSql()}

    CREATE TABLE idempotency_receipts (
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      PRIMARY KEY (scope, idempotency_key),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE
    ) STRICT;

    ${threadIdempotencyTableSql()}

    CREATE INDEX run_events_event_id_idx ON run_events(event_id);
    CREATE INDEX run_events_tenant_run_idx
      ON run_events(tenant_id, run_id, sequence);
    ${authorityIndexesSql()}
    ${queueIndexesSql()}
    ${executionAuthorityIndexesSql()}
    ${toolExecutionReceiptsIndexesSql()}
    ${toolApprovalsIndexesSql()}
  `);
}

function migrateVersionOne(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE outbox RENAME TO outbox_v1;
    DROP INDEX IF EXISTS outbox_pending_idx;

    ${outboxTableSql()}

    INSERT INTO outbox (
      outbox_order,
      message_id,
      tenant_id,
      run_id,
      topic,
      message_json,
      created_at,
      available_at_ms
    )
    SELECT
      outbox_order,
      message_id,
      tenant_id,
      run_id,
      topic,
      message_json,
      created_at,
      0
    FROM outbox_v1;

    DROP TABLE outbox_v1;

    ${workItemsTableSql()}
    ${queueIndexesSql()}
  `);
}

function migrateVersionTwo(database: DatabaseSync): void {
  const rows = database
    .prepare(
      `SELECT tenant_id, space_id, run_id, state_json
       FROM run_snapshots
       ORDER BY tenant_id, run_id`,
    )
    .all() as unknown as LegacyRunRow[];
  const threads = collectBackfilledThreads(rows);

  database.exec(`
    ${threadAuthorityTablesSql()}
    ${runThreadBindingsTableSql()}
    ${threadIdempotencyTableSql()}
    ${authorityIndexesSql()}
  `);

  const insertThread = database.prepare(
    `INSERT INTO threads (
      tenant_id,
      space_id,
      thread_id,
      created_by_actor_id,
      title,
      status,
      revision,
      last_event_sequence,
      last_message_sequence,
      state_json,
      created_at,
      updated_at,
      archived_at
    ) VALUES (?, ?, ?, ?, NULL, 'active', 1, 1, 0, ?, ?, ?, NULL)`,
  );
  const insertEvent = database.prepare(
    `INSERT INTO thread_events (
      tenant_id,
      thread_id,
      sequence,
      event_id,
      event_json
    ) VALUES (?, ?, 1, ?, ?)`,
  );
  for (const thread of threads.values()) {
    const state = {
      threadId: thread.threadId,
      tenantId: thread.tenantId,
      spaceId: thread.spaceId,
      createdByActorId: thread.createdByActorId,
      title: null,
      status: "active",
      revision: 1,
      lastEventSequence: 1,
      lastMessageSequence: 0,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      archivedAt: null,
    } as const;
    const eventId = migrationThreadEventId(thread.tenantId, thread.threadId);
    const event = {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: thread.threadId },
      eventId,
      sequence: 1,
      occurredAt: thread.createdAt,
      type: "thread.created",
      data: {
        tenantId: thread.tenantId,
        spaceId: thread.spaceId,
        createdByActorId: thread.createdByActorId,
        title: null,
      },
    } as const;
    insertThread.run(
      thread.tenantId,
      thread.spaceId,
      thread.threadId,
      thread.createdByActorId,
      JSON.stringify(state),
      thread.createdAt,
      thread.updatedAt,
    );
    insertEvent.run(
      thread.tenantId,
      thread.threadId,
      eventId,
      JSON.stringify(event),
    );
  }

  const insertBinding = database.prepare(
    `INSERT INTO run_thread_bindings (tenant_id, run_id, thread_id)
     VALUES (?, ?, ?)`,
  );
  for (const row of rows) {
    const state = parseLegacyRunState(row);
    insertBinding.run(row.tenant_id, row.run_id, state.threadId);
  }
}

function migrateVersionThree(database: DatabaseSync): void {
  database.exec(legacyThreadContinuationsTableSql());
}

function migrateVersionFour(database: DatabaseSync): void {
  database.exec(`
    ${executionAuthorityTablesSql()}
    ${executionAuthorityIndexesSql()}
  `);
}

function migrateVersionFive(database: DatabaseSync): void {
  database.exec(`
    ${modelHistoryTableSql()}

    INSERT INTO model_history_items (
      tenant_id,
      thread_id,
      sequence,
      item_id,
      run_id,
      segment_id,
      item_type,
      item_json,
      created_at
    )
    SELECT
      tenant_id,
      thread_id,
      sequence,
      'history:migration:' || message_id,
      NULL,
      NULL,
      'message',
      json_object(
        'schemaVersion', 'crewon.model-history-item.v0',
        'itemId', 'history:migration:' || message_id,
        'tenantId', tenant_id,
        'threadId', thread_id,
        'sequence', sequence,
        'runId', NULL,
        'segmentId', NULL,
        'createdAt', created_at,
        'type', 'message',
        'role', role,
        'source', 'thread_message',
        'content', content,
        'contentDigest', content_digest
      ),
      created_at
    FROM messages
    ORDER BY tenant_id, thread_id, sequence;

    ALTER TABLE thread_continuations RENAME TO thread_continuations_v5;
    DROP INDEX IF EXISTS thread_continuations_thread_idx;
    ${threadContinuationsTableSql()}
    INSERT INTO thread_continuations (
      tenant_id,
      thread_id,
      agent_version_id,
      adapter_name,
      adapter_version,
      model_id,
      through_history_sequence,
      context_revision,
      checkpoint_json,
      updated_at
    )
    SELECT
      tenant_id,
      thread_id,
      agent_version_id,
      adapter_name,
      adapter_version,
      model_id,
      through_message_sequence,
      'canonical',
      checkpoint_json,
      updated_at
    FROM thread_continuations_v5;
    DROP TABLE thread_continuations_v5;
  `);
}

function migrateVersionSix(database: DatabaseSync): void {
  database.exec(`
    ${toolExecutionReceiptsTableSql()}
    ${toolExecutionReceiptsIndexesSql()}
  `);
}

function migrateVersionSeven(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE thread_continuations RENAME TO thread_continuations_v8;
    DROP INDEX IF EXISTS thread_continuations_thread_idx;
    ALTER TABLE model_history_items RENAME TO model_history_items_v8;
    DROP INDEX IF EXISTS model_history_items_thread_idx;
    DROP INDEX IF EXISTS model_history_items_run_idx;

    ${modelHistoryTableSql()}
    INSERT INTO model_history_items (
      tenant_id,
      thread_id,
      sequence,
      item_id,
      run_id,
      segment_id,
      item_type,
      item_json,
      created_at
    )
    SELECT
      tenant_id,
      thread_id,
      sequence,
      item_id,
      run_id,
      segment_id,
      item_type,
      item_json,
      created_at
    FROM model_history_items_v8;

    ${threadContinuationsTableSql()}
    INSERT INTO thread_continuations (
      tenant_id,
      thread_id,
      agent_version_id,
      adapter_name,
      adapter_version,
      model_id,
      through_history_sequence,
      context_revision,
      checkpoint_json,
      updated_at
    )
    SELECT
      tenant_id,
      thread_id,
      agent_version_id,
      adapter_name,
      adapter_version,
      model_id,
      through_history_sequence,
      'canonical',
      checkpoint_json,
      updated_at
    FROM thread_continuations_v8;

    DROP TABLE thread_continuations_v8;
    DROP TABLE model_history_items_v8;
  `);
}

function migrateVersionEight(database: DatabaseSync): void {
  database.exec(`
    UPDATE threads
    SET state_json = json_set(
      state_json,
      '$.forkedFromThreadId', NULL,
      '$.forkedThroughHistorySequence', NULL
    )
    WHERE json_type(state_json, '$.forkedFromThreadId') IS NULL
       OR json_type(state_json, '$.forkedThroughHistorySequence') IS NULL;

    UPDATE thread_idempotency_receipts
    SET result_json = json_set(
      result_json,
      '$.state.forkedFromThreadId', NULL,
      '$.state.forkedThroughHistorySequence', NULL
    )
    WHERE json_type(result_json, '$.state') = 'object'
      AND (
        json_type(result_json, '$.state.forkedFromThreadId') IS NULL
        OR json_type(result_json, '$.state.forkedThroughHistorySequence') IS NULL
      );

    UPDATE idempotency_receipts
    SET result_json = json_set(
      result_json,
      '$.threadState.forkedFromThreadId', NULL,
      '$.threadState.forkedThroughHistorySequence', NULL
    )
    WHERE json_type(result_json, '$.threadState') = 'object'
      AND (
        json_type(result_json, '$.threadState.forkedFromThreadId') IS NULL
        OR json_type(result_json, '$.threadState.forkedThroughHistorySequence') IS NULL
      );
  `);
}

function migrateVersionNine(database: DatabaseSync): void {
  database.exec(`
    UPDATE tool_execution_receipts
    SET state_json = json_set(state_json, '$.actionIntent', json('null'))
    WHERE json_type(state_json, '$.actionIntent') IS NULL;
  `);
}

function migrateVersionTen(database: DatabaseSync): void {
  database.exec(`
    ${toolApprovalsTableSql()}
    ${toolApprovalsIndexesSql()}
  `);
}

function migrateVersionEleven(database: DatabaseSync): void {
  database.exec(threadModelStatesTableSql());
}

function collectBackfilledThreads(
  rows: readonly LegacyRunRow[],
): Map<string, BackfilledThread> {
  const threads = new Map<string, BackfilledThread>();
  for (const row of rows) {
    const state = parseLegacyRunState(row);
    const key = `${row.tenant_id}\u0000${state.threadId}`;
    const prior = threads.get(key);
    if (
      prior !== undefined &&
      (prior.spaceId !== row.space_id ||
        prior.createdByActorId !== state.createdByActorId)
    ) {
      throw new RunStoreError("sqlite_thread_backfill_conflict");
    }
    threads.set(key, {
      tenantId: row.tenant_id,
      spaceId: row.space_id,
      threadId: state.threadId,
      createdByActorId: state.createdByActorId,
      createdAt:
        prior === undefined || state.createdAt < prior.createdAt
          ? state.createdAt
          : prior.createdAt,
      updatedAt:
        prior === undefined || state.updatedAt > prior.updatedAt
          ? state.updatedAt
          : prior.updatedAt,
    });
  }
  return threads;
}

function parseLegacyRunState(row: LegacyRunRow): {
  threadId: string;
  createdByActorId: string;
  createdAt: string;
  updatedAt: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(row.state_json);
  } catch (error) {
    throw new RunStoreError("sqlite_thread_backfill_invalid", {
      cause: error,
    });
  }
  if (
    !isRecord(value) ||
    value.tenantId !== row.tenant_id ||
    value.spaceId !== row.space_id ||
    value.runId !== row.run_id ||
    !isNonEmptyString(value.threadId) ||
    !isNonEmptyString(value.createdByActorId) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt)
  ) {
    throw new RunStoreError("sqlite_thread_backfill_invalid");
  }
  return {
    threadId: value.threadId,
    createdByActorId: value.createdByActorId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function threadAuthorityTablesSql(): string {
  return `
    CREATE TABLE threads (
      tenant_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_by_actor_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'deleted')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 1),
      last_message_sequence INTEGER NOT NULL CHECK (last_message_sequence >= 0),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT,
      deleted_by_actor_id TEXT,
      PRIMARY KEY (tenant_id, thread_id)
    ) STRICT;

    CREATE TABLE thread_events (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      event_id TEXT NOT NULL UNIQUE,
      event_json TEXT NOT NULL CHECK (json_valid(event_json)),
      PRIMARY KEY (tenant_id, thread_id, sequence),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE messages (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      message_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      message_json TEXT NOT NULL CHECK (json_valid(message_json)),
      PRIMARY KEY (tenant_id, thread_id, sequence),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX threads_visible_list_idx
      ON threads(tenant_id, space_id, updated_at DESC, thread_id DESC)
      WHERE status != 'deleted';`;
}

function threadGoalsTableSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS thread_goals (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, thread_id),
      UNIQUE (tenant_id, goal_id),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE
    ) STRICT;`;
}

function threadGoalEventsTableSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS thread_goal_events (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL CHECK (event_type IN ('goal.updated', 'goal.cleared')),
      event_json TEXT NOT NULL CHECK (json_valid(event_json)),
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, thread_id, sequence),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX IF NOT EXISTS thread_goal_events_tenant_thread_idx
      ON thread_goal_events(tenant_id, thread_id, sequence);`;
}

function runThreadBindingsTableSql(): string {
  return `
    CREATE TABLE run_thread_bindings (
      tenant_id TEXT NOT NULL,
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE RESTRICT
    ) STRICT;`;
}

function modelHistoryTableSql(): string {
  return `
    CREATE TABLE model_history_items (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      item_id TEXT NOT NULL UNIQUE,
      run_id TEXT,
      segment_id TEXT,
      item_type TEXT NOT NULL
        CHECK (item_type IN ('message', 'tool_call', 'tool_result', 'compaction', 'rollback')),
      item_json TEXT NOT NULL CHECK (json_valid(item_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, thread_id, sequence),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX model_history_items_thread_idx
      ON model_history_items(tenant_id, thread_id, sequence);
    CREATE INDEX model_history_items_run_idx
      ON model_history_items(tenant_id, run_id, sequence);`;
}

function threadContinuationsTableSql(): string {
  return `
    CREATE TABLE thread_continuations (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      agent_version_id TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      model_id TEXT NOT NULL,
      through_history_sequence INTEGER NOT NULL
        CHECK (through_history_sequence >= 1),
      context_revision TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (
        tenant_id,
        thread_id,
        agent_version_id,
        adapter_name,
        adapter_version,
        model_id
      ),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, thread_id, through_history_sequence)
        REFERENCES model_history_items(tenant_id, thread_id, sequence) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX thread_continuations_thread_idx
      ON thread_continuations(tenant_id, thread_id, through_history_sequence);`;
}

function messageInvalidationsTableSql(): string {
  return `
    CREATE TABLE message_invalidations (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_sequence INTEGER NOT NULL CHECK (message_sequence >= 1),
      history_sequence INTEGER NOT NULL CHECK (history_sequence >= 1),
      rollback_id TEXT NOT NULL,
      marker_item_id TEXT NOT NULL,
      marker_history_sequence INTEGER NOT NULL
        CHECK (marker_history_sequence >= 1),
      invalidated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, thread_id, message_sequence),
      UNIQUE (tenant_id, thread_id, history_sequence),
      FOREIGN KEY (tenant_id, thread_id, message_sequence)
        REFERENCES messages(tenant_id, thread_id, sequence) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, thread_id, history_sequence)
        REFERENCES model_history_items(tenant_id, thread_id, sequence) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, thread_id, marker_history_sequence)
        REFERENCES model_history_items(tenant_id, thread_id, sequence) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX message_invalidations_thread_idx
      ON message_invalidations(tenant_id, thread_id, message_sequence);

    CREATE TABLE thread_rollback_commits (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      rollback_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL CHECK (event_sequence >= 1),
      marker_history_sequence INTEGER NOT NULL
        CHECK (marker_history_sequence >= 1),
      invalidated_continuation_count INTEGER NOT NULL
        CHECK (invalidated_continuation_count >= 0),
      invalidated_model_state INTEGER NOT NULL
        CHECK (invalidated_model_state IN (0, 1)),
      committed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, thread_id, rollback_id),
      FOREIGN KEY (tenant_id, thread_id, event_sequence)
        REFERENCES thread_events(tenant_id, thread_id, sequence) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, thread_id, marker_history_sequence)
        REFERENCES model_history_items(tenant_id, thread_id, sequence) ON DELETE CASCADE
    ) STRICT;`;
}

function threadModelStatesTableSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS thread_model_states (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, thread_id),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE
    ) STRICT;`;
}

function migrateVersionTwelve(database: DatabaseSync): void {
  database.exec(agentVersionsTableSql());
}

function migrateVersionThirteen(database: DatabaseSync): void {
  database.exec(agentVersionDeploymentsTableSql());
}

function migrateVersionFourteen(database: DatabaseSync): void {
  database.exec(agentVersionReleaseTablesSql());
}

function migrateVersionFifteen(database: DatabaseSync): void {
  database.exec(threadGoalsTableSql());
}

function migrateVersionSixteen(database: DatabaseSync): void {
  const legacyGoalRun = database
    .prepare(
      `SELECT run_id
       FROM run_snapshots
       WHERE json_extract(state_json, '$.status')
               NOT IN ('completed', 'failed', 'canceled')
         AND json_type(state_json, '$.goalBinding') = 'object'
         AND (
           json_type(state_json, '$.goalAccounting') IS NULL
           OR json_type(state_json, '$.goalAccounting') = 'null'
         )
       LIMIT 1`,
    )
    .get() as { run_id: string } | undefined;
  if (legacyGoalRun !== undefined) {
    throw new RunStoreError("legacy_goal_run_requires_drain");
  }
  database.exec(threadGoalEventsTableSql());
}

function migrateVersionSeventeen(database: DatabaseSync): void {
  const columns = database
    .prepare("PRAGMA table_info(threads)")
    .all() as unknown as { name: string }[];
  if (!columns.some((column) => column.name === "deleted_at")) {
    database.exec(`
      CREATE TABLE threads_v18 (
        tenant_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_by_actor_id TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'deleted')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 1),
        last_message_sequence INTEGER NOT NULL CHECK (last_message_sequence >= 0),
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        deleted_at TEXT,
        deleted_by_actor_id TEXT,
        PRIMARY KEY (tenant_id, thread_id)
      ) STRICT;

      INSERT INTO threads_v18 (
        tenant_id, space_id, thread_id, created_by_actor_id, title, status,
        revision, last_event_sequence, last_message_sequence, state_json,
        created_at, updated_at, archived_at, deleted_at, deleted_by_actor_id
      )
      SELECT
        tenant_id, space_id, thread_id, created_by_actor_id, title, status,
        revision, last_event_sequence, last_message_sequence, state_json,
        created_at, updated_at, archived_at, NULL, NULL
      FROM threads;

      DROP TABLE threads;
      ALTER TABLE threads_v18 RENAME TO threads;
    `);
  }

  database.exec(`
    UPDATE threads
    SET state_json = json_set(
      state_json,
      '$.deletedAt', NULL,
      '$.deletedByActorId', NULL
    )
    WHERE json_type(state_json, '$.deletedAt') IS NULL
       OR json_type(state_json, '$.deletedByActorId') IS NULL;

    UPDATE thread_idempotency_receipts
    SET result_json = json_set(
      result_json,
      '$.state.deletedAt', NULL,
      '$.state.deletedByActorId', NULL
    )
    WHERE json_type(result_json, '$.state') = 'object'
      AND (
        json_type(result_json, '$.state.deletedAt') IS NULL
        OR json_type(result_json, '$.state.deletedByActorId') IS NULL
      );

    UPDATE thread_idempotency_receipts
    SET result_json = json_set(
      result_json,
      '$.threadState.deletedAt', NULL,
      '$.threadState.deletedByActorId', NULL
    )
    WHERE json_type(result_json, '$.threadState') = 'object'
      AND (
        json_type(result_json, '$.threadState.deletedAt') IS NULL
        OR json_type(result_json, '$.threadState.deletedByActorId') IS NULL
      );

    UPDATE idempotency_receipts
    SET result_json = json_set(
      result_json,
      '$.threadState.deletedAt', NULL,
      '$.threadState.deletedByActorId', NULL
    )
    WHERE json_type(result_json, '$.threadState') = 'object'
      AND (
        json_type(result_json, '$.threadState.deletedAt') IS NULL
        OR json_type(result_json, '$.threadState.deletedByActorId') IS NULL
      );

    CREATE INDEX IF NOT EXISTS threads_visible_list_idx
      ON threads(tenant_id, space_id, updated_at DESC, thread_id DESC)
      WHERE status != 'deleted';
  `);
  if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
    throw new RunStoreError("sqlite_foreign_key_migration_invalid");
  }
}

function migrateVersionEighteen(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE IF EXISTS thread_rollback_commits;
    DROP TABLE IF EXISTS message_invalidations;
    ALTER TABLE thread_continuations RENAME TO thread_continuations_v19;
    DROP INDEX IF EXISTS thread_continuations_thread_idx;
    ALTER TABLE model_history_items RENAME TO model_history_items_v19;
    DROP INDEX IF EXISTS model_history_items_thread_idx;
    DROP INDEX IF EXISTS model_history_items_run_idx;

    ${modelHistoryTableSql()}
    INSERT INTO model_history_items (
      tenant_id, thread_id, sequence, item_id, run_id, segment_id,
      item_type, item_json, created_at
    )
    SELECT
      tenant_id, thread_id, sequence, item_id, run_id, segment_id,
      item_type, item_json, created_at
    FROM model_history_items_v19;

    ${threadContinuationsTableSql()}
    INSERT INTO thread_continuations (
      tenant_id, thread_id, agent_version_id, adapter_name, adapter_version,
      model_id, through_history_sequence, context_revision, checkpoint_json,
      updated_at
    )
    SELECT
      tenant_id, thread_id, agent_version_id, adapter_name, adapter_version,
      model_id, through_history_sequence, context_revision, checkpoint_json,
      updated_at
    FROM thread_continuations_v19;

    DROP TABLE thread_continuations_v19;
    DROP TABLE model_history_items_v19;
    ${messageInvalidationsTableSql()}
  `);
  if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
    throw new RunStoreError("sqlite_foreign_key_migration_invalid");
  }
}

function migrateVersionNineteen(database: DatabaseSync): void {
  database.exec(modelProviderSettingsTablesSql());
}

function modelProviderSettingsTablesSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS model_provider_settings (
      tenant_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      active_provider_id TEXT,
      catalog_json TEXT NOT NULL CHECK (json_valid(catalog_json)),
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS model_provider_settings_operations (
      tenant_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      coordinator_binding TEXT NOT NULL,
      base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
      operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'finalized', 'aborted', 'expired')),
      prepared_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      terminal_binding TEXT,
      completed_at TEXT,
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      PRIMARY KEY (tenant_id, operation_id),
      CHECK (
        (status = 'pending' AND terminal_binding IS NULL
          AND completed_at IS NULL AND result_json IS NULL)
        OR
        (status IN ('finalized', 'aborted', 'expired')
          AND terminal_binding IS NOT NULL
          AND completed_at IS NOT NULL AND result_json IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS model_provider_settings_receipts (
      tenant_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('prepare', 'finalize', 'abort', 'expire')),
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      PRIMARY KEY (tenant_id, phase, idempotency_key)
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS model_provider_settings_pending_tenant_idx
      ON model_provider_settings_operations(tenant_id)
      WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS model_provider_settings_pending_expiry_idx
      ON model_provider_settings_operations(expires_at, tenant_id)
      WHERE status = 'pending';

    CREATE UNIQUE INDEX IF NOT EXISTS model_provider_settings_finalized_revision_idx
      ON model_provider_settings_operations(tenant_id, base_revision)
      WHERE status = 'finalized';`;
}

function agentVersionsTableSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS agent_versions (
      tenant_id TEXT NOT NULL,
      agent_version_id TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      asset_json TEXT NOT NULL CHECK (json_valid(asset_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, agent_version_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS agent_versions_list_idx
      ON agent_versions(tenant_id, agent_version_id);`;
}

function agentVersionDeploymentsTableSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS agent_version_deployments (
      tenant_id TEXT NOT NULL,
      agent_version_id TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      materialization_digest TEXT NOT NULL,
      deployment_json TEXT NOT NULL CHECK (json_valid(deployment_json)),
      deployed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, agent_version_id),
      FOREIGN KEY (tenant_id, agent_version_id)
        REFERENCES agent_versions(tenant_id, agent_version_id) ON DELETE RESTRICT
    ) STRICT;`;
}

function agentVersionReleaseTablesSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS agent_version_release_bundles (
      tenant_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      default_agent_version_id TEXT NOT NULL,
      bundle_json TEXT NOT NULL CHECK (json_valid(bundle_json)),
      PRIMARY KEY (tenant_id, release_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS agent_version_release_activations (
      tenant_id TEXT NOT NULL,
      activation_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      previous_release_id TEXT,
      operator_principal_id TEXT NOT NULL,
      operator_actor_id TEXT NOT NULL,
      operator_space_id TEXT NOT NULL,
      activation_json TEXT NOT NULL CHECK (json_valid(activation_json)),
      activated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, activation_id),
      UNIQUE (tenant_id, release_id, activation_id),
      FOREIGN KEY (tenant_id, release_id)
        REFERENCES agent_version_release_bundles(tenant_id, release_id)
        ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, previous_release_id)
        REFERENCES agent_version_release_bundles(tenant_id, release_id)
        ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS active_agent_version_releases (
      tenant_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      activation_id TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      FOREIGN KEY (tenant_id, release_id)
        REFERENCES agent_version_release_bundles(tenant_id, release_id)
        ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, activation_id)
        REFERENCES agent_version_release_activations(tenant_id, activation_id)
        ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, release_id, activation_id)
        REFERENCES agent_version_release_activations(
          tenant_id, release_id, activation_id
        )
        ON DELETE RESTRICT
    ) STRICT;`;
}

function legacyThreadContinuationsTableSql(): string {
  return `
    CREATE TABLE thread_continuations (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      agent_version_id TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      model_id TEXT NOT NULL,
      through_message_sequence INTEGER NOT NULL
        CHECK (through_message_sequence >= 1),
      checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (
        tenant_id,
        thread_id,
        agent_version_id,
        adapter_name,
        adapter_version,
        model_id
      ),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, thread_id, through_message_sequence)
        REFERENCES messages(tenant_id, thread_id, sequence) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX thread_continuations_thread_idx
      ON thread_continuations(tenant_id, thread_id, through_message_sequence);`;
}

function threadIdempotencyTableSql(): string {
  return `
    CREATE TABLE thread_idempotency_receipts (
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      PRIMARY KEY (scope, idempotency_key),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE
    ) STRICT;`;
}

function authorityIndexesSql(): string {
  return `
    CREATE INDEX thread_events_tenant_thread_idx
      ON thread_events(tenant_id, thread_id, sequence);
    CREATE INDEX messages_tenant_thread_idx
      ON messages(tenant_id, thread_id, sequence);
    CREATE INDEX run_thread_bindings_thread_idx
      ON run_thread_bindings(tenant_id, thread_id, run_id);`;
}

function outboxTableSql(): string {
  return `
    CREATE TABLE outbox (
      outbox_order INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      message_json TEXT NOT NULL CHECK (json_valid(message_json)),
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'leased', 'delivered')),
      available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= 0),
      lease_owner_id TEXT,
      lease_id TEXT,
      lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
      lease_expires_at_ms INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      delivered_at_ms INTEGER,
      last_error_code TEXT,
      CHECK (
        (status = 'pending' AND lease_owner_id IS NULL AND lease_id IS NULL
          AND lease_expires_at_ms IS NULL AND delivered_at_ms IS NULL)
        OR
        (status = 'leased' AND lease_owner_id IS NOT NULL AND lease_id IS NOT NULL
          AND lease_expires_at_ms IS NOT NULL AND delivered_at_ms IS NULL)
        OR
        (status = 'delivered' AND lease_owner_id IS NULL AND lease_id IS NULL
          AND lease_expires_at_ms IS NULL AND delivered_at_ms IS NOT NULL)
      ),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE
    ) STRICT;`;
}

function workItemsTableSql(): string {
  return `
    CREATE TABLE work_items (
      work_item_order INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'run.execute'),
      work_item_json TEXT NOT NULL CHECK (json_valid(work_item_json)),
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'leased', 'completed')),
      available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= 0),
      lease_owner_id TEXT,
      lease_id TEXT,
      lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
      lease_expires_at_ms INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      completed_at_ms INTEGER,
      last_error_code TEXT,
      CHECK (
        (status = 'pending' AND lease_owner_id IS NULL AND lease_id IS NULL
          AND lease_expires_at_ms IS NULL AND completed_at_ms IS NULL)
        OR
        (status = 'leased' AND lease_owner_id IS NOT NULL AND lease_id IS NOT NULL
          AND lease_expires_at_ms IS NOT NULL AND completed_at_ms IS NULL)
        OR
        (status = 'completed' AND lease_owner_id IS NULL AND lease_id IS NULL
          AND lease_expires_at_ms IS NULL AND completed_at_ms IS NOT NULL)
      ),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE
    ) STRICT;`;
}

function executionAuthorityTablesSql(): string {
  return `
    CREATE TABLE run_steps (
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL
        CHECK (kind IN ('model', 'tool', 'agent', 'workflowNode', 'gate', 'verification')),
      status TEXT NOT NULL
        CHECK (status IN ('pending', 'ready', 'running', 'waitingApproval', 'completed', 'failed', 'skipped', 'canceled')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      current_attempt_id TEXT,
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      UNIQUE (tenant_id, run_id, step_id),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, run_id, step_id, current_attempt_id)
        REFERENCES run_attempts(tenant_id, run_id, step_id, attempt_id)
        DEFERRABLE INITIALLY DEFERRED
    ) STRICT;

    CREATE TABLE run_attempts (
      attempt_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
      retry_of_attempt_id TEXT,
      lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
      status TEXT NOT NULL
        CHECK (status IN ('running', 'completed', 'failed', 'canceled', 'abandoned')),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      UNIQUE (tenant_id, step_id, attempt_number),
      UNIQUE (tenant_id, run_id, step_id, attempt_id),
      FOREIGN KEY (tenant_id, run_id, step_id)
        REFERENCES run_steps(tenant_id, run_id, step_id) ON DELETE CASCADE,
      FOREIGN KEY (work_item_id)
        REFERENCES work_items(work_item_id) ON DELETE CASCADE,
      FOREIGN KEY (retry_of_attempt_id)
        REFERENCES run_attempts(attempt_id) ON DELETE RESTRICT
    ) STRICT;`;
}

function toolExecutionReceiptsTableSql(): string {
  return `
    CREATE TABLE tool_execution_receipts (
      receipt_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('prepared', 'dispatched', 'unknownOutcome', 'completed', 'canceled')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      prepared_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE (tenant_id, run_id, action_digest),
      UNIQUE (tenant_id, idempotency_key),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, run_id, step_id, attempt_id)
        REFERENCES run_attempts(tenant_id, run_id, step_id, attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (work_item_id)
        REFERENCES work_items(work_item_id) ON DELETE RESTRICT
    ) STRICT;`;
}

function toolApprovalsTableSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS tool_approvals (
      approval_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      receipt_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      policy_snapshot_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('required', 'approved', 'rejected', 'expired', 'superseded')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      required_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, run_id, action_digest),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE,
      FOREIGN KEY (receipt_id)
        REFERENCES tool_execution_receipts(receipt_id) ON DELETE RESTRICT,
      FOREIGN KEY (work_item_id)
        REFERENCES work_items(work_item_id) ON DELETE RESTRICT
    ) STRICT;`;
}

function queueIndexesSql(): string {
  return `
    CREATE INDEX outbox_claim_idx
      ON outbox(status, available_at_ms, lease_expires_at_ms, outbox_order);
    CREATE INDEX work_items_claim_idx
      ON work_items(status, available_at_ms, lease_expires_at_ms, work_item_order);`;
}

function executionAuthorityIndexesSql(): string {
  return `
    CREATE INDEX run_steps_run_idx
      ON run_steps(tenant_id, run_id, status, step_id);
    CREATE INDEX run_attempts_step_idx
      ON run_attempts(tenant_id, run_id, step_id, attempt_number);`;
}

function toolExecutionReceiptsIndexesSql(): string {
  return `
    CREATE INDEX tool_execution_receipts_run_idx
      ON tool_execution_receipts(tenant_id, run_id, status, receipt_id);
    CREATE INDEX tool_execution_receipts_attempt_idx
      ON tool_execution_receipts(tenant_id, run_id, step_id, attempt_id);`;
}

function toolApprovalsIndexesSql(): string {
  return `
    CREATE INDEX IF NOT EXISTS tool_approvals_run_idx
      ON tool_approvals(tenant_id, run_id, status, approval_id);
    CREATE INDEX IF NOT EXISTS tool_approvals_action_idx
      ON tool_approvals(tenant_id, run_id, action_digest);`;
}

function migrationThreadEventId(tenantId: string, threadId: string): string {
  return `migration-thread-created:${encodeURIComponent(tenantId)}:${encodeURIComponent(threadId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.endsWith("Z") &&
    !Number.isNaN(Date.parse(value))
  );
}
