import assert from "node:assert/strict";
import test from "node:test";
import { textIntentFixture } from "./project-text-ui-intent.test-support.ts";
import { foundationMetadataFixture } from "./project-foundation-legacy-access.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: saved pending journal, cold recovery and same-key stage refuse protected project`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend),
        g = f.outline(),
        staged = await f.stage(g),
        cold = await f.reopen();
      const m = await foundationMetadataFixture(t, {
        backend,
        path: String(
          f.database?.prepare("PRAGMA database_list").get()?.file ?? "",
        ),
        schema: f.schema,
        prefix: f.prefix,
      });
      await m.migrate();
      await m.mark(f.scope.projectId, f.actor);
      for (const action of [
        () => f.pending(),
        () => f.pending(cold.journal),
        () => f.stage(g),
        () => f.ack(staged),
      ])
        await assert.rejects(action(), /creative_project_not_found/);
      assert.equal((await f.textCounts()).project_text_mutation_receipts, 0);
    },
  );
  test(
    `${backend}: actual accepted journal cannot expose saved result or acknowledge it after protection`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend),
        g = f.outline();
      await f.stage(g);
      await f.write(g);
      const accepted = await f.pending();
      assert.ok(accepted);
      const before = await f.textCounts();
      const m = await foundationMetadataFixture(t, {
        backend,
        path: String(
          f.database?.prepare("PRAGMA database_list").get()?.file ?? "",
        ),
        schema: f.schema,
        prefix: f.prefix,
      });
      await m.migrate();
      await m.mark(f.scope.projectId, f.actor);
      await assert.rejects(f.pending(), /creative_project_not_found/);
      await assert.rejects(f.ack(accepted), /creative_project_not_found/);
      assert.deepEqual(await f.textCounts(), before);
    },
  );
  test(
    `${backend}: original journal DDL preserves partial owner evidence and data remains closed`,
    options,
    async (t) => {
      const f = await textIntentFixture(t, backend),
        g = f.outline();
      await f.stage(g);
      if (f.database)
        f.database.exec(
          "CREATE TABLE plugin_project_metadata_owners(tenant_id TEXT)",
        );
      else
        await f.pool!.query(
          `CREATE TABLE ${f.prefix}plugin_project_metadata_owners(tenant_id TEXT)`,
        );
      const objects = () =>
        f.query(
          backend === "sqlite"
            ? "SELECT name,type,sql FROM sqlite_schema WHERE name LIKE 'plugin_project_metadata_owner%' ORDER BY name"
            : `SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${f.schema}' AND c.relname LIKE 'plugin_project_metadata_owner%' ORDER BY c.relname`,
        );
      const before = await objects();
      await f.journal.migrate();
      assert.deepEqual(await objects(), before);
      await assert.rejects(f.pending(), /plugin_project_metadata_owner_schema/);
      await assert.rejects(f.stage(g), /plugin_project_metadata_owner_schema/);
    },
  );
}
