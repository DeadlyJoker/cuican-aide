import assert from "node:assert/strict";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiTransportError,
} from "@crewon/control-client";
import { WORKFLOW_RECOVERY_CONTEXT_HEADER } from "@crewon/contracts";
import { createWebBff } from "../../web-bff/src/web-bff.ts";
import {
  deploymentWorkflowSource,
  waitWorkflow,
} from "./workflow-deployment.test-support.ts";
import { workflowDeploymentIntegrationTest } from "./workflow-deployment-integration.test-support.ts";
const changed = (code: string) => (error: unknown) =>
  error instanceof ControlApiClientError &&
  error.status === 409 &&
  error.code === code;
workflowDeploymentIntegrationTest(
  "real guarded Workflow restores the original unknown POST after restart, rejects a changed deployment, and replays one contextual Gate review before one final reply",
  async (t, fixture) => {
    const f = await fixture(t);
    let server = await f.control();
    const initial = await server.client.getWorkflowRecoveryContext();
    assert.equal(initial.version, "v1");
    assert.ok(initial.contextId);
    const headers = { authorization: `Bearer ${f.token}`, origin: f.origin };
    const response = await fetch(
      `${server.baseUrl}/api/v1/capabilities/workflow-recovery-context-v1`,
      { headers },
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      (
        await fetch(
          `${server.baseUrl}/api/v1/capabilities/workflow-recovery-context-v1`,
        )
      ).status,
      401,
    );
    const version = (
      await server.client.publishWorkflowVersion(deploymentWorkflowSource())
    ).workflowVersion;
    const thread = (
      await server.client.createThread(
        { title: "Original intent" },
        "original-thread-key",
      )
    ).thread;
    const body = {
      threadId: thread.threadId,
      workflowVersionId: version.workflowVersionId,
      input: { topic: "safe" },
    };
    const options = { workflowRecoveryContext: initial.contextId };
    const loseReply = (baseUrl: string, suffix: string) =>
      new ControlApiClient({
        baseUrl,
        accessToken: f.token,
        csrfToken: f.token,
        origin: f.origin,
        fetch: async (url, init) => {
          const result = await fetch(url, init);
          if (
            init?.method === "POST" &&
            new URL(String(url)).pathname.endsWith(suffix) &&
            result.ok
          ) {
            await result.arrayBuffer();
            throw Error("fixture response lost after commit");
          }
          return result;
        },
      });
    await assert.rejects(
      loseReply(server.baseUrl, "/workflow-runs:admit-v1").startWorkflowRun(
        body,
        "original-start-key",
        options,
      ),
      ControlApiTransportError,
    );
    const admitted = (
      await server.client.listWorkflowRuns({
        workflowVersionId: version.workflowVersionId,
      })
    ).data;
    assert.equal(admitted.length, 1);
    const original = admitted[0]!;
    await server.runtime.app.close();
    server = await f.control({ ...f.workflow, maximumParallelNodes: 1 });
    const newer = await server.client.getWorkflowRecoveryContext();
    assert.notEqual(newer.contextId, initial.contextId);
    await assert.rejects(
      server.client.startWorkflowRun(body, "original-start-key", options),
      changed("workflow_recovery_context_changed"),
    );
    assert.equal(
      (
        await server.client.listWorkflowRuns({
          workflowVersionId: version.workflowVersionId,
        })
      ).data.length,
      1,
    );
    assert.equal(f.requests.length, 0);
    await server.runtime.app.close();
    server = await f.control();
    assert.deepEqual(await server.client.getWorkflowRecoveryContext(), initial);
    const replay = await server.client.startWorkflowRun(
      body,
      "original-start-key",
      options,
    );
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.run.runId, original.runId);
    let worker = await f.worker();
    worker.start();
    const waiting = await waitWorkflow(
      server.client,
      original.runId,
      (snapshot) =>
        snapshot.nodes.some((node) => node.status === "waitingHuman"),
    );
    await worker.close();
    const node = waiting.nodes.find((node) => node.kind === "humanGate")!,
      locator = {
        runId: original.runId,
        nodeId: node.nodeId,
        gateRequestId: node.gate!.gateRequestId,
      };
    const review = {
      inputDigest: node.inputDigest!,
      decision: "approved" as const,
      comment: "Preserve the original contextual review.",
      commentContext: "descendants-v1" as const,
    };
    await assert.rejects(
      server.client.reviewWorkflowHumanGate(locator, review, {
        workflowRecoveryContext: newer.contextId!,
      }),
      changed("workflow_recovery_context_changed"),
    );
    assert.equal(
      (await server.client.getWorkflowHumanGateReview(locator)).review,
      null,
    );
    await assert.rejects(
      loseReply(server.baseUrl, "/review-guarded-v1").reviewWorkflowHumanGate(
        locator,
        review,
        options,
      ),
      ControlApiTransportError,
    );
    await server.runtime.app.close();
    server = await f.control();
    assert.deepEqual(await server.client.getWorkflowRecoveryContext(), initial);
    assert.equal(
      (await server.client.reviewWorkflowHumanGate(locator, review, options))
        .disposition,
      "replayed",
    );
    worker = await f.worker();
    worker.start();
    const completed = await waitWorkflow(
      server.client,
      original.runId,
      (snapshot) => snapshot.run.status === "completed",
    );
    await worker.close();
    assert.equal(completed.run.runId, original.runId);
    assert.deepEqual(f.requests, ["agent", "verifier"]);
    const transcript = await server.client.getThreadTranscriptSnapshot(
      thread.threadId,
    );
    assert.equal(transcript.activeRunId, null);
    assert.equal(
      transcript.transcriptWindow.messageWindow.data.filter(
        (message) => message.role === "assistant",
      ).length,
      1,
    );
    const stream = await fetch(
      `${server.baseUrl}/api/v1/runs/${original.runId}/events?view=transcript`,
      {
        headers: {
          ...headers,
          "last-event-id": String(completed.run.lastSequence - 1),
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.match(await stream.text(), /event: run.completed/);
    t.diagnostic(
      JSON.stringify({
        case: "guarded-workflow-unknown-recovery",
        roots: 1,
        models: f.requests,
        assistantReplies: 1,
        originalContextRestored: true,
      }),
    );
  },
);
workflowDeploymentIntegrationTest(
  "real cancellation rejects a stale or unavailable guard before requesting cancellation and retains legacy omission",
  async (t, fixture) => {
    const f = await fixture(t);
    let server = await f.control();
    const context = (await server.client.getWorkflowRecoveryContext())
      .contextId!;
    const version = (
      await server.client.publishWorkflowVersion(deploymentWorkflowSource())
    ).workflowVersion;
    const thread = (
      await server.client.createThread(
        { title: "Cancel context" },
        "cancel-thread",
      )
    ).thread;
    const root = (
      await server.client.startWorkflowRun(
        {
          threadId: thread.threadId,
          workflowVersionId: version.workflowVersionId,
          input: { topic: "safe" },
        },
        "cancel-root",
        { workflowRecoveryContext: context },
      )
    ).run;
    await assert.rejects(
      server.client.cancelRun(
        root.runId,
        { expectedRevision: root.revision },
        "cancel-identity",
        { workflowRecoveryContext: `sha256:${"f".repeat(64)}` },
      ),
      changed("workflow_recovery_context_changed"),
    );
    assert.equal(
      (await server.client.getRun(root.runId)).run.cancelRequested,
      false,
    );
    await server.runtime.app.close();
    server = await f.control(null);
    assert.deepEqual(await server.client.getWorkflowRecoveryContext(), {
      version: "v1",
      contextId: null,
    });
    await assert.rejects(
      server.client.cancelRun(
        root.runId,
        { expectedRevision: root.revision },
        "cancel-identity",
        { workflowRecoveryContext: context },
      ),
      (error: unknown) =>
        error instanceof ControlApiClientError &&
        error.status === 503 &&
        error.code === "workflow_recovery_context_unavailable",
    );
    assert.equal(
      (await server.client.getRun(root.runId)).run.cancelRequested,
      false,
    );
    const cancel = await server.client.cancelRun(
      root.runId,
      { expectedRevision: root.revision },
      "cancel-identity",
    );
    assert.equal(cancel.run.cancelRequested, true);
    assert.equal(f.requests.length, 0);
    const unauth = await fetch(
      `${server.baseUrl}/api/v1/runs/${root.runId}:cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WORKFLOW_RECOVERY_CONTEXT_HEADER]: context,
        },
        body: JSON.stringify({ expectedRevision: root.revision }),
      },
    );
    assert.equal(unauth.status, 401);
  },
);

workflowDeploymentIntegrationTest(
  "browser SDK through the real BFF preserves Workflow context and rejects mismatches without dropping identity, CSRF or cancellation boundaries",
  async (t, fixture) => {
    const f = await fixture(t, {
        origin: "https://workflow.example.test",
      }),
      server = await f.control();
    const version = (
      await server.client.publishWorkflowVersion(deploymentWorkflowSource())
    ).workflowVersion;
    const thread = (
      await server.client.createThread(
        { title: "Browser recovery" },
        "browser-thread",
      )
    ).thread;
    const cookie = "crewon_session=workflow-context-fixture";
    const forwarded: { method: string; context: string | null }[] = [];
    let forwarding: "preserve" | "drop" = "preserve";
    const bff = createWebBff({
      publicOrigin: f.origin,
      controlTarget: server.baseUrl,
      controlBffToken: "workflow-bff-service-token-with-32-bytes",
      controlCsrfToken: f.token,
      csrfSecret: "workflow-browser-csrf-secret-with-32-bytes",
      identity: {
        resolve: async (input) =>
          input.cookie === cookie
            ? {
                sessionId: "workflow-browser-session-with-32-bytes",
                expiresAt: "2030-01-01T00:00:00Z",
                controlAccessToken: f.token,
              }
            : null,
      },
      fetch: async (url, init) => {
        forwarded.push({
          method: init!.method!,
          context: new Headers(init!.headers).get(
            WORKFLOW_RECOVERY_CONTEXT_HEADER,
          ),
        });
        const headers = new Headers(init!.headers);
        if (forwarding === "drop")
          headers.delete(WORKFLOW_RECOVERY_CONTEXT_HEADER);
        return fetch(url, { ...init, headers });
      },
    });
    const bootstrap = await bff.handle(
      new Request(`${f.origin}/control-api/session`, { headers: { cookie } }),
    );
    assert.equal(bootstrap.status, 200);
    const { csrfToken } = (await bootstrap.json()) as { csrfToken: string };
    const browserFetch: typeof fetch = (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", cookie);
      return bff.handle(new Request(url, { ...init, headers }));
    };
    const client = new ControlApiClient({
      baseUrl: f.origin,
      csrfToken,
      origin: f.origin,
      fetch: browserFetch,
    });
    const context = (await client.getWorkflowRecoveryContext()).contextId!;
    assert.ok(context);
    const bad = { workflowRecoveryContext: `sha256:${"f".repeat(64)}` };
    const body = {
      threadId: thread.threadId,
      workflowVersionId: version.workflowVersionId,
      input: { topic: "safe" },
    };
    forwarding = "drop";
    await assert.rejects(
      client.startWorkflowRun(body, "browser-start", {
        workflowRecoveryContext: context,
      }),
      (error: unknown) =>
        error instanceof ControlApiClientError &&
        error.status === 400 &&
        error.code === "workflow_recovery_context_invalid",
    );
    forwarding = "preserve";
    assert.equal(
      (
        await server.client.listWorkflowRuns({
          workflowVersionId: version.workflowVersionId,
        })
      ).data.length,
      0,
    );
    await assert.rejects(
      client.startWorkflowRun(body, "browser-start", bad),
      changed("workflow_recovery_context_changed"),
    );
    assert.equal(
      (
        await server.client.listWorkflowRuns({
          workflowVersionId: version.workflowVersionId,
        })
      ).data.length,
      0,
    );
    assert.equal(forwarded.at(-1)!.context, bad.workflowRecoveryContext);
    const root = (
      await client.startWorkflowRun(body, "browser-start", {
        workflowRecoveryContext: context,
      })
    ).run;
    const worker = await f.worker();
    worker.start();
    const waiting = await waitWorkflow(server.client, root.runId, (snapshot) =>
      snapshot.nodes.some((node) => node.status === "waitingHuman"),
    );
    await worker.close();
    const node = waiting.nodes.find((node) => node.kind === "humanGate")!,
      locator = {
        runId: root.runId,
        nodeId: node.nodeId,
        gateRequestId: node.gate!.gateRequestId,
      };
    const decision = {
      inputDigest: node.inputDigest!,
      decision: "approved" as const,
    };
    await assert.rejects(
      client.decideWorkflowHumanGate(locator, decision, bad),
      changed("workflow_recovery_context_changed"),
    );
    await assert.rejects(
      client.reviewWorkflowHumanGate(
        locator,
        { ...decision, comment: null, commentContext: "descendants-v1" },
        bad,
      ),
      changed("workflow_recovery_context_changed"),
    );
    assert.equal(
      (await server.client.getWorkflowHumanGateReview(locator)).review,
      null,
    );
    const run = (await client.getRun(root.runId)).run;
    await assert.rejects(
      client.cancelRun(
        root.runId,
        { expectedRevision: run.revision },
        "browser-cancel",
        bad,
      ),
      changed("workflow_recovery_context_changed"),
    );
    assert.equal(
      (await server.client.getRun(root.runId)).run.cancelRequested,
      false,
    );
    const before = forwarded.length;
    const noCsrf = await bff.handle(
      new Request(`${f.origin}/api/v1/workflow-runs`, {
        method: "POST",
        headers: {
          cookie,
          "origin": f.origin,
          "content-type": "application/json",
          [WORKFLOW_RECOVERY_CONTEXT_HEADER]: context,
          "idempotency-key": "csrf-never-dispatched",
        },
        body: JSON.stringify(body),
      }),
    );
    assert.equal(noCsrf.status, 403);
    assert.equal(forwarded.length, before);
    const noIdentity = await bff.handle(
      new Request(
        `${f.origin}/api/v1/capabilities/workflow-recovery-context-v1`,
      ),
    );
    assert.equal(noIdentity.status, 401);
    assert.equal(forwarded.length, before);
    const accepted = await client.cancelRun(
      root.runId,
      { expectedRevision: run.revision },
      "browser-cancel",
      { workflowRecoveryContext: context },
    );
    assert.equal(accepted.run.cancelRequested, true);
    const resumed = await f.worker();
    resumed.start();
    await waitWorkflow(
      server.client,
      root.runId,
      (snapshot) => snapshot.run.status === "canceled",
    );
    await resumed.close();
    assert.deepEqual(f.requests, ["agent"]);
    const mutations = forwarded.filter((request) => request.method === "POST");
    assert.equal(mutations.length, 7);
    assert.ok(
      mutations.every(
        (request) =>
          request.context === context ||
          request.context === bad.workflowRecoveryContext,
      ),
    );
    t.diagnostic(
      JSON.stringify({
        case: "browser-bff-workflow-context",
        guardedMutations: mutations.length,
        mismatchWrites: 0,
        droppedHeaderWrites: 0,
        models: f.requests,
        browserCsrfRejectedBeforeForward: true,
      }),
    );
  },
);
