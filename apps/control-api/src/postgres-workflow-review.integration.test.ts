import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import {
  workflowDeploymentFixture,
  deploymentWorkflowSource,
  waitWorkflow,
} from "./workflow-deployment.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;
function httpStatus(status: number) {
  return (error: unknown) =>
    error instanceof ControlApiClientError && error.status === status;
}
for (const commentContext of [undefined, "descendants-v1"] as const)
  for (const decision of ["approved", "rejected"] as const)
    pgTest(
      `real Control/SDK/Worker ${commentContext ?? "metadata"} ${decision} review survives lost response and restart, resumes once and reconnects terminal SSE`,
      async (t) => {
        const modelRequests: string[] = [];
        const f = await workflowDeploymentFixture(t, {
          output(request) {
            modelRequests.push(JSON.stringify(request));
            return JSON.stringify(request).includes("审核原文")
              ? '{"topic":"reviewed"}'
              : '{"topic":"verified"}';
          },
        });
        let server = await f.control();
        assert.deepEqual(await server.client.getWorkflowReviewCapability(), {
          version: "v1",
          available: true,
        });
        assert.deepEqual(
          await server.client.getWorkflowReviewContextCapability(),
          { version: "v1", available: true },
        );
        const published = await server.client.publishWorkflowVersion(
          deploymentWorkflowSource(),
        );
        const thread = (
          await server.client.createThread(
            { title: "Durable review" },
            "review-thread",
          )
        ).thread;
        const started = await server.client.startWorkflowRun(
          {
            threadId: thread.threadId,
            workflowVersionId: published.workflowVersion.workflowVersionId,
            input: { topic: "safe" },
          },
          "review-run",
        );
        let worker = await f.worker(f.workflow, 1);
        worker.start();
        const parked = await waitWorkflow(
          server.client,
          started.run.runId,
          (value) => value.execution?.status === "waitingHuman",
        );
        await worker.close();
        const gate = parked.nodes.find((node) => node.kind === "humanGate")!;
        const locator = {
          runId: started.run.runId,
          nodeId: gate.nodeId,
          gateRequestId: gate.gate!.gateRequestId,
        };
        const pending = await server.client.getWorkflowHumanGateReview(locator);
        assert.equal(pending.review, null);
        const body = {
          inputDigest: gate.inputDigest!,
          decision,
          comment: "  审核原文\n不能替换冻结输入 😀  ",
          ...(commentContext ? { commentContext } : {}),
        };
        const url = `${server.baseUrl}/api/v1/workflow-runs/${locator.runId}/nodes/${locator.nodeId}/gates/${locator.gateRequestId}/review-v1`;
        const headers = {
          "authorization": `Bearer ${f.token}`,
          "origin": f.origin,
          "content-type": "application/json",
        };
        const missingCsrf = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        assert.equal(missingCsrf.status, 403);
        const wrongOrigin = await fetch(url, {
          method: "POST",
          headers: {
            ...headers,
            "origin": "https://foreign.example",
            "x-csrf-token": f.token,
          },
          body: JSON.stringify(body),
        });
        assert.equal(wrongOrigin.status, 403);
        assert.equal((await fetch(url)).status, 401);
        const malformed = await fetch(url, {
          method: "POST",
          headers: { ...headers, "x-csrf-token": f.token },
          body: JSON.stringify({ ...body, output: { topic: "changed" } }),
        });
        assert.equal(malformed.status, 400);
        assert.equal(
          (await server.client.getWorkflowHumanGateReview(locator)).review,
          null,
        );
        let attempts = 0;
        const lostResponse = new ControlApiClient({
          baseUrl: server.baseUrl,
          accessToken: f.token,
          csrfToken: f.token,
          origin: f.origin,
          fetch: async (input, init) => {
            attempts++;
            const response = await fetch(input, init);
            assert.equal(response.status, 200);
            await response.arrayBuffer();
            throw new Error(
              "fixture: committed response lost before SDK acknowledgement",
            );
          },
        });
        await assert.rejects(
          lostResponse.reviewWorkflowHumanGate(locator, body),
        );
        assert.equal(attempts, 1);
        const saved = await server.client.getWorkflowHumanGateReview(locator);
        assert.equal(saved.review!.comment, body.comment);
        assert.deepEqual(saved.input, pending.input);
        assert.deepEqual(
          await server.client.decideWorkflowHumanGate(locator, {
            inputDigest: body.inputDigest,
            decision,
          }),
          { disposition: "replayed", decision: saved.review!.decision },
        );
        await server.runtime.app.close();
        server = await f.control();
        assert.deepEqual(
          await server.client.getWorkflowHumanGateReview(locator),
          saved,
        );
        assert.deepEqual(
          await server.client.reviewWorkflowHumanGate(locator, body),
          { disposition: "replayed", review: saved.review },
        );
        await assert.rejects(
          server.client.reviewWorkflowHumanGate(locator, {
            ...body,
            comment: "changed",
          }),
          httpStatus(409),
        );
        const revoked = await f.control({ ...f.workflow, humanGates: [] });
        await assert.rejects(
          revoked.client.getWorkflowHumanGateReview(locator),
          httpStatus(403),
        );
        await assert.rejects(
          revoked.client.reviewWorkflowHumanGate(locator, body),
          httpStatus(403),
        );
        worker = await f.worker(f.workflow, 1);
        worker.start();
        const final = await waitWorkflow(
          server.client,
          started.run.runId,
          (value) =>
            value.run.status ===
            (decision === "approved" ? "completed" : "failed"),
        );
        assert.deepEqual(
          f.requests,
          decision === "approved" ? ["agent", "verifier"] : ["agent"],
        );
        assert.equal(modelRequests[0]!.includes("审核原文"), false);
        assert.equal(
          modelRequests.filter((request) => request.includes("审核原文"))
            .length,
          commentContext && decision === "approved" ? 1 : 0,
        );
        assert.deepEqual(
          (await server.client.getWorkflowHumanGateReview(locator)).review,
          saved.review,
        );
        const transcript = await server.client.getThreadTranscriptSnapshot(
          thread.threadId,
        );
        assert.equal(transcript.activeRunId, null);
        assert.equal(
          transcript.transcriptWindow.runBindings.filter(
            (binding) => binding.runId === started.run.runId,
          ).length,
          decision === "approved" ? 1 : 0,
        );
        if (decision === "approved")
          assert.equal(
            transcript.transcriptWindow.messageWindow.data.at(-1)!.content,
            commentContext ? '{"topic":"reviewed"}' : '{"topic":"verified"}',
          );
        const response = await fetch(
          `${server.baseUrl}/api/v1/runs/${started.run.runId}/events?view=transcript`,
          {
            headers: {
              "authorization": `Bearer ${f.token}`,
              "origin": f.origin,
              "last-event-id": String(final.run.lastSequence - 1),
            },
            signal: AbortSignal.timeout(5000),
          },
        );
        assert.match(
          await response.text(),
          decision === "approved"
            ? /event: run\.completed/
            : /event: run\.failed/,
        );
      },
    );
pgTest(
  "review capability is independently unavailable on an older composition and legacy decisions cannot gain invented review text",
  async (t) => {
    const f = await workflowDeploymentFixture(t),
      old = await f.control(null);
    assert.deepEqual(await old.client.getWorkflowReviewCapability(), {
      version: "v1",
      available: false,
    });
    assert.deepEqual(await old.client.getWorkflowReviewContextCapability(), {
      version: "v1",
      available: false,
    });
    const capability = await fetch(
      `${old.baseUrl}/api/v1/capabilities/workflow-reviews-v1`,
      { headers: { authorization: `Bearer ${f.token}`, origin: f.origin } },
    );
    assert.equal(capability.headers.get("cache-control"), "no-store");
    assert.equal(
      (await fetch(`${old.baseUrl}/api/v1/capabilities/workflow-reviews-v1`))
        .status,
      401,
    );
    await assert.rejects(
      old.client.getWorkflowHumanGateReview({
        runId: "run",
        nodeId: "node",
        gateRequestId: "gate",
      }),
      httpStatus(503),
    );
    const server = await f.control(),
      worker = await f.worker(f.workflow, 1);
    const published = await server.client.publishWorkflowVersion(
      deploymentWorkflowSource(),
    );
    const thread = (
      await server.client.createThread(
        { title: "Legacy approval" },
        "legacy-thread",
      )
    ).thread;
    const started = await server.client.startWorkflowRun(
      {
        threadId: thread.threadId,
        workflowVersionId: published.workflowVersion.workflowVersionId,
        input: { topic: "safe" },
      },
      "legacy-run",
    );
    worker.start();
    const parked = await waitWorkflow(
      server.client,
      started.run.runId,
      (view) => view.execution?.status === "waitingHuman",
    );
    await worker.close();
    const gate = parked.nodes.find((node) => node.kind === "humanGate")!;
    const locator = {
      runId: started.run.runId,
      nodeId: gate.nodeId,
      gateRequestId: gate.gate!.gateRequestId,
    };
    const body = {
      inputDigest: gate.inputDigest!,
      decision: "approved" as const,
    };
    const legacy = await server.client.decideWorkflowHumanGate(locator, body);
    await assert.rejects(
      server.client.getWorkflowHumanGateReview(locator),
      httpStatus(409),
    );
    await assert.rejects(
      server.client.reviewWorkflowHumanGate(locator, {
        ...body,
        comment: null,
      }),
      httpStatus(409),
    );
    assert.deepEqual(
      (await server.client.getWorkflowHumanGate(locator)).decision,
      legacy.decision,
    );
  },
);
