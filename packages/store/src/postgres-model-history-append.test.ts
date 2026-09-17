import assert from "node:assert/strict";
import test from "node:test";
import type { ModelHistoryItem } from "@crewon/domain";
import { toolHistory } from "./model-history-append.test-support.ts";
import { historyAppendFixture } from "./postgres-model-history-append.test-support.ts";
import { POSTGRES_THREAD_SCHEMA_VERSION } from "./postgres-thread-schema.ts";
import { assertPostgresSchemaNotNewer } from "./postgres-store-support.ts";

const options = { skip: process.env.CREWON_TEST_POSTGRES_URL === undefined };
const pair = (start: number, id: string) => [
  toolHistory(start, id, "tool_call", "run-store-1"),
  toolHistory(start + 1, id, "tool_result", "run-store-1"),
];
const message = (sequence: number): ModelHistoryItem => ({
  schemaVersion: "crewon.model-history-item.v0",
  tenantId: "tenant-1",
  threadId: "thread-1",
  itemId: `message-${sequence}`,
  sequence,
  runId: "run-store-1",
  segmentId: "segment-1",
  createdAt: "2026-08-08T00:00:00Z",
  type: "message",
  role: "user",
  source: "thread_message",
  content: "next",
  contentDigest: `sha256:${"a".repeat(64)}`,
});

test(
  "PostgreSQL warm appends read exact identities after 20,000 closed items with reused call IDs",
  options,
  async (context) => {
    const f = await historyAppendFixture(context);
    await f.seed(
      Array.from({ length: 20_000 }, (_, index) =>
        toolHistory(
          index + 1,
          "reused",
          index % 2 === 0 ? "tool_call" : "tool_result",
          `old-run-${Math.floor(index / 2)}`,
        ),
      ),
    );
    assert.deepEqual(await f.state(), []);
    await f.append(20_000, pair(20_001, "warm"));
    await f.admin.query(
      `ANALYZE ${f.schema}.model_history_items; ANALYZE ${f.schema}.model_history_append_state`,
    );
    f.observe(true);
    await f.append(20_002, pair(20_003, "reused"));
    const reads = [...f.reads];
    f.observe(false);
    assert.ok(reads.length > 0 && reads.length < 12, JSON.stringify(reads));
    assert.ok(
      reads.every((read) => read.rows <= 2 && !read.body),
      JSON.stringify(reads),
    );
    for (const read of reads) {
      const result = await f.admin.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${read.sql}`,
        read.values,
      );
      const visit = (plan: Record<string, unknown>) => {
        if (plan["Relation Name"] === "model_history_items") {
          assert.notEqual(plan["Node Type"], "Seq Scan", JSON.stringify(plan));
          assert.ok(
            Number(plan["Actual Rows"]) * Number(plan["Actual Loops"]) <= 4,
            JSON.stringify(plan),
          );
          assert.ok(
            Number(plan["Shared Hit Blocks"]) +
              Number(plan["Shared Read Blocks"]) <
              100,
            JSON.stringify(plan),
          );
        }
        for (const child of (plan.Plans ?? []) as Record<string, unknown>[])
          visit(child);
      };
      visit(result.rows[0]["QUERY PLAN"][0].Plan);
    }
    assert.deepEqual(await f.state(), [
      { last_sequence: 20_004, pending_tool_call_count: 0 },
    ]);
    await assert.rejects(
      f.append(20_004, pair(20_005, "reused")),
      /model_history_tool_call_duplicate/,
    );
    context.diagnostic(
      `20,000 closed history rows across 10,000 Runs with one reused call ID: ${reads.length} bounded warm reads, no history bodies or completed-ledger scan`,
    );
  },
);

test(
  "PostgreSQL pairing metadata rolls back with a statement-level failure after history insertion",
  options,
  async (context) => {
    const f = await historyAppendFixture(context);
    await f.append(0, pair(1, "first"));
    const before = await f.state();
    await f.admin
      .query(`CREATE FUNCTION ${f.schema}.fail_append() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected_history_failure'; END $$;
    CREATE TRIGGER zzz_fail_append AFTER INSERT ON ${f.schema}.model_history_items FOR EACH STATEMENT EXECUTE FUNCTION ${f.schema}.fail_append()`);
    await assert.rejects(f.append(2, pair(3, "second")));
    assert.deepEqual(await f.state(), before);
    assert.equal((await f.events()).length, 3);
    assert.equal(
      Number(
        (
          await f.admin.query(
            `SELECT count(*) n FROM ${f.schema}.model_history_items`,
          )
        ).rows[0].n,
      ),
      2,
    );
    await f.admin.query(
      `DROP TRIGGER zzz_fail_append ON ${f.schema}.model_history_items`,
    );
    await f.append(2, pair(3, "second"));
    assert.deepEqual(await f.state(), [
      { last_sequence: 4, pending_tool_call_count: 0 },
    ]);
  },
);

test(
  "PostgreSQL statement metadata tolerates physical row order and detects a noncontiguous append",
  options,
  async (context) => {
    const f = await historyAppendFixture(context);
    await f.append(0, pair(1, "first"));
    await f.seed(pair(3, "reverse").reverse());
    assert.deepEqual(await f.state(), [
      { last_sequence: 4, pending_tool_call_count: 0 },
    ]);
    await f.seed(pair(7, "gap"));
    assert.deepEqual(await f.state(), [
      { last_sequence: 4, pending_tool_call_count: 0 },
    ]);
    await assert.rejects(
      f.append(8, [message(9)]),
      /model_history_append_state_stale/,
    );
  },
);

test(
  "PostgreSQL incremental pairing rejects interrupted, duplicate and mismatched tool boundaries",
  options,
  async (context) => {
    const f = await historyAppendFixture(context);
    await f.append(0, [toolHistory(1, "pending", "tool_call", "run-store-1")]);
    assert.deepEqual(await f.state(), [
      { last_sequence: 1, pending_tool_call_count: 1 },
    ]);
    await assert.rejects(
      f.append(1, [message(2)]),
      /model_history_tool_result_missing/,
    );
    const result = toolHistory(2, "pending", "tool_result", "run-store-1");
    await assert.rejects(
      f.append(1, [{ ...result, segmentId: "wrong" }]),
      /model_history_tool_result_orphaned/,
    );
    await f.append(1, [result]);
    await assert.rejects(
      f.append(2, [toolHistory(3, "pending", "tool_result", "run-store-1")]),
      /model_history_tool_result_orphaned/,
    );
    await f.append(2, [message(3)]);
    assert.deepEqual(await f.state(), [
      { last_sequence: 3, pending_tool_call_count: 0 },
    ]);
  },
);

test(
  "PostgreSQL canonical updates and deletes invalidate pairing metadata and corrupt legacy history fails closed",
  options,
  async (context) => {
    const f = await historyAppendFixture(context);
    await f.append(0, [toolHistory(1, "pending", "tool_call", "run-store-1")]);
    await f.admin.query(
      `UPDATE ${f.schema}.model_history_items SET item_json=jsonb_set(item_json,'{input}','123'::jsonb) WHERE sequence=1`,
    );
    assert.deepEqual(await f.state(), []);
    await assert.rejects(
      f.append(1, [toolHistory(2, "pending", "tool_result", "run-store-1")]),
      /stored_model_history|model_history_item/,
    );
    await f.admin.query(
      `UPDATE ${f.schema}.model_history_items SET item_json=jsonb_set(item_json,'{input}','"{}"'::jsonb) WHERE sequence=1`,
    );
    await f.append(1, [
      toolHistory(2, "pending", "tool_result", "run-store-1"),
    ]);
    await f.admin.query(
      `DELETE FROM ${f.schema}.model_history_items WHERE sequence=1`,
    );
    assert.deepEqual(await f.state(), []);
    await assert.rejects(
      f.append(2, [message(3)]),
      /model_history_tool_result_orphaned/,
    );
    assert.deepEqual(await f.state(), []);
  },
);

test(
  "PostgreSQL stale pairing state is rejected and the existing pending-tool limit remains enforced",
  options,
  async (context) => {
    const f = await historyAppendFixture(context);
    await f.append(0, pair(1, "complete"));
    await f.admin.query(
      `UPDATE ${f.schema}.model_history_append_state SET last_sequence=1`,
    );
    await assert.rejects(
      f.append(2, [message(3)]),
      /model_history_append_state_stale/,
    );
    const large = await historyAppendFixture(context);
    await large.seed(
      Array.from({ length: 129 }, (_, i) =>
        toolHistory(i + 1, `pending-${i}`, "tool_call", "run-store-1"),
      ),
    );
    await assert.rejects(
      large.append(129, [
        toolHistory(130, "pending-0", "tool_result", "run-store-1"),
      ]),
      /model_history_pending_tool_limit_exceeded/,
    );
  },
);

test(
  "PostgreSQL old schema upgrades lazily without rewriting canonical history or public receipts",
  options,
  async (context) => {
    const f = await historyAppendFixture(context);
    await f.seed(pair(1, "old"));
    const before = (
      await f.admin.query(
        `SELECT item_json FROM ${f.schema}.model_history_items ORDER BY sequence`,
      )
    ).rows;
    const receipts = (
      await f.admin.query(
        `SELECT result_json FROM ${f.schema}.thread_idempotency_receipts ORDER BY scope,idempotency_key`,
      )
    ).rows;
    await f.store.close();
    await f.admin
      .query(`DROP TRIGGER model_history_append_state_insert ON ${f.schema}.model_history_items;
    DROP TRIGGER model_history_append_state_update ON ${f.schema}.model_history_items;
    DROP TRIGGER model_history_append_state_delete ON ${f.schema}.model_history_items;
    DROP FUNCTION ${f.schema}.advance_model_history_append_state(); DROP FUNCTION ${f.schema}.invalidate_model_history_append_state();
    DROP TABLE ${f.schema}.model_history_append_state; DROP INDEX ${f.schema}.model_history_non_tool_sequence_idx;
    UPDATE ${f.schema}.schema_migrations SET version=7 WHERE component='thread_authority'`);
    const reopened = await f.open();
    assert.deepEqual(await f.state(), []);
    assert.equal(
      (
        await f.admin.query(
          `SELECT version FROM ${f.schema}.schema_migrations WHERE component='thread_authority'`,
        )
      ).rows[0].version,
      POSTGRES_THREAD_SCHEMA_VERSION,
    );
    assert.deepEqual(
      (
        await f.admin.query(
          `SELECT item_json FROM ${f.schema}.model_history_items ORDER BY sequence`,
        )
      ).rows,
      before,
    );
    assert.deepEqual(
      (
        await f.admin.query(
          `SELECT result_json FROM ${f.schema}.thread_idempotency_receipts ORDER BY scope,idempotency_key`,
        )
      ).rows,
      receipts,
    );
    await f.append(2, pair(3, "new"), reopened);
    assert.deepEqual(await f.state(), [
      { last_sequence: 4, pending_tool_call_count: 0 },
    ]);
    const oldReader = await f.admin.connect();
    try {
      await assert.rejects(
        assertPostgresSchemaNotNewer(
          oldReader,
          f.schema,
          "thread_authority",
          7,
        ),
        /postgres_schema_too_new/,
      );
    } finally {
      oldReader.release();
    }
  },
);

test(
  "PostgreSQL independent pools converge duplicate history without double-counting pending calls",
  options,
  async (context) => {
    const f = await historyAppendFixture(context),
      second = await f.open();
    const input = f.input(0, pair(1, "same"));
    const results = await Promise.all([
      f.store.commitLeasedRun(input),
      second.commitLeasedRun(input),
    ]);
    assert.deepEqual(results.map((r) => r.disposition).sort(), [
      "committed",
      "replayed",
    ]);
    assert.deepEqual(await f.state(), [
      { last_sequence: 2, pending_tool_call_count: 0 },
    ]);
    assert.equal(
      Number(
        (
          await f.admin.query(
            `SELECT count(*) n FROM ${f.schema}.model_history_items`,
          )
        ).rows[0].n,
      ),
      2,
    );
  },
);
