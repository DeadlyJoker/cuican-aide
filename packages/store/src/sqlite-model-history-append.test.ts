import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { DomainStore, WorkItemLeaseInput } from "@crewon/application";
import type { ModelHistoryItem } from "@crewon/domain";
import { toolHistory } from "./model-history-append.test-support.ts";
import { outputFixture } from "./run-output-store-conformance.test-support.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";

test("SQLite warm history appends use indexed metadata lookups after 20,000 history entries", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-history-append-"));
  const path = join(directory, "store.sqlite");
  const fixture = await outputFixture(
    context,
    (clock) => new SqliteRunStore(path, { clock }),
  );
  const database = new DatabaseSync(path);
  context.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const insert = database.prepare(
    `INSERT INTO model_history_items (tenant_id, thread_id, sequence, item_id, run_id, segment_id, item_type, item_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  database.exec("BEGIN IMMEDIATE");
  for (let sequence = 1; sequence <= 20_000; sequence += 1) {
    const item = toolHistory(
      sequence,
      `old-${Math.floor((sequence - 1) / 2)}`,
      sequence % 2 === 1 ? "tool_call" : "tool_result",
      "run-store-1",
    );
    insert.run(
      item.tenantId,
      item.threadId,
      item.sequence,
      item.itemId,
      item.runId,
      item.segmentId,
      item.type,
      JSON.stringify(item),
      item.createdAt,
    );
  }
  database.exec("COMMIT");
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM model_history_append_state")
      .get()?.count,
    0,
  );
  const lease = fixture.input([1], 2, "unused").lease;
  let revision = 2;
  let head = 20_000;
  const append = async () => {
    const call = `new-${head}`;
    const event = fixture.input([head + 1], revision, "unused").entries[0]!
      .event;
    const result = await fixture.store.commitLeasedRun({
      lease,
      commit: {
        tenantId: "tenant-1",
        expectedRevision: revision,
        idempotency: {
          scope: "history-cost",
          key: String(head),
          requestFingerprint: String(head),
        },
        events: [{ ...event, sequence: revision + 1 }],
        outbox: [],
        workItems: [],
      },
      history: {
        expectedLastSequence: head,
        items: [
          toolHistory(head + 1, call, "tool_call", "run-store-1"),
          toolHistory(head + 2, call, "tool_result", "run-store-1"),
        ],
      },
    });
    revision = result.state.revision;
    head += 2;
  };
  await append();
  const reads: Array<{
    sql: string;
    bindings: SQLInputValue[];
    rows: number;
    returnedBody: boolean;
  }> = [];
  const prepare = DatabaseSync.prototype.prepare;
  const observer = context.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return (...args: SQLInputValue[]) => {
            const result = Reflect.apply(value, target, args);
            if (
              (key === "get" || key === "all") &&
              sql.includes("model_history_items")
            ) {
              const rows = Array.isArray(result)
                ? result
                : result === undefined
                  ? []
                  : [result];
              reads.push({
                sql,
                bindings: args,
                rows: rows.length,
                returnedBody: rows.some((row) =>
                  Object.hasOwn(row, "item_json"),
                ),
              });
            }
            return result;
          };
        },
      });
    },
  );
  await append();
  observer.mock.restore();
  assert.ok(reads.length > 0 && reads.length < 30);
  assert.ok(reads.every((read) => read.rows <= 1 && !read.returnedBody));
  assert.ok(
    reads.every((read) => !read.sql.includes("COUNT(*)")),
    "warm appends must not recount historical tools",
  );
  for (const read of reads) {
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${read.sql}`)
      .all(...read.bindings);
    assert.ok(
      plan.every((row) => !/\bSCAN\b/.test(String(row.detail))),
      JSON.stringify(plan),
    );
  }
  assert.deepEqual(
    {
      ...database
        .prepare(
          "SELECT last_sequence, pending_tool_call_count FROM model_history_append_state",
        )
        .get(),
    },
    { last_sequence: 20_004, pending_tool_call_count: 0 },
  );
  assert.equal(
    (
      await fixture.store.listModelHistoryItems(
        { tenantId: "tenant-1", threadId: "thread-1" },
        20_000,
        10,
      )
    ).length,
    4,
  );
  context.diagnostic(
    `20,000 historical entries: ${reads.length} bounded indexed history reads; no historical bodies returned`,
  );
});

test("SQLite rolls append metadata back with a failed history batch", async (context) => {
  const fixture = await sqliteFixture(context);
  const before = fixture.database
    .prepare("SELECT * FROM model_history_append_state")
    .all();
  fixture.database
    .exec(`CREATE TRIGGER fail_history_insert AFTER INSERT ON model_history_items
    WHEN NEW.sequence=2 BEGIN SELECT RAISE(ABORT, 'injected_history_failure'); END`);
  const items = [
    toolHistory(1, "call", "tool_call", "run-store-1"),
    toolHistory(2, "call", "tool_result", "run-store-1"),
  ];
  await assert.rejects(appendHistory(fixture.store, fixture.lease, 0, items));
  assert.deepEqual(
    fixture.database.prepare("SELECT * FROM model_history_append_state").all(),
    before,
  );
  assert.equal(
    fixture.database
      .prepare("SELECT COUNT(*) AS count FROM model_history_items")
      .get()?.count,
    0,
  );
  assert.equal(
    (
      await fixture.store.loadRun({
        tenantId: "tenant-1",
        runId: "run-store-1",
      })
    )?.revision,
    2,
  );
  fixture.database.exec("DROP TRIGGER fail_history_insert");
  await appendHistory(fixture.store, fixture.lease, 0, items);
  assert.deepEqual(
    {
      ...fixture.database
        .prepare(
          "SELECT last_sequence, pending_tool_call_count FROM model_history_append_state",
        )
        .get(),
    },
    { last_sequence: 2, pending_tool_call_count: 0 },
  );
});

test("SQLite v24 upgrade initializes metadata lazily and preserves an open tool pair across reopening", async (context) => {
  const fixture = await sqliteFixture(context);
  await appendHistory(fixture.store, fixture.lease, 0, [
    toolHistory(1, "call", "tool_call", "run-store-1"),
  ]);
  await fixture.store.close();
  const before = fixture.database
    .prepare("SELECT item_json FROM model_history_items")
    .all();
  fixture.database.exec(`DROP TRIGGER model_history_append_state_insert;
    DROP TRIGGER model_history_append_state_delete; DROP TRIGGER model_history_append_state_update;
    DROP TABLE model_history_append_state;
    DROP INDEX model_history_tool_call_identity_idx; DROP INDEX model_history_tool_result_identity_idx;
    DROP INDEX model_history_non_tool_sequence_idx; PRAGMA user_version=24`);
  const reopened = new SqliteRunStore(fixture.path, { clock: fixture.clock });
  try {
    assert.equal(
      fixture.database.prepare("PRAGMA user_version").get()?.user_version,
      SQLITE_SCHEMA_VERSION,
    );
    assert.deepEqual(
      fixture.database
        .prepare("SELECT item_json FROM model_history_items")
        .all(),
      before,
    );
    assert.equal(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM model_history_append_state")
        .get()?.count,
      0,
    );
    await assert.rejects(
      appendHistory(reopened, fixture.lease, 1, [
        {
          ...toolHistory(2, "call", "tool_result", "run-store-1"),
          segmentId: "wrong",
        },
      ]),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "model_history_tool_result_orphaned",
    );
    await appendHistory(reopened, fixture.lease, 1, [
      toolHistory(2, "call", "tool_result", "run-store-1"),
    ]);
    assert.deepEqual(
      {
        ...fixture.database
          .prepare(
            "SELECT last_sequence, pending_tool_call_count FROM model_history_append_state",
          )
          .get(),
      },
      { last_sequence: 2, pending_tool_call_count: 0 },
    );
  } finally {
    await reopened.close();
  }
});

test("SQLite invalidates derived append state on raw changes and refuses a corrupted historical tool pair", async (context) => {
  const fixture = await sqliteFixture(context);
  await appendHistory(fixture.store, fixture.lease, 0, [
    toolHistory(1, "call", "tool_call", "run-store-1"),
    toolHistory(2, "call", "tool_result", "run-store-1"),
  ]);
  fixture.database.exec(
    `UPDATE model_history_items SET segment_id='wrong', item_json=json_set(item_json,'$.segmentId','wrong') WHERE sequence=2`,
  );
  assert.equal(
    fixture.database
      .prepare("SELECT COUNT(*) AS count FROM model_history_append_state")
      .get()?.count,
    0,
  );
  await assert.rejects(
    appendHistory(fixture.store, fixture.lease, 2, [
      toolHistory(3, "next", "tool_call", "run-store-1"),
    ]),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "model_history_tool_result_orphaned",
  );
  assert.equal(
    fixture.database
      .prepare("SELECT COUNT(*) AS count FROM model_history_items")
      .get()?.count,
    2,
  );
});

async function sqliteFixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "crewon-history-state-"));
  const path = join(directory, "store.sqlite");
  const fixture = await outputFixture(
    context,
    (clock) => new SqliteRunStore(path, { clock }),
  );
  const database = new DatabaseSync(path);
  context.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...fixture,
    path,
    database,
    lease: fixture.input([1], 2, "unused").lease,
  };
}

async function appendHistory(
  store: DomainStore,
  lease: WorkItemLeaseInput,
  expectedLastSequence: number,
  items: readonly ModelHistoryItem[],
) {
  const current = await store.loadRun({
    tenantId: "tenant-1",
    runId: "run-store-1",
  });
  assert.ok(current !== null);
  return store.commitLeasedRun({
    lease,
    commit: {
      tenantId: "tenant-1",
      expectedRevision: current.revision,
      idempotency: {
        scope: "history-append",
        key: String(expectedLastSequence),
        requestFingerprint: JSON.stringify(items),
      },
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: "run-store-1" },
          eventId: `history-event-${expectedLastSequence}`,
          sequence: current.lastSequence + 1,
          occurredAt: "2026-08-08T00:01:02Z",
          type: "model.output.delta",
          data: {
            segmentId: "segment-1",
            segmentSequence: expectedLastSequence + 1,
            delta: "working",
          },
        },
      ],
      outbox: [],
      workItems: [],
    },
    history: { expectedLastSequence, items },
  });
}
