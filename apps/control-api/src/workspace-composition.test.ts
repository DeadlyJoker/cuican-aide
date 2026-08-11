import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { InMemoryArtifactStore } from "@crewon/artifacts";
import type {
  ErrorEnvelope,
  GetWorkspaceOperationResponse,
  ListWorkspaceOperationsResponse,
  ThreadMutationResponse,
  WorkspaceOperationMutationResponse,
} from "@crewon/contracts";
import {
  NodeSha256ContentDigester,
  RuntimeWorkspaceFreezeService,
  startRuntimeWorkspacePrivateServer,
} from "@crewon/runtime-worker";
import { SqliteRunStore } from "@crewon/store";

import {
  createStandaloneControlApi,
  type StandaloneControlApiConfig,
} from "./standalone-composition.ts";
import { RuntimeWorkspaceWorkerClientError } from "./workspace-runtime-worker-client.ts";

const SESSION_TOKEN = "workspace-control-session-token-0001";
const CSRF_TOKEN = "workspace-control-csrf-token-00001";
const WORKER_TOKEN = "workspace-control-worker-token-0001";
const ORIGIN = "http://127.0.0.1:5175";
const ACTOR = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
} as const;

test("keeps Workspace unavailable unless the standalone loopback route is explicit", async (context) => {
  const runtime = createStandaloneControlApi(config(databasePath(context)));
  assert.equal(runtime.workspaceLists, null);
  const unavailable = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-missing/workspace-list",
    headers: mutationHeaders("workspace-unavailable"),
    payload: { expectedThreadRevision: 1, maxEntries: 5 },
  });
  assert.equal(unavailable.statusCode, 503, unavailable.body);
  assert.deepEqual(unavailable.json<ErrorEnvelope>().error, {
    category: "deviceUnavailable",
    code: "workspace_command_factory_unavailable",
    message: "The execution device is unavailable.",
    requestId: unavailable.json<ErrorEnvelope>().error.requestId,
  });
  await runtime.app.close();
});

test("fails startup closed for an invalid Workspace route and releases SQLite", async (context) => {
  const path = databasePath(context);
  assert.throws(
    () =>
      createStandaloneControlApi({
        ...config(path),
        workspaceWorker: {
          origin: "http://localhost:3211",
          token: WORKER_TOKEN,
        },
      }),
    (error) =>
      error instanceof RuntimeWorkspaceWorkerClientError &&
      error.code === "runtime_workspace_worker_origin_invalid",
  );
  const reopened = new SqliteRunStore(path);
  await reopened.close();
});

test("maps a malformed successful freeze response to internal instead of unavailable", async (context) => {
  const worker = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ malformed: true }));
  });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  context.after(
    () => new Promise<void>((resolve) => worker.close(() => resolve())),
  );
  const address = worker.address();
  assert.ok(address !== null && typeof address !== "string");
  const runtime = createStandaloneControlApi({
    ...config(databasePath(context)),
    workspaceWorker: {
      origin: `http://127.0.0.1:${address.port}`,
      token: WORKER_TOKEN,
    },
  });
  context.after(() => runtime.app.close());
  const thread = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("workspace-malformed-thread"),
    payload: { title: "Malformed freeze" },
  });
  const threadView = thread.json<ThreadMutationResponse>().thread;
  const response = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/threads/${threadView.threadId}/workspace-list`,
    headers: mutationHeaders("workspace-malformed-freeze"),
    payload: { expectedThreadRevision: threadView.revision, maxEntries: 5 },
  });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(response.json<ErrorEnvelope>().error.category, "internal");
  assert.equal(
    response.json<ErrorEnvelope>().error.code,
    "workspace_command_factory_invalid",
  );
});

test("freezes and dispatches once, then receipt-replays the same idempotency command", async (context) => {
  let freezeCalls = 0;
  let dispatchCalls = 0;
  let executionSequence = 0;
  let driftExecutionId: string | null = null;
  let driftReconcileCalls = 0;
  const freeze = new RuntimeWorkspaceFreezeService({
    bindings: {
      resolve: async (query) => {
        freezeCalls += 1;
        return {
          ...query,
          workspaceBindingId: "workspace-1",
          incarnationId: "incarnation-1",
          deviceBindingId: "device-binding-1",
          deviceId: "device-1",
          runtimeBindingId: "runtime-binding-1",
          policySnapshotId: "policy-1",
        };
      },
    },
    ids: {
      nextExecutionId: () =>
        `workspace-execution-${String(++executionSequence).padStart(3, "0")}`,
    },
    digester: new NodeSha256ContentDigester(),
  });
  const worker = await startRuntimeWorkspacePrivateServer({
    port: 0,
    authentication: { kind: "loopbackToken", token: WORKER_TOKEN },
    freeze,
    dispatch: {
      dispatch: async (request) => {
        dispatchCalls += 1;
        if (request.operation.executionId === driftExecutionId) {
          const unknown =
            request.phase === "execute" || ++driftReconcileCalls === 1;
          if (unknown) {
            return {
              schemaVersion:
                "crewon.runtime-worker-workspace-dispatch-response.v0",
              apiVersion: 1,
              phase: request.phase,
              resolution: {
                status: "unknownOutcome",
                executionId: request.operation.executionId,
                actionDigest: request.operation.command.actionDigest,
                commandDigest: request.operation.command.commandDigest,
                providerReceiptId: null,
              },
            };
          }
        }
        return {
          schemaVersion: "crewon.runtime-worker-workspace-dispatch-response.v0",
          apiVersion: 1,
          phase: request.phase,
          resolution: {
            status: "completed",
            executionId: request.operation.executionId,
            actionDigest: request.operation.command.actionDigest,
            commandDigest: request.operation.command.commandDigest,
            providerReceiptId: "gateway-receipt-1",
            entries: [{ name: "README.md", kind: "file" }],
            truncated: false,
          },
        };
      },
    },
  });
  context.after(() => worker.close());
  const runtime = createStandaloneControlApi({
    ...config(databasePath(context)),
    workspaceWorker: { origin: worker.origin, token: WORKER_TOKEN },
  });
  context.after(() => runtime.app.close());
  assert.ok(runtime.workspaceLists !== null);
  const threadResponse = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("workspace-thread-create"),
    payload: { title: "Workspace thread" },
  });
  assert.equal(threadResponse.statusCode, 201, threadResponse.body);
  const thread = threadResponse.json<ThreadMutationResponse>().thread;
  const executeRequest = () =>
    runtime.app.inject({
      method: "POST",
      url: `/api/v1/threads/${thread.threadId}/workspace-list`,
      headers: mutationHeaders("workspace-list-same-key"),
      payload: { expectedThreadRevision: thread.revision, maxEntries: 5 },
    });
  const firstResponse = await executeRequest();
  const replayResponse = await executeRequest();
  assert.equal(firstResponse.statusCode, 201, firstResponse.body);
  assert.equal(replayResponse.statusCode, 200, replayResponse.body);
  const first = firstResponse.json<WorkspaceOperationMutationResponse>();
  const replay = replayResponse.json<WorkspaceOperationMutationResponse>();
  assert.deepEqual(
    { first: first.disposition, replay: replay.disposition },
    { first: "committed", replay: "replayed" },
  );
  assert.deepEqual(replay, { ...first, disposition: "replayed" });
  assert.equal(first.eventSequence, first.operation.revision);
  assert.equal(first.operation.status, "completed");
  assert.deepEqual(first.operation.result, {
    status: "completed",
    entries: [{ name: "README.md", kind: "file" }],
    truncated: false,
  });
  for (const privateField of [
    "tenantId",
    "spaceId",
    "actorId",
    "actionDigest",
    "commandDigest",
    "providerReceiptId",
    "deviceId",
    "workspaceBindingId",
    "incarnationId",
    "runtimeBindingId",
    "policySnapshotId",
    "lease",
    "path",
  ]) {
    assert.equal(
      firstResponse.body.includes(privateField),
      false,
      privateField,
    );
  }
  assert.deepEqual(
    { freezeCalls, dispatchCalls },
    { freezeCalls: 1, dispatchCalls: 1 },
  );

  const snapshotResponse = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/threads/${thread.threadId}/workspace-list/${first.operation.executionId}`,
    headers: readHeaders(),
  });
  assert.equal(snapshotResponse.statusCode, 200, snapshotResponse.body);
  assert.deepEqual(snapshotResponse.json<GetWorkspaceOperationResponse>(), {
    operation: first.operation,
    eventSequence: first.eventSequence,
  });

  const stale = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/threads/${thread.threadId}/workspace-list/${first.operation.executionId}:reconcile`,
    headers: mutationHeaders("workspace-reconcile-stale"),
    payload: { expectedOperationRevision: 1 },
  });
  assert.equal(stale.statusCode, 409, stale.body);
  const terminalCancel = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/threads/${thread.threadId}/workspace-list/${first.operation.executionId}:cancel`,
    headers: mutationHeaders("workspace-cancel-terminal"),
    payload: { expectedOperationRevision: first.operation.revision },
  });
  assert.equal(terminalCancel.statusCode, 200, terminalCancel.body);
  assert.equal(
    terminalCancel.json<WorkspaceOperationMutationResponse>().operation.status,
    "completed",
  );
  assert.equal(dispatchCalls, 1);

  driftExecutionId = "workspace-execution-002";
  const driftCreate = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/threads/${thread.threadId}/workspace-list`,
    headers: mutationHeaders("workspace-drift-create"),
    payload: { expectedThreadRevision: thread.revision, maxEntries: 1 },
  });
  const driftInitial =
    driftCreate.json<WorkspaceOperationMutationResponse>().operation;
  assert.equal(driftInitial.status, "unknownOutcome");
  const firstReconcileRequest = () =>
    runtime.app.inject({
      method: "POST",
      url: `/api/v1/threads/${thread.threadId}/workspace-list/${driftInitial.executionId}:reconcile`,
      headers: mutationHeaders("workspace-drift-reconcile-first"),
      payload: { expectedOperationRevision: driftInitial.revision },
    });
  const firstReconcile = await firstReconcileRequest();
  const firstReconcileBody =
    firstReconcile.json<WorkspaceOperationMutationResponse>();
  assert.equal(firstReconcileBody.operation.status, "unknownOutcome");
  const secondReconcile = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/threads/${thread.threadId}/workspace-list/${driftInitial.executionId}:reconcile`,
    headers: mutationHeaders("workspace-drift-reconcile-second"),
    payload: {
      expectedOperationRevision: firstReconcileBody.operation.revision,
    },
  });
  assert.equal(
    secondReconcile.json<WorkspaceOperationMutationResponse>().operation.status,
    "completed",
  );
  const historicalReplay = await firstReconcileRequest();
  assert.equal(historicalReplay.statusCode, 200, historicalReplay.body);
  assert.deepEqual(
    historicalReplay.json<WorkspaceOperationMutationResponse>(),
    {
      ...firstReconcileBody,
      disposition: "replayed",
    },
  );

  const missingCsrf = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/threads/${thread.threadId}/workspace-list`,
    headers: {
      ...mutationHeaders("workspace-no-csrf"),
      "x-csrf-token": "",
    },
    payload: { expectedThreadRevision: thread.revision, maxEntries: 5 },
  });
  assert.equal(missingCsrf.statusCode, 403, missingCsrf.body);
  const missingIdempotency = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/threads/${thread.threadId}/workspace-list`,
    headers: {
      ...readHeaders(),
      "content-type": "application/json",
      "x-csrf-token": CSRF_TOKEN,
    },
    payload: { expectedThreadRevision: thread.revision, maxEntries: 5 },
  });
  assert.equal(missingIdempotency.statusCode, 400, missingIdempotency.body);

  for (let index = 0; index < 99; index += 1) {
    const response = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/threads/${thread.threadId}/workspace-list`,
      headers: mutationHeaders(`workspace-page-${index}`),
      payload: { expectedThreadRevision: thread.revision, maxEntries: 1 },
    });
    assert.equal(response.statusCode, 201, response.body);
  }
  const firstPageResponse = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/threads/${thread.threadId}/workspace-list?limit=100`,
    headers: readHeaders(),
  });
  const firstPage = firstPageResponse.json<ListWorkspaceOperationsResponse>();
  assert.equal(firstPage.data.length, 100);
  assert.equal(firstPage.nextAfterExecutionId, "workspace-execution-100");
  const secondPageResponse = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/threads/${thread.threadId}/workspace-list?afterExecutionId=${firstPage.nextAfterExecutionId}&limit=100`,
    headers: readHeaders(),
  });
  assert.deepEqual(
    secondPageResponse
      .json<ListWorkspaceOperationsResponse>()
      .data.map(({ executionId }) => executionId),
    ["workspace-execution-101"],
  );

  const address = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const eventResponse = await fetch(
    `${address}/api/v1/threads/${thread.threadId}/workspace-list/${first.operation.executionId}/events`,
    { headers: readHeaders() },
  );
  assert.equal(eventResponse.status, 200);
  const eventBody = await eventResponse.text();
  assert.match(eventBody, /id: 1\nevent: workspace\.operation\.replaced/u);
  assert.match(eventBody, /id: 2\nevent: workspace\.operation\.replaced/u);
  assert.equal(eventBody.includes("providerReceiptId"), false);

  const handoff = await fetch(
    `${address}/api/v1/threads/${thread.threadId}/workspace-list/${first.operation.executionId}/events`,
    { headers: { ...readHeaders(), "last-event-id": "2" } },
  );
  assert.equal(handoff.status, 200);
  assert.equal(await handoff.text(), "");

  const ahead = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/threads/${thread.threadId}/workspace-list/${first.operation.executionId}/events`,
    headers: { ...readHeaders(), "last-event-id": "3" },
  });
  assert.equal(ahead.statusCode, 400, ahead.body);
  const missingExecution = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/threads/${thread.threadId}/workspace-list/workspace-missing/events`,
    headers: readHeaders(),
  });
  assert.equal(missingExecution.statusCode, 404, missingExecution.body);
});

function config(databasePath: string): StandaloneControlApiConfig {
  return {
    actor: ACTOR,
    defaultAgentVersionId: "workspace-unused-agent-version",
    sessionToken: SESSION_TOKEN,
    csrfToken: CSRF_TOKEN,
    allowedOrigins: [ORIGIN],
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "workspace-artifact-key",
    databasePath,
  };
}

function mutationHeaders(idempotencyKey: string): Record<string, string> {
  return {
    "authorization": `Bearer ${SESSION_TOKEN}`,
    "origin": ORIGIN,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-csrf-token": CSRF_TOKEN,
  };
}

function readHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${SESSION_TOKEN}`,
    origin: ORIGIN,
  };
}

function databasePath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-workspace-control-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "control.sqlite");
}
