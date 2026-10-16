import assert from "node:assert/strict";
import test from "node:test";
import { workflowVerificationInstructionV1 } from "@crewon/domain";
import {
  workflowDeploymentFixture,
  deploymentWorkflowSource,
  waitWorkflow,
} from "./workflow-deployment.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

for (const scenario of [
  { text: "VERDICT: PASS", failure: null },
  { text: "VERDICT: FAIL", failure: "control_workflow_verification_failed" },
  {
    text: "VERDICT: PASS\nVERDICT: FAIL",
    failure: "control_workflow_verification_invalid",
  },
])
  pgTest(
    `real PostgreSQL factories honor the UI verification text contract: ${JSON.stringify(scenario.text)}`,
    async (t) => {
      const f = await workflowDeploymentFixture(t, {
        output: (request) =>
          JSON.stringify({
            result: JSON.stringify(request).includes("workflow-verifier-role")
              ? scenario.text
              : "Prepared evidence",
          }),
      });
      let server = await f.control();
      const source = deploymentWorkflowSource(false);
      const resultSchema = {
        type: "object" as const,
        properties: {
          result: { type: "string" as const, maxLength: 9999, enum: null },
        },
        required: ["result"],
        additionalProperties: false as const,
      };
      const version = await server.client.publishWorkflowVersion({
        ...source,
        outputSchema: resultSchema,
        nodes: source.nodes.map((node) =>
          node.kind === "verification"
            ? {
                ...node,
                instruction:
                  workflowVerificationInstructionV1("Verify evidence"),
                inputSchema: resultSchema,
                outputSchema: resultSchema,
              }
            : { ...node, outputSchema: resultSchema },
        ),
      });
      const thread = (
        await server.client.createThread(
          { title: "Verifier contract" },
          "thread",
        )
      ).thread;
      const created = await server.client.startWorkflowRun(
        {
          threadId: thread.threadId,
          workflowVersionId: version.workflowVersion.workflowVersionId,
          input: { topic: "safe" },
        },
        "start",
      );
      const worker = await f.worker();
      worker.start();
      const final = await waitWorkflow(
        server.client,
        created.run.runId,
        (snapshot) => ["completed", "failed"].includes(snapshot.run.status),
      );
      assert.equal(
        final.run.status,
        scenario.failure === null ? "completed" : "failed",
      );
      const verifier = final.nodes.find(
        (node) => node.kind === "verification",
      )!;
      assert.equal(verifier.failureCode, scenario.failure);
      assert.equal(
        verifier.status,
        scenario.failure === null ? "completed" : "failed",
      );
      if (scenario.failure !== null) assert.equal(verifier.output, null);
      assert.equal(
        verifier.child!.status,
        "completed",
        "model completion alone is not a passing verification",
      );
      const evidence = await server.client.getThreadTranscriptSnapshot(
        verifier.child!.threadId,
      );
      assert.equal(
        evidence.transcriptWindow.messageWindow.data
          .filter((message) => message.role === "assistant")
          .at(-1)!.content,
        JSON.stringify({ result: scenario.text }),
      );
      assert.deepEqual(f.requests, ["agent", "verifier"]);
      const stream = await fetch(
        `${server.baseUrl}/api/v1/runs/${created.run.runId}/events?view=transcript`,
        {
          headers: {
            "authorization": `Bearer ${f.token}`,
            "origin": f.origin,
            "last-event-id": String(final.run.lastSequence - 1),
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      const events = await stream.text();
      assert.match(
        events,
        scenario.failure === null
          ? /event: run\.completed/
          : /event: run\.failed/,
      );
      if (scenario.failure !== null)
        assert.doesNotMatch(events, /event: message\.completed/);
      const transcript = await server.client.getThreadTranscriptSnapshot(
        thread.threadId,
      );
      assert.equal(
        transcript.transcriptWindow.messageWindow.data.filter(
          (message) => message.role === "assistant",
        ).length,
        scenario.failure === null ? 1 : 0,
      );
      await worker.close();
      await server.runtime.app.close();
      server = await f.control();
      assert.deepEqual(
        await server.client.getWorkflowRunSnapshot(created.run.runId),
        final,
      );
      assert.deepEqual(f.requests, ["agent", "verifier"]);
    },
  );
