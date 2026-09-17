import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import {
  AutomationStoreError,
  RunStoreError,
  type ScheduledAutomationListQuery,
} from "@crewon/application";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { listPostgresScheduledAutomations } from "./postgres-automation-read-receipt.ts";
import { POSTGRES_AUTOMATION_SCHEMA_VERSION } from "./postgres-automation-schema.ts";
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

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
const options = { skip: connectionString === undefined };

test(
  "PostgreSQL upgrades v1 in place and uses bounded index seeks for 20,000 mixed automation definitions",
  options,
  async (context) => {
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
    for (let offset = 0; offset < records.length; offset += 100) {
      await fixture.admin.query(
        `INSERT INTO ${fixture.schema}.automations
      (tenant_id,space_id,automation_id,thread_id,revision,definition_digest,definition_json,updated_at)
      SELECT r->'definition'->>'tenantId', r->'definition'->>'spaceId', r->'definition'->>'automationId',
        r->'definition'->>'threadId', 1, r->>'definitionDigest', r->'definition',
        (r->'definition'->>'updatedAt')::timestamptz FROM jsonb_array_elements($1::jsonb) r`,
        [JSON.stringify(records.slice(offset, offset + 100))],
      );
    }
    await fixture.store.close();
    await fixture.admin
      .query(`DROP INDEX ${fixture.schema}.${AUTOMATION_SCHEDULE_INDEX};
    UPDATE ${fixture.schema}.schema_migrations SET version=1 WHERE component='automation_authority';
    ANALYZE ${fixture.schema}.automations`);
    const before = scheduleCursor(records[4999]!);
    const old = await fixture.admin.query(
      `EXPLAIN (ANALYZE, FORMAT JSON)
    SELECT * FROM ${fixture.schema}.automations
    WHERE definition_json ->> 'executionMode'='scheduled'
      AND ($1::timestamptz IS NULL OR updated_at < $1::timestamptz OR (updated_at=$1::timestamptz AND automation_id < $2))
    ORDER BY updated_at DESC, automation_id DESC LIMIT 37`,
      [before.updatedAt, before.automationId],
    );
    const oldNodes = planNodes(old.rows[0]["QUERY PLAN"][0].Plan);
    assert.ok(oldNodes.some((node) => node["Node Type"] === "Seq Scan"));
    assert.ok(oldNodes.some((node) => node["Node Type"] === "Sort"));
    const originalAuthority = (
      await fixture.admin.query(
        `SELECT definition_json, definition_digest FROM ${fixture.schema}.automations ORDER BY automation_id`,
      )
    ).rows;
    const originalReceipts = (
      await fixture.admin.query(
        `SELECT result_json FROM ${fixture.schema}.automation_invocation_receipts`,
      )
    ).rows;
    await fixture.reopen();
    assert.equal(
      (
        await fixture.admin.query(
          `SELECT version FROM ${fixture.schema}.schema_migrations WHERE component='automation_authority'`,
        )
      ).rows[0].version,
      POSTGRES_AUTOMATION_SCHEMA_VERSION,
    );
    assert.deepEqual(
      (
        await fixture.admin.query(
          `SELECT definition_json, definition_digest FROM ${fixture.schema}.automations ORDER BY automation_id`,
        )
      ).rows,
      originalAuthority,
    );
    assert.deepEqual(
      (
        await fixture.admin.query(
          `SELECT result_json FROM ${fixture.schema}.automation_invocation_receipts`,
        )
      ).rows,
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
    const captured: Array<{ sql: string; parameters: (string | number)[] }> =
      [];
    const observed = new Proxy(fixture.admin, {
      get(target, key) {
        if (key === "query")
          return (sql: string, parameters: (string | number)[]) => {
            captured.push({ sql, parameters });
            return target.query(sql, parameters);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    for (const cursor of [
      null,
      before,
      scheduleCursor(records[100]!),
    ] as const) {
      const query = { before: cursor, limit: 37 };
      const expected = expectedScheduledPage(records, cursor, 37);
      assert.deepEqual(
        await fixture.store.listScheduledAutomations(query),
        expected,
      );
      assert.deepEqual(
        await listPostgresScheduledAutomations(observed, fixture.schema, query),
        expected,
      );
    }
    assert.equal(captured.length, 3);
    for (const [page, query] of captured.entries()) {
      const explained = await fixture.admin.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
        query.parameters,
      );
      const nodes = planNodes(explained.rows[0]["QUERY PLAN"][0].Plan);
      assert.equal(
        nodes.some((node) =>
          ["Seq Scan", "Sort", "Bitmap Heap Scan"].includes(
            String(node["Node Type"]),
          ),
        ),
        false,
      );
      const index = nodes.find(
        (node) => node["Index Name"] === AUTOMATION_SCHEDULE_INDEX,
      );
      assert.ok(index !== undefined);
      assert.ok(Number(index["Actual Rows"]) <= 37);
      assert.equal(index["Rows Removed by Filter"] ?? 0, 0);
      if (page > 0)
        assert.ok(String(index["Index Cond"]).includes("ROW(updated_at"));
      context.diagnostic(
        JSON.stringify({
          page,
          index: index["Index Name"],
          rows: index["Actual Rows"],
          blocks: index["Shared Hit Blocks"],
          condition: index["Index Cond"] ?? null,
        }),
      );
    }
    for (const query of invalidScheduleQueries)
      await assert.rejects(
        listPostgresScheduledAutomations(
          observed,
          fixture.schema,
          query as ScheduledAutomationListQuery,
        ),
        AutomationStoreError,
      );
    assert.equal(captured.length, 3);
    await fixture.admin.query(
      `UPDATE ${fixture.schema}.automations SET definition_digest=$1 WHERE automation_id=$2`,
      [`sha256:${"0".repeat(64)}`, records.at(-1)!.definition.automationId],
    );
    await assert.rejects(
      fixture.store.listScheduledAutomations({ before: null, limit: 1 }),
      AutomationStoreError,
    );
  },
);

test(
  "PostgreSQL keeps scheduled insertion and receipt replay ordered across punctuation and case",
  options,
  async (context) => {
    const fixture = await createFixture(context);
    await assertScheduledInsertionOrder(fixture.store);
  },
);

test(
  "PostgreSQL rejects malformed schedule indexes and rolls the upgrade back",
  options,
  async (context) => {
    const fixture = await createFixture(context);
    await fixture.store.close();
    await fixture.admin
      .query(`DROP INDEX ${fixture.schema}.${AUTOMATION_SCHEDULE_INDEX};
    CREATE INDEX ${AUTOMATION_SCHEDULE_INDEX} ON ${fixture.schema}.automations(automation_id);
    UPDATE ${fixture.schema}.schema_migrations SET version=1 WHERE component='automation_authority'`);
    await assert.rejects(
      fixture.reopen(),
      (error: unknown) =>
        error instanceof RunStoreError &&
        error.code === "postgres_automation_schedule_index_invalid",
    );
    assert.equal(
      (
        await fixture.admin.query(
          `SELECT version FROM ${fixture.schema}.schema_migrations WHERE component='automation_authority'`,
        )
      ).rows[0].version,
      1,
    );
    await fixture.admin.query(
      `UPDATE ${fixture.schema}.schema_migrations SET version=2 WHERE component='automation_authority'`,
    );
    await assert.rejects(
      fixture.reopen(),
      (error: unknown) =>
        error instanceof RunStoreError &&
        error.code === "postgres_automation_schedule_index_invalid",
    );
  },
);

function planNodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  return [
    plan,
    ...((plan.Plans ?? []) as Record<string, unknown>[]).flatMap(planNodes),
  ];
}

async function createFixture(context: TestContext) {
  assert.ok(connectionString !== undefined);
  const schemaName = `crewon_schedule_index_${randomUUID().replaceAll("-", "_")}`;
  const schema = `"${schemaName}"`;
  const admin = new Pool({ connectionString, max: 1 });
  const opened: PostgresDomainStore[] = [];
  const open = async () => {
    const value = await PostgresDomainStore.open({
      connectionString,
      schema: schemaName,
      maxPoolSize: 2,
    });
    opened.push(value);
    return value;
  };
  context.after(async () => {
    for (const store of opened) await store.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  let store = await open();
  await seedAutomationThread(store);
  return {
    schema,
    admin,
    get store() {
      return store;
    },
    async reopen() {
      store = await open();
    },
  };
}
