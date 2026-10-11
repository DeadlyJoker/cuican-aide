import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient } from "pg";
import { SqliteProjectTextStore } from "./project-text-sqlite-store.ts";
import { PostgresProjectTextStore } from "./project-text-postgres-store.ts";
import {
  structuredOutlineFixture,
  candidate,
  actor,
} from "./project-structured-outline.test-support.ts";
import {
  structuredOwnerInsert,
  structuredLegacySnapshot,
} from "./project-structured-outline-legacy-access.test-support.ts";
import {
  migrateSqlitePluginProjectMetadataOwners,
  migratePostgresPluginProjectMetadataOwners,
} from "./plugin-project-metadata-owner-schema.ts";

for (const method of ["revision", "page", "receipt"] as const) {
  test(`sqlite: v2 ${method} holds the original snapshot across a first owner-schema commit`, async (t) => {
    const f = await structuredOutlineFixture(t, "sqlite");
    await f.execute("PRAGMA journal_mode=WAL");
    const command = candidate(f, "snapshot-v2");
    await f.first.text.commitStructuredOutlineCandidate(command);
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
        (method === "receipt"
          ? /FROM project_text_mutation_receipts WHERE/u
          : /FROM project_text_revisions c/u
        ).test(sql)
      ) {
        inserted = true;
        // Constraint-only rows model a concurrent first cutover, not an authorized protected writer.
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
          const raw = structuredOwnerInsert(f.created.project.projectId);
          writer
            .prepare(
              `INSERT INTO plugin_project_metadata_owners(${raw.columns.join(",")}) VALUES(${raw.values.map(() => "?").join(",")})`,
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
    const result =
      method === "revision"
        ? await store.loadStructuredRevision({
            ...f.scope,
            artifactId: command.artifact.artifactId,
            contentRevision: 1,
          })
        : method === "page"
          ? await store.listStructuredRevisions({
              ...f.scope,
              artifactId: command.artifact.artifactId,
              afterContentRevision: 0,
              limit: 1,
            })
          : await store.loadStructuredMutationReceipt({
              actor,
              kind: "save-outline",
              receipt: command.receipt,
            });
    assert.equal(inserted, true);
    assert.deepEqual(
      result,
      method === "page" ? { revisions: [], nextContentRevision: null } : null,
    );
    reader.prepare = prepare;
    assert.equal(
      await store.loadStructuredRevision({
        ...f.scope,
        artifactId: command.artifact.artifactId,
        contentRevision: 1,
      }),
      null,
    );
    assert.equal(reader.isTransaction, false);
  });
}

for (const method of ["revision", "page", "receipt", "mutation"] as const) {
  test(
    `postgres: v2 ${method} observes a waiting first migration despite session-default repeatable read`,
    { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 20000 },
    async (t) => {
      const f = await structuredOutlineFixture(t, "postgres");
      const command = candidate(f, "migration-v2");
      const saved =
        await f.first.text.commitStructuredOutlineCandidate(command);
      const name = `structured_legacy_${randomUUID()}`;
      const pool = new Pool({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        application_name: name,
        max: 1,
      });
      const admin = new Pool({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        max: 2,
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
      const store = new PostgresProjectTextStore({
        pool,
        schema: f.schema,
        assertOpen() {},
      });
      await migration.query("BEGIN");
      try {
        await migratePostgresPluginProjectMetadataOwners(migration, f.schema);
        const raw = structuredOwnerInsert(f.created.project.projectId);
        await migration.query(
          `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${raw.columns.join(",")}) VALUES(${raw.values.map((_, i) => `$${i + 1}`).join(",")})`,
          raw.values,
        );
        const operation =
          method === "revision"
            ? store.loadStructuredRevision({
                ...f.scope,
                artifactId: command.artifact.artifactId,
                contentRevision: 1,
              })
            : method === "page"
              ? store.listStructuredRevisions({
                  ...f.scope,
                  artifactId: command.artifact.artifactId,
                  afterContentRevision: 0,
                  limit: 1,
                })
              : method === "receipt"
                ? store.loadStructuredMutationReceipt({
                    actor,
                    kind: "save-outline",
                    receipt: command.receipt,
                  })
                : store.commitStructuredOutlineCandidate(
                    candidate(f, "migration-fresh-v2", saved.artifact),
                  );
        const checked =
          method === "mutation"
            ? assert.rejects(operation, /creative_project_not_found/u)
            : operation.then((result) =>
                assert.deepEqual(
                  result,
                  method === "page"
                    ? { revisions: [], nextContentRevision: null }
                    : null,
                ),
              );
        let waiting = false;
        const until = Date.now() + 10000;
        while (Date.now() < until) {
          const row = (
            await admin.query(
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

for (const backend of ["sqlite", "postgres"] as const) {
  for (const mode of ["fresh", "replay"] as const) {
    test(
      `${backend}: v2 ${mode} final negative fence rolls back an owner inserted by an actual SQL hook`,
      { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
      async (t) => {
        const f = await structuredOutlineFixture(t, backend);
        const command = candidate(f, "late-v2-owner");
        if (mode === "replay")
          await f.first.text.commitStructuredOutlineCandidate(command);
        const raw = structuredOwnerInsert(f.created.project.projectId);
        let inserted = false;
        const before = await structuredLegacySnapshot(f);
        if (backend === "sqlite") {
          const db = new DatabaseSync(f.path);
          db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
          migrateSqlitePluginProjectMetadataOwners(db);
          db.exec("COMMIT");
          const prepare = db.prepare.bind(db);
          const store = new SqliteProjectTextStore({
            database: db,
            assertOpen() {},
          });
          t.after(() => db.close());
          db.prepare = ((sql: string) => {
            const statement = prepare(sql);
            if (
              (mode === "fresh"
                ? /INSERT INTO project_text_mutation_receipts/u
                : /FROM project_text_mutation_receipts WHERE/u
              ).test(sql)
            )
              return new Proxy(statement, {
                get(target, key) {
                  if (key === (mode === "fresh" ? "run" : "get"))
                    return (...values: unknown[]) => {
                      const result = Reflect.apply(
                        mode === "fresh" ? target.run : target.get,
                        target,
                        values,
                      );
                      if (!inserted) {
                        prepare(
                          `INSERT INTO plugin_project_metadata_owners(${raw.columns.join(",")}) VALUES(${raw.values.map(() => "?").join(",")})`,
                        ).run(...raw.values);
                        inserted = true;
                      }
                      return result;
                    };
                  const value: unknown = Reflect.get(target, key, target);
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                },
              });
            return statement;
          }) as DatabaseSync["prepare"];
          await assert.rejects(
            store.commitStructuredOutlineCandidate(command),
            /creative_project_not_found/u,
          );
          db.prepare = prepare;
          assert.equal(
            db
              .prepare(
                "SELECT count(*) AS n FROM plugin_project_metadata_owners",
              )
              .get()!.n,
            0,
          );
        } else {
          const pool = new Pool({
            connectionString: process.env.CREWON_TEST_POSTGRES_URL,
            max: 1,
          });
          const setup = await pool.connect();
          await setup.query("BEGIN");
          await migratePostgresPluginProjectMetadataOwners(setup, f.schema);
          await setup.query("COMMIT");
          setup.release();
          t.after(() => pool.end());
          const connect = pool.connect.bind(pool);
          pool.connect = (async () => {
            const client = await connect();
            const query = client.query.bind(client);
            client.query = (async (...args: unknown[]) => {
              const result = await Reflect.apply(query, client, args);
              const sql = String(args[0]);
              if (
                !inserted &&
                (mode === "fresh"
                  ? /INSERT INTO .*project_text_mutation_receipts/u
                  : /FROM .*project_text_mutation_receipts WHERE/u
                ).test(sql)
              ) {
                inserted = true;
                await query(
                  `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${raw.columns.join(",")}) VALUES(${raw.values.map((_, i) => `$${i + 1}`).join(",")})`,
                  raw.values,
                );
              }
              return result;
            }) as PoolClient["query"];
            return client;
          }) as Pool["connect"];
          const store = new PostgresProjectTextStore({
            pool,
            schema: f.schema,
            assertOpen() {},
          });
          await assert.rejects(
            store.commitStructuredOutlineCandidate(command),
            /creative_project_not_found/u,
          );
          pool.connect = connect;
          assert.equal(
            Number(
              (
                await pool.query(
                  `SELECT count(*) AS n FROM ${f.prefix}plugin_project_metadata_owners`,
                )
              ).rows[0].n,
            ),
            0,
          );
        }
        assert.equal(inserted, true);
        assert.deepEqual(await structuredLegacySnapshot(f), before);
      },
    );
  }
}
