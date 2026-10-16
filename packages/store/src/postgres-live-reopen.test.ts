import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { postgresCompositionFixture } from "./postgres-workflow-composition.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "opening a current PostgreSQL Store does not request DDL locks on live Run, history, attempt or queue tables",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const writer = await f.admin.connect();
    const pool = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      options: "-c lock_timeout=1000",
      max: 2,
    });
    let reopened: PostgresDomainStore | undefined;
    const before = await f.snapshot();
    const triggers = async () =>
      (
        await f.admin.query(
          `SELECT oid,tgname,tgenabled FROM pg_trigger WHERE tgrelid IN ('${f.sql}.outbox'::regclass,'${f.sql}.run_snapshots'::regclass) AND NOT tgisinternal ORDER BY tgname`,
        )
      ).rows;
    const installed = await triggers();
    try {
      await writer.query("BEGIN");
      await writer.query(
        `LOCK TABLE ${f.sql}.run_snapshots,${f.sql}.run_events,${f.sql}.run_steps,${f.sql}.run_attempts,${f.sql}.outbox,${f.sql}.work_items,${f.sql}.model_history_items IN ROW EXCLUSIVE MODE`,
      );
      reopened = await PostgresDomainStore.open({ pool, schema: f.schema });
      assert.deepEqual(await f.snapshot(), before);
      assert.deepEqual(
        await triggers(),
        installed,
        "healthy triggers must not be dropped and recreated",
      );
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await reopened?.close();
      await pool.end();
    }
  },
);

pgTest(
  "reopening still repairs disabled outbox and progress triggers and restores their durable behavior",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    await f.admin.query(
      `ALTER TABLE ${f.sql}.outbox DISABLE TRIGGER outbox_register_message_id; ALTER TABLE ${f.sql}.run_snapshots DISABLE TRIGGER retire_terminal_run_execution_progress`,
    );
    const before = await f.snapshot();
    await f.open();
    assert.deepEqual(
      await f.snapshot(),
      before,
      "repair must preserve canonical records",
    );
    const insertOutbox = () =>
      f.admin.query(
        `INSERT INTO ${f.sql}.outbox(message_id,tenant_id,run_id,topic,message_json,created_at,available_at) SELECT 'repair-proof',tenant_id,run_id,topic,jsonb_set(message_json,'{messageId}','"repair-proof"'),created_at,available_at FROM ${f.sql}.outbox ORDER BY outbox_order LIMIT 1`,
      );
    assert.equal((await insertOutbox()).rowCount, 1);
    assert.equal(
      (
        await f.admin.query(
          `SELECT count(*)::int AS n FROM ${f.sql}.outbox_deduplication WHERE message_id='repair-proof'`,
        )
      ).rows[0].n,
      1,
    );
    await f.admin.query(
      `DELETE FROM ${f.sql}.outbox WHERE message_id='repair-proof'`,
    );
    await assert.rejects(insertOutbox, /outbox_message_conflict/);
    await assert.rejects(
      f.admin.query(
        `UPDATE ${f.sql}.outbox SET message_id='changed-identity' WHERE outbox_order=(SELECT min(outbox_order) FROM ${f.sql}.outbox)`,
      ),
      /outbox_message_conflict/,
    );

    await f.admin.query(
      `INSERT INTO ${f.sql}.run_execution_progress(tenant_id,run_id,through_sequence,source_event_id,payload,payload_digest) VALUES($1,$2,1,'repair-proof','{}','repair-proof')`,
      [f.root.tenantId, f.root.runId],
    );
    await f.admin.query(
      `UPDATE ${f.sql}.run_snapshots SET state_json=jsonb_set(state_json,'{status}','"canceled"') WHERE run_id=$1`,
      [f.root.runId],
    );
    assert.equal(
      (
        await f.admin.query(
          `SELECT count(*)::int AS n FROM ${f.sql}.run_execution_progress WHERE run_id=$1`,
          [f.root.runId],
        )
      ).rows[0].n,
      0,
    );
  },
);
