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
        if (denyRunRead && input.action === "run:read")
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
  denyRunRead = true;
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
  for (const suffix of ["?limit=101", "?view=audit", "?cursor=invalid"])
    assert.equal((await get(suffix)).statusCode, 400);
  await threads.renameThread(actor, {
    kind: "thread.rename",
    threadId,
    idempotencyKey: "rename",
    expectedRevision: 3,
    title: "Renamed",
  });
  assert.equal(
    (await get(`?cursor=${latest.messageWindow.olderCursor}`)).statusCode,
    409,
  );
});
