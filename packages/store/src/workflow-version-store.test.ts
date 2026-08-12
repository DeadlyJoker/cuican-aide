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
    "CREATE TABLE workflow_version_schema(singleton INTEGER PRIMARY KEY, version INTEGER); INSERT INTO workflow_version_schema VALUES(1,2)",
  );
  assert.throws(
    () => new SqliteWorkflowVersionStore(database, digester),
    /workflow_version_schema_unsupported/,
  );
  assert.equal(
    (
      database.prepare("SELECT version FROM workflow_version_schema").get() as {
        version: number;
      }
    ).version,
    2,
  );
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
      ["version-1"],
    );
    assert.equal(
      await store.loadWorkflowVersion({
        tenantId: "tenant-2",
        workflowVersionId: "version-1",
      }),
      null,
    );
  });
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
