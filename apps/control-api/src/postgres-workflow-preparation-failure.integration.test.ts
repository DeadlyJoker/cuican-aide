import { assertWorkflowRootInput } from "./workflow-root-transcript.test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  workflowDeploymentFixture,
  deploymentWorkflowSource,
} from "./workflow-deployment.test-support.ts";
import { largeWorkflowOutputSchema } from "../../../packages/store/src/workflow-preparation-failure.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

for (const { contextual, cancel } of [
  { contextual: false, cancel: false },
  { contextual: true, cancel: false },
  { contextual: false, cancel: true },
])
  pgTest(
    `real HTTP/SDK ${contextual ? "approved context plus" : "plain"} prompt overflow ${cancel ? "accepts explicit cancellation" : "fails"} across restart and terminal SSE without sampling or a fabricated reply`,
    async (t) => {
      const f = await workflowDeploymentFixture(t);
      let server = await f.control();
      const base = deploymentWorkflowSource(false),
        agent = base.nodes.find((node) => node.kind === "agent")!,
        verifier = base.nodes.find((node) => node.kind === "verification")!;
      const gate = deploymentWorkflowSource().nodes.find(
        (node) => node.kind === "humanGate",
      )!;
      const outputSchema = contextual
        ? largeWorkflowOutputSchema(6, 9000)
        : largeWorkflowOutputSchema();
      const version = (
        await server.client.publishWorkflowVersion({
          ...base,
          workflowId: "preparation-overflow",
          workflowVersionId: "preparation-overflow-v1",
          entryNodeIds: [contextual ? "review" : "agent"],
          nodes: [
            ...(contextual ? [{ ...gate, dependsOn: [] }] : []),
            {
              ...agent,
              instruction: "x".repeat(9999),
              dependsOn: contextual ? ["review"] : [],
              outputSchema,
            },
            { ...verifier, inputSchema: outputSchema },
          ],
        })
      ).workflowVersion;
      const thread = (
        await server.client.createThread(
          { title: "Failed preparation" },
          "preparation-thread",
        )
      ).thread;
      await server.client.appendThreadMessage(
        thread.threadId,
        {
          expectedRevision: thread.revision,
          content: "Keep the existing root history unchanged.",
        },
        "preparation-prefix",
      );
      const locator = { tenantId: f.actor.tenantId, threadId: thread.threadId };
      const prefix = await f.store.listModelHistoryItems(locator, 0, 100);
      const root = (
        await server.client.startWorkflowRun(
          {
            threadId: thread.threadId,
            workflowVersionId: version.workflowVersionId,
            input: { topic: "safe" },
          },
          "preparation-root",
        )
      ).run;
      let worker = await f.worker(f.workflow, 1);
      const first = await worker.workers[0]!.wake();
      if (contextual) {
        assert.equal(first.kind, "workflowWaiting");
        const parked = await server.client.getWorkflowRunSnapshot(root.runId),
          node = parked.nodes.find((node) => node.kind === "humanGate")!;
        await server.client.reviewWorkflowHumanGate(
          {
            runId: root.runId,
            nodeId: node.nodeId,
            gateRequestId: node.gate!.gateRequestId,
          },
          {
            inputDigest: node.inputDigest!,
            decision: "approved",
            comment: "x".repeat(3500),
            commentContext: "descendants-v1",
          },
        );
        assert.equal((await worker.workers[0]!.wake()).kind, "retried");
      } else assert.equal(first.kind, "retried");
      const prepared = await server.client.getWorkflowRunSnapshot(root.runId),
        failedChild = prepared.nodes.find(
          (node) => node.nodeId === "agent",
        )!.child!;
      assert.equal(prepared.run.status, "running");
      assert.equal(failedChild.status, "failed");
      assert.deepEqual(f.requests, []);
      let saved = prepared;
      if (cancel) {
        await server.client.cancelRun(
          root.runId,
          { expectedRevision: prepared.run.revision },
          "cancel-rejected-preparation",
        );
        saved = await server.client.getWorkflowRunSnapshot(root.runId);
        assert.equal(saved.run.cancelRequested, true);
      }
      await worker.close();
      await server.runtime.app.close();
      server = await f.control();
      assert.deepEqual(
        await server.client.getWorkflowRunSnapshot(root.runId),
        saved,
        "read/reopen never creates a second child or advances the root",
      );
      worker = await f.worker(f.workflow, 1);
      for (let pass = 0; pass < 8; pass++)
        if ((await worker.workers[0]!.wake()).kind === "idle") break;
      const final = await server.client.getWorkflowRunSnapshot(root.runId);
      assert.equal(final.run.status, cancel ? "canceled" : "failed");
      assert.equal(
        final.nodes.find((node) => node.nodeId === "agent")!.failureCode,
        "workflow_child_prompt_limit",
      );
      assert.equal(
        final.nodes.find((node) => node.nodeId === "verify")!.status,
        "canceled",
      );
      assert.deepEqual(f.requests, []);
      const history = await f.store.listModelHistoryItems(locator, 0, 100);
      assert.deepEqual(history.slice(0, prefix.length), prefix);
      assert.equal(history.length, prefix.length + 1);
      const originalInput = history.at(-1)!;
      assert.equal(originalInput.runId, root.runId);
      if (originalInput.type !== "message")
        assert.fail("missing original input");
      assert.equal(originalInput.role, "user");
      assert.equal(originalInput.content, '{"topic":"safe"}');
      assert.deepEqual(
        await f.store.listModelHistoryItems(
          { ...locator, threadId: failedChild.threadId },
          0,
          100,
        ),
        [],
      );
      const child = (await server.client.getRun(failedChild.runId)).run;
      assert.deepEqual(child.failure, {
        code: "workflow_child_prompt_limit",
        retryable: false,
      });
      assert.equal(
        (
          await f.admin.query(
            `SELECT count(*)::int AS n FROM ${f.sql}.run_attempts WHERE run_id=$1`,
            [child.runId],
          )
        ).rows[0]!.n,
        0,
      );
      assert.equal(child.lastSequence, 2);
      assert.deepEqual(await f.store.listPendingWorkItems(100), []);
      const transcript = await server.client.getThreadTranscriptSnapshot(
        thread.threadId,
      );
      assert.equal(transcript.activeRunId, null);
      const rootInput = assertWorkflowRootInput(
        transcript,
        root.runId,
        '{"topic":"safe"}',
      );
      assert.deepEqual(
        transcript.transcriptWindow.messageWindow.data
          .filter((message) => message.messageId !== rootInput.messageId)
          .map((message) => message.content),
        ["Keep the existing root history unchanged."],
      );
      for (const run of [final.run, child]) {
        const response = await fetch(
          `${server.baseUrl}/api/v1/runs/${run.runId}/events?view=transcript`,
          {
            headers: {
              "authorization": `Bearer ${f.token}`,
              "origin": f.origin,
              "last-event-id": String(run.lastSequence - 1),
            },
            signal: AbortSignal.timeout(5000),
          },
        );
        assert.match(
          await response.text(),
          cancel && run.runId === root.runId
            ? /event: run\.canceled/
            : /event: run\.failed/,
        );
      }
      assert.equal(
        (
          await server.client.listWorkflowRuns({
            workflowVersionId: version.workflowVersionId,
          })
        ).data[0]!.status,
        cancel ? "canceled" : "failed",
      );
      assert.equal(
        (
          await f.admin.query(
            `SELECT count(*)::int AS n FROM ${f.sql}.workflow_node_children WHERE run_id=$1`,
            [root.runId],
          )
        ).rows[0]!.n,
        1,
      );
      const terminalCount = (
        await f.admin.query(
          `SELECT count(*)::int AS n FROM ${f.sql}.run_events WHERE run_id=$1 AND event_json->>'type'=ANY($2::text[])`,
          [root.runId, ["run.failed", "run.canceled"]],
        )
      ).rows[0]!.n;
      assert.equal(terminalCount, 1);
      t.diagnostic(
        JSON.stringify({
          case: "preparation-failure-http",
          contextual,
          cancel,
          rootStatus: final.run.status,
          terminalEvents: terminalCount,
          modelSamples: f.requests.length,
        }),
      );
    },
  );
