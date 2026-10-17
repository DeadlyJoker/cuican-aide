import assert from "node:assert/strict";
import test from "node:test";
import {
  workflowDeploymentFixture,
  deploymentWorkflowSource,
  waitWorkflow,
} from "./workflow-deployment.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;
pgTest(
  "real HTTP/SDK discovers each canonical Workflow root across restart, filtered pages, approval and terminal SSE",
  async (t) => {
    const f = await workflowDeploymentFixture(t);
    let server = await f.control();
    const published = await server.client.publishWorkflowVersion(
      deploymentWorkflowSource(),
    );
    const version = published.workflowVersion.workflowVersionId;
    const roots = [];
    for (let n = 0; n < 2; n++) {
      const thread = (
        await server.client.createThread(
          { title: `Root ${n}` },
          `root-thread-${n}`,
        )
      ).thread;
      roots.push(
        (
          await server.client.startWorkflowRun(
            {
              threadId: thread.threadId,
              workflowVersionId: version,
              input: { topic: "safe" },
            },
            `root-start-${n}`,
          )
        ).run,
      );
    }
    const first = await server.client.listWorkflowRuns({
      workflowVersionId: version,
      limit: 1,
    });
    assert.equal(first.data.length, 1);
    assert.ok(first.nextCursor);
    const second = await server.client.listWorkflowRuns({
      workflowVersionId: version,
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(
      new Set([first.data[0]!.runId, second.data[0]!.runId]).size,
      2,
    );
    for (const root of roots)
      assert.deepEqual(
        (
          await server.client.listWorkflowRuns({
            workflowVersionId: version,
            threadId: root.threadId,
          })
        ).data.map((item) => item.runId),
        [root.runId],
      );
    assert.equal(
      (
        await fetch(
          `${server.baseUrl}/api/v1/workflow-runs?workflowVersionId=${version}`,
        )
      ).status,
      401,
    );
    const response = await fetch(
      `${server.baseUrl}/api/v1/workflow-runs?workflowVersionId=${version}`,
      { headers: { authorization: `Bearer ${f.token}`, origin: f.origin } },
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    await server.runtime.app.close();
    server = await f.control();
    assert.equal(
      (await server.client.listWorkflowRuns({ workflowVersionId: version }))
        .data.length,
      2,
    );
    const worker = await f.worker(f.workflow, 2);
    worker.start();
    for (const root of roots)
      await waitWorkflow(
        server.client,
        root.runId,
        (view) => view.execution?.status === "waitingHuman",
      );
    // Complete the newest entry first so the older entry has the latest progress timestamp.
    const newestId = first.data[0]!.runId;
    const approvalOrder = [...roots].sort(
      (a, b) => Number(b.runId === newestId) - Number(a.runId === newestId),
    );
    for (const root of approvalOrder) {
      const parked = await waitWorkflow(
        server.client,
        root.runId,
        (view) => view.execution?.status === "waitingHuman",
      );
      const gate = parked.nodes.find((node) => node.kind === "humanGate")!;
      await server.client.reviewWorkflowHumanGate(
        {
          runId: root.runId,
          nodeId: gate.nodeId,
          gateRequestId: gate.gate!.gateRequestId,
        },
        {
          inputDigest: gate.inputDigest!,
          decision: "approved",
          comment: "checked",
        },
      );
      await waitWorkflow(
        server.client,
        root.runId,
        (view) => view.run.status === "completed",
      );
    }
    assert.equal(
      (
        await server.client.listWorkflowRuns({
          workflowVersionId: version,
          limit: 1,
        })
      ).data[0]!.runId,
      newestId,
      "progress must not move an older execution across creation-time pages",
    );
    for (const root of roots) {
      const final = await waitWorkflow(
        server.client,
        root.runId,
        (view) => view.run.status === "completed",
      );
      const tail = await fetch(
        `${server.baseUrl}/api/v1/runs/${root.runId}/events?view=transcript`,
        {
          headers: {
            "authorization": `Bearer ${f.token}`,
            "origin": f.origin,
            "last-event-id": String(final.run.lastSequence - 1),
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.match(await tail.text(), /event: run\.completed/);
    }
    const final = await server.client.listWorkflowRuns({
      workflowVersionId: version,
    });
    assert.ok(final.data.every((root) => root.status === "completed"));
    assert.equal(final.data.length, 2);
  },
);
pgTest(
  "unconfigured PostgreSQL root discovery returns empty without creating Workflow execution schemas",
  async (t) => {
    const f = await workflowDeploymentFixture(t),
      server = await f.control(null);
    const before = (
      await f.admin.query(
        "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
        [f.schema],
      )
    ).rows;
    assert.deepEqual(
      await server.client.listWorkflowRuns({
        workflowVersionId: "unknown-version",
      }),
      { data: [], nextCursor: null },
    );
    assert.deepEqual(
      (
        await f.admin.query(
          "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
          [f.schema],
        )
      ).rows,
      before,
    );
  },
);
