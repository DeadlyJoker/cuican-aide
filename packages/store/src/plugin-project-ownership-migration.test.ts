import assert from "node:assert/strict";
import test from "node:test";
import {
  fixture,
  creationRecipe,
  owner,
} from "./creative-project-store.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: explicit parent ownership DDL is idempotent and preserves legacy project bytes without adoption`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await fixture(t, backend);
      const creation = creationRecipe(
        "legacy-before-owned-schema",
        "legacy-before-owned-schema",
      );
      await f.first.store.commitProjectCreation(creation);
      const before = await f.query(
        `SELECT * FROM ${f.prefix}creative_projects ORDER BY project_id`,
      );
      assert.equal(
        (await f.tableNames()).includes("plugin_project_metadata_owners"),
        false,
      );
      await f.first.parent.migratePluginProjectOwnership();
      await f.second.parent.migratePluginProjectOwnership();
      assert.deepEqual(
        await f.query(
          `SELECT * FROM ${f.prefix}creative_projects ORDER BY project_id`,
        ),
        before,
      );
      assert.equal(await f.count("plugin_project_metadata_owners"), 0);
      assert.equal(await f.count("plugin_project_workspace_namespaces"), 0);
      assert.ok(
        await f.first.store.loadProject({
          owner: owner(),
          projectId: creation.project.projectId,
        }),
      );
      await f.first.parent.close();
      await assert.rejects(
        f.first.parent.migratePluginProjectOwnership(),
        /closed/,
      );
    },
  );
  test(
    `${backend}: malformed namespace schema rolls back new ownership DDL and is never repaired implicitly`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await fixture(t, backend);
      await f.execute(
        `CREATE TABLE ${f.prefix}plugin_project_workspace_namespaces(bad INTEGER)`,
      );
      await assert.rejects(
        f.first.parent.migratePluginProjectOwnership(),
        /schema_invalid/,
      );
      assert.equal(
        (await f.tableNames()).includes("plugin_project_metadata_owners"),
        false,
      );
      await f.execute(
        `INSERT INTO ${f.prefix}plugin_project_workspace_namespaces(bad) VALUES(7)`,
      );
      assert.deepEqual(
        await f.query(
          `SELECT bad FROM ${f.prefix}plugin_project_workspace_namespaces`,
        ),
        [{ bad: 7 }],
      );
    },
  );
}
