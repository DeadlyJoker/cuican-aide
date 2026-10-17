import assert from "node:assert/strict";
import test from "node:test";
import {
  workflowDeploymentFixture,
  deploymentWorkflowSource,
} from "./workflow-deployment.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;
pgTest(
  "real Control/SDK discovers immutable definitions without any Thread and paginates across Workflow identities after restart",
  async (t) => {
    const f = await workflowDeploymentFixture(t);
    let server = await f.control();
    assert.deepEqual(await server.client.listWorkflowVersionCatalog(), {
      data: [],
      nextCursor: null,
    });
    const base = deploymentWorkflowSource();
    for (const [workflowId, workflowVersionId] of [
      ["b-workflow", "a-version"],
      ["a-workflow", "z-version"],
      ["a-workflow", "a-version"],
    ])
      await server.client.publishWorkflowVersion({
        ...base,
        workflowId: workflowId!,
        workflowVersionId: `${workflowVersionId}-${workflowId}`,
      });
    const before = (
      await f.admin.query(`SELECT count(*)::int AS n FROM ${f.sql}.threads`)
    ).rows[0]!.n;
    assert.equal(before, 0);
    let cursor: string | null = null;
    const summaries = [];
    do {
      const page = await server.client.listWorkflowVersionCatalog({
        cursor,
        limit: 1,
      });
      summaries.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(
      summaries.map((entry) => entry.workflowId),
      ["a-workflow", "a-workflow", "b-workflow"],
    );
    assert.equal(
      summaries.some(
        (entry) =>
          "definitionJson" in entry || "tenantId" in entry || "nodes" in entry,
      ),
      false,
    );
    const result = await fetch(
      `${server.baseUrl}/api/v1/workflow-catalog?limit=20`,
      { headers: { authorization: `Bearer ${f.token}`, origin: f.origin } },
    );
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(
      (await fetch(`${server.baseUrl}/api/v1/workflow-catalog`)).status,
      401,
    );
    await assert.rejects(
      server.client.listWorkflowVersionCatalog({ cursor: "wrong", limit: 1 }),
    );
    await server.runtime.app.close();
    server = await f.control();
    assert.deepEqual(
      (await server.client.listWorkflowVersionCatalog()).data,
      summaries,
    );
    assert.equal(
      (await f.admin.query(`SELECT count(*)::int AS n FROM ${f.sql}.threads`))
        .rows[0]!.n,
      before,
    );
    const missing = await server.client.listWorkflowVersions("no-workflow");
    assert.equal(missing.data.length, 0);
  },
);
