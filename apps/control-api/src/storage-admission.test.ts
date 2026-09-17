import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import {
  RunApplicationService,
  StorageAdmissionError,
} from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";
import type { ThreadMutationResponse } from "@crewon/contracts";
import { installStorageAdmission } from "./storage-admission.ts";
import { createStandaloneControlApi } from "./standalone-composition.ts";
import {
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";

test("storage admission gates new mutations using registered routes and admits recovery", async (context) => {
  const app = Fastify();
  context.after(() => app.close());
  let checks = 0;
  let failure: Error | null = new StorageAdmissionError(
    "storage_capacity_low",
    1501,
  );
  installStorageAdmission(app, {
    async assertNewWorkAllowed() {
      checks += 1;
      if (failure !== null) throw failure;
    },
  });
  for (const route of [
    { method: "GET", url: "/read" },
    { method: "OPTIONS", url: "/read" },
    { method: "POST", url: "/api/v1/runs/:runId([^:]+)::cancel" },
    {
      method: "POST",
      url: "/api/v1/threads/:threadId/workspace-list/:executionId([^:]+)::cancel",
    },
    {
      method: "POST",
      url: "/api/v1/threads/:threadId/workspace-list/:executionId([^:]+)::reconcile",
    },
    { method: "DELETE", url: "/api/v1/threads/:threadId/goal" },
    {
      method: "POST",
      url: "/api/v1/tool-approvals/:approvalId([^:]+)::decide",
    },
    { method: "POST", url: "/api/v1/threads" },
    { method: "PUT", url: "/api/v1/threads/:threadId/goal" },
    { method: "POST", url: "/api/v1/runs/:runId([^:]+)::cancel/extra" },
  ] as const)
    app.route({ ...route, handler: async () => ({ admitted: true }) });

  for (const request of [
    { method: "GET", url: "/read" },
    { method: "HEAD", url: "/read" },
    { method: "OPTIONS", url: "/read" },
    { method: "POST", url: "/api/v1/runs/run-1:cancel" },
    {
      method: "POST",
      url: "/api/v1/threads/thread-1/workspace-list/execution-1:cancel",
    },
    {
      method: "POST",
      url: "/api/v1/threads/thread-1/workspace-list/execution-1:reconcile",
    },
    { method: "DELETE", url: "/api/v1/threads/thread-1/goal" },
    {
      method: "POST",
      url: "/api/v1/tool-approvals/approval-1:decide",
      payload: { decision: "rejected" },
    },
  ] as const)
    assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal(checks, 0);

  for (const request of [
    { method: "POST", url: "/api/v1/threads" },
    { method: "PUT", url: "/api/v1/threads/thread-1/goal" },
    { method: "POST", url: "/api/v1/runs/run-1:cancel/extra" },
    {
      method: "POST",
      url: "/api/v1/tool-approvals/approval-1:decide",
      payload: { decision: "approved" },
    },
    {
      method: "POST",
      url: "/api/v1/tool-approvals/approval-1:decide",
      payload: { decision: "denied" },
    },
    {
      method: "POST",
      url: "/api/v1/threads?decision=rejected&route=/api/v1/runs/run:cancel",
    },
  ] as const) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["retry-after"], "2");
    assert.equal(response.json().error.code, "storage_capacity_low");
  }
  assert.equal(checks, 6);
  failure = new StorageAdmissionError("storage_capacity_unknown");
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/v1/threads" })).json().error
      .code,
    "storage_capacity_unknown",
  );
  failure = new Error("unrelated_failure");
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/v1/threads" })).statusCode,
    500,
  );
  failure = null;
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/v1/threads" })).statusCode,
    200,
  );
});

test("actual SQLite Control API rejects new writes under pressure and preserves cancellation, auth and idempotency", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-api-storage-"));
  const databasePath = join(directory, "store.sqlite");
  const actor = {
    principalId: "principal-storage",
    actorId: "actor-storage",
    tenantId: "tenant-storage",
    spaceId: "space-storage",
  };
  const sessionToken = "storage-session-token-32-bytes-minimum";
  const csrfToken = "storage-csrf-token-32-bytes-minimum";
  const origin = "http://127.0.0.1:5175";
  let blocked = false;
  let checks = 0;
  const runtime = createStandaloneControlApi({
    databasePath,
    actor,
    sessionToken,
    csrfToken,
    allowedOrigins: [origin],
    defaultAgentVersionId: "agent-version-storage",
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "storage-test-key",
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    automationScanIntervalMs: null,
    storageAdmission: {
      async assertNewWorkAllowed() {
        checks += 1;
        if (blocked) throw new StorageAdmissionError("storage_capacity_low");
      },
    },
  });
  const store = new SqliteRunStore(databasePath);
  context.after(async () => {
    await runtime.app.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const headers = (key: string) => ({
    "authorization": `Bearer ${sessionToken}`,
    origin,
    "x-csrf-token": csrfToken,
    "idempotency-key": key,
  });
  const created = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: headers("thread-create"),
    payload: { title: "Storage pressure" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const threadId = created.json<ThreadMutationResponse>().thread.threadId;
  const goal = await runtime.app.inject({
    method: "PUT",
    url: `/api/v1/threads/${threadId}/goal`,
    headers: headers("goal"),
    payload: {
      expectedRevision: null,
      objective: "Storage recovery",
      status: "paused",
      tokenBudget: { kind: "set", value: null },
    },
  });
  assert.equal(goal.statusCode, 201, goal.body);
  const runs = new RunApplicationService({
    store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: new SystemApplicationClock(),
    ids: new UuidV7ApplicationIdGenerator(),
  });
  const run = await runs.createRun(actor, {
    kind: "run.create",
    idempotencyKey: "create-run",
    threadId,
    route: {
      authorityId: "standalone-storage",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-storage",
      policySnapshotId: "policy-storage",
      workspaceBindingId: null,
    },
  });
  blocked = true;
  const denied = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: headers("thread-later"),
    payload: { title: "Later" },
  });
  assert.equal(denied.statusCode, 503, denied.body);
  assert.equal(denied.headers["retry-after"], "30");
  assert.equal(denied.json().error.code, "storage_capacity_low");
  const checkCount = checks;
  const read = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/threads/${threadId}`,
    headers: headers("read"),
  });
  assert.equal(read.statusCode, 200, read.body);
  const cancelRequest = {
    method: "POST",
    url: `/api/v1/runs/${run.state.runId}:cancel`,
    headers: headers("cancel"),
    payload: { expectedRevision: run.state.revision },
  } as const;
  const unauthorized = await runtime.app.inject({
    ...cancelRequest,
    headers: { ...headers("cancel"), authorization: "Bearer invalid" },
  });
  assert.equal(unauthorized.statusCode, 401, unauthorized.body);
  const canceled = await runtime.app.inject(cancelRequest);
  assert.equal(canceled.statusCode, 200, canceled.body);
  assert.equal(canceled.json().run.cancelRequested, true);
  const replayed = await runtime.app.inject(cancelRequest);
  assert.equal(replayed.statusCode, 200, replayed.body);
  assert.equal(replayed.json().disposition, "replayed");
  const clear = await runtime.app.inject({
    method: "DELETE",
    url: `/api/v1/threads/${threadId}/goal`,
    headers: headers("clear"),
    payload: { expectedRevision: 1 },
  });
  assert.equal(clear.statusCode, 200, clear.body);
  const rejected = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/tool-approvals/missing:decide",
    headers: headers("reject"),
    payload: { expectedRevision: 1, decision: "rejected", comment: null },
  });
  assert.equal(rejected.statusCode, 404, rejected.body);
  assert.equal(checks, checkCount);
  blocked = false;
  const resumed = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: headers("thread-later"),
    payload: { title: "Later" },
  });
  assert.equal(resumed.statusCode, 201, resumed.body);
});
