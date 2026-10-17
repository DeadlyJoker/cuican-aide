import { assertWorkflowRootInput } from "./workflow-root-transcript.test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { WorkflowHumanGateApplicationService } from "@crewon/application";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import {
  parkedPostgresGates,
  postgresGateFixture,
  gateActor,
  authorizePostgresTestGate,
} from "../../../packages/store/src/postgres-workflow-human-gate.test-support.ts";
import { sequentialGateVersion } from "../../../packages/store/src/workflow-human-gate.test-support.ts";
import { admissionActor } from "../../../packages/store/src/workflow-run-admission.test-support.ts";
import { postgresParentWorker } from "../../runtime-worker/src/postgres-workflow-parent.test-support.ts";
import { createPostgresControlApi } from "./standalone-composition.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;
const token = "workflow-control-http-fixture-token-with-32-bytes",
  origin = "http://127.0.0.1:5175";

async function httpFixture(
  t: Parameters<typeof parkedPostgresGates>[0],
  f: Awaited<ReturnType<typeof postgresGateFixture>>,
  gates: WorkflowHumanGateApplicationService | null = new WorkflowHumanGateApplicationService(
    f.composition,
  ),
) {
  const control = await createPostgresControlApi({
    connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
    schema: f.schema,
    actor: gateActor,
    defaultAgentVersionId: f.root.agentVersionId,
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "fixture-key",
    sessionToken: token,
    csrfToken: token,
    allowedOrigins: [origin],
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    automationScanIntervalMs: null,
    artifactRetention: null,
    workflowHumanGates: gates,
  });
  t.after(() => control.app.close());
  await control.outboxDispatcher.wake();
  const baseUrl = await control.app.listen({ host: "127.0.0.1", port: 0 });
  const client = new ControlApiClient({
    baseUrl,
    accessToken: token,
    csrfToken: token,
    origin,
  });
  return { control, baseUrl, client };
}

pgTest(
  "real PostgreSQL Control HTTP/SDK reads parked gates, approves exactly once and reconstructs the same decision after reopening its Store",
  async (t) => {
    const f = await parkedPostgresGates(t);
    const { client, baseUrl, control } = await httpFixture(t, f);
    const before = await f.snapshot();
    const snapshot = await client.getWorkflowRunSnapshot(f.root.runId);
    assert.equal(snapshot.execution!.status, "waitingHuman");
    const node = snapshot.nodes.find(
      (node) => node.nodeId === f.command.nodeId,
    )!;
    assert.equal(node.child, null);
    const locator = {
      runId: f.root.runId,
      nodeId: node.nodeId,
      gateRequestId: node.gate!.gateRequestId,
    };
    const gate = await client.getWorkflowHumanGate(locator);
    assert.equal(gate.status, "waitingHuman");
    assert.deepEqual(await f.snapshot(), before);
    const body = {
      inputDigest: gate.authority.inputDigest,
      decision: "approved" as const,
    };
    const decision = await client.decideWorkflowHumanGate(locator, body);
    assert.equal(decision.disposition, "committed");
    await control.outboxDispatcher.wake();
    const committed = await f.snapshot();
    assert.deepEqual(await client.decideWorkflowHumanGate(locator, body), {
      ...decision,
      disposition: "replayed",
    });
    assert.deepEqual(await f.snapshot(), committed);
    const reopened = (await f.open()).experimentalWorkflowRunCompositionStore(
      f.config,
    );
    const second = await httpFixture(
      t,
      f,
      new WorkflowHumanGateApplicationService(reopened),
    );
    assert.deepEqual(
      (await second.client.getWorkflowHumanGate(locator)).decision,
      decision.decision,
    );
    assert.equal(
      (await second.client.getWorkflowRunSnapshot(f.root.runId)).nodes.find(
        (node) => node.nodeId === locator.nodeId,
      )!.status,
      "completed",
    );
    await assert.rejects(
      client.decideWorkflowHumanGate(locator, {
        ...body,
        decision: "rejected",
      }),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 409,
    );
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/workflow-runs/${f.root.runId}`)).status,
      401,
    );
    const noCsrf = await fetch(
      `${baseUrl}/api/v1/workflow-runs/${f.root.runId}/nodes/${locator.nodeId}/gates/${locator.gateRequestId}/decisions`,
      {
        method: "POST",
        headers: {
          "authorization": `Bearer ${token}`,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(noCsrf.status, 403);
  },
);

pgTest(
  "real HTTP approval resumes the ordinary Worker after reopen and publishes one final root result",
  async (t) => {
    const f = await postgresGateFixture(t, { asset: sequentialGateVersion() });
    const worker = await postgresParentWorker(f, t);
    assert.equal((await worker.worker.wake()).kind, "workflowWaiting");
    assert.equal((await worker.worker.wake()).kind, "completed");
    assert.equal((await worker.worker.wake()).kind, "workflowWaiting");
    const { client, baseUrl } = await httpFixture(t, f);
    const snapshot = await client.getWorkflowRunSnapshot(f.root.runId);
    const gate = snapshot.nodes.find((node) => node.kind === "humanGate")!;
    assert.equal(gate.status, "waitingHuman");
    await worker.worker.close();
    const resumed = await postgresParentWorker(f, t);
    await client.decideWorkflowHumanGate(
      {
        runId: f.root.runId,
        nodeId: gate.nodeId,
        gateRequestId: gate.gate!.gateRequestId,
      },
      { inputDigest: gate.inputDigest!, decision: "approved" },
    );
    for (let pass = 0; pass < 8; pass++)
      if ((await resumed.worker.wake()).kind === "idle") break;
    const final = await client.getWorkflowRunSnapshot(f.root.runId);
    assert.equal(final.run.status, "completed");
    assert.ok(final.nodes.every((node) => node.status === "completed"));
    const transcript = await client.getThreadTranscriptSnapshot(
      f.root.threadId,
    );
    assert.equal(transcript.activeRunId, null);
    assertWorkflowRootInput(transcript, f.root.runId);
    assert.equal(
      transcript.transcriptWindow.runBindings.filter(
        (binding) =>
          binding.runId === f.root.runId &&
          binding.source === "messageCompletedEvent",
      ).length,
      1,
    );
    const headers = {
      "authorization": `Bearer ${token}`,
      origin,
      "last-event-id": String(final.run.lastSequence - 1),
    };
    const tail = await (
      await fetch(
        `${baseUrl}/api/v1/runs/${f.root.runId}/events?view=transcript`,
        { headers, signal: AbortSignal.timeout(5000) },
      )
    ).text();
    assert.match(tail, /event: run\.completed/);
    assert.doesNotMatch(tail, /event: message\.completed/);
  },
);

pgTest(
  "gate HTTP reads and writes respect current approver identity and revocation",
  async (t) => {
    let revoked = false;
    const f = await parkedPostgresGates(t, {
      composition: {
        humanGates: {
          authorize: (input) =>
            revoked
              ? { outcome: "deny", reasonCode: "revoked" }
              : authorizePostgresTestGate(input),
        },
      },
    });
    const { client } = await httpFixture(t, f);
    const locator = {
      runId: f.root.runId,
      nodeId: f.command.nodeId,
      gateRequestId: f.command.gateRequestId,
    };
    await client.getWorkflowHumanGate(locator);
    const before = await f.snapshot();
    revoked = true;
    for (const request of [
      () => client.getWorkflowHumanGate(locator),
      () =>
        client.decideWorkflowHumanGate(locator, {
          inputDigest: f.command.inputDigest,
          decision: "approved",
        }),
    ])
      await assert.rejects(
        request(),
        (error: unknown) =>
          error instanceof ControlApiClientError && error.status === 403,
      );
    assert.deepEqual(await f.snapshot(), before);
    await assert.rejects(
      new WorkflowHumanGateApplicationService(f.composition).getGate(
        admissionActor,
        locator,
      ),
    );
  },
);

pgTest(
  "Workflow reads do not enable approval or execution when no policy service is composed",
  async (t) => {
    const f = await parkedPostgresGates(t);
    const { client, baseUrl } = await httpFixture(t, f, null);
    const before = await f.snapshot();
    assert.equal(
      (await client.getWorkflowRunSnapshot(f.root.runId)).execution!.status,
      "waitingHuman",
    );
    const locator = {
      runId: f.root.runId,
      nodeId: f.command.nodeId,
      gateRequestId: f.command.gateRequestId,
    };
    for (const operation of [
      () => client.getWorkflowHumanGate(locator),
      () =>
        client.decideWorkflowHumanGate(locator, {
          inputDigest: f.command.inputDigest,
          decision: "approved",
        }),
    ])
      await assert.rejects(
        operation(),
        (error: unknown) =>
          error instanceof ControlApiClientError && error.status === 503,
      );
    const response = await fetch(`${baseUrl}/api/v1/workflow-runs`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        origin,
        "x-csrf-token": token,
        "content-type": "application/json",
        "idempotency-key": "must-not-start",
      },
      body: JSON.stringify({
        threadId: f.root.threadId,
        workflowVersionId: f.root.workflowVersionBinding!.workflowVersionId,
        input: { topic: "safe" },
      }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "HTTP rejection remains visible as a failed gate and one failed root without a fabricated assistant reply",
  async (t) => {
    const f = await parkedPostgresGates(t);
    const { client } = await httpFixture(t, f);
    const locator = {
      runId: f.root.runId,
      nodeId: f.command.nodeId,
      gateRequestId: f.command.gateRequestId,
    };
    await client.decideWorkflowHumanGate(locator, {
      inputDigest: f.command.inputDigest,
      decision: "rejected",
    });
    const rejected = await client.getWorkflowRunSnapshot(f.root.runId);
    assert.equal(rejected.execution!.status, "failed");
    assert.equal(
      rejected.nodes.find((node) => node.nodeId === locator.nodeId)!.status,
      "failed",
    );
    assert.equal(
      (await client.getWorkflowHumanGate(locator)).decision!.outcome,
      "rejected",
    );
    const worker = await postgresParentWorker(f, t);
    assert.equal((await worker.worker.wake()).kind, "failed");
    assert.equal(
      (await client.getWorkflowRunSnapshot(f.root.runId)).run.status,
      "failed",
    );
    const transcript = await client.getThreadTranscriptSnapshot(
      f.root.threadId,
    );
    assert.equal(transcript.activeRunId, null);
    assertWorkflowRootInput(transcript, f.root.runId);
    assert.deepEqual(
      transcript.transcriptWindow.messageWindow.data.map(
        (message) => message.role,
      ),
      ["user"],
    );
    assert.equal(worker.requests.length, 0);
  },
);
