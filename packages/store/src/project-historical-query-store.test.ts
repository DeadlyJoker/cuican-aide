import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { projectHistoricalQueryFixture } from "./project-historical-query.test-support.ts";
import { unchangedTables } from "./project-query.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const)
  describe(
    `${backend} historical query`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      test("actual source18 and original target commit once, cold replay preserves history/funding and original query is independent", async (t) => {
        const f = await projectHistoricalQueryFixture(t, backend),
          input = await f.queryInput(),
          before = await f.counts(),
          result = await f.first.store.commitExtensionTurn(
            input,
            f.commitOptions,
          );
        assert.equal(result.creditAdmission, undefined);
        assert.equal(result.unmeteredAdmission, undefined);
        const link = await f.second.store.loadProjectHistoricalQueryLink(
          result.binding,
        );
        assert.ok(link);
        assert.equal(link.sourcePin.version, "18.0.0");
        assert.equal(link.executionPin.version, "1.0.0");
        assert.deepEqual(link.publication, f.publication);
        assert.equal(
          await f.count("creative_project_historical_query_links"),
          1,
        );
        assert.equal(await f.count("creative_project_query_links"), 0);
        const cold = await f.open();
        await cold.store.migrateProjectHistoricalQueries();
        const candidate = await f.queryInput("another-query-id");
        assert.equal(
          (await cold.store.commitExtensionTurn(candidate, f.commitOptions))
            .binding.runId,
          result.binding.runId,
        );
        assert.deepEqual(
          await cold.store.loadProjectHistoricalQueryLink(result.binding),
          link,
        );
        const after = await f.counts();
        for (const table of unchangedTables)
          assert.equal(after[table], before[table], table);
        assert.equal(
          after.plugin_query_task_admissions,
          before.plugin_query_task_admissions! + 1,
        );
        const { projectHistoricalQuery, ...alias } = candidate;
        await assert.rejects(
          cold.store.commitExtensionTurn(alias),
          /project_historical_query_authority_required/u,
        );
        assert.equal(
          await f.count("creative_project_historical_query_links"),
          1,
        );
      });
      for (const owner of ["source", "execution"] as const)
        test(`${owner} withdrawal denies fresh and original-key replay without writes`, async (t) => {
          const f = await projectHistoricalQueryFixture(t, backend),
            old = await f.queryInput();
          await f.first.store.commitExtensionTurn(old, f.commitOptions);
          await f.disable(owner);
          const before = await f.counts();
          await assert.rejects(
            f.second.store.commitExtensionTurn(
              await f.queryInput("new-replay"),
              f.commitOptions,
            ),
            /plugin_task_admission_conflict/u,
          );
          await assert.rejects(
            f.first.store.commitExtensionTurn(
              await f.queryInput("new-fresh", "fresh-key"),
              f.commitOptions,
            ),
            /plugin_task_admission_conflict/u,
          );
          assert.deepEqual(await f.counts(), before);
        });
      test("full original manifest/implementation approval mismatch cannot admit", async (t) => {
        const f = await projectHistoricalQueryFixture(t, backend),
          before = await f.counts(),
          p = f.commitOptions.projectHistoricalQueryPublication!;
        await assert.rejects(
          f.first.store.commitExtensionTurn(await f.queryInput(), {
            ...f.commitOptions,
            projectHistoricalQueryPublication: {
              ...p,
              publication: {
                ...p.publication,
                target: {
                  ...p.publication.target,
                  implementationDigest: `sha256:${"f".repeat(64)}`,
                },
              },
            },
          }),
          /project_historical_query_source_configuration_mismatch/u,
        );
        assert.deepEqual(await f.counts(), before);
      });
      test("explicit migration required and preCOMMIT withdrawal rolls back", async (t) => {
        const f = await projectHistoricalQueryFixture(t, backend, {
            migration: false,
          }),
          input = await f.queryInput();
        await assert.rejects(
          f.first.store.commitExtensionTurn(input, f.commitOptions),
          /project_historical_query_unavailable/u,
        );
        await f.first.store.migrateProjectHistoricalQueries();
        await f.first.store.migrateProjectHistoricalQueries();
        const before = await f.counts();
        await assert.rejects(
          f.first.store.commitExtensionTurn(input, {
            ...f.commitOptions,
            projectHistoricalQueryAuthority: {
              async assertCurrent() {
                throw new Error("history-withdrawn");
              },
              assertActive() {},
            },
          }),
          /history-withdrawn/u,
        );
        assert.deepEqual(await f.counts(), before);
      });
      test("evidence views cannot substitute original operation facts", async (t) => {
        const f = await projectHistoricalQueryFixture(t, backend),
          input = await f.queryInput(),
          before = await f.counts();
        await f.sql(
          `ALTER TABLE ${f.prefix}extension_external_operations RENAME TO historical_original_operations; CREATE VIEW ${f.prefix}extension_external_operations AS SELECT * FROM ${f.prefix}historical_original_operations;`,
        );
        await assert.rejects(
          f.first.store.commitExtensionTurn(input, f.commitOptions),
          /project_historical_query_schema_incomplete/u,
        );
        assert.deepEqual(await f.counts(), before);
      });
      test("missing persisted marker refuses cold link reads and raw replay", async (t) => {
        const f = await projectHistoricalQueryFixture(t, backend),
          input = await f.queryInput(),
          accepted = await f.first.store.commitExtensionTurn(
            input,
            f.commitOptions,
          );
        const sql = `ALTER TABLE ${f.prefix}plugin_query_task_admissions RENAME COLUMN project_historical_query_digest TO removed_historical_query_digest;`;
        if (backend === "sqlite") {
          const db = new DatabaseSync(f.databasePath);
          try {
            db.exec(sql);
          } finally {
            db.close();
          }
        } else await f.sql(sql);
        await assert.rejects(
          f.first.store.loadProjectHistoricalQueryLink(accepted.binding),
          /project_historical_query_schema_incomplete/u,
        );
        const { projectHistoricalQuery, ...raw } = input;
        await assert.rejects(
          f.first.store.commitExtensionTurn(raw),
          /project_historical_query_marker_missing/u,
        );
        assert.equal(
          await f.count("creative_project_historical_query_links"),
          1,
        );
      });
      test("cleared marker cannot downgrade an actual historical query to a raw original-key replay", async (t) => {
        const f = await projectHistoricalQueryFixture(t, backend),
          input = await f.queryInput();
        await f.first.store.commitExtensionTurn(input, f.commitOptions);
        // Simulate persisted corruption in this owned fixture, restoring the original immutable guard.
        if (backend === "sqlite") {
          const db = new DatabaseSync(f.databasePath);
          try {
            const trigger = db
              .prepare(
                "SELECT sql FROM main.sqlite_schema WHERE type='trigger' AND name='plugin_query_task_no_update'",
              )
              .get()?.sql;
            assert.equal(typeof trigger, "string");
            db.exec(
              `BEGIN; DROP TRIGGER plugin_query_task_no_update; UPDATE plugin_query_task_admissions SET project_historical_query_digest=NULL; ${trigger}; COMMIT;`,
            );
          } finally {
            db.close();
          }
        } else
          await f.sql(
            `BEGIN; ALTER TABLE ${f.prefix}plugin_query_task_admissions DISABLE TRIGGER plugin_query_task_no_change; UPDATE ${f.prefix}plugin_query_task_admissions SET project_historical_query_digest=NULL; ALTER TABLE ${f.prefix}plugin_query_task_admissions ENABLE TRIGGER plugin_query_task_no_change; COMMIT;`,
          );
        const before = await f.counts(),
          { projectHistoricalQuery, ...raw } = input;
        await assert.rejects(
          f.first.store.commitExtensionTurn(raw),
          /project_historical_query_marker_missing/u,
        );
        assert.deepEqual(await f.counts(), before);
      });
    },
  );
