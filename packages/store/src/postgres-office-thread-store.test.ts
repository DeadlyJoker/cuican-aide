import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { POSTGRES_THREAD_SCHEMA_VERSION } from "./postgres-thread-schema.ts";
import {
  createOfficeThread,
  officeBinding,
  registerOfficeThreadConformance,
  seedOffice,
} from "./office-thread-store.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
if (connectionString === undefined) {
  test.skip("PostgreSQL Office thread authority requires CREWON_TEST_POSTGRES_URL", () => {});
} else {
  async function fixture(t: TestContext) {
    const schema = `office_thread_${randomUUID().replaceAll("-", "")}`;
    const first = await PostgresDomainStore.open({ connectionString, schema });
    t.after(async () => {
      await first.close();
      const admin = new Pool({ connectionString, max: 1 });
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    return { first, schema };
  }
  registerOfficeThreadConformance(
    "PostgreSQL Office thread authority",
    async (t) => (await fixture(t)).first,
  );

  test("PostgreSQL serializes creation and adoption across independent pools", async (t) => {
    const { first, schema } = await fixture(t);
    const second = await PostgresDomainStore.open({ connectionString, schema });
    t.after(() => second.close());
    await seedOffice(first);
    const results = await Promise.allSettled([
      first.commitThread(createOfficeThread()),
      second.commitThread(
        createOfficeThread({ ...officeBinding, threadId: "thread-2" }),
      ),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const binding = (await first.loadOfficeThreadBinding(officeBinding))!;
    assert.deepEqual(
      await second.loadOfficeThreadBinding(officeBinding),
      binding,
    );
    const loser = binding.threadId === "thread-1" ? "thread-2" : "thread-1";
    assert.equal(
      await first.loadThread({ tenantId: "tenant-1", threadId: loser }),
      null,
    );
    const adoptions = await Promise.all([
      first.bindOfficeThread({ binding, expectedThreadRevision: 1 }),
      second.bindOfficeThread({ binding, expectedThreadRevision: 1 }),
    ]);
    assert.deepEqual(
      adoptions.map((result) => result.disposition),
      ["existing", "existing"],
    );
  });

  test("PostgreSQL rolls back all creation writes on receipt failure", async (t) => {
    const { first, schema } = await fixture(t);
    await seedOffice(first);
    const admin = new Pool({ connectionString, max: 1 });
    try {
      await admin.query(
        `CREATE FUNCTION "${schema}".fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$; CREATE TRIGGER fail_receipt BEFORE INSERT ON "${schema}".thread_idempotency_receipts FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_receipt()`,
      );
      await assert.rejects(first.commitThread(createOfficeThread()));
      assert.equal(await first.loadOfficeThreadBinding(officeBinding), null);
      assert.equal(
        await first.loadThread({ tenantId: "tenant-1", threadId: "thread-1" }),
        null,
      );
      for (const table of [
        "office_thread_bindings",
        "threads",
        "thread_events",
        "thread_idempotency_receipts",
        "model_history_items",
      ])
        assert.equal(
          (
            await admin.query(
              `SELECT COUNT(*)::int AS count FROM "${schema}".${table}`,
            )
          ).rows[0].count,
          0,
        );
      await admin.query(
        `DROP TRIGGER fail_receipt ON "${schema}".thread_idempotency_receipts`,
      );
      assert.equal(
        (await first.commitThread(createOfficeThread())).disposition,
        "committed",
      );
    } finally {
      await admin.end();
    }
  });

  test("PostgreSQL upgrades v6 without assigning old threads and persists explicit adoption", async (t) => {
    const { first, schema } = await fixture(t);
    await seedOffice(first);
    const { officeBinding: _binding, ...input } = createOfficeThread();
    const created = await first.commitThread(input);
    await first.close();
    const admin = new Pool({ connectionString, max: 1 });
    try {
      await admin.query(
        `DROP TABLE "${schema}".office_thread_bindings; UPDATE "${schema}".schema_migrations SET version = 6 WHERE component = 'thread_authority'`,
      );
      const migrated = await PostgresDomainStore.open({
        connectionString,
        schema,
      });
      try {
        assert.equal(
          await migrated.loadOfficeThreadBinding(officeBinding),
          null,
        );
        assert.deepEqual(
          await migrated.loadThread({
            tenantId: "tenant-1",
            threadId: "thread-1",
          }),
          created.state,
        );
        await migrated.bindOfficeThread({
          binding: officeBinding,
          expectedThreadRevision: 1,
        });
        assert.equal(
          (
            await admin.query(
              `SELECT version FROM "${schema}".schema_migrations WHERE component = 'thread_authority'`,
            )
          ).rows[0].version,
          POSTGRES_THREAD_SCHEMA_VERSION,
        );
      } finally {
        await migrated.close();
      }
      const reopened = await PostgresDomainStore.open({
        connectionString,
        schema,
      });
      try {
        assert.deepEqual(
          await reopened.loadOfficeThreadBinding(officeBinding),
          officeBinding,
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await admin.end();
    }
  });

  test("PostgreSQL refuses a missing current binding table instead of resetting associations", async (t) => {
    const { first, schema } = await fixture(t);
    await seedOffice(first);
    await first.commitThread(createOfficeThread());
    await first.close();
    const admin = new Pool({ connectionString, max: 1 });
    try {
      await admin.query(`DROP TABLE "${schema}".office_thread_bindings`);
      await assert.rejects(
        PostgresDomainStore.open({ connectionString, schema }),
        (error: unknown) => {
          assert.match(
            String(error) + String((error as Error).cause),
            /office_thread_binding_schema_missing/u,
          );
          return true;
        },
      );
      assert.equal(
        (
          await admin.query("SELECT to_regclass($1) AS name", [
            `${schema}.office_thread_bindings`,
          ])
        ).rows[0].name,
        null,
      );
    } finally {
      await admin.end();
    }
  });
}
