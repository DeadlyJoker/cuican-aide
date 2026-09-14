import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { ModelHistoryItem } from "@crewon/domain";
import {
  locator,
  message,
  compaction,
  rollback,
  assertReplay,
  readWindow,
} from "./model-history-context.test-support.ts";
import { outputFixture } from "./run-output-store-conformance.test-support.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { appendSqliteModelHistoryContext } from "./sqlite-model-history-context.ts";
import { toolHistory } from "./model-history-append.test-support.ts";

test("SQLite context references match canonical replay through partial compaction and repeated rollbacks", async (context) => {
  const fixture = await createFixture(context);
  const history: ModelHistoryItem[] = [];
  const append = async (...items: ModelHistoryItem[]) => {
    fixture.insert(items, true);
    history.push(...items);
    await assertReplay(fixture.store.modelHistoryContext, history);
  };
  await append(message(1), message(2, "assistant"), compaction(3, 2));
  await append(message(4, "user", "goal_steering"), message(5));
  await append(
    toolHistory(6, "call", "tool_call", "run-store-1"),
    toolHistory(7, "call", "tool_result", "run-store-1"),
  );
  await append(message(8, "assistant"), compaction(9, 7));
  await append(rollback(history, 1)); // Removes steering plus second turn and its compaction.
  assert.equal(
    (await fixture.store.modelHistoryContext.prepare(locator)).context
      ?.lastCompaction?.sequence,
    3,
  );
  await append(message(11), compaction(12, 3)); // Retains a user item before the compaction marker.
  await append(rollback(history, 2)); // Removes the first compaction too.
  await append(rollback(history, 3)); // No-op still changes the revision.
  await append(
    message(15),
    message(16, "assistant"),
    compaction(17, 16),
    message(18),
  );
  await fixture.store.close();
  fixture.store = new SqliteRunStore(fixture.path);
  await assertReplay(fixture.store.modelHistoryContext, history);
});

test("SQLite context backfill resumes after restart and transaction failure; warm reads ignore 20,000 compacted bodies", async (context) => {
  const fixture = await createFixture(context);
  const history: ModelHistoryItem[] = [];
  for (let sequence = 1; sequence <= 20_200; sequence += 1)
    history.push(message(sequence, sequence % 2 ? "user" : "assistant"));
  history.push(compaction(20_201, 20_200), message(20_202));
  fixture.insert(history);
  const first = await fixture.store.modelHistoryContext.prepare(locator);
  assert.equal(first.processedThroughSequence, 100);
  assert.equal(first.context, null);
  await fixture.store.close();
  fixture.store = new SqliteRunStore(fixture.path);
  assert.equal(
    (await fixture.store.modelHistoryContext.prepare(locator))
      .processedThroughSequence,
    200,
  );
  fixture.database
    .exec(`CREATE TRIGGER fail_context_reference AFTER INSERT ON model_history_context_refs
    WHEN NEW.sequence=250 BEGIN SELECT RAISE(ABORT, 'injected_context_failure'); END`);
  await assert.rejects(
    fixture.store.modelHistoryContext.prepare(locator),
    /injected_context_failure/,
  );
  assert.equal(
    fixture.database
      .prepare("SELECT through_sequence FROM model_history_context_state")
      .get()?.through_sequence,
    200,
  );
  assert.equal(
    fixture.database
      .prepare("SELECT MAX(sequence) AS value FROM model_history_context_refs")
      .get()?.value,
    200,
  );
  fixture.database.exec("DROP TRIGGER fail_context_reference");
  await assertReplay(fixture.store.modelHistoryContext, history);

  const reads: { sql: string; rows: number; bindings: SQLInputValue[] }[] = [];
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
          return (...bindings: SQLInputValue[]) => {
            const result = Reflect.apply(value, target, bindings);
            if (
              (key === "get" || key === "all") &&
              sql.includes("model_history_items")
            ) {
              reads.push({
                sql,
                rows: Array.isArray(result)
                  ? result.length
                  : result === undefined
                    ? 0
                    : 1,
                bindings,
              });
            }
            return result;
          };
        },
      });
    },
  );
  const warmed = await readWindow(fixture.store.modelHistoryContext);
  observer.mock.restore();
  assert.equal(warmed.items.length, 1);
  assert.ok(reads.every((read) => read.rows <= 1));
  assert.ok(reads.length <= 10);
  for (const read of reads) {
    const plan = fixture.database
      .prepare(`EXPLAIN QUERY PLAN ${read.sql}`)
      .all(...read.bindings);
    assert.ok(
      plan.every((row) => !/\bSCAN\b/.test(String(row.detail))),
      JSON.stringify(plan),
    );
  }
  context.diagnostic(
    `20,202 canonical records: ${reads.length} indexed warm history queries, at most one row each; one effective content item`,
  );
});

test("SQLite context snapshots reject concurrent append, same-head replacement and corrupt body references", async (context) => {
  const fixture = await createFixture(context);
  fixture.insert(
    [message(1), message(2, "assistant"), compaction(3, 2), message(4)],
    true,
  );
  const old = (await fixture.store.modelHistoryContext.prepare(locator))
    .context!;
  // An external/older writer need not understand the derived index.
  fixture.insert([message(5)]);
  await assert.rejects(
    fixture.store.modelHistoryContext.listItems(
      locator,
      old.checkpoint,
      0,
      100,
    ),
    /model_history_context_changed/,
  );
  const current = (await fixture.store.modelHistoryContext.prepare(locator))
    .context!;
  assert.equal(current.checkpoint.throughHistorySequence, 5);
  fixture.database
    .prepare(`UPDATE model_history_items SET item_json=? WHERE sequence=5`)
    .run(JSON.stringify({ ...message(5), content: "replacement" }));
  await assert.rejects(
    fixture.store.modelHistoryContext.listItems(
      locator,
      current.checkpoint,
      0,
      100,
    ),
    /model_history_context_changed/,
  );
  const rebuilt = (await fixture.store.modelHistoryContext.prepare(locator))
    .context!;
  assert.notEqual(
    rebuilt.checkpoint.fingerprint,
    current.checkpoint.fingerprint,
  );
  fixture.database.exec(
    "UPDATE model_history_context_refs SET item_digest='broken' WHERE sequence=4",
  );
  await assert.rejects(
    fixture.store.modelHistoryContext.listItems(
      locator,
      rebuilt.checkpoint,
      0,
      100,
    ),
    /model_history_context_invalid/,
  );
  await assert.rejects(
    fixture.store.modelHistoryContext.listItems(
      { ...locator, tenantId: "other-tenant" },
      rebuilt.checkpoint,
      0,
      100,
    ),
    /model_history_context_changed/,
  );
});

test("SQLite checkpoint migration is lazy and rejects invalid old rollback boundaries", async (context) => {
  const fixture = await createFixture(context);
  const history = [message(1), message(2, "assistant"), message(3)];
  fixture.insert(history);
  const malformed = { ...rollback(history, 1), historyFromSequence: 2 };
  fixture.insert([malformed]);
  const before = fixture.database
    .prepare("SELECT item_json FROM model_history_items ORDER BY sequence")
    .all();
  await fixture.store.close();
  fixture.database.exec(`DROP TRIGGER model_history_context_invalidate_update;
    DROP TRIGGER model_history_context_invalidate_delete;
    DROP TABLE model_history_context_refs; DROP TABLE model_history_context_state; PRAGMA user_version=25`);
  fixture.store = new SqliteRunStore(fixture.path);
  assert.equal(
    fixture.database.prepare("PRAGMA user_version").get()?.user_version,
    SQLITE_SCHEMA_VERSION,
  );
  assert.equal(
    fixture.database
      .prepare("SELECT COUNT(*) AS value FROM model_history_context_state")
      .get()?.value,
    0,
  );
  assert.deepEqual(
    fixture.database
      .prepare("SELECT item_json FROM model_history_items ORDER BY sequence")
      .all(),
    before,
  );
  await assert.rejects(
    fixture.store.modelHistoryContext.prepare(locator),
    /model_history_rollback_boundary_mismatch/,
  );
  assert.equal(
    fixture.database
      .prepare("SELECT COUNT(*) AS value FROM model_history_context_state")
      .get()?.value,
    0,
  );
});

test("SQLite hot reference writes roll back with canonical history", async (context) => {
  const fixture = await createFixture(context);
  fixture.insert([message(1)], true);
  const before = (await fixture.store.modelHistoryContext.prepare(locator))
    .context!;
  fixture.database.exec("BEGIN IMMEDIATE");
  fixture.insertRows([message(2)]);
  appendSqliteModelHistoryContext(fixture.database, [message(2)]);
  fixture.database.exec("ROLLBACK");
  assert.deepEqual(
    (await fixture.store.modelHistoryContext.prepare(locator)).context,
    before,
  );
  assert.equal(
    fixture.database
      .prepare("SELECT COUNT(*) AS value FROM model_history_context_refs")
      .get()?.value,
    1,
  );
});

async function createFixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "crewon-context-index-"));
  const path = join(directory, "store.sqlite");
  const seeded = await outputFixture(
    context,
    (clock) => new SqliteRunStore(path, { clock }),
  );
  const database = new DatabaseSync(path);
  const insertRows = (items: readonly ModelHistoryItem[]) => {
    const statement = database.prepare(`INSERT INTO model_history_items
      (tenant_id, thread_id, sequence, item_id, run_id, segment_id, item_type, item_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of items)
      statement.run(
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
  };
  const fixture = {
    path,
    database,
    store: seeded.store as SqliteRunStore,
    insertRows,
    insert(items: readonly ModelHistoryItem[], maintain = false) {
      database.exec("BEGIN IMMEDIATE");
      try {
        insertRows(items);
        if (maintain) appendSqliteModelHistoryContext(database, items);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  context.after(async () => {
    await fixture.store.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return fixture;
}
