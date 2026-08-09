import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { PostgresThreadStore } from "./postgres-thread-store.ts";
import {
  createThreadCommitFixture,
  registerThreadStoreConformance,
  threadStateFixture,
} from "./thread-store-conformance.test-support.ts";
import { POSTGRES_THREAD_SCHEMA_VERSION } from "./postgres-thread-schema.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

if (connectionString === undefined) {
  test.skip("PostgresThreadStore conformance requires CREWON_TEST_POSTGRES_URL", () => {});
} else {
  registerThreadStoreConformance("PostgresThreadStore Thread authority", () =>
    createTestStore(connectionString),
  );

  test("serializes the same Thread commit across independent pools", async () => {
    const schema = testSchema();
    const first = await createTestStore(connectionString, schema, false);
    const second = await createTestStore(connectionString, schema, true);
    try {
      const input = createThreadCommitFixture();
      const results = await Promise.all([
        first.commitThread(input),
        second.commitThread(input),
      ]);
      assert.deepEqual(results.map((result) => result.disposition).sort(), [
        "committed",
        "replayed",
      ]);
      assert.deepEqual(
        await first.loadThread({
          tenantId: input.tenantId,
          threadId: input.events[0].identity.threadId,
        }),
        results[0]?.state,
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  test("migrates the Thread authority from v2 through the current schema", async () => {
    const schema = testSchema();
    const initialized = await createTestStore(connectionString, schema, false);
    await initialized.close();
    const admin = new Pool({ connectionString, max: 1 });
    let migrated: TestPostgresThreadStore | null = null;
    try {
      await admin.query(`DROP TABLE "${schema}".thread_goal_events`);
      await admin.query(
        `UPDATE "${schema}".schema_migrations
         SET version = 2 WHERE component = 'thread_authority'`,
      );

      migrated = await createTestStore(connectionString, schema, false);
      const version = await admin.query<{ version: number }>(
        `SELECT version FROM "${schema}".schema_migrations
         WHERE component = 'thread_authority'`,
      );
      assert.equal(version.rows[0]?.version, POSTGRES_THREAD_SCHEMA_VERSION);
      const columns = await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'thread_goal_events'
         ORDER BY ordinal_position`,
        [schema],
      );
      assert.deepEqual(
        columns.rows.map((row) => row.column_name),
        [
          "tenant_id",
          "thread_id",
          "sequence",
          "event_id",
          "event_type",
          "event_json",
          "occurred_at",
        ],
      );
    } finally {
      await migrated?.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  test("migrates v3 Thread snapshots and receipts to terminal tombstone authority", async () => {
    const schema = testSchema();
    const initialized = await createTestStore(connectionString, schema, false);
    const input = createThreadCommitFixture();
    await initialized.commitThread(input);
    await initialized.close();
    const admin = new Pool({ connectionString, max: 1 });
    let migrated: TestPostgresThreadStore | null = null;
    try {
      await admin.query(`
        DROP INDEX "${schema}".threads_visible_list_idx;
        UPDATE "${schema}".threads
          SET state_json = state_json - 'deletedAt' - 'deletedByActorId';
        UPDATE "${schema}".thread_idempotency_receipts
          SET result_json = jsonb_set(
            result_json,
            '{state}',
            (result_json->'state') - 'deletedAt' - 'deletedByActorId'
          )
          WHERE jsonb_typeof(result_json->'state') = 'object';
        ALTER TABLE "${schema}".threads
          DROP CONSTRAINT threads_status_check;
        ALTER TABLE "${schema}".threads
          ADD CONSTRAINT threads_status_check
          CHECK (status IN ('active', 'archived'));
        ALTER TABLE "${schema}".threads DROP COLUMN deleted_at;
        ALTER TABLE "${schema}".threads DROP COLUMN deleted_by_actor_id;
        UPDATE "${schema}".schema_migrations
          SET version = 3 WHERE component = 'thread_authority';
      `);

      migrated = await createTestStore(connectionString, schema, false);
      assert.deepEqual(await migrated.commitThread(input), {
        disposition: "replayed",
        state: threadStateFixture(),
        events: input.events,
        messages: [],
        historyItems: [],
      });
      const version = await admin.query<{ version: number }>(
        `SELECT version FROM "${schema}".schema_migrations
         WHERE component = 'thread_authority'`,
      );
      assert.equal(version.rows[0]?.version, POSTGRES_THREAD_SCHEMA_VERSION);
      const columns = await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'threads'
           AND column_name IN ('deleted_at', 'deleted_by_actor_id')
         ORDER BY column_name`,
        [schema],
      );
      assert.deepEqual(
        columns.rows.map((row) => row.column_name),
        ["deleted_at", "deleted_by_actor_id"],
      );
    } finally {
      await migrated?.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  test("migrates v4 Thread authority to append-only rollback v5", async () => {
    const schema = testSchema();
    const initialized = await createTestStore(connectionString, schema, false);
    await initialized.close();
    const admin = new Pool({ connectionString, max: 1 });
    let migrated: TestPostgresThreadStore | null = null;
    try {
      await admin.query(`
        DROP TABLE "${schema}".thread_rollback_commits;
        DROP TABLE "${schema}".message_invalidations;
        ALTER TABLE "${schema}".model_history_items
          DROP CONSTRAINT model_history_items_item_type_check;
        ALTER TABLE "${schema}".model_history_items
          DROP CONSTRAINT model_history_items_check;
        ALTER TABLE "${schema}".model_history_items
          ADD CONSTRAINT model_history_items_item_type_check
          CHECK (item_type IN ('message', 'tool_call', 'tool_result', 'compaction'));
        ALTER TABLE "${schema}".model_history_items
          ADD CONSTRAINT model_history_items_check
          CHECK (
            (item_type IN ('tool_call', 'tool_result') AND run_id IS NOT NULL
              AND segment_id IS NOT NULL AND call_id IS NOT NULL AND tool_kind IS NOT NULL)
            OR
            (item_type IN ('message', 'compaction')
              AND call_id IS NULL AND tool_kind IS NULL)
          );
        UPDATE "${schema}".schema_migrations
          SET version = 4 WHERE component = 'thread_authority';
      `);

      migrated = await createTestStore(connectionString, schema, false);
      const version = await admin.query<{ version: number }>(
        `SELECT version FROM "${schema}".schema_migrations
         WHERE component = 'thread_authority'`,
      );
      assert.equal(version.rows[0]?.version, POSTGRES_THREAD_SCHEMA_VERSION);
      const tables = await admin.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema=$1
           AND table_name=ANY($2::text[])
         ORDER BY table_name`,
        [schema, ["message_invalidations", "thread_rollback_commits"]],
      );
      assert.deepEqual(
        tables.rows.map(({ table_name }) => table_name),
        ["message_invalidations", "thread_rollback_commits"],
      );
    } finally {
      await migrated?.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
}

class TestPostgresThreadStore extends PostgresThreadStore {
  readonly #admin: Pool;
  readonly #schemaSql: string;
  readonly #dropSchema: boolean;
  #cleaned = false;

  constructor(url: string, schema: string, dropSchema: boolean) {
    super({
      connectionString: url,
      schema,
      maxPoolSize: 2,
      statementTimeoutMs: 2_000,
    });
    this.#admin = new Pool({ connectionString: url, max: 1 });
    this.#schemaSql = `"${schema}"`;
    this.#dropSchema = dropSchema;
  }

  override async close(): Promise<void> {
    if (this.#cleaned) return;
    this.#cleaned = true;
    await super.close();
    try {
      if (this.#dropSchema) {
        await this.#admin.query(
          `DROP SCHEMA IF EXISTS ${this.#schemaSql} CASCADE`,
        );
      }
    } finally {
      await this.#admin.end();
    }
  }
}

async function createTestStore(
  url: string,
  schema = testSchema(),
  dropSchema = true,
): Promise<TestPostgresThreadStore> {
  const store = new TestPostgresThreadStore(url, schema, dropSchema);
  try {
    await store.migrate();
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}

function testSchema(): string {
  return `crewon_thread_${randomUUID().replaceAll("-", "_")}`;
}
