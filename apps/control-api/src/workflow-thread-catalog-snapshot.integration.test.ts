import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentVersionAsset } from "@crewon/agent-version";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import { sqliteWorkflowDeploymentFixture } from "./sqlite-workflow-deployment.test-support.ts";
import { workflowDeploymentFixture } from "./workflow-deployment.test-support.ts";
import { createThreadCommitFixture } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import {
  readSqliteOrdinaryThreadList,
  readPostgresOrdinaryThreadList,
} from "../../../packages/store/src/ordinary-thread-list-snapshot.ts";

const query = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  before: null,
  limit: 100,
};

test("SQLite ownership discovery and rows remain in one snapshot during actual first Workflow installation and Thread publication", async (t) => {
  const f = await sqliteWorkflowDeploymentFixture(t);
  await f.store.commitThread(createThreadCommitFixture({ threadId: "before" }));
  const prepare = f.database.prepare.bind(f.database);
  const digester = new NodeSha256ContentDigester();
  let pending: Promise<unknown> | undefined;
  let published = false;
  t.mock.method(f.database, "prepare", (sql: string) => {
    if (!published && sql.includes("FROM threads WHERE")) {
      published = true;
      f.store.workflowDeployment(
        f.workflow,
        (asset) => parseAgentVersionAsset(asset, digester),
        digester,
      );
      pending = f.store.commitThread(
        createThreadCommitFixture({ threadId: "after" }),
      );
    }
    return prepare(sql);
  });
  const captured = readSqliteOrdinaryThreadList(f.database, query);
  await pending;
  assert.equal(published, true);
  assert.deepEqual(
    captured.map((row) => row.thread_id),
    ["before"],
  );
  assert.deepEqual(
    readSqliteOrdinaryThreadList(f.database, query)
      .map((row) => row.thread_id)
      .sort(),
    ["after", "before"],
  );
  assert.deepEqual(f.requests, []);
});

const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;
pgTest(
  "PostgreSQL ownership discovery and rows remain in one snapshot during actual first Workflow installation and Thread publication",
  async (t) => {
    const f = await workflowDeploymentFixture(t);
    await f.store.commitThread(
      createThreadCommitFixture({ threadId: "before" }),
    );
    const client = await f.admin.connect();
    const execute = client.query.bind(client);
    const digester = new NodeSha256ContentDigester();
    let published = false;
    const interception = t.mock.method(client, "query", (async (
      sql: string,
      values?: unknown[],
    ) => {
      if (!published && sql.includes(`FROM "${f.schema}"."threads" WHERE`)) {
        published = true;
        await f.store
          .workflowDeployment(
            f.workflow,
            (asset) => parseAgentVersionAsset(asset, digester),
            digester,
          )
          .migrate();
        await f.store.commitThread(
          createThreadCommitFixture({ threadId: "after" }),
        );
      }
      return execute(sql, values);
    }) as typeof client.query);
    try {
      const captured = await readPostgresOrdinaryThreadList(
        client,
        f.schema,
        query,
      );
      assert.equal(published, true);
      assert.deepEqual(
        captured.map((row) => row.thread_id),
        ["before"],
      );
      assert.deepEqual(
        (await readPostgresOrdinaryThreadList(client, f.schema, query))
          .map((row) => row.thread_id)
          .sort(),
        ["after", "before"],
      );
      assert.deepEqual(f.requests, []);
    } finally {
      interception.mock.restore();
      client.release();
    }
  },
);

pgTest(
  "PostgreSQL lost BEGIN response rolls back its read-only transaction before returning the directory connection",
  async (t) => {
    const f = await workflowDeploymentFixture(t);
    const client = await f.admin.connect();
    const execute = client.query.bind(client);
    let lost = false;
    const interception = t.mock.method(client, "query", (async (
      sql: string,
      values?: unknown[],
    ) => {
      if (!lost && sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") {
        lost = true;
        await execute(sql);
        throw Error("fixture lost BEGIN response");
      }
      return execute(sql, values);
    }) as typeof client.query);
    try {
      await assert.rejects(
        readPostgresOrdinaryThreadList(client, f.schema, query),
        /fixture lost BEGIN response/,
      );
      assert.equal(
        (await client.query("SHOW transaction_read_only")).rows[0]
          .transaction_read_only,
        "off",
      );
      assert.equal(
        (await client.query("SHOW transaction_isolation")).rows[0]
          .transaction_isolation,
        "read committed",
      );
    } finally {
      interception.mock.restore();
      client.release();
    }
  },
);
