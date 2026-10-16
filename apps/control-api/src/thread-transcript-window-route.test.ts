import { ControlApiClient } from "@crewon/control-client";
import { registerThreadTranscriptSnapshotRoute } from "./thread-transcript-snapshot-route.ts";
import { parseThreadTranscriptSnapshotResponse } from "@crewon/contracts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import {
  ThreadApplicationService,
  TurnApplicationService,
  type ApplicationIdKind,
} from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";
import {
  parseThreadTranscriptWindowResponse,
  type GetThreadTranscriptWindowResponse,
} from "@crewon/contracts";
import { registerThreadTranscriptWindowRoute } from "./thread-transcript-window-route.ts";
import { registerThreadMessageWindowRoute } from "./thread-message-window-route.ts";
import { errorResponse } from "./control-api-errors.ts";
import {
  NodeSha256ContentDigester,
  StandaloneAuthorization,
  StandaloneIdentity,
} from "./standalone-adapters.ts";

test("transcript HTTP uses durable associations, authorizes each Run and rejects stale pages", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-transcript-http-"));
  const store = new SqliteRunStore(join(directory, "test.db"));
  const app = Fastify();
  context.after(async () => {
    await app.close();
    await store.close();
    rmSync(directory, { recursive: true });
  });
  const actor = {
    tenantId: "tenant-1",
    spaceId: "space-1",
    actorId: "actor-1",
    principalId: "principal-1",
  };
  let identifier = 0;
  let denyRunRead = false;
  let denySpecificRun: string | null = null;
  const checked: string[] = [];
  const authorization = new StandaloneAuthorization(actor);
  const deps = {
    store,
    digester: new NodeSha256ContentDigester(),
    clock: { now: () => "2026-09-11T00:00:00Z" },
    ids: { nextId: (kind: ApplicationIdKind) => `${kind}-${++identifier}` },
    authorization: {
      authorize: async (
        input: Parameters<typeof authorization.authorize>[0],
      ) => {
        checked.push(input.action);
        if (
          input.action === "run:read" &&
          (denyRunRead ||
            (input.resource.kind === "run" &&
              denySpecificRun !== null &&
              input.resource.runId === denySpecificRun))
        )
          return { outcome: "deny" as const, reasonCode: "fixture-denied" };
        return authorization.authorize(input);
      },
    },
  };
  const threads = new ThreadApplicationService(deps);
  const created = await threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "create",
    title: "Transcript",
  });
  const threadId = created.state.threadId;
  await threads.appendMessage(actor, {
    kind: "thread.message.append",
    idempotencyKey: "legacy",
    threadId,
    expectedRevision: 1,
    role: "user",
    content: "legacy message with same timestamp",
  });
  const started = await new TurnApplicationService(deps).startTurn(actor, {
    kind: "turn.start",
    threadId,
    expectedThreadRevision: 2,
    idempotencyKey: "turn",
    content: "exactly linked message",
    requestedAgentVersionId: "agent-version-1",
    executionIntent: "none",
    route: {
      authorityId: "authority",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy",
      workspaceBindingId: null,
    },
  });
  const token = "transcript-session-with-32-bytes-minimum";
  const origin = "http://127.0.0.1:5175";
  const identity = new StandaloneIdentity({
    actor,
    sessionToken: token,
    csrfToken: token,
    allowedOrigins: [origin],
  });
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error, request.id);
    return reply.code(result.statusCode).send(result.body);
  });
  registerThreadTranscriptWindowRoute(app, { threads, identity });
  registerThreadTranscriptSnapshotRoute(app, { threads, identity });
  registerThreadMessageWindowRoute(app, { threads, identity });
  const url = `/api/v1/threads/${threadId}/transcript-window`;
  const headers = { authorization: `Bearer ${token}`, origin };
  const get = (suffix = "") =>
    app.inject({ method: "GET", url: url + suffix, headers });
  const latestResponse = await get("?limit=1");
  assert.equal(latestResponse.statusCode, 200, latestResponse.body);
  const latest = latestResponse.json<GetThreadTranscriptWindowResponse>();
  assert.deepEqual(
    parseThreadTranscriptWindowResponse(latest, threadId, {
      position: null,
      limit: 1,
    }),
    latest,
  );
  assert.deepEqual(latest.runBindings, [
    {
      messageId: started.messages[0]!.messageId,
      runId: started.runState.runId,
      source: "turnStartReceipt",
    },
  ]);
  assert.ok(checked.includes("thread:read") && checked.includes("run:read"));
  const snapshotUrl = `/api/v1/threads/${threadId}/transcript-snapshot?limit=1`;
  const snapshotResponse = await app.inject({
    method: "GET",
    url: snapshotUrl,
    headers,
  });
  assert.equal(snapshotResponse.statusCode, 200, snapshotResponse.body);
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  let snapshotRequests = 0;
  const client = new ControlApiClient({
    baseUrl,
    accessToken: token,
    origin,
    fetch: async (url, init) => {
      snapshotRequests++;
      return fetch(url, init);
    },
  });
  const snapshot = await client.getThreadTranscriptSnapshot(threadId, {
    limit: 1,
  });
  assert.equal(snapshotRequests, 1);
  assert.deepEqual(
    snapshot,
    parseThreadTranscriptSnapshotResponse(snapshotResponse.json(), threadId, {
      position: null,
      limit: 1,
    }),
  );
  assert.deepEqual(snapshot.transcriptWindow, latest);
  assert.equal(snapshot.activeRunId, started.runState.runId);
  assert.deepEqual(
    snapshot.runs.map((run) => [run.runId, run.cancelRequested]),
    [[started.runState.runId, false]],
  );
  const oldSnapshot = await app.inject({
    method: "GET",
    url: snapshotUrl + `&cursor=${latest.messageWindow.olderCursor}`,
    headers,
  });
  assert.equal(oldSnapshot.statusCode, 200, oldSnapshot.body);
  assert.equal(oldSnapshot.json().activeRunId, started.runState.runId);
  assert.equal(oldSnapshot.json().transcriptWindow.runBindings[0].runId, null);
  const older = await get(
    `?limit=1&cursor=${latest.messageWindow.olderCursor}`,
  );
  assert.equal(older.statusCode, 200, older.body);
  assert.deepEqual(
    older
      .json<GetThreadTranscriptWindowResponse>()
      .runBindings.map(({ runId, source }) => ({ runId, source })),
    [{ runId: null, source: "unassociated" }],
  );
  denySpecificRun = started.runState.runId;
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: snapshotUrl + `&cursor=${latest.messageWindow.olderCursor}`,
        headers,
      })
    ).statusCode,
    403,
  );
  // The old window contains only an unassociated legacy message; it exposes no Run.
  assert.equal(
    (await get(`?limit=1&cursor=${latest.messageWindow.olderCursor}`))
      .statusCode,
    200,
  );
  denySpecificRun = null;
  denyRunRead = true;
  assert.equal(
    (await app.inject({ method: "GET", url: snapshotUrl, headers })).statusCode,
    403,
  );
  assert.equal((await get("?limit=1")).statusCode, 403);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/api/v1/threads/${threadId}/message-window`,
        headers,
      })
    ).statusCode,
    200,
  );
  denyRunRead = false;
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: "GET", url: snapshotUrl })).statusCode,
    401,
  );
  for (const suffix of ["?limit=101", "?view=audit", "?cursor=invalid"])
    assert.equal((await get(suffix)).statusCode, 400);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: snapshotUrl + "&limit=101",
        headers,
      })
    ).statusCode,
    400,
  );
  await threads.renameThread(actor, {
    kind: "thread.rename",
    threadId,
    idempotencyKey: "rename",
    expectedRevision: 3,
    title: "Renamed",
  });
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: snapshotUrl + `&cursor=${latest.messageWindow.olderCursor}`,
        headers,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await get(`?cursor=${latest.messageWindow.olderCursor}`)).statusCode,
    409,
  );
});
