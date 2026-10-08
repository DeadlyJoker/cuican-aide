import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import {
  assertPostgresProjectFoundationSchema,
  assertSqliteProjectFoundationSchema,
  migratePostgresProjectFoundations,
  migrateSqliteProjectFoundations,
  projectFoundationSchemaSql,
} from "./project-foundation-schema.ts";
import { migrateSqliteCreativeProjects } from "./creative-project-schema.ts";
import {
  fixture,
  creationRecipe,
  owner,
} from "./creative-project-store.test-support.ts";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";
import { validateCreativeProject } from "@crewon/domain";

function database(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  t.after(() => db.close());
  return db;
}
function migrate(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    migrateSqliteProjectFoundations(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function catalog(db: DatabaseSync) {
  return db
    .prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name")
    .all();
}

test("foundation: absent reads do not migrate; migration requires the original project table", (t) => {
  const db = database(t);
  const before = catalog(db);
  assert.equal(assertSqliteProjectFoundationSchema(db), false);
  assert.deepEqual(catalog(db), before);
  assert.throws(() => migrate(db), /project_foundation_schema_incomplete/u);
  assert.deepEqual(catalog(db), before);
});

test("foundation: existing v0 project JSON, schema version and old read path survive the independent migration", async (t) => {
  const db = database(t);
  const store = new SqliteCreativeProjectStore({
    database: db,
    assertOpen() {},
  });
  await store.migrate();
  const created = await store.commitProjectCreation(
    creationRecipe("legacy-original"),
  );
  const before = db.prepare("SELECT * FROM creative_projects").all();
  const version = db
    .prepare("SELECT * FROM creative_project_schema_version")
    .all();
  migrate(db);
  assert.equal(assertSqliteProjectFoundationSchema(db), true);
  assert.deepEqual(db.prepare("SELECT * FROM creative_projects").all(), before);
  assert.deepEqual(
    db.prepare("SELECT * FROM creative_project_schema_version").all(),
    version,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM project_foundations").get()?.n,
    0,
  );
  assert.deepEqual(
    await store.loadProject({
      owner: owner(),
      projectId: created.project.projectId,
    }),
    created.project,
  );
  assert.deepEqual(validateCreativeProject(created.project), created.project);
  const installed = catalog(db);
  migrate(db);
  assert.deepEqual(catalog(db), installed);
});

test("foundation: an unknown independent version fails without rewriting the marker or old schema", (t) => {
  const db = database(t);
  migrateSqliteCreativeProjects(db);
  migrate(db);
  db.exec("UPDATE project_foundation_schema_version SET version=2");
  const before = catalog(db);
  assert.throws(
    () => migrate(db),
    /project_foundation_schema_version_unsupported/u,
  );
  assert.deepEqual(catalog(db), before);
  assert.equal(
    db.prepare("SELECT version FROM project_foundation_schema_version").get()
      ?.version,
    2,
  );
  assert.equal(
    db.prepare("SELECT version FROM creative_project_schema_version").get()
      ?.version,
    1,
  );
});

test("foundation: partial schema, views, missing immutability fences and index fail without repair", (t) => {
  for (const mutation of [
    "DROP TRIGGER project_proposals_no_update",
    "DROP INDEX project_source_chunk_window",
    "ALTER TABLE project_sources RENAME TO actual_sources; CREATE VIEW project_sources AS SELECT * FROM actual_sources",
    "DROP TABLE project_source_chapters",
  ]) {
    const db = database(t);
    migrateSqliteCreativeProjects(db);
    migrate(db);
    db.exec(mutation);
    const before = catalog(db);
    assert.throws(
      () => assertSqliteProjectFoundationSchema(db),
      /project_foundation_schema_incomplete/u,
    );
    assert.throws(() => migrate(db), /project_foundation_schema_incomplete/u);
    assert.deepEqual(catalog(db), before);
  }
});

test("foundation: SQL preserves original owner/scope and immutable source/proposal/receipt identity", async (t) => {
  const db = database(t);
  const store = new SqliteCreativeProjectStore({
    database: db,
    assertOpen() {},
  });
  await store.migrate();
  const created = await store.commitProjectCreation(creationRecipe("new-spec"));
  migrate(db);
  const p = created.project;
  const foundation = {
    ...p,
    schemaVersion: "crewon.project-foundation.v1",
    origin: "novel",
    revision: 1,
    parametersRevision: 1,
  };
  const insert = db.prepare(
    "INSERT INTO project_foundations VALUES(?,?,?,?,?,?,?,?)",
  );
  assert.throws(
    () =>
      insert.run(
        p.tenantId,
        p.spaceId,
        p.projectId,
        "other-owner",
        "novel",
        1,
        1,
        JSON.stringify({ ...foundation, ownerPrincipalId: "other-owner" }),
      ),
    /FOREIGN KEY/u,
  );
  insert.run(
    p.tenantId,
    p.spaceId,
    p.projectId,
    p.ownerPrincipalId,
    "novel",
    1,
    1,
    JSON.stringify(foundation),
  );
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE project_foundations SET origin='creative',record_json=?",
        )
        .run(JSON.stringify({ ...foundation, origin: "creative" })),
    /identity_immutable/u,
  );
  assert.throws(
    () => db.exec("DELETE FROM project_foundations"),
    /identity_immutable/u,
  );
  const digest = `sha256:${"a".repeat(64)}`;
  const source = {
    tenantId: p.tenantId,
    spaceId: p.spaceId,
    projectId: p.projectId,
    revision: 1,
    digest,
    fileDigest: digest,
    characterLength: 3,
  };
  db.prepare("INSERT INTO project_sources VALUES(?,?,?,?,?,?,?,?)").run(
    p.tenantId,
    p.spaceId,
    p.projectId,
    1,
    digest,
    digest,
    3,
    JSON.stringify(source),
  );
  db.prepare("INSERT INTO project_source_chunks VALUES(?,?,?,?,?,?,?,?,?)").run(
    p.tenantId,
    p.spaceId,
    p.projectId,
    1,
    0,
    0,
    3,
    "甲😀乙",
    digest,
  );
  assert.throws(
    () => db.exec("UPDATE project_sources SET character_length=4"),
    /history_immutable/u,
  );
  assert.throws(
    () => db.exec("DELETE FROM project_source_chunks"),
    /history_immutable/u,
  );
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO project_source_chunks VALUES(?,?,?,?,?,?,?,?,?)")
        .run(p.tenantId, "wrong-space", p.projectId, 1, 0, 0, 1, "甲", digest),
    /FOREIGN KEY/u,
  );
  const proposal = { ...source, contentDigest: digest };
  db.prepare("INSERT INTO project_proposals VALUES(?,?,?,?,?,?)").run(
    p.tenantId,
    p.spaceId,
    p.projectId,
    1,
    digest,
    JSON.stringify(proposal),
  );
  assert.throws(
    () => db.exec("DELETE FROM project_proposals"),
    /history_immutable/u,
  );
  db.prepare(
    "INSERT INTO project_foundation_mutation_receipts VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    p.tenantId,
    p.spaceId,
    p.ownerPrincipalId,
    "actor",
    "confirm-proposal",
    "key",
    digest,
    p.projectId,
    "{}",
  );
  assert.throws(
    () =>
      db.exec(
        "UPDATE project_foundation_mutation_receipts SET result_json='{}'",
      ),
    /history_immutable/u,
  );
});

test("foundation: PostgreSQL SQL quotes schemas and preserves the old identity/version namespace", () => {
  const sql = projectFoundationSchemaSql({
    dialect: "postgres",
    schema: "test_foundation",
  });
  assert.ok(sql.includes('REFERENCES "test_foundation".creative_projects'));
  assert.ok(sql.includes("JSONB"));
  assert.ok(!sql.includes("INSERT INTO creative_project_schema_version"));
  assert.throws(
    () =>
      projectFoundationSchemaSql({ dialect: "postgres", schema: 'bad"schema' }),
    /schema_invalid/u,
  );
});

test(
  "postgres foundation: real shared database migration preserves v0 projects and is idempotent",
  {
    skip: !process.env.CREWON_TEST_POSTGRES_URL,
  },
  async (t) => {
    const f = await fixture(t, "postgres");
    const created = await f.first.store.commitProjectCreation(
      creationRecipe("pg-legacy"),
    );
    const pool = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      max: 1,
    });
    t.after(() => pool.end());
    const client = await pool.connect();
    const schema = f.prefix.slice(1, -2);
    try {
      assert.equal(
        await assertPostgresProjectFoundationSchema(client, schema),
        false,
      );
      await client.query("BEGIN");
      await migratePostgresProjectFoundations(client, schema);
      await client.query("COMMIT");
      assert.equal(
        await assertPostgresProjectFoundationSchema(client, schema),
        true,
      );
      await migratePostgresProjectFoundations(client, schema);
      assert.deepEqual(
        await f.first.store.loadProject({
          owner: owner(),
          projectId: created.project.projectId,
        }),
        created.project,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);
