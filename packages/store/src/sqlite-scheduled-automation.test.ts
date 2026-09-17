import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  AutomationStoreError,
  RunStoreError,
  type ScheduledAutomationListQuery,
} from "@crewon/application";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import {
  automationApplicationService,
  automationCreateCommand,
  automationRunCommand,
  seedAutomationThread,
} from "./automation-store-conformance.test-support.ts";
import { AUTOMATION_SCHEDULE_INDEX } from "./automation-schedule-index-schema.ts";
import {
  automationActor,
  scheduleRecord,
  scheduleCursor,
  expectedScheduledPage,
  invalidScheduleQueries,
  assertScheduledInsertionOrder,
} from "./scheduled-automation.test-support.ts";

test("SQLite upgrades v27 without rewriting authority and seeks deep schedule pages through its partial index", async (context) => {
  const fixture = await createFixture(context);
  const service = automationApplicationService(fixture.store);
  const base = await service.createAutomation(
    automationActor,
    automationCreateCommand(),
  );
  const invocation = await service.runAutomationNow(
    automationActor,
    automationRunCommand(),
  );
  const records = Array.from({ length: 20_000 }, (_, index) =>
    scheduleRecord(base.record, index + 1),
  );
  const database = fixture.database;
  const insert = database.prepare(`INSERT INTO automations
    (tenant_id,space_id,automation_id,thread_id,revision,definition_digest,definition_json,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  database.exec("BEGIN");
  for (const record of records) {
    const item = record.definition;
    insert.run(
      item.tenantId,
      item.spaceId,
      item.automationId,
      item.threadId,
      item.revision,
      record.definitionDigest,
      JSON.stringify(item),
      item.updatedAt,
    );
  }
  database.exec("COMMIT");
  const before = scheduleCursor(records[4999]!);
  await fixture.store.close();
  database.exec(
    `DROP INDEX ${AUTOMATION_SCHEDULE_INDEX}; PRAGMA user_version=27`,
  );
  const originalAuthority = database
    .prepare(
      "SELECT definition_json, definition_digest FROM automations ORDER BY automation_id",
    )
    .all();
  const originalReceipts = database
    .prepare("SELECT result_json FROM automation_invocation_receipts")
    .all();
  const oldPlan = database
    .prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM automations
    WHERE json_extract(definition_json,'$.executionMode')='scheduled'
    AND (? IS NULL OR updated_at < ? OR (updated_at=? AND automation_id < ?))
    ORDER BY updated_at DESC,automation_id DESC LIMIT 37`,
    )
    .all(
      before.updatedAt,
      before.updatedAt,
      before.updatedAt,
      before.automationId,
    );
  assert.ok(oldPlan.some((row) => String(row.detail).includes("TEMP B-TREE")));
  fixture.reopen();
  assert.equal(
    database.prepare("PRAGMA user_version").get()?.user_version,
    SQLITE_SCHEMA_VERSION,
  );
  assert.deepEqual(
    database
      .prepare(
        "SELECT definition_json, definition_digest FROM automations ORDER BY automation_id",
      )
      .all(),
    originalAuthority,
  );
  assert.deepEqual(
    database
      .prepare("SELECT result_json FROM automation_invocation_receipts")
      .all(),
    originalReceipts,
  );
  assert.deepEqual(
    await automationApplicationService(fixture.store).runAutomationNow(
      automationActor,
      {
        ...automationRunCommand(),
        expectedThreadRevision: 2,
      },
    ),
    { ...invocation, disposition: "replayed" },
  );
  const captured: Array<{ sql: string; parameters: SQLInputValue[] }> = [];
  const prepare = DatabaseSync.prototype.prepare;
  const observer = context.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (/FROM automations\s+WHERE/.test(sql)) {
        statement.all = new Proxy(statement.all, {
          apply(all, receiver, parameters: SQLInputValue[]) {
            captured.push({ sql, parameters });
            return Reflect.apply(all, receiver, parameters);
          },
        });
      }
      return statement;
    },
  );
  for (const cursor of [null, before, scheduleCursor(records[100]!)] as const) {
    const rows = await fixture.store.listScheduledAutomations({
      before: cursor,
      limit: 37,
    });
    assert.deepEqual(rows, expectedScheduledPage(records, cursor, 37));
  }
  observer.mock.restore();
  assert.equal(captured.length, 3);
  for (const [index, query] of captured.entries()) {
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(...query.parameters);
    assert.equal(
      plan.some((row) => String(row.detail).includes("TEMP B-TREE")),
      false,
    );
    assert.ok(
      plan.some((row) =>
        String(row.detail).includes(AUTOMATION_SCHEDULE_INDEX),
      ),
    );
    if (index > 0)
      assert.ok(plan.some((row) => String(row.detail).includes("SEARCH")));
    context.diagnostic(
      JSON.stringify({ page: index, plan: plan.map((row) => row.detail) }),
    );
  }
  for (const query of invalidScheduleQueries)
    await assert.rejects(
      fixture.store.listScheduledAutomations(
        query as ScheduledAutomationListQuery,
      ),
      AutomationStoreError,
    );
  database
    .prepare("UPDATE automations SET definition_digest=? WHERE automation_id=?")
    .run(`sha256:${"0".repeat(64)}`, records.at(-1)!.definition.automationId);
  await assert.rejects(
    fixture.store.listScheduledAutomations({ before: null, limit: 1 }),
    AutomationStoreError,
  );
});

test("SQLite keeps scheduled insertion and receipt replay ordered across punctuation and case", async (context) => {
  const fixture = await createFixture(context);
  await assertScheduledInsertionOrder(fixture.store);
});

test("SQLite rejects a same-name incorrect schedule index without publishing a migration version", async (context) => {
  const fixture = await createFixture(context);
  await fixture.store.close();
  for (const definition of [
    "ON automations(automation_id)",
    "ON automations(updated_at DESC, automation_id DESC) WHERE json_extract(definition_json, '$.executionMode') = 'scheduled '",
  ]) {
    fixture.database.exec(`DROP INDEX ${AUTOMATION_SCHEDULE_INDEX};
      CREATE INDEX ${AUTOMATION_SCHEDULE_INDEX} ${definition}; PRAGMA user_version=27`);
    assert.throws(
      () => fixture.reopen(),
      (error: unknown) =>
        error instanceof RunStoreError &&
        error.code === "sqlite_automation_schedule_index_invalid",
    );
    assert.equal(
      fixture.database.prepare("PRAGMA user_version").get()?.user_version,
      27,
    );
    fixture.database.exec("PRAGMA user_version=28");
    assert.throws(
      () => fixture.reopen(),
      (error: unknown) =>
        error instanceof RunStoreError &&
        error.code === "sqlite_automation_schedule_index_invalid",
    );
  }
});

async function createFixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "crewon-schedule-index-"));
  const path = join(directory, "store.sqlite");
  let store = new SqliteRunStore(path);
  const database = new DatabaseSync(path);
  context.after(async () => {
    await store.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedAutomationThread(store);
  return {
    database,
    get store() {
      return store;
    },
    reopen() {
      store = new SqliteRunStore(path);
    },
  };
}
