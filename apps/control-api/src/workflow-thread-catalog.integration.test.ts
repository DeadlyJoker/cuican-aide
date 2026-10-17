import assert from "node:assert/strict";
import { createThreadCommitFixture } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import {
  ControlApiClientError,
  type ControlApiClient,
} from "@crewon/control-client";
import { workflowDeploymentIntegrationTest } from "./workflow-deployment-integration.test-support.ts";
import {
  deploymentWorkflowSource,
  waitWorkflow,
} from "./workflow-deployment.test-support.ts";

async function ordinaryIds(client: ControlApiClient) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 12; n++) {
    const page = await client.listThreads({ cursor, limit: 1 });
    ids.push(...page.data.map((thread) => thread.threadId));
    if (page.nextCursor === null) return ids;
    assert.equal(
      page.data.length,
      1,
      "hidden children must not consume a page",
    );
    cursor = page.nextCursor;
  }
  throw Error("ordinary pagination did not converge");
}

workflowDeploymentIntegrationTest(
  "Workflow children stay outside ordinary navigation across pagination, search, archive, restart and execution disable while qualified reads and main results remain available",
  async (t, fixture) => {
    const f = await fixture(t);
    let server = await f.control();
    const version = (
      await server.client.publishWorkflowVersion(deploymentWorkflowSource())
    ).workflowVersion;
    const roots = [];
    for (let n = 0; n < 2; n++) {
      const thread = (
        await server.client.createThread({ title: `Main ${n}` }, `main-${n}`)
      ).thread;
      const root = (
        await server.client.startWorkflowRun(
          {
            threadId: thread.threadId,
            workflowVersionId: version.workflowVersionId,
            input: { topic: "safe" },
          },
          `start-${n}`,
        )
      ).run;
      roots.push(root);
    }
    const worker = await f.worker();
    worker.start();
    const waiting = await Promise.all(
      roots.map((root) =>
        waitWorkflow(
          server.client,
          root.runId,
          (view) => view.execution?.status === "waitingHuman",
        ),
      ),
    );
    const children = waiting.flatMap((view) =>
      view.nodes.flatMap((node) => (node.child ? [node.child] : [])),
    );
    assert.equal(children.length, 2);
    const child = (await server.client.getThread(children[0]!.threadId)).thread;
    assert.ok(child.title);
    const childTitle = child.title;
    assert.equal(
      child.forkedFromThreadId,
      null,
      "a new Workflow child is not a historical fork",
    );
    await f.store.commitThread(
      createThreadCommitFixture({
        tenantId: "other-tenant",
        spaceId: "other-space",
        actorId: "other-actor",
        threadId: "foreign-ordinary",
      }),
    );
    assert.deepEqual(
      (
        await f.store.listThreads({
          tenantId: "other-tenant",
          spaceId: "other-space",
          before: null,
          limit: 20,
        })
      ).map((thread) => thread.threadId),
      ["foreign-ordinary"],
      "ordinary ownership stays within the requested tenant",
    );
    await assert.rejects(
      server.client.getThread("foreign-ordinary"),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 404,
    );
    const ordinary = (
      await server.client.createThread(
        { title: childTitle },
        "same-title-ordinary",
      )
    ).thread;
    const expected = [
      ...roots.map((root) => root.threadId),
      ordinary.threadId,
    ].sort();
    assert.deepEqual((await ordinaryIds(server.client)).sort(), expected);
    for (const excludeForks of [false, true]) {
      const found = await server.client.getThreadCatalog({
        search: childTitle,
        excludeForks,
        limit: 1,
      });
      assert.deepEqual(
        found.data.map((thread) => thread.threadId),
        [ordinary.threadId],
        "ownership comes from authority, never title or fork heuristics",
      );
    }
    const first = await server.client.getThreadCatalog({ limit: 1 });
    assert.equal(first.data.length, 1);
    assert.ok(first.olderCursor);
    const second = await server.client.getThreadCatalog({
      limit: 1,
      cursor: first.olderCursor,
    });
    assert.equal(second.data.length, 1);
    assert.ok(second.newerCursor);
    const back = await server.client.getThreadCatalog({
      limit: 1,
      cursor: second.newerCursor,
    });
    assert.deepEqual(
      back.data.map((thread) => thread.threadId),
      first.data.map((thread) => thread.threadId),
    );
    for (const view of waiting) {
      const gate = view.nodes.find((node) => node.kind === "humanGate")!;
      await server.client.decideWorkflowHumanGate(
        {
          runId: view.run.runId,
          nodeId: gate.nodeId,
          gateRequestId: gate.gate!.gateRequestId,
        },
        { inputDigest: gate.inputDigest!, decision: "approved" },
      );
    }
    const finished = await Promise.all(
      roots.map((root) =>
        waitWorkflow(
          server.client,
          root.runId,
          (view) => view.run.status === "completed",
        ),
      ),
    );
    await worker.close();
    const allChildren = finished.flatMap((view) =>
      view.nodes.flatMap((node) => (node.child ? [node.child] : [])),
    );
    assert.equal(allChildren.length, 4);
    for (const item of allChildren) {
      const detail = (await server.client.getThread(item.threadId)).thread;
      assert.equal(detail.forkedFromThreadId, null);
      assert.equal(
        (
          await server.client.getThreadTranscriptSnapshot(item.threadId)
        ).transcriptWindow.messageWindow.data.filter(
          (message) => message.role === "assistant",
        ).length,
        1,
      );
    }
    const archived = (await server.client.getThread(child.threadId)).thread;
    await server.client.archiveThread(
      archived.threadId,
      { expectedRevision: archived.revision },
      "archive-child",
    );
    assert.deepEqual(
      (
        await server.client.getThreadCatalog({
          status: "archived",
          search: childTitle,
        })
      ).data,
      [],
    );
    // A broken scheduler wake must not break ordinary navigation or reclassify children.
    if ("database" in f)
      f.database.exec("DROP TRIGGER workflow_child_terminal_wake");
    else
      await f.admin.query(
        `ALTER TABLE ${f.sql}.run_snapshots DISABLE TRIGGER workflow_child_terminal_wake`,
      );
    await server.runtime.app.close();
    server = await f.control(null);
    assert.equal(
      (await server.client.getThread(child.threadId)).thread.status,
      "archived",
    );
    assert.equal(
      (
        await server.client.getThreadTranscriptSnapshot(child.threadId)
      ).transcriptWindow.messageWindow.data.filter(
        (message) => message.role === "assistant",
      ).length,
      1,
    );
    assert.deepEqual((await ordinaryIds(server.client)).sort(), expected);
    assert.deepEqual(
      (
        await server.client.listWorkflowRuns({
          workflowVersionId: version.workflowVersionId,
        })
      ).data
        .map((run) => run.runId)
        .sort(),
      roots.map((root) => root.runId).sort(),
    );
    for (const root of roots) {
      const transcript = await server.client.getThreadTranscriptSnapshot(
        root.threadId,
      );
      assert.equal(transcript.activeRunId, null);
      assert.deepEqual(
        transcript.transcriptWindow.messageWindow.data.map(
          (message) => message.role,
        ),
        ["user", "assistant"],
      );
    }
    t.diagnostic(
      JSON.stringify({
        roots: 2,
        children: 4,
        ordinary: 3,
        modelCalls: f.requests.length,
        executionDisabledAfterRestart: true,
      }),
    );
    assert.equal(f.requests.length, 4);
  },
);
