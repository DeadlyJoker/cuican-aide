import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  compileWorkflowVersion,
  serializeCompiledWorkflowVersion,
  type WorkflowVersionSource,
} from "@crewon/domain";
import { Pool } from "pg";
import {
  InMemoryWorkflowVersionStore,
  PostgresWorkflowVersionStore,
  SqliteWorkflowVersionStore,
} from "./workflow-version-store.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

for (const [name, factory] of [
  ["memory", () => new InMemoryWorkflowVersionStore(digester)],
  [
    "sqlite",
    () =>
      new SqliteWorkflowVersionStore(new DatabaseSync(":memory:"), digester),
  ],
] as const)
  registerConformance(name, factory);

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;
if (!postgresUrl)
  test.skip("Postgres WorkflowVersion conformance requires CREWON_TEST_POSTGRES_URL", () => {});
else {
  const schema = `workflow_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: postgresUrl });
  await pool.query(`CREATE SCHEMA ${schema}`);
  const store = new PostgresWorkflowVersionStore(pool, schema, digester);
  await store.migrate();
  registerConformance("postgres", () => store);
  test.after(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });
}

test("SQLite migration fails closed without replacing a newer authority", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(
    "CREATE TABLE workflow_version_schema(singleton INTEGER PRIMARY KEY, version INTEGER); INSERT INTO workflow_version_schema VALUES(1,2); CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserve')",
  );
  const before = sqliteState(database);
  assert.throws(
    () => new SqliteWorkflowVersionStore(database, digester),
    /workflow_version_schema_unsupported/,
  );
  assert.deepEqual(sqliteState(database), before);
});

test("SQLite v1 shape corruption fails closed without repair writes", () => {
  for (const workflowTable of [
    `CREATE TABLE workflow_versions (tenant_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
      workflow_version_id TEXT NOT NULL, content_digest TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, workflow_version_id)) STRICT`,
    `CREATE TABLE workflow_versions (tenant_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
      workflow_version_id TEXT NOT NULL, content_digest TEXT NOT NULL, definition_json TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(workflow_version_id)) STRICT`,
  ]) {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE workflow_version_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
      INSERT INTO workflow_version_schema VALUES(1,1); ${workflowTable}`);
    const before = sqliteMaster(database);
    assert.throws(
      () => new SqliteWorkflowVersionStore(database, digester),
      /workflow_version_schema_corrupt/,
    );
    assert.deepEqual(sqliteMaster(database), before);
  }
});

if (postgresUrl)
  test("PostgreSQL newer migration rolls back without DDL side effects", async () => {
    const schema = `workflow_newer_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl });
    try {
      await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.workflow_version_schema
      (singleton boolean PRIMARY KEY, version integer); INSERT INTO ${schema}.workflow_version_schema VALUES(true,2)`);
      const before = await postgresTables(pool, schema);
      const client = await pool.connect();
      try {
        await assert.rejects(
          import("./workflow-version-store.ts").then(
            ({ migratePostgresWorkflowVersions }) =>
              migratePostgresWorkflowVersions(client, schema),
          ),
          /workflow_version_schema_unsupported/,
        );
      } finally {
        client.release();
      }
      assert.deepEqual(await postgresTables(pool, schema), before);
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  });

if (postgresUrl)
  test("PostgreSQL v1 shape corruption fails closed without repair DDL", async () => {
    const schema = `workflow_corrupt_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl });
    try {
      await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.workflow_version_schema
        (singleton boolean PRIMARY KEY, version integer NOT NULL); INSERT INTO ${schema}.workflow_version_schema VALUES(true,1);
        CREATE TABLE ${schema}.workflow_versions (tenant_id text NOT NULL, workflow_version_id text PRIMARY KEY)`);
      const before = await postgresTables(pool, schema);
      const client = await pool.connect();
      try {
        await assert.rejects(
          import("./workflow-version-store.ts").then(
            ({ migratePostgresWorkflowVersions }) =>
              migratePostgresWorkflowVersions(client, schema),
          ),
          /workflow_version_schema_corrupt/,
        );
      } finally {
        client.release();
      }
      assert.deepEqual(await postgresTables(pool, schema), before);
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  });

test("PostgreSQL migration entry rejects unsafe schema identifiers", async () => {
  const queries: string[] = [];
  const client = {
    query: async (query: string) => {
      queries.push(query);
      return { rows: [] };
    },
  } as never;
  const { migratePostgresWorkflowVersions } = await import(
    "./workflow-version-store.ts"
  );
  await assert.rejects(
    migratePostgresWorkflowVersions(client, "public;DROP SCHEMA public"),
    /postgres_schema_invalid/,
  );
  assert.deepEqual(queries, []);
});

function registerConformance(
  name: string,
  factory: () =>
    | InMemoryWorkflowVersionStore
    | SqliteWorkflowVersionStore
    | PostgresWorkflowVersionStore,
) {
  test(`${name} keeps WorkflowVersion immutable, scoped and paginated`, async () => {
    const store = factory();
    const one = asset("tenant-1", "version-1");
    assert.equal(
      (await store.registerWorkflowVersion(one)).disposition,
      "registered",
    );
    assert.equal(
      (await store.registerWorkflowVersion(one)).disposition,
      "existing",
    );
    await assert.rejects(
      store.registerWorkflowVersion({
        ...one,
        contentDigest: `sha256:${"0".repeat(64)}`,
      }),
    );
    await store.registerWorkflowVersion(asset("tenant-1", "version-2"));
    for (const id of ["Z", "a"])
      await store.registerWorkflowVersion(asset("tenant-1", id));
    await store.registerWorkflowVersion(asset("tenant-2", "version-3"));
    assert.deepEqual(
      (
        await store.listWorkflowVersions({
          tenantId: "tenant-1",
          workflowId: "workflow-1",
          after: null,
          limit: 1,
        })
      ).map((x) => x.workflowVersionId),
      ["Z"],
    );
    assert.equal(
      await store.loadWorkflowVersion({
        tenantId: "tenant-2",
        workflowVersionId: "version-1",
      }),
      null,
    );
    assert.deepEqual(
      (
        await store.listWorkflowVersions({
          tenantId: "tenant-1",
          workflowId: "workflow-1",
          after: null,
          limit: 100,
        })
      ).map((item) => item.workflowVersionId),
      ["Z", "a", "version-1", "version-2"],
    );
    await assert.rejects(
      store.listWorkflowVersions({
        tenantId: "tenant-1",
        workflowId: "workflow-1",
        after: { workflowId: "workflow-1", workflowVersionId: "bad\0cursor" },
        limit: 1,
      }),
      /workflow_version_cursor_invalid/,
    );
  });
}

function sqliteState(database: DatabaseSync) {
  return {
    schema: database
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
      )
      .all(),
    version: database.prepare("SELECT * FROM workflow_version_schema").all(),
    sentinel: database.prepare("SELECT * FROM sentinel").all(),
  };
}
function sqliteMaster(database: DatabaseSync) {
  return database
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
    )
    .all();
}
async function postgresTables(pool: Pool, schema: string) {
  return (
    await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name",
      [schema],
    )
  ).rows;
}

function asset(tenantId: string, workflowVersionId: string) {
  const version = compileWorkflowVersion(source(workflowVersionId), digester);
  return {
    schemaVersion: "crewon.workflow-version-asset.v0" as const,
    tenantId,
    workflowId: version.workflowId,
    workflowVersionId,
    contentDigest: version.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(version),
    createdAt: "2026-08-12T00:00:00.000Z",
  };
}
function source(workflowVersionId: string): WorkflowVersionSource {
  const schema = {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: false as const,
  };
  return {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "workflow-1",
    workflowVersionId,
    name: "workflow",
    description: "workflow",
    inputSchema: schema,
    outputSchema: schema,
    entryNodeIds: ["agent"],
    outputNodeIds: ["verify"],
    nodes: [
      {
        nodeId: "agent",
        title: "agent",
        instruction: "run",
        dependsOn: [],
        inputSchema: schema,
        outputSchema: schema,
        kind: "agent",
        agentVersionId: "agent-1",
      },
      {
        nodeId: "verify",
        title: "verify",
        instruction: "verify",
        dependsOn: ["agent"],
        inputSchema: schema,
        outputSchema: schema,
        kind: "verification",
        verifierAgentVersionId: "agent-2",
      },
    ],
  };
}
