import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { ControlApiClient } from "@crewon/control-client";
import { postgresCancellationFixture } from "../../../packages/store/src/postgres-workflow-cancellation.test-support.ts";
import { admissionActor } from "../../../packages/store/src/workflow-run-admission.test-support.ts";
import { parallelVersion } from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import { postgresParentWorker } from "../../runtime-worker/src/postgres-workflow-parent.test-support.ts";
import { createPostgresControlApi } from "./standalone-composition.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL authenticated Control HTTP cancellation signals children, retains the active slot until terminal, and resumes only the unconsumed SSE tail",
  async (t) => {
    const f = await postgresCancellationFixture(t, {
      prepare: false,
      asset: parallelVersion(2),
    });
    const worker = await postgresParentWorker(f, t);
    assert.equal((await worker.worker.wake()).kind, "workflowWaiting");
    const token = "pg-workflow-cancel-http-test-token-32-bytes-minimum";
    const origin = "http://127.0.0.1:5175";
    const control = await createPostgresControlApi({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
      schema: f.schema,
      actor: admissionActor,
      defaultAgentVersionId: f.root.agentVersionId,
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "fixture-artifact-key",
      sessionToken: token,
      csrfToken: token,
      allowedOrigins: [origin],
      heartbeatIntervalMs: null,
      outboxScanIntervalMs: null,
      automationScanIntervalMs: null,
      artifactRetention: null,
    });
    try {
      const baseUrl = await control.app.listen({ host: "127.0.0.1", port: 0 });
      const client = new ControlApiClient({
        baseUrl,
        accessToken: token,
        csrfToken: token,
        origin,
      });
      const current = (await f.store.loadRun(f.root))!;
      const before = await client.getThreadTranscriptSnapshot(
        current.threadId,
        { limit: 50 },
      );
      assert.equal(before.activeRunId, current.runId);
      const command = { expectedRevision: current.revision };
      const canceled = await client.cancelRun(
        current.runId,
        command,
        "fixture-http-workflow-cancel",
      );
      assert.equal(canceled.run.cancelRequested, true);
      assert.equal(canceled.run.status, "running");
      assert.deepEqual(
        await client.cancelRun(
          current.runId,
          command,
          "fixture-http-workflow-cancel",
        ),
        { ...canceled, disposition: "replayed" },
      );
      for (const child of await f.children())
        assert.equal(
          (await f.store.loadRun({
            tenantId: current.tenantId,
            runId: child.child_run_id,
          }))!.cancelRequested,
          true,
        );
      const waiting = await client.getThreadTranscriptSnapshot(
        current.threadId,
        { limit: 50 },
      );
      assert.equal(waiting.activeRunId, current.runId);
      for (let pass = 0; pass < 8; pass++)
        if ((await worker.worker.wake()).kind === "idle") break;
      const snapshot = await client.getThreadTranscriptSnapshot(
        current.threadId,
        { limit: 50 },
      );
      assert.equal(snapshot.activeRunId, null);
      // This Run has no associated root message. The bounded snapshot omits it after it leaves the active slot.
      assert.equal(
        snapshot.runs.some((run) => run.runId === current.runId),
        false,
      );
      assert.equal((await client.getRun(current.runId)).run.status, "canceled");
      const execution = await client.getWorkflowRunSnapshot(current.runId);
      assert.equal(execution.run.status, "canceled");
      assert.equal(execution.execution!.status, "canceled");
      assert.ok(execution.nodes.every((node) => node.status === "canceled"));
      assert.deepEqual(
        snapshot.transcriptWindow.messageWindow.data,
        before.transcriptWindow.messageWindow.data,
      );
      assert.equal(worker.requests.length, 0);
      const headers = {
        "authorization": `Bearer ${token}`,
        origin,
        "last-event-id": String(current.lastSequence),
      };
      const first = await fetch(
        `${baseUrl}/api/v1/runs/${current.runId}/events?view=transcript`,
        { headers, signal: AbortSignal.timeout(5000) },
      );
      assert.equal(first.status, 200);
      const text = await first.text();
      assert.match(text, /event: run\.cancel\.requested/);
      assert.match(text, /event: run\.canceled/);
      assert.doesNotMatch(text, /event: message\.completed/);
      const resumed = await fetch(
        `${baseUrl}/api/v1/runs/${current.runId}/events?view=transcript`,
        {
          headers: {
            ...headers,
            "last-event-id": String(canceled.run.lastSequence),
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.equal(resumed.status, 200);
      const tail = await resumed.text();
      assert.match(tail, /event: run\.canceled/);
      assert.doesNotMatch(tail, /event: run\.cancel\.requested/);
      assert.equal((tail.match(/^id:/gm) ?? []).length, 1);
      assert.deepEqual(await f.store.listPendingWorkItems(100), []);
    } finally {
      await control.app.close();
    }
  },
);
