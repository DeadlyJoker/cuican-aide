import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Pool } from "pg";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresQueueStore } from "./postgres-queue-store.ts";
import { createRunningCommitFixture } from "./run-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import { workItemCandidatesSql } from "./work-item-ready-order.ts";

test("SQLite fair scheduling seeks existing indexes past 20,000 completed Work Items and merges expired leases", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "crewon-fair-queue-")),
    path = join(root, "store.sqlite");
  const now = Date.parse("2026-08-08T01:00:00Z");
  const store = new SqliteRunStore(path, {
      clock: { nowEpochMilliseconds: () => now },
    }),
    db = new DatabaseSync(path);
  t.after(async () => {
    await store.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await seedThread(store);
  const seed = createRunningCommitFixture();
  await store.commitRun(seed);
  const item = seed.workItems[0]!;
  db.prepare(
    `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20000)
    INSERT INTO work_items(work_item_id,tenant_id,run_id,kind,work_item_json,created_at,available_at_ms,status,completed_at_ms)
    SELECT 'history-'||i,?,?,?,json_set(?,'$.workItemId','history-'||i),?,0,'completed',? FROM n`,
  ).run(
    item.tenantId,
    item.runId,
    item.kind,
    JSON.stringify(item),
    item.createdAt,
    now,
  );
  db.prepare(
    `INSERT INTO work_items(work_item_id,tenant_id,run_id,kind,work_item_json,created_at,available_at_ms,status,lease_owner_id,lease_id,lease_epoch,lease_expires_at_ms)
    VALUES('expired',?,?,?,json_set(?,'$.workItemId','expired'),?,0,'leased','old','old',1,?)`,
  ).run(
    item.tenantId,
    item.runId,
    item.kind,
    JSON.stringify(item),
    item.createdAt,
    now - 1000,
  );
  db.prepare(
    "UPDATE work_items SET available_at_ms=? WHERE work_item_id=?",
  ).run(now - 500, item.workItemId);
  const query = workItemCandidatesSql({
    table: "work_items",
    now: "?1",
    limit: "?2",
    dialect: "sqlite",
    lock: "none",
  });
  assert.deepEqual(
    db
      .prepare(query)
      .all(now, 2)
      .map((row) => row.work_item_id),
    ["expired", item.workItemId],
  );
  const plan = db
    .prepare("EXPLAIN QUERY PLAN " + query)
    .all(now, 2)
    .map((row) => row.detail)
    .join("\n");
  assert.equal(
    (
      plan.match(
        /SEARCH work_items USING (?:COVERING )?INDEX work_items_claim_idx/g,
      ) ?? []
    ).length,
    2,
    plan,
  );
  assert.doesNotMatch(plan, /SCAN work_items/);
  assert.deepEqual(
    (await store.listPendingWorkItems(2)).map((w) => w.workItemId),
    ["expired", item.workItemId],
  );
  const claim = await store.claimNextWorkItem({
    ownerId: "new",
    leaseId: "new",
    leaseDurationMs: 30000,
  });
  assert.equal(claim?.workItem.workItemId, "expired");
  assert.equal(claim?.lease.epoch, 2);
  assert.equal(
    db.prepare("PRAGMA user_version").get()!.user_version,
    SQLITE_SCHEMA_VERSION,
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test(
  "PostgreSQL fair candidates use existing indexes and skip a locked oldest task without scanning completed history",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!,
      schema = `fair_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString, max: 3 }),
      queue = new PostgresQueueStore({
        connectionString,
        schema,
        statementTimeoutMs: 1000,
      });
    t.after(async () => {
      await queue.close();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    await queue.migrate();
    await pool.query(`INSERT INTO ${schema}.work_items(work_item_id,tenant_id,run_id,kind,work_item_json,created_at,available_at,status,completed_at)
    SELECT 'history-'||n,'tenant','run','run.execute','{}',now(),now(),'completed',now() FROM generate_series(1,20000) n`);
    for (const [id, delay] of [
      ["first", 3000],
      ["second", 2000],
      ["third", 1000],
    ] as const) {
      const item = {
        workItemId: id,
        tenantId: "tenant",
        runId: "run",
        kind: "run.execute",
        payload: { throughSequence: 2 },
        createdAt: "2026-08-08T00:00:00.000Z",
      };
      await pool.query(
        `INSERT INTO ${schema}.work_items(work_item_id,tenant_id,run_id,kind,work_item_json,created_at,available_at) VALUES($1,'tenant','run','run.execute',$2,$3,now()-$4*interval '1 millisecond')`,
        [id, item, item.createdAt, delay],
      );
    }
    await pool.query(`ANALYZE ${schema}.work_items`);
    const query = workItemCandidatesSql({
      table: `${schema}.work_items`,
      now: "statement_timestamp()",
      limit: "2",
      dialect: "postgres",
      lock: "none",
    });
    const explain = (
      await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`)
    ).rows[0]["QUERY PLAN"][0].Plan;
    const scans: Record<string, unknown>[] = [];
    function visit(node: Record<string, unknown>) {
      if (node["Relation Name"] === "work_items") scans.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[])
        visit(child);
    }
    visit(explain);
    assert.equal(scans.length, 2);
    for (const scan of scans) {
      assert.match(String(scan["Node Type"]), /Index/);
      assert.equal(scan["Index Name"], "work_items_claim_idx");
      assert(Number(scan["Actual Rows"]) <= 3);
    }
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query(
        `SELECT work_item_id FROM ${schema}.work_items WHERE work_item_id='first' FOR UPDATE`,
      );
      const claimed = await queue.claimNextWorkItem({
        ownerId: "worker",
        leaseId: "lease",
        leaseDurationMs: 30000,
      });
      assert.equal(claimed?.workItem.workItemId, "second");
      await lock.query("ROLLBACK");
    } finally {
      lock.release();
    }
    await pool.query(
      `UPDATE ${schema}.work_items SET lease_expires_at=now()-interval '4 second' WHERE work_item_id='second'`,
    );
    assert.deepEqual(
      (await queue.listPendingWorkItems(3)).map((w) => w.workItemId),
      ["second", "first", "third"],
    );
    const expired = await queue.claimNextWorkItem({
      ownerId: "new",
      leaseId: "new",
      leaseDurationMs: 30000,
    });
    assert.equal(expired?.workItem.workItemId, "second");
    assert.equal(expired?.lease.epoch, 2);
  },
);
