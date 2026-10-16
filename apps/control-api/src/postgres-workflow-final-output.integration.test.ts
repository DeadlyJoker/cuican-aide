import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ControlApiClient } from "@crewon/control-client";
import {
  RunApplicationService,
  ThreadApplicationService,
} from "@crewon/application";
import { parseLastEventSequence, parseRunId } from "@crewon/contracts";
import { finalizationFixture } from "../../runtime-worker/src/postgres-workflow-parent.test-support.ts";
import { admissionActor } from "../../../packages/store/src/workflow-run-admission.test-support.ts";
import { workflowAdmissionDigest } from "../../../packages/store/src/workflow-run-admission-validation.ts";
import {
  StandaloneIdentity,
  StandaloneAuthorization,
} from "./standalone-adapters.ts";
import { registerThreadTranscriptSnapshotRoute } from "./thread-transcript-snapshot-route.ts";
import { streamRunEvents } from "./run-event-stream.ts";
import { RunEventHub } from "./run-event-hub.ts";
import { requestContext } from "./request-context.ts";
import { errorResponse } from "./control-api-errors.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL final Workflow reply is readable through the real transcript HTTP route and terminal SSE resumes from its cursor",
  async (t) => {
    const f = await finalizationFixture(t);
    const after = (await f.store.loadRun(f.root))!.lastSequence;
    const result = await f.composition.finalizeWorkflowRun(f.finalInput);
    const store = await f.open();
    const deps = {
      store,
      authorization: new StandaloneAuthorization(admissionActor),
      clock: { now: () => new Date().toISOString() },
      ids: {
        nextId: () => {
          throw Error("read must not allocate");
        },
      },
      digester: workflowAdmissionDigest,
    };
    const threads = new ThreadApplicationService(deps),
      application = new RunApplicationService(deps);
    const token = "workflow-final-output-test-token-with-more-than-32-bytes",
      origin = "http://127.0.0.1:5175";
    const identity = new StandaloneIdentity({
      actor: admissionActor,
      sessionToken: token,
      csrfToken: token,
      allowedOrigins: [origin],
    });
    const app = Fastify(),
      hub = new RunEventHub();
    t.after(async () => {
      hub.close();
      await app.close();
    });
    app.setErrorHandler((error, request, reply) => {
      const response = errorResponse(error, request.id);
      return reply.code(response.statusCode).send(response.body);
    });
    registerThreadTranscriptSnapshotRoute(app, { threads, identity });
    app.get<{ Params: { runId: string } }>(
      "/api/v1/runs/:runId/events",
      async (request, reply) =>
        streamRunEvents({
          request,
          reply,
          application,
          actor: await identity.resolveActor(requestContext(request)),
          eventHub: hub,
          runId: parseRunId(request.params.runId),
          afterSequence: parseLastEventSequence(
            request.headers["last-event-id"],
          ),
          view: "transcript",
          extensions: [],
          heartbeatIntervalMs: null,
        }),
    );
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new ControlApiClient({
      baseUrl,
      accessToken: token,
      origin,
    });
    const snapshot = await client.getThreadTranscriptSnapshot(f.root.threadId, {
      limit: 50,
    });
    assert.equal(snapshot.activeRunId, null);
    assert.equal(
      snapshot.runs.find((run) => run.runId === f.root.runId)!.status,
      "completed",
    );
    const message = snapshot.transcriptWindow.messageWindow.data.at(-1)!;
    assert.equal(message.content, '{"topic":"child-result"}');
    assert.equal(result.run.outputRef, `message:${message.messageId}`);
    assert.equal(
      snapshot.transcriptWindow.runBindings.find(
        (binding) => binding.messageId === message.messageId,
      )!.runId,
      f.root.runId,
    );
    const headers = {
      "authorization": `Bearer ${token}`,
      origin,
      "last-event-id": String(after),
    };
    const first = await fetch(`${baseUrl}/api/v1/runs/${f.root.runId}/events`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(first.status, 200);
    const text = await first.text();
    assert.match(text, /event: message\.completed/);
    assert.match(text, /event: run\.completed/);
    const resumed = await fetch(
      `${baseUrl}/api/v1/runs/${f.root.runId}/events`,
      {
        headers: { ...headers, "last-event-id": String(after + 1) },
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(resumed.status, 200);
    const tail = await resumed.text();
    assert.doesNotMatch(tail, /event: message\.completed/);
    assert.match(tail, /event: run\.completed/);
    assert.equal((tail.match(/^id:/gm) ?? []).length, 1);
    assert.deepEqual(await f.store.listPendingWorkItems(100), []);
  },
);
