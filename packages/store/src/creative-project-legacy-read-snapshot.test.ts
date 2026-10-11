import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";
import { migrateSqlitePluginProjectMetadataOwners } from "./plugin-project-metadata-owner-schema.ts";
import { readSqliteLegacyCreativeProject } from "./creative-project-sqlite-legacy-read.ts";
import {
  legacyAccessFixture,
  constraintOwnerInsert,
} from "./creative-project-legacy-access.test-support.ts";
import {
  actor,
  conceptRecipe,
  creationRecipe,
  owner,
} from "./creative-project-store.test-support.ts";

const table = "plugin_project_metadata_owners";

for (const method of [
  "loadProject",
  "listProjects",
  "loadBrief",
  "listBriefs",
  "loadConceptAsset",
  "listConceptAssets",
  "loadConceptRevision",
  "listConceptRevisions",
  "loadMutationReceipt",
] as const) {
  test(`sqlite: ${method} retains one snapshot when a second WAL connection commits the first owner schema`, async (t) => {
    const f = await legacyAccessFixture(t, "sqlite");
    const database = f.database!;
    database.exec("PRAGMA journal_mode=WAL");
    const path = String(database.prepare("PRAGMA database_list").get()!.file);
    const writer = new DatabaseSync(path);
    writer.exec("PRAGMA foreign_keys=ON");
    t.after(() => writer.close());
    const store = new SqliteCreativeProjectStore({
      database: writer,
      assertOpen() {},
    });
    const recipe = creationRecipe("concurrent-protected", "concurrent-create");
    const createPromise = store.commitProjectCreation(recipe);
    const created = await createPromise;
    const concept = await store.commitConceptRevision(
      conceptRecipe(created.project, created.brief, "concurrent-concept"),
    );
    // New project/history are committed only after this reader has inspected
    // the absent sidecar. Test-only row copying does not authorize a writer.
    const tables = [
      "creative_projects",
      "creative_project_briefs",
      "creative_concept_assets",
      "creative_concept_revisions",
      "creative_project_mutation_receipts",
    ];
    const rows = tables.map((table) =>
      writer.prepare(`SELECT * FROM ${table}`).all(),
    );
    writer.exec("PRAGMA foreign_keys=OFF");
    for (const table of [...tables].reverse()) {
      const triggers = writer
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=?",
        )
        .all(table);
      for (const trigger of triggers)
        writer.exec(`DROP TRIGGER "${String(trigger.name)}"`);
      writer.exec(`DELETE FROM ${table}`);
    }
    // Restore the original schema triggers through its genuine explicit migration.
    await store.migrate();
    writer.exec("PRAGMA foreign_keys=ON");
    const prepare = database.prepare.bind(database);
    let hook = false;
    database.prepare = ((sql: string) => {
      if (
        !hook &&
        /\bFROM creative_(?:projects|project_|concept_)/u.test(sql)
      ) {
        hook = true;
        writer.exec("BEGIN IMMEDIATE");
        try {
          migrateSqlitePluginProjectMetadataOwners(writer);
          for (let i = 0; i < tables.length; i++) {
            for (const row of rows[i]!) {
              const columns = Object.keys(row);
              writer
                .prepare(
                  `INSERT INTO ${tables[i]}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
                )
                .run(...Object.values(row));
            }
          }
          const raw = constraintOwnerInsert(created.project.projectId);
          writer
            .prepare(
              `INSERT INTO ${table}(${raw.columns.join(",")}) VALUES(${raw.columns.map(() => "?").join(",")})`,
            )
            .run(...raw.values);
          writer.exec("COMMIT");
        } catch (error) {
          writer.exec("ROLLBACK");
          throw error;
        }
      }
      return prepare(sql);
    }) as DatabaseSync["prepare"];
    const scope = { owner: owner(), projectId: created.project.projectId };
    const result =
      method === "loadProject"
        ? await f.store.loadProject(scope)
        : method === "listProjects"
          ? await f.store.listProjects({
              owner: owner(),
              state: "all",
              after: null,
              limit: 1,
            })
          : method === "loadBrief"
            ? await f.store.loadBrief({ ...scope, briefRevision: 1 })
            : method === "listBriefs"
              ? await f.store.listBriefs({
                  ...scope,
                  afterBriefRevision: 0,
                  limit: 1,
                })
              : method === "loadConceptAsset"
                ? await f.store.loadConceptAsset({
                    ...scope,
                    assetId: concept.asset.assetId,
                  })
                : method === "listConceptAssets"
                  ? await f.store.listConceptAssets({
                      ...scope,
                      afterAssetId: null,
                      limit: 1,
                    })
                  : method === "loadConceptRevision"
                    ? await f.store.loadConceptRevision({
                        ...scope,
                        assetId: concept.asset.assetId,
                        assetRevision: 1,
                      })
                    : method === "listConceptRevisions"
                      ? await f.store.listConceptRevisions({
                          ...scope,
                          assetId: concept.asset.assetId,
                          afterAssetRevision: 0,
                          limit: 1,
                        })
                      : await f.store.loadMutationReceipt({
                          actor,
                          kind: "create-project",
                          receipt: recipe.receipt,
                        });
    assert.equal(hook, true);
    assert.deepEqual(
      result,
      method === "listProjects"
        ? { projects: [], next: null }
        : method.startsWith("list")
          ? []
          : null,
    );
    database.prepare = prepare;
    assert.equal(await f.store.loadProject(scope), null);
    assert.equal(
      readSqliteLegacyCreativeProject(database, () => database.isTransaction),
      true,
    );
    assert.equal(database.isTransaction, false);
    database.exec("BEGIN");
    assert.equal(
      readSqliteLegacyCreativeProject(database, () => database.isTransaction),
      true,
    );
    assert.equal(database.isTransaction, true);
    database.exec("ROLLBACK");
  });
}
