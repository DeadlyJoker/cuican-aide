import { POSTGRES_RUN_SCHEMA_VERSION } from "./postgres-run-schema.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { outputFixture } from "./run-output-store-conformance.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

test(
  "PostgreSQL v2 migration preserves old events and exact replay while adding compact receipt authority",
  { skip: connectionString === undefined },
  async (context) => {
    const fixture = await postgresFixture(context);
    const input = fixture.input([1], 2, "legacy");
    await fixture.store.commitLeasedRun({
      lease: input.lease,
      history: null,
      commit: {
        tenantId: input.tenantId,
        expectedRevision: 2,
        idempotency: input.entries[0]!.idempotency,
        events: [{ ...input.entries[0]!.event, sequence: 3 }],
        outbox: [],
        workItems: [],
      },
    });
    const before = (
      await fixture.admin.query(
        `SELECT result_json FROM ${fixture.schema} .idempotency_receipts ORDER BY scope, idempotency_key`,
      )
    ).rows;
    await fixture.store.close();
    await fixture.admin
      .query(`DROP TRIGGER run_output_receipt_duplicate_guard ON ${fixture.schema}.run_events;
    DROP TABLE ${fixture.schema}.run_output_receipts;
    UPDATE ${fixture.schema}.schema_migrations SET version=2 WHERE component='run_authority'`);
    const migrated = await fixture.open();
    assert.equal(
      (
        await fixture.admin.query(
          `SELECT version FROM ${fixture.schema}.schema_migrations WHERE component='run_authority'`,
        )
      ).rows[0]?.version,
      POSTGRES_RUN_SCHEMA_VERSION,
    );
    assert.deepEqual(
      (
        await fixture.admin.query(
          `SELECT result_json FROM ${fixture.schema}.idempotency_receipts ORDER BY scope, idempotency_key`,
        )
      ).rows,
      before,
    );
    const appended = await migrated.appendRunOutputEvents(
      fixture.input([1, 2, 3], 3, "after-migration"),
    );
    assert.equal(appended.replayedCount, 1);
    assert.deepEqual(
      appended.appendedEvents.map((event) => event.sequence),
      [4, 5],
    );
  },
);

test(
  "PostgreSQL independent pools converge identical batches and retry a rejected overlapping suffix",
  { skip: connectionString === undefined },
  async (context) => {
    const fixture = await postgresFixture(context);
    const second = await fixture.open();
    const outcomes = await Promise.all([
      fixture.append(fixture.input([1, 2], 2, "first")),
      second.appendRunOutputEvents(fixture.input([1, 2], 2, "duplicate")),
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.appendedEvents.length).sort(),
      [0, 2],
    );
    assert.deepEqual(
      outcomes.map((outcome) => outcome.replayedCount).sort(),
      [0, 2],
    );
    const race = await Promise.allSettled([
      fixture.append(fixture.input([2, 3, 4], 4, "suffix-a")),
      second.appendRunOutputEvents(fixture.input([2, 3, 4, 5], 4, "suffix-b")),
    ]);
    for (const outcome of race) {
      if (outcome.status === "rejected")
        assert.equal(outcome.reason.code, "revision_conflict");
    }
    const current = await fixture.store.loadRun({
      tenantId: "tenant-1",
      runId: "run-store-1",
    });
    assert.ok(current !== null);
    await second.appendRunOutputEvents(
      fixture.input([1, 2, 3, 4, 5], current.revision, "converged"),
    );
    const events = await fixture.events();
    assert.deepEqual(
      events
        .filter((event) => event.type === "model.output.delta")
        .map((event) => event.data.segmentSequence),
      [1, 2, 3, 4, 5],
    );
    assert.equal(
      (
        await fixture.admin.query(
          `SELECT COUNT(*)::int AS count FROM ${fixture.schema}.run_output_receipts`,
        )
      ).rows[0]?.count,
      5,
    );
  },
);

async function postgresFixture(context: TestContext) {
  assert.ok(connectionString !== undefined);
  const schemaName = `crewon_output_${randomUUID().replaceAll("-", "_")}`;
  const schema = `"${schemaName}"`;
  const admin = new Pool({ connectionString, max: 1 });
  const stores: PostgresDomainStore[] = [];
  const open = async () => {
    const store = new PostgresDomainStore({
      connectionString,
      schema: schemaName,
      maxPoolSize: 2,
    });
    stores.push(store);
    await store.migrate();
    return store;
  };
  const fixture = await outputFixture(context, open);
  context.after(async () => {
    for (const store of stores) await store.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  return { ...fixture, schema, admin, open };
}
