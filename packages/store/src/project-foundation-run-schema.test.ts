import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { SqliteProjectFoundationRunStore } from "./project-foundation-run-store.ts";
import {
  foundationRunSchemaFixture,
  foundationRunTables,
  foundationRunTestOptions,
} from "./project-foundation-run.test-support.ts";

const locator = {
  tenantId: "legacy-tenant",
  spaceId: "legacy-space",
  runId: "legacy-run",
};

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: Foundation Run construction and absent reads do no DDL on the original host DB`,
    foundationRunTestOptions(backend),
    async (t) => {
      const f = await foundationRunSchemaFixture(t, backend);
      const before = await f.catalog();
      const reader = f.parent.projectFoundationRunStore();
      assert.deepEqual(await f.catalog(), before);
      assert.equal(await reader.loadFoundationRunAdmission(locator), null);
      assert.equal(await reader.readRequiredFoundationDigest(locator), null);
      assert.deepEqual(await f.catalog(), before);
      assert.equal(
        before.some((row) =>
          foundationRunTables.includes(
            String(
              row.name ?? row.relname,
            ) as (typeof foundationRunTables)[number],
          ),
        ),
        false,
      );
    },
  );

  test(
    `${backend}: explicit Foundation migration is idempotent and keeps the original Run tables`,
    foundationRunTestOptions(backend),
    async (t) => {
      const f = await foundationRunSchemaFixture(t, backend);
      assert.equal(
        Number(
          (
            await f.rows(`SELECT COUNT(*) AS n FROM ${f.prefix}run_snapshots`)
          )[0]?.n,
        ),
        0,
      );
      await f.migrate();
      const catalog = await f.catalog();
      await f.migrate();
      assert.deepEqual(await f.catalog(), catalog);
      for (const table of foundationRunTables.slice(1))
        assert.equal(
          Number(
            (await f.rows(`SELECT COUNT(*) AS n FROM ${f.prefix}${table}`))[0]
              ?.n,
          ),
          0,
        );
      assert.equal(
        await f.parent
          .projectFoundationRunStore()
          .loadFoundationRunAdmission(locator),
        null,
      );
      const reopened = await f.open();
      assert.equal(
        await reopened
          .projectFoundationRunStore()
          .readRequiredFoundationDigest(locator),
        null,
      );
      assert.deepEqual(await f.catalog(), catalog);
    },
  );

  for (const corruption of [
    "partial",
    "view",
    "missing-trigger",
    "no-op-trigger",
    "future-version",
  ] as const) {
    test(
      `${backend}: ${corruption} Run sidecar rejects reads and migration without legacy fallback`,
      foundationRunTestOptions(backend),
      async (t) => {
        const f = await foundationRunSchemaFixture(t, backend);
        await f.migrate();
        const table = "project_foundation_run_requirements";
        if (corruption === "partial")
          await f.execute(`DROP TABLE ${f.prefix}${table}`);
        else if (corruption === "view") {
          await f.execute(
            `ALTER TABLE ${f.prefix}${table} RENAME TO actual_requirements`,
          );
          await f.execute(
            `CREATE VIEW ${f.prefix}${table} AS SELECT * FROM ${f.prefix}actual_requirements`,
          );
        } else if (corruption === "missing-trigger")
          await f.execute(
            backend === "sqlite"
              ? `DROP TRIGGER ${table}_no_delete`
              : `DROP TRIGGER ${table}_immutable ON ${f.prefix}${table}`,
          );
        else if (corruption === "no-op-trigger") {
          if (backend === "sqlite") {
            await f.execute(`DROP TRIGGER ${table}_no_delete`);
            await f.execute(
              `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT 1; END`,
            );
          } else {
            await f.execute(
              `CREATE FUNCTION ${f.prefix}test_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END; $$`,
            );
            await f.execute(
              `DROP TRIGGER ${table}_immutable ON ${f.prefix}${table}`,
            );
            await f.execute(
              `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${f.prefix}${table} FOR EACH ROW EXECUTE FUNCTION ${f.prefix}test_noop()`,
            );
          }
        } else {
          await f.execute(
            `DROP TABLE ${f.prefix}project_foundation_run_schema_version`,
          );
          await f.execute(
            `CREATE TABLE ${f.prefix}project_foundation_run_schema_version(id INTEGER PRIMARY KEY,version INTEGER NOT NULL)`,
          );
          await f.execute(
            `INSERT INTO ${f.prefix}project_foundation_run_schema_version VALUES(1,2)`,
          );
        }
        const catalog = await f.catalog();
        const error =
          corruption === "future-version"
            ? /project_foundation_run_schema_version_unsupported/u
            : /project_foundation_run_schema_incomplete/u;
        const reader = f.parent.projectFoundationRunStore();
        await assert.rejects(reader.loadFoundationRunAdmission(locator), error);
        await assert.rejects(
          reader.readRequiredFoundationDigest(locator),
          error,
        );
        await assert.rejects(
          f.parent.projectFoundationStore().migrate(),
          error,
        );
        assert.deepEqual(await f.catalog(), catalog);
      },
    );
  }

  test(
    `${backend}: original parent closure revokes readers acquired before close`,
    foundationRunTestOptions(backend),
    async (t) => {
      const f = await foundationRunSchemaFixture(t, backend);
      await f.migrate();
      const reader = f.parent.projectFoundationRunStore();
      await f.parent.close();
      assert.throws(() => f.parent.projectFoundationRunStore(), /closed/u);
      await assert.rejects(
        reader.loadFoundationRunAdmission(locator),
        /closed/u,
      );
      await assert.rejects(
        reader.readRequiredFoundationDigest(locator),
        /closed/u,
      );
    },
  );
}

for (const corruption of [
  "disabled-trigger",
  "no-op-trigger-function",
] as const) {
  test(
    `postgres: ${corruption} cannot present itself as the approved immutable Run sidecar`,
    foundationRunTestOptions("postgres"),
    async (t) => {
      const f = await foundationRunSchemaFixture(t, "postgres");
      await f.migrate();
      await f.execute(
        corruption === "disabled-trigger"
          ? `ALTER TABLE ${f.prefix}project_foundation_run_requirements DISABLE TRIGGER project_foundation_run_requirements_immutable`
          : `CREATE OR REPLACE FUNCTION ${f.prefix}project_foundation_run_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END; $$`,
      );
      const before = await f.catalog();
      const reader = f.parent.projectFoundationRunStore();
      await assert.rejects(
        reader.loadFoundationRunAdmission(locator),
        /project_foundation_run_schema_incomplete/u,
      );
      await assert.rejects(
        reader.readRequiredFoundationDigest(locator),
        /project_foundation_run_schema_incomplete/u,
      );
      await assert.rejects(
        f.parent.projectFoundationStore().migrate(),
        /project_foundation_run_schema_incomplete/u,
      );
      assert.deepEqual(await f.catalog(), before);
    },
  );
}

test("sqlite: temp shadowing cannot substitute an opted-in Run sidecar", async (t) => {
  const f = await foundationRunSchemaFixture(t, "sqlite");
  await f.migrate();
  // Temp objects are connection-local; this actual DB connection points at the original file.
  assert.ok(f.database);
  const reader = new SqliteProjectFoundationRunStore({
    database: f.database,
    assertOpen() {},
  });
  f.database.exec(
    "CREATE TEMP TABLE project_foundation_run_requirements(tenant_id TEXT,space_id TEXT,run_id TEXT,content_digest TEXT)",
  );
  await assert.rejects(
    reader.loadFoundationRunAdmission(locator),
    /project_foundation_run_schema_incomplete/u,
  );
});

test(
  "postgres: factory reads borrow the same original max-one pool and return its connection",
  foundationRunTestOptions("postgres"),
  async (t) => {
    const f = await foundationRunSchemaFixture(t, "postgres");
    await f.migrate();
    let prototype = Pool.prototype;
    while (!Object.hasOwn(prototype, "connect"))
      prototype = Object.getPrototypeOf(prototype);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "connect")!;
    const borrowed: Pool[] = [];
    Object.defineProperty(prototype, "connect", {
      ...descriptor,
      value: function (this: Pool, ...args: unknown[]) {
        borrowed.push(this);
        return Reflect.apply(descriptor.value, this, args);
      },
    });
    const restore = () =>
      Object.defineProperty(prototype, "connect", descriptor);
    t.after(restore);
    try {
      await f.parent.loadThread({
        tenantId: locator.tenantId,
        threadId: "missing-thread",
      });
      const originalPool = borrowed[0];
      assert.ok(originalPool);
      assert.equal(originalPool.options.max, 1);
      borrowed.length = 0;
      const reader = f.parent.projectFoundationRunStore();
      assert.equal(await reader.loadFoundationRunAdmission(locator), null);
      assert.deepEqual(borrowed, [originalPool]);
      assert.equal(originalPool.totalCount, 1);
      assert.equal(originalPool.idleCount, 1);
      borrowed.length = 0;
      assert.equal(await reader.readRequiredFoundationDigest(locator), null);
      assert.deepEqual(borrowed, [originalPool]);
      assert.equal(originalPool.idleCount, 1);
    } finally {
      restore();
    }
  },
);
