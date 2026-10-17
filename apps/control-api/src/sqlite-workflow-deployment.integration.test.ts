import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClientError } from "@crewon/control-client";
import { sqliteWorkflowDeploymentFixture } from "./sqlite-workflow-deployment.test-support.ts";
import { deploymentWorkflowSource } from "./workflow-deployment.test-support.ts";

test("unconfigured SQLite Control exposes read-only discovery without installing execution authority or accepting runs", async (t) => {
  const f = await sqliteWorkflowDeploymentFixture(t);
  const server = await f.control(null);
  assert.deepEqual(await server.client.getWorkflowExecutionCapability(), {
    version: "v1",
    admission: false,
    snapshots: true,
    humanGates: false,
  });
  const tables = () =>
    f.database
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
  const before = tables();
  assert.deepEqual(
    await server.client.listWorkflowRuns({
      workflowVersionId: "not-published",
    }),
    { data: [], nextCursor: null },
  );
  assert.deepEqual(tables(), before);
  const version = (
    await server.client.publishWorkflowVersion(deploymentWorkflowSource())
  ).workflowVersion;
  const thread = (
    await server.client.createThread(
      { title: "Unconfigured" },
      "ordinary-thread",
    )
  ).thread;
  await assert.rejects(
    server.client.startWorkflowRun(
      {
        threadId: thread.threadId,
        workflowVersionId: version.workflowVersionId,
        input: { topic: "safe" },
      },
      "must-not-admit",
    ),
    (error: unknown) =>
      error instanceof ControlApiClientError && error.status === 503,
  );
  assert.equal(
    f.database
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('workflow_executions','workflow_deployment_identity','workflow_run_admissions')",
      )
      .get()!.n,
    0,
  );
  assert.deepEqual(f.requests, []);
});
