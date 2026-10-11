import {
  CreativeProjectApplicationService,
  ProjectTextApplicationService,
} from "@crewon/application";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";
import { projectRunCommitFixture } from "./creative-project-run-commit.test-support.ts";
import { unmeteredFixture } from "./plugin-task-unmetered.test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { SqliteProjectTextStore } from "./project-text-sqlite-store.ts";
import { PostgresProjectTextStore } from "./project-text-postgres-store.ts";
import {
  projectTextFixture,
  textActor,
  textOwner,
} from "./project-text-store.test-support.ts";
import {
  legacyOutlineRecipe,
  legacyScriptRecipe,
  textOwnerInsert,
} from "./project-text-legacy-access.test-support.ts";
import {
  migrateSqlitePluginProjectMetadataOwners,
  migratePostgresPluginProjectMetadataOwners,
} from "./plugin-project-metadata-owner-schema.ts";

for (const method of [
  "loadOutline",
  "loadScript",
  "loadArtifact",
  "loadRevision",
  "loadOutlineSourceRevision",
  "listArtifacts",
  "listRevisions",
] as const) {
  test(`sqlite: text v1 ${method} keeps one snapshot across the first owner-schema commit on another WAL connection`, async (t) => {
    const f = await projectTextFixture(t, "sqlite");
    await f.execute("PRAGMA journal_mode=WAL");
    const saved = await f.first.text.commitCandidate(
      legacyOutlineRecipe(f, "snapshot-outline"),
    );
    await f.first.text.commitCandidate(
      legacyScriptRecipe(f, "snapshot-script"),
    );
    const reader = new DatabaseSync(f.path),
      writer = new DatabaseSync(f.path);
    t.after(() => {
      reader.close();
      writer.close();
    });
    writer.exec("PRAGMA foreign_keys=ON");
    const store = new SqliteProjectTextStore({
      database: reader,
      assertOpen() {},
    });
    const tables = [
      "project_text_artifacts",
      "project_text_revisions",
      "project_text_mutation_receipts",
    ];
    const rows = tables.map((table) =>
      writer.prepare(`SELECT * FROM ${table}`).all(),
    );
    for (const table of [...tables].reverse()) {
      for (const trigger of writer
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=?",
        )
        .all(table))
        writer.exec(`DROP TRIGGER "${String(trigger.name)}"`);
      writer.exec(`DELETE FROM ${table}`);
    }
    await store.migrate();
    const prepare = reader.prepare.bind(reader);
    let inserted = false;
    reader.prepare = ((sql: string) => {
      if (
        !inserted &&
        /\bFROM project_text_(?:artifacts|revisions) c\b/u.test(sql)
      ) {
        inserted = true;
        // Raw rows only model a concurrent cutover; this fixture does not issue ownership or a writer qualification.
        writer.exec("BEGIN IMMEDIATE");
        try {
          migrateSqlitePluginProjectMetadataOwners(writer);
          for (let i = 0; i < tables.length; i++)
            for (const row of rows[i]!) {
              const columns = Object.keys(row);
              writer
                .prepare(
                  `INSERT INTO ${tables[i]}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
                )
                .run(...Object.values(row));
            }
          const owner = textOwnerInsert(f.created.project.projectId);
          writer
            .prepare(
              `INSERT INTO plugin_project_metadata_owners(${owner.columns.join(",")}) VALUES(${owner.values.map(() => "?").join(",")})`,
            )
            .run(...owner.values);
          writer.exec("COMMIT");
        } catch (error) {
          writer.exec("ROLLBACK");
          throw error;
        }
      }
      return prepare(sql);
    }) as DatabaseSync["prepare"];
    const q = { owner: textOwner(), projectId: f.created.project.projectId };
    const revision = {
      ...q,
      artifactId: saved.artifact.artifactId,
      contentRevision: 1,
    };
    const result =
      method === "loadOutline"
        ? await store.loadOutline(q)
        : method === "loadScript"
          ? await store.loadScript({ ...q, episodeId: "episode-1" })
          : method === "loadArtifact"
            ? await store.loadArtifact({
                ...q,
                artifactId: saved.artifact.artifactId,
              })
            : method === "loadRevision"
              ? await store.loadRevision(revision)
              : method === "loadOutlineSourceRevision"
                ? await store.loadOutlineSourceRevision(revision)
                : method === "listArtifacts"
                  ? await store.listArtifacts({
                      ...q,
                      afterArtifactId: null,
                      limit: 1,
                    })
                  : await store.listRevisions({
                      ...q,
                      artifactId: saved.artifact.artifactId,
                      afterContentRevision: 0,
                      limit: 1,
                    });
    assert.equal(inserted, true);
    assert.deepEqual(
      result,
      method === "listArtifacts"
        ? { artifacts: [], nextArtifactId: null }
        : method === "listRevisions"
          ? { revisions: [], nextContentRevision: null }
          : null,
    );
    reader.prepare = prepare;
    assert.equal(await store.loadOutline(q), null);
    assert.equal(reader.isTransaction, false);
  });
}

for (const method of ["read", "mutation", "receipt"] as const) {
  test(
    `postgres: text v1 ${method} uses explicit READ COMMITTED after a waiting first migration despite session-default RR`,
    { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 20000 },
    async (t) => {
      const f = await projectTextFixture(t, "postgres");
      const recipe = legacyOutlineRecipe(f, "migration-outline");
      const saved = await f.first.text.commitCandidate(recipe);
      const fresh = legacyOutlineRecipe(f, "migration-fresh", saved.artifact);
      const name = `text_legacy_${randomUUID()}`;
      const pool = new Pool({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        application_name: name,
        max: 1,
      });
      const admin = new Pool({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        max: 1,
      });
      const migration = await admin.connect();
      t.after(async () => {
        migration.release();
        await pool.end();
        await admin.end();
      });
      await pool.query(
        "SET default_transaction_isolation TO 'repeatable read'",
      );
      assert.equal(
        (await pool.query("SHOW default_transaction_isolation")).rows[0]
          ?.default_transaction_isolation,
        "repeatable read",
      );
      const store = new PostgresProjectTextStore({
        pool,
        schema: f.schema,
        assertOpen() {},
      });
      await migration.query("BEGIN");
      try {
        await migratePostgresPluginProjectMetadataOwners(migration, f.schema);
        const owner = textOwnerInsert(f.created.project.projectId);
        await migration.query(
          `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${owner.columns.join(",")}) VALUES(${owner.values.map((_, i) => `$${i + 1}`).join(",")})`,
          owner.values,
        );
        const operation =
          method === "read"
            ? store.loadOutline({
                owner: textOwner(),
                projectId: f.created.project.projectId,
              })
            : method === "receipt"
              ? store.loadMutationReceipt({
                  actor: textActor,
                  kind: "save-outline",
                  receipt: recipe.receipt,
                })
              : store.commitCandidate(fresh);
        // Register the rejection handler while the actual lock waiter is still blocked.
        const checked =
          method === "mutation"
            ? assert.rejects(operation, /creative_project_not_found/u)
            : operation.then((result) => assert.equal(result, null));
        let waiting = false;
        const watch = new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          max: 1,
        });
        try {
          const until = Date.now() + 10000;
          while (Date.now() < until) {
            const row = (
              await watch.query(
                "SELECT wait_event_type,query FROM pg_stat_activity WHERE application_name=$1",
                [name],
              )
            ).rows[0];
            if (
              row?.wait_event_type === "Lock" &&
              /pg_advisory_xact_lock_shared/u.test(String(row.query))
            ) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        } finally {
          await watch.end();
        }
        assert.equal(waiting, true);
        await migration.query("COMMIT");
        await checked;
        assert.equal(await f.count("project_text_revisions"), 1);
        assert.equal(await f.count("project_text_mutation_receipts"), 1);
      } catch (error) {
        await migration.query("ROLLBACK");
        throw error;
      }
    },
  );
}

for (const target of ["text", "metadata"] as const) {
  test(
    `sqlite: ${target} original physical Run lease expiring during the final negative/downstream SQL rolls back all records`,
    { timeout: 15000 },
    async (t) => {
      const base = await unmeteredFixture(t, "sqlite");
      // The original public queue writer issues a genuine short lease; no clock or stored expiry is forged.
      const claimNext = base.first.parent.claimNextWorkItem.bind(
        base.first.parent,
      );
      base.first.parent.claimNextWorkItem = (input) =>
        claimNext({ ...input, leaseDurationMs: 2000 });
      const f = await projectRunCommitFixture(t, "sqlite", undefined, base);
      const db = f.db!;
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      try {
        migrateSqlitePluginProjectMetadataOwners(db);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const operation = await f.prepareOperation(
        target === "text" ? "outline_save" : "project_create",
        target === "text"
          ? {
              projectId: f.reference.projectId,
              expectedArtifactRevision: 0,
              briefRevision: 1,
              content: {
                title: "雨夜",
                logline: "旧信",
                synopsis: "修复师收到旧信",
                episodes: [
                  {
                    episodeId: "episode-1",
                    title: "来信",
                    summary: "发现旧信",
                  },
                ],
              },
            }
          : { title: "新项目", briefText: "创建一个新的普通项目" },
      );
      const context = {
        authorization: {
          authorize: async () => ({ outcome: "allow" as const }),
        },
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => randomUUID() },
        digester: f.digester,
      };
      const service =
        target === "text"
          ? new ProjectTextApplicationService({
              ...context,
              store: new SqliteProjectTextStore({
                database: db,
                assertOpen() {},
              }),
              projects: f.metadata,
            })
          : new CreativeProjectApplicationService({
              ...context,
              store: new SqliteCreativeProjectStore({
                database: db,
                assertOpen() {},
              }),
            });
      const before = await f.counts();
      const prepare = db.prepare.bind(db);
      let inserted = false,
        expiredInFinalSql = false;
      db.prepare = ((sql: string) => {
        if (
          inserted &&
          !expiredInFinalSql &&
          (target === "text"
            ? /FROM creative_projects p/u.test(sql)
            : /PRAGMA foreign_key_check\(plugin_project_metadata_owners\)/u.test(
                sql,
              ))
        ) {
          assert.ok(
            Date.now() < Date.parse(f.claim.lease.expiresAt),
            "original lease remains live before the final new SQL",
          );
          const pause = Math.max(
            1,
            Date.parse(f.claim.lease.expiresAt) - Date.now() + 10,
          );
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
          assert.ok(Date.now() >= Date.parse(f.claim.lease.expiresAt));
          expiredInFinalSql = true;
        }
        const statement = prepare(sql);
        if (
          /INSERT INTO (?:project_text|creative_project)_mutation_receipts/u.test(
            sql,
          )
        ) {
          return new Proxy(statement, {
            get(target, key) {
              if (key === "run")
                return (...values: unknown[]) => {
                  const result = Reflect.apply(target.run, target, values);
                  inserted = true;
                  return result;
                };
              const value: unknown = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }
        return statement;
      }) as DatabaseSync["prepare"];
      t.after(() => {
        db.prepare = prepare;
      });
      const pending =
        target === "text"
          ? (service as ProjectTextApplicationService).saveOutlineCandidate(
              f.actor,
              operation.commandBody as never,
              operation.options,
            )
          : (service as CreativeProjectApplicationService).createProject(
              f.actor,
              operation.commandBody as never,
              operation.options,
            );
      await assert.rejects(pending, (error) =>
        hasCause(error, "creative_project_run_commit_not_current"),
      );
      assert.equal(inserted, true);
      assert.equal(expiredInFinalSql, true);
      db.prepare = prepare;
      assert.deepEqual(await f.counts(), before);
    },
  );
}
function hasCause(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    (error.message === code || hasCause(error.cause, code))
  );
}
