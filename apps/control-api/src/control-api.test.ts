import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";

import {
  compileAgentVersion,
  createAgentVersionAsset,
  type AgentVersionSource,
} from "@crewon/agent-version";
import {
  AgentVersionApplicationService,
  AgentVersionCatalogApplicationService,
  ApplicationError,
  ArtifactApplicationService,
  AutomationApplicationService,
  ModelProviderSettingsApplicationService,
  compileAgentVersionReleaseBundle,
  RunApplicationService,
  RunExecutionService,
  ThreadApplicationService,
  ThreadGoalApplicationService,
  ThreadRollbackApplicationService,
  ToolApprovalApplicationService,
  TurnApplicationService,
  ThreadCompactionApplicationService,
  WorkspaceOperationQueryService,
  WorkflowVersionApplicationService,
  type ActorContext,
  type ApplicationClock,
  type ApplicationIdGenerator,
  type ApplicationIdKind,
  type AutomationApplicationIdGenerator,
  type AutomationApplicationIdKind,
} from "@crewon/application";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { InMemoryWorkflowVersionStore } from "@crewon/store";
import type {
  ActiveAgentVersionCatalogResponse,
  AgentVersionMutationResponse,
  AppendThreadMessageResponse,
  AutomationMutationResponse,
  ErrorEnvelope,
  GetAgentVersionResponse,
  GetAutomationResponse,
  GetModelProviderSettingsResponse,
  GetThreadGoalResponse,
  ListThreadMessagesResponse,
  ListAgentVersionsResponse,
  ListAutomationsResponse,
  WorkflowVersionMutationResponse,
  GetWorkflowVersionResponse,
  ListWorkflowVersionsResponse,
  ProbeModelProviderResponse,
  GetToolApprovalResponse,
  ListThreadRunsResponse,
  ListThreadsResponse,
  RunMutationResponse,
  RunAutomationNowResponse,
  StartTurnResponse,
  ThreadEventView,
  ThreadGoalEventView,
  ThreadGoalMutationResponse,
  ThreadMutationResponse,
  ToolApprovalMutationResponse,
} from "@crewon/contracts";
import {
  formatMessageCursor,
  formatThreadCursor,
  formatThreadRunCursor,
} from "@crewon/contracts";
import {
  reduceRunLifecycleEvent,
  type RunLifecycleEvent,
  type WorkflowVersionSource,
} from "@crewon/domain";
import { InMemoryRunStore } from "@crewon/store";
import type { FastifyInstance } from "fastify";

import { buildControlApi } from "./control-api.ts";
import { ProcessLocalActivationGate } from "./paused-admission.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { RunEventHub } from "./run-event-hub.ts";
import type { ThreadEventPoller } from "./thread-event-stream.ts";
import type { ThreadGoalEventPoller } from "./thread-goal-event-stream.ts";
import {
  projectRun,
  projectRunEvent,
  projectRunEventForView,
} from "./run-projection.ts";
import { projectMessage } from "./thread-projection.ts";
import {
  AdmittedAgentVersionRunRouteResolver,
  StandaloneAuthorization,
  StandaloneIdentity,
  StoreBackedAgentVersionAdmission,
  StoreReadiness,
  NodeSha256ContentDigester,
} from "./standalone-adapters.ts";

const SESSION_TOKEN = "session-token-32-bytes-minimum-0001";
const CSRF_TOKEN = "csrf-token-32-bytes-minimum-value-1";
const ORIGIN = "http://127.0.0.1:5175";

test("creates, reads, lists and invokes one redacted manual-only Automation", async (context) => {
  const runtime = await testRuntime(context);
  const threadResponse = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: jsonMutationHeaders("automation-thread-create"),
    payload: { title: "Automation thread" },
  });
  assert.equal(threadResponse.statusCode, 201, threadResponse.body);
  const thread = threadResponse.json<ThreadMutationResponse>().thread;
  const request = {
    threadId: thread.threadId,
    expectedThreadRevision: thread.revision,
    title: "Review changes",
    prompt: "Review the current changes and summarize risks.",
    agentVersionId: null,
  };
  const createdResponse = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/automations",
    headers: jsonMutationHeaders("automation-create-1"),
    payload: request,
  });
  assert.equal(createdResponse.statusCode, 201, createdResponse.body);
  const created = createdResponse.json<AutomationMutationResponse>();
  assert.deepEqual(created, {
    disposition: "committed",
    automation: {
      automationId: "automation-1",
      threadId: thread.threadId,
      title: request.title,
      prompt: request.prompt,
      agentVersionId: "agent-version-1",
      executionMode: "manualOnly",
      automaticScheduling: false,
      revision: 1,
      createdAt: created.automation.createdAt,
      updatedAt: created.automation.createdAt,
    },
  });
  for (const privateField of [
    "tenantId",
    "spaceId",
    "createdByActorId",
    "definitionDigest",
    "instructionDigest",
    "routeDigest",
    "schedule",
  ]) {
    assert.equal(createdResponse.body.includes(privateField), false);
  }
  const replay = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/automations",
    headers: jsonMutationHeaders("automation-create-1"),
    payload: request,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(
    replay.json<AutomationMutationResponse>().disposition,
    "replayed",
  );
  const get = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/automations/${created.automation.automationId}`,
    headers: readHeaders(),
  });
  assert.deepEqual(get.json<GetAutomationResponse>(), {
    automation: created.automation,
  });
  const list = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/automations?limit=25",
    headers: readHeaders(),
  });
  assert.deepEqual(list.json<ListAutomationsResponse>(), {
    data: [created.automation],
    nextCursor: null,
  });
  const run = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/automations/${created.automation.automationId}:run-now`,
    headers: jsonMutationHeaders("automation-run-1"),
    payload: {
      expectedAutomationRevision: created.automation.revision,
      expectedThreadRevision: thread.revision,
    },
  });
  assert.equal(run.statusCode, 201, run.body);
  const invocation = run.json<RunAutomationNowResponse>();
  assert.deepEqual(invocation.automation, created.automation);
  assert.deepEqual(invocation.invocation, {
    automationId: created.automation.automationId,
    runId: invocation.run.runId,
  });
  assert.equal(invocation.run.threadId, thread.threadId);
  assert.equal(invocation.run.purpose, "turn");
  assert.equal(run.body.includes("origin"), false);
  assert.equal(runtime.outboxWakeups(), 1);
});

test("fenced Control admission exposes only exact health activation surfaces", async (context) => {
  const runtime = await testRuntime(context);
  const gate = new ProcessLocalActivationGate();
  const app = buildControlApi({
    ...runtime.dependencies,
    activationGate: gate,
  });
  context.after(() => app.close());
  for (const url of ["/api/v1/health/live", "/api/v1/health/ready"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, response.body);
  }
  for (const request of [
    { method: "POST", url: "/api/v1/health/live" },
    { method: "GET", url: "/api/v1/health/live?probe=1" },
    { method: "GET", url: "/api/v1/threads" },
  ] as const) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(
      response.json<ErrorEnvelope>().error.code,
      "control_activation_pending",
    );
  }
  assert.equal(gate.activate(), true);
  const activated = await app.inject({
    method: "GET",
    url: "/api/v1/threads",
    headers: readHeaders(),
  });
  assert.equal(activated.statusCode, 200, activated.body);
});

test("exposes a safe Provider snapshot and replays one bounded probe", async (context) => {
  const runtime = await testRuntime(context);
  const snapshotResponse = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/model-provider-settings",
    headers: readHeaders(),
  });
  assert.equal(snapshotResponse.statusCode, 200, snapshotResponse.body);
  assert.deepEqual(snapshotResponse.json<GetModelProviderSettingsResponse>(), {
    settings: {
      revision: 0,
      activeProviderId: null,
      providers: [],
      runtimeAvailability: "unconfigured",
      updatedAt: null,
    },
  });
  for (const privateField of [
    "runtimeBindingId",
    "coordinatorBinding",
    "operationId",
    "tenantId",
    "secret",
  ]) {
    assert.equal(snapshotResponse.body.includes(privateField), false);
  }

  let probes = 0;
  const app = buildControlApi({
    ...runtime.dependencies,
    providerProbes: {
      probe: async () => {
        probes += 1;
        return {
          providerId: "gateway",
          catalogRevision: 1,
          runtimeBindingId: "private-runtime-binding",
          status: "ok",
          models: [{ id: "model-1", displayName: "Model One" }],
          modelCount: 1,
          latencyMs: 7,
          retryable: false,
          retryAfterMs: null,
        };
      },
    },
  });
  context.after(() => app.close());
  const request = () =>
    app.inject({
      method: "POST",
      url: "/api/v1/model-provider-settings/probe",
      headers: mutationHeaders("provider-probe-one-action"),
      payload: {},
    });
  const first = await request();
  const replay = await request();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(first.json<ProbeModelProviderResponse>(), {
    disposition: "completed",
    providerId: "gateway",
    catalogRevision: 1,
    status: "ok",
    models: [{ id: "model-1", displayName: "Model One" }],
    modelCount: 1,
    latencyMs: 7,
    retryable: false,
    retryAfterMs: null,
  });
  assert.deepEqual(replay.json(), {
    ...first.json<ProbeModelProviderResponse>(),
    disposition: "replayed",
  });
  assert.equal(probes, 1);
  assert.equal(first.body.includes("runtimeBindingId"), false);

  const missingIdempotency = await app.inject({
    method: "POST",
    url: "/api/v1/model-provider-settings/probe",
    headers: {
      "authorization": `Bearer ${SESSION_TOKEN}`,
      "origin": ORIGIN,
      "x-csrf-token": CSRF_TOKEN,
    },
    payload: {},
  });
  assertError(missingIdempotency, 400, "validation", "idempotency_key_invalid");
  const missingCsrf = await app.inject({
    method: "POST",
    url: "/api/v1/model-provider-settings/probe",
    headers: {
      "authorization": `Bearer ${SESSION_TOKEN}`,
      "origin": ORIGIN,
      "idempotency-key": "provider-probe-no-csrf",
    },
    payload: {},
  });
  assertError(missingCsrf, 403, "authorization", "csrf_invalid");
  const injected = await app.inject({
    method: "POST",
    url: "/api/v1/model-provider-settings/probe",
    headers: mutationHeaders("provider-probe-injected"),
    payload: { endpoint: "http://169.254.169.254" },
  });
  assertError(
    injected,
    400,
    "validation",
    "model_provider_probe_fields_invalid",
  );
});

test("atomically starts one Goal Turn and replays the original durable result", async (context) => {
  const runtime = await testRuntime(context);
  const createdThread = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("turn-thread-1"),
    payload: { title: "Atomic turn" },
  });
  assert.equal(createdThread.statusCode, 201, createdThread.body);

  const start = () =>
    runtime.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread-1/turns",
      headers: mutationHeaders("turn-start-1"),
      payload: {
        expectedRevision: 1,
        content: "hello atomically",
        agentVersionId: null,
        executionIntent: "goal",
      },
    });
  const started = await start();
  assert.equal(started.statusCode, 201, started.body);
  const body = started.json<StartTurnResponse>();
  assert.equal(body.disposition, "committed");
  assert.equal(body.thread.revision, 2);
  assert.equal(body.message.sequence, 1);
  assert.equal(body.message.content, "hello atomically");
  assert.equal(body.run.status, "queued");
  assert.equal(body.run.collaborationMode, "default");
  assert.equal(body.run.goalBinding?.revision, 1);
  assert.equal(
    (
      await runtime.store.loadThreadGoal({
        tenantId: "standalone-tenant",
        threadId: "thread-1",
      })
    )?.objective,
    "hello atomically",
  );
  const goalResponse = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/threads/thread-1/goal",
    headers: readHeaders(),
  });
  assert.equal(goalResponse.statusCode, 200, goalResponse.body);
  const goalSnapshot = goalResponse.json<GetThreadGoalResponse>();
  const visibleGoal = goalSnapshot.goal;
  assert.equal(goalSnapshot.eventSequence, 1);
  assert.equal(visibleGoal?.objective, "hello atomically");
  assert.equal(visibleGoal?.goalId, body.run.goalBinding?.goalId);
  assert.equal(visibleGoal?.revision, body.run.goalBinding?.revision);
  assert.equal(visibleGoal?.tokenBudget, 200_000);
  assert.equal("tenantId" in (visibleGoal ?? {}), false);

  const replayed = await start();
  assert.equal(replayed.statusCode, 200, replayed.body);
  assert.deepEqual(replayed.json(), { ...body, disposition: "replayed" });

  const concurrent = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1/turns",
    headers: mutationHeaders("turn-start-2"),
    payload: {
      expectedRevision: 2,
      content: "must not create a parallel Run",
      agentVersionId: null,
      executionIntent: "none",
    },
  });
  assertError(concurrent, 409, "conflict", "thread_active_run_conflict");

  const messages = await runtime.store.listMessages(
    { tenantId: "standalone-tenant", threadId: "thread-1" },
    0,
    10,
  );
  const runs = await runtime.store.listThreadRuns({
    tenantId: "standalone-tenant",
    spaceId: "standalone-space",
    threadId: "thread-1",
    before: null,
    limit: 10,
  });
  assert.equal(messages.length, 1);
  assert.equal(runs.length, 1);
});

test("sets, replays and clears a persistent Goal with safe Run projections", async (context) => {
  const runtime = await testRuntime(context);
  const createdThread = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("goal-thread-1"),
    payload: { title: "Goal mutation" },
  });
  assert.equal(createdThread.statusCode, 201, createdThread.body);

  const initialSnapshot = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/threads/thread-1/goal",
    headers: readHeaders(),
  });
  assert.deepEqual(initialSnapshot.json<GetThreadGoalResponse>(), {
    goal: null,
    eventSequence: 0,
  });

  const createGoal = () =>
    runtime.app.inject({
      method: "PUT",
      url: "/api/v1/threads/thread-1/goal",
      headers: mutationHeaders("goal-set-1"),
      payload: {
        expectedRevision: null,
        objective: "完成全部 TypeScript 迁移",
        status: "active",
        tokenBudget: { kind: "set", value: null },
      },
    });
  const created = await createGoal();
  assert.equal(created.statusCode, 201, created.body);
  const createdBody = created.json<ThreadGoalMutationResponse>();
  assert.equal(createdBody.disposition, "committed");
  assert.equal(createdBody.goal?.revision, 1);
  assert.equal(createdBody.goal?.objective, "完成全部 TypeScript 迁移");
  assert.equal(createdBody.goal?.tokenBudget, null);
  assert.equal(createdBody.canceledRun, null);
  assert.equal(createdBody.retainedRun, null);
  assert.equal(createdBody.continuationRun?.status, "queued");
  assert.equal(createdBody.continuationRun?.goalBinding?.revision, 1);
  assertGoalMutationProjectionSafe(createdBody);

  const replayedCreate = await createGoal();
  assert.equal(replayedCreate.statusCode, 200, replayedCreate.body);
  assert.deepEqual(replayedCreate.json(), {
    ...createdBody,
    disposition: "replayed",
  });

  const updated = await runtime.app.inject({
    method: "PUT",
    url: "/api/v1/threads/thread-1/goal",
    headers: mutationHeaders("goal-set-2"),
    payload: {
      expectedRevision: 1,
      objective: "完成全部 TypeScript 迁移并验证",
      status: null,
      tokenBudget: { kind: "keep" },
    },
  });
  assert.equal(updated.statusCode, 201, updated.body);
  const updatedBody = updated.json<ThreadGoalMutationResponse>();
  assert.equal(updatedBody.goal?.revision, 2);
  assert.equal(updatedBody.goal?.tokenBudget, null);
  assert.equal(
    updatedBody.canceledRun?.runId,
    createdBody.continuationRun?.runId,
  );
  assert.equal(updatedBody.canceledRun?.status, "canceled");
  assert.equal(updatedBody.retainedRun, null);
  assert.equal(updatedBody.continuationRun?.status, "queued");
  assert.equal(updatedBody.continuationRun?.goalBinding?.revision, 2);
  assertGoalMutationProjectionSafe(updatedBody);

  const clearGoal = () =>
    runtime.app.inject({
      method: "DELETE",
      url: "/api/v1/threads/thread-1/goal",
      headers: mutationHeaders("goal-clear-1"),
      payload: { expectedRevision: 2 },
    });
  const cleared = await clearGoal();
  assert.equal(cleared.statusCode, 200, cleared.body);
  const clearedBody = cleared.json<ThreadGoalMutationResponse>();
  assert.equal(clearedBody.disposition, "committed");
  assert.equal(clearedBody.goal, null);
  assert.equal(
    clearedBody.canceledRun?.runId,
    updatedBody.continuationRun?.runId,
  );
  assert.equal(clearedBody.canceledRun?.status, "canceled");
  assert.equal(clearedBody.retainedRun, null);
  assert.equal(clearedBody.continuationRun, null);
  assertGoalMutationProjectionSafe(clearedBody);

  const clearedSnapshot = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/threads/thread-1/goal",
    headers: readHeaders(),
  });
  assert.deepEqual(clearedSnapshot.json<GetThreadGoalResponse>(), {
    goal: null,
    eventSequence: 3,
  });

  const replayedClear = await clearGoal();
  assert.equal(replayedClear.statusCode, 200, replayedClear.body);
  assert.deepEqual(replayedClear.json(), {
    ...clearedBody,
    disposition: "replayed",
  });
  assert.equal(runtime.outboxWakeups(), 5);
});

test("requires CSRF and Idempotency-Key and rejects Goal authority injection", async (context) => {
  const runtime = await testRuntime(context);
  const body = {
    expectedRevision: null,
    objective: "secure goal",
    status: "active",
    tokenBudget: { kind: "keep" },
  };

  const missingCsrf = await runtime.app.inject({
    method: "PUT",
    url: "/api/v1/threads/thread-1/goal",
    headers: {
      "authorization": `Bearer ${SESSION_TOKEN}`,
      "origin": ORIGIN,
      "idempotency-key": "goal-missing-csrf",
    },
    payload: body,
  });
  assertError(missingCsrf, 403, "authorization", "csrf_invalid");

  const missingClearCsrf = await runtime.app.inject({
    method: "DELETE",
    url: "/api/v1/threads/thread-1/goal",
    headers: {
      "authorization": `Bearer ${SESSION_TOKEN}`,
      "origin": ORIGIN,
      "idempotency-key": "goal-clear-missing-csrf",
    },
    payload: { expectedRevision: 1 },
  });
  assertError(missingClearCsrf, 403, "authorization", "csrf_invalid");

  const missingIdempotency = await runtime.app.inject({
    method: "PUT",
    url: "/api/v1/threads/thread-1/goal",
    headers: {
      ...readHeaders(),
      "x-csrf-token": CSRF_TOKEN,
    },
    payload: body,
  });
  assertError(missingIdempotency, 400, "validation", "idempotency_key_invalid");

  const missingClearIdempotency = await runtime.app.inject({
    method: "DELETE",
    url: "/api/v1/threads/thread-1/goal",
    headers: {
      ...readHeaders(),
      "x-csrf-token": CSRF_TOKEN,
    },
    payload: { expectedRevision: 1 },
  });
  assertError(
    missingClearIdempotency,
    400,
    "validation",
    "idempotency_key_invalid",
  );

  const injected = await runtime.app.inject({
    method: "PUT",
    url: "/api/v1/threads/thread-1/goal",
    headers: mutationHeaders("goal-injected"),
    payload: { ...body, tenantId: "tenant-attacker" },
  });
  assertError(injected, 400, "validation", "set_thread_goal_fields_invalid");

  const injectedClear = await runtime.app.inject({
    method: "DELETE",
    url: "/api/v1/threads/thread-1/goal",
    headers: mutationHeaders("goal-clear-injected"),
    payload: { expectedRevision: 1, historyItem: "attacker" },
  });
  assertError(
    injectedClear,
    400,
    "validation",
    "clear_thread_goal_fields_invalid",
  );
});

test("streams durable Goal catch-up and polling across clear and reconnect without Run outbox", async (context) => {
  const poller = new ManualThreadGoalEventPoller();
  const runtime = await testRuntime(context, { threadGoalEventPoller: poller });
  await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = serverBaseUrl(runtime.app);

  const createdThread = await fetch(`${baseUrl}/api/v1/threads`, {
    method: "POST",
    headers: jsonMutationHeaders("goal-events-thread"),
    body: JSON.stringify({ title: "Goal events" }),
  });
  assert.equal(createdThread.status, 201);
  await createdThread.body?.cancel();

  const createdGoal = await fetch(`${baseUrl}/api/v1/threads/thread-1/goal`, {
    method: "PUT",
    headers: jsonMutationHeaders("goal-events-set-1"),
    body: JSON.stringify({
      expectedRevision: null,
      objective: "first goal",
      status: "active",
      tokenBudget: { kind: "set", value: 1_000 },
    }),
  });
  assert.equal(createdGoal.status, 201);
  await createdGoal.body?.cancel();

  const firstAbort = new AbortController();
  const firstStream = await fetch(
    `${baseUrl}/api/v1/threads/thread-1/goal/events`,
    { headers: readHeaders(), signal: firstAbort.signal },
  );
  assert.equal(firstStream.status, 200);
  assert.match(
    firstStream.headers.get("content-type") ?? "",
    /^text\/event-stream/,
  );
  const firstReader = new GoalSseReader(requiredBody(firstStream).getReader());
  const firstFrame = await firstReader.nextFrame();
  assert.equal(firstFrame.id, "1");
  assert.equal(firstFrame.event, "goal.updated");
  assert.equal(firstFrame.data.sequence, 1);
  assert.equal(firstFrame.data.type, "goal.updated");
  assert.equal(firstFrame.data.data.goal.revision, 1);
  assert.equal(firstFrame.data.data.goal.objective, "first goal");
  assertGoalEventSafe(firstFrame.data);
  await poller.waitUntilStarted(1);
  await firstReader.cancel();
  firstAbort.abort();

  const updatedGoal = await fetch(`${baseUrl}/api/v1/threads/thread-1/goal`, {
    method: "PUT",
    headers: jsonMutationHeaders("goal-events-set-2"),
    body: JSON.stringify({
      expectedRevision: 1,
      objective: "updated while disconnected",
      status: null,
      tokenBudget: { kind: "keep" },
    }),
  });
  assert.equal(updatedGoal.status, 201);
  await updatedGoal.body?.cancel();

  const clearPoll = poller.started + 1;
  const resumedAbort = new AbortController();
  const resumedStream = await fetch(
    `${baseUrl}/api/v1/threads/thread-1/goal/events`,
    {
      headers: { ...readHeaders(), "last-event-id": "1" },
      signal: resumedAbort.signal,
    },
  );
  const resumedReader = new GoalSseReader(
    requiredBody(resumedStream).getReader(),
  );
  const resumedFrame = await resumedReader.nextFrame();
  assert.equal(resumedFrame.id, "2");
  assert.equal(resumedFrame.data.type, "goal.updated");
  assert.equal(
    resumedFrame.data.data.goal.objective,
    "updated while disconnected",
  );
  assertGoalEventSafe(resumedFrame.data);
  await poller.waitUntilStarted(clearPoll);

  const clearedGoal = await fetch(`${baseUrl}/api/v1/threads/thread-1/goal`, {
    method: "DELETE",
    headers: jsonMutationHeaders("goal-events-clear"),
    body: JSON.stringify({ expectedRevision: 2 }),
  });
  assert.equal(clearedGoal.status, 200);
  await clearedGoal.body?.cancel();
  const recreatedPoll = poller.started + 1;
  poller.advance();

  const clearedFrame = await resumedReader.nextFrame();
  assert.equal(clearedFrame.id, "3");
  assert.equal(clearedFrame.event, "goal.cleared");
  assert.equal(clearedFrame.data.type, "goal.cleared");
  assert.equal(clearedFrame.data.data.previousRevision, 2);
  assertGoalEventSafe(clearedFrame.data);
  await poller.waitUntilStarted(recreatedPoll);

  const recreatedGoal = await fetch(`${baseUrl}/api/v1/threads/thread-1/goal`, {
    method: "PUT",
    headers: jsonMutationHeaders("goal-events-set-3"),
    body: JSON.stringify({
      expectedRevision: null,
      objective: "new goal after clear",
      status: "active",
      tokenBudget: { kind: "keep" },
    }),
  });
  assert.equal(recreatedGoal.status, 201);
  await recreatedGoal.body?.cancel();
  poller.advance();

  const recreatedFrame = await resumedReader.nextFrame();
  assert.equal(recreatedFrame.id, "4");
  assert.equal(recreatedFrame.data.type, "goal.updated");
  assert.equal(recreatedFrame.data.sequence, 4);
  assert.equal(recreatedFrame.data.data.goal.revision, 1);
  assert.equal(recreatedFrame.data.data.goal.objective, "new goal after clear");
  assertGoalEventSafe(recreatedFrame.data);
  const recreatedSnapshot = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/threads/thread-1/goal",
    headers: readHeaders(),
  });
  const recreatedSnapshotBody = recreatedSnapshot.json<GetThreadGoalResponse>();
  assert.equal(recreatedSnapshotBody.eventSequence, 4);
  assert.equal(recreatedSnapshotBody.goal?.revision, 1);
  assert.equal(recreatedSnapshotBody.goal?.objective, "new goal after clear");
  await resumedReader.cancel();
  resumedAbort.abort();

  const invalidCursor = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/threads/thread-1/goal/events",
    headers: { ...readHeaders(), "last-event-id": "01" },
  });
  assertError(invalidCursor, 400, "validation", "last_event_id_invalid");

  const foreignApp = buildControlApi({
    ...runtime.dependencies,
    identity: {
      resolveActor: async () => ({
        ...standaloneActor(),
        principalId: "foreign-principal",
        actorId: "foreign-actor",
        tenantId: "foreign-tenant",
      }),
    },
  });
  const crossTenant = await foreignApp.inject({
    method: "GET",
    url: "/api/v1/threads/thread-1/goal/events",
  });
  assertError(crossTenant, 404, "notFound", "thread_not_found");
  const crossTenantSnapshot = await foreignApp.inject({
    method: "GET",
    url: "/api/v1/threads/thread-1/goal",
  });
  assertError(crossTenantSnapshot, 404, "notFound", "thread_not_found");
  await foreignApp.close();
});

test("admits Plan as a one-Run mode without creating a persistent Goal", async (context) => {
  const runtime = await testRuntime(context);
  const createdThread = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("plan-thread-1"),
    payload: { title: "Plan turn" },
  });
  assert.equal(createdThread.statusCode, 201, createdThread.body);

  const started = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1/turns",
    headers: mutationHeaders("plan-turn-1"),
    payload: {
      expectedRevision: 1,
      content: "plan the migration",
      agentVersionId: null,
      executionIntent: "plan",
    },
  });

  assert.equal(started.statusCode, 201, started.body);
  const body = started.json<StartTurnResponse>();
  assert.equal(body.run.collaborationMode, "plan");
  assert.equal(body.run.goalBinding, null);
  assert.equal(
    await runtime.store.loadThreadGoal({
      tenantId: "standalone-tenant",
      threadId: "thread-1",
    }),
    null,
  );
});

test("serves health and strict authenticated Run create/get/cancel commands", async (context) => {
  const runtime = await testRuntime(context);
  const health = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/health/ready",
  });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: "ok" });

  const threadCreated = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("create-thread-http-1"),
    payload: { title: "HTTP thread" },
  });
  assert.equal(threadCreated.statusCode, 201);
  const threadCreatedBody = threadCreated.json<ThreadMutationResponse>();
  assert.equal(threadCreatedBody.thread.threadId, "thread-1");
  assert.equal(threadCreatedBody.thread.revision, 1);

  const forked = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1/forks",
    headers: mutationHeaders("fork-thread-http-1"),
    payload: { expectedRevision: 1, throughHistorySequence: 0 },
  });
  assert.equal(forked.statusCode, 201, forked.body);
  const forkedBody = forked.json<ThreadMutationResponse>();
  assert.equal(forkedBody.thread.threadId, "thread-2");
  assert.equal(forkedBody.thread.forkedFromThreadId, "thread-1");
  assert.equal(forkedBody.thread.forkedThroughHistorySequence, 0);

  const forkReplay = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1/forks",
    headers: mutationHeaders("fork-thread-http-1"),
    payload: { expectedRevision: 1, throughHistorySequence: 0 },
  });
  assert.equal(forkReplay.statusCode, 200);
  assert.deepEqual(forkReplay.json(), {
    ...forkedBody,
    disposition: "replayed",
  });

  const messageAppended = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1/messages",
    headers: mutationHeaders("append-message-http-1"),
    payload: { expectedRevision: 1, content: "hello from HTTP" },
  });
  assert.equal(messageAppended.statusCode, 201);
  const messageAppendedBody =
    messageAppended.json<AppendThreadMessageResponse>();
  assert.equal(messageAppendedBody.message.role, "user");
  assert.equal(messageAppendedBody.message.sequence, 1);
  assert.equal(messageAppendedBody.thread.revision, 2);

  const messages = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/threads/thread-1/messages?limit=1",
    headers: readHeaders(),
  });
  assert.equal(messages.statusCode, 200, messages.body);
  assert.deepEqual(messages.json<ListThreadMessagesResponse>(), {
    data: [messageAppendedBody.message],
    nextCursor: formatMessageCursor(1),
  });

  const threadList = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/threads?limit=1",
    headers: readHeaders(),
  });
  assert.equal(threadList.statusCode, 200, threadList.body);
  assert.deepEqual(threadList.json<ListThreadsResponse>(), {
    data: [messageAppendedBody.thread],
    nextCursor: formatThreadCursor({
      updatedAt: messageAppendedBody.thread.updatedAt,
      threadId: messageAppendedBody.thread.threadId,
    }),
  });

  const created = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/runs",
    headers: mutationHeaders("create-http-1"),
    payload: { threadId: "thread-1" },
  });
  assert.equal(created.statusCode, 201);
  const createdBody = created.json<RunMutationResponse>();
  assert.equal(createdBody.disposition, "committed");
  assert.equal(createdBody.run.runId, "run-1");
  assert.equal(createdBody.run.status, "queued");
  assertPublicProjection(createdBody);

  const threadRuns = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/threads/thread-1/runs?limit=1",
    headers: readHeaders(),
  });
  assert.equal(threadRuns.statusCode, 200, threadRuns.body);
  assert.deepEqual(threadRuns.json<ListThreadRunsResponse>(), {
    data: [createdBody.run],
    nextCursor: formatThreadRunCursor({
      updatedAt: createdBody.run.updatedAt,
      runId: createdBody.run.runId,
    }),
  });

  const replayed = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/runs",
    headers: mutationHeaders("create-http-1"),
    payload: { threadId: "thread-1" },
  });
  assert.equal(replayed.statusCode, 200);
  assert.deepEqual(replayed.json(), {
    ...createdBody,
    disposition: "replayed",
  });

  const read = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/runs/${createdBody.run.runId}`,
    headers: readHeaders(),
  });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), { run: createdBody.run });

  const canceled = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/runs/${createdBody.run.runId}:cancel`,
    headers: mutationHeaders("cancel-http-1"),
    payload: { expectedRevision: 1 },
  });
  assert.equal(canceled.statusCode, 200);
  const canceledBody = canceled.json<RunMutationResponse>();
  assert.equal(canceledBody.run.cancelRequested, true);
  assert.equal(canceledBody.run.revision, 2);
  assertPublicProjection(canceledBody);

  const stale = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/runs/${createdBody.run.runId}:cancel`,
    headers: mutationHeaders("cancel-http-stale"),
    payload: { expectedRevision: 1 },
  });
  assertError(stale, 409, "conflict", "revision_conflict");
});

test("admits and replays a manual compaction maintenance Run", async (context) => {
  const runtime = await testRuntime(context);
  const created = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("compact-thread-create"),
    payload: { title: "Compact me" },
  });
  assert.equal(created.statusCode, 201, created.body);

  const empty = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:compact",
    headers: mutationHeaders("compact-empty"),
    payload: { expectedRevision: 1, agentVersionId: null },
  });
  assert.equal(empty.statusCode, 409, empty.body);
  assertError(empty, 409, "conflict", "context_compaction_not_applicable");

  const appended = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1/messages",
    headers: mutationHeaders("compact-message"),
    payload: { expectedRevision: 1, content: "conversation history" },
  });
  assert.equal(appended.statusCode, 201, appended.body);

  const compact = () =>
    runtime.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread-1:compact",
      headers: mutationHeaders("compact-thread-1"),
      payload: { expectedRevision: 2, agentVersionId: null },
    });
  const admitted = await compact();
  assert.equal(admitted.statusCode, 201, admitted.body);
  const body = admitted.json<RunMutationResponse>();
  assert.equal(body.run.purpose, "manualCompaction");
  assert.equal(body.run.status, "queued");
  assert.equal(body.run.goalBinding, null);

  const replay = await compact();
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), { ...body, disposition: "replayed" });

  const parallel = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:compact",
    headers: mutationHeaders("compact-thread-2"),
    payload: { expectedRevision: 2, agentVersionId: null },
  });
  assertError(
    parallel,
    409,
    "conflict",
    "manual_compaction_admission_conflict",
  );
});

test("commits and replays a redacted append-only Thread rollback", async (context) => {
  const runtime = await testRuntime(context);
  const created = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("rollback-thread-create"),
    payload: { title: "Rollback target" },
  });
  assert.equal(created.statusCode, 201, created.body);

  const missingCsrf = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:rollback",
    headers: {
      "authorization": `Bearer ${SESSION_TOKEN}`,
      "origin": ORIGIN,
      "idempotency-key": "rollback-missing-csrf",
    },
    payload: { expectedRevision: 1, numTurns: 1 },
  });
  assertError(missingCsrf, 403, "authorization", "csrf_invalid");

  const missingIdempotency = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:rollback",
    headers: { ...readHeaders(), "x-csrf-token": CSRF_TOKEN },
    payload: { expectedRevision: 1, numTurns: 1 },
  });
  assertError(missingIdempotency, 400, "validation", "idempotency_key_invalid");

  const appended = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1/messages",
    headers: mutationHeaders("rollback-message"),
    payload: { expectedRevision: 1, content: "remove this turn" },
  });
  assert.equal(appended.statusCode, 201, appended.body);

  const injected = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:rollback",
    headers: mutationHeaders("rollback-injected"),
    payload: { expectedRevision: 2, numTurns: 1, actorId: "attacker" },
  });
  assertError(injected, 400, "validation", "rollback_thread_fields_invalid");

  const rollback = () =>
    runtime.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread-1:rollback",
      headers: mutationHeaders("rollback-thread-1"),
      payload: { expectedRevision: 2, numTurns: 1 },
    });
  const committed = await rollback();
  assert.equal(committed.statusCode, 201, committed.body);
  const body = committed.json<ThreadMutationResponse>();
  assert.deepEqual(Object.keys(body).sort(), ["disposition", "thread"]);
  assert.equal(body.disposition, "committed");
  assert.equal(body.thread.revision, 3);
  const publicJson = JSON.stringify(body);
  for (const forbidden of [
    "actorId",
    "rollbackId",
    "markerItemId",
    "historyFromSequence",
    "historyThroughSequence",
    "markerHistorySequence",
    "invalidatedMessages",
  ]) {
    assert.equal(publicJson.includes(forbidden), false);
  }

  const replayed = await rollback();
  assert.equal(replayed.statusCode, 200, replayed.body);
  assert.deepEqual(replayed.json(), { ...body, disposition: "replayed" });

  const changedFingerprint = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:rollback",
    headers: mutationHeaders("rollback-thread-1"),
    payload: { expectedRevision: 2, numTurns: 2 },
  });
  assertError(changedFingerprint, 409, "conflict", "idempotency_conflict");

  const stale = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:rollback",
    headers: mutationHeaders("rollback-thread-stale"),
    payload: { expectedRevision: 2, numTurns: 1 },
  });
  assertError(stale, 409, "conflict", "revision_conflict");

  const activeThread = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("rollback-active-thread-create"),
    payload: { title: "Active Run rollback target" },
  });
  assert.equal(activeThread.statusCode, 201, activeThread.body);
  const activeThreadId =
    activeThread.json<ThreadMutationResponse>().thread.threadId;
  const activeRun = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/runs",
    headers: mutationHeaders("rollback-active-run-create"),
    payload: { threadId: activeThreadId },
  });
  assert.equal(activeRun.statusCode, 201, activeRun.body);
  const activeConflict = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/threads/${activeThreadId}:rollback`,
    headers: mutationHeaders("rollback-active-conflict"),
    payload: { expectedRevision: 1, numTurns: 1 },
  });
  assertError(activeConflict, 409, "conflict", "thread_active_run_conflict");

  await seedThread(runtime.store, {
    tenantId: "tenant-2",
    spaceId: "space-1",
    threadId: "thread-other-tenant",
  });
  await seedThread(runtime.store, {
    tenantId: "tenant-1",
    spaceId: "space-2",
    threadId: "thread-other-space",
  });
  for (const threadId of ["thread-other-tenant", "thread-other-space"]) {
    const hidden = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/threads/${threadId}:rollback`,
      headers: mutationHeaders(`rollback-hidden-${threadId}`),
      payload: { expectedRevision: 1, numTurns: 1 },
    });
    assertError(hidden, 404, "notFound", "thread_not_found");
  }
});

test("maps every rollback admission fence to HTTP 409", async (context) => {
  const runtime = await testRuntime(context);
  let code = "thread_active_run_conflict";
  const app = buildControlApi({
    ...runtime.dependencies,
    rollbacks: {
      rollbackThread: async () => {
        throw new ApplicationError("conflict", code);
      },
    } as unknown as ThreadRollbackApplicationService,
  });
  context.after(() => app.close());

  for (const conflictCode of [
    "thread_active_run_conflict",
    "thread_active_work_conflict",
    "model_history_sequence_conflict",
  ]) {
    code = conflictCode;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/threads/thread-1:rollback",
      headers: mutationHeaders(`rollback-conflict-${conflictCode}`),
      payload: { expectedRevision: 1, numTurns: 1 },
    });
    assertError(response, 409, "conflict", conflictCode);
  }
});

test("archives a Thread with CSRF, CAS and an idempotent durable receipt", async (context) => {
  const runtime = await testRuntime(context);
  const created = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("archive-thread-create"),
    payload: { title: "Archive me" },
  });
  assert.equal(created.statusCode, 201, created.body);

  const missingCsrf = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:archive",
    headers: {
      ...readHeaders(),
      "idempotency-key": "archive-missing-csrf",
    },
    payload: { expectedRevision: 1 },
  });
  assertError(missingCsrf, 403, "authorization", "csrf_invalid");

  const missingIdempotency = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:archive",
    headers: {
      ...readHeaders(),
      "x-csrf-token": CSRF_TOKEN,
    },
    payload: { expectedRevision: 1 },
  });
  assertError(missingIdempotency, 400, "validation", "idempotency_key_invalid");

  const archive = () =>
    runtime.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread-1:archive",
      headers: mutationHeaders("archive-thread-1"),
      payload: { expectedRevision: 1 },
    });
  const archived = await archive();
  assert.equal(archived.statusCode, 200, archived.body);
  const body = archived.json<ThreadMutationResponse>();
  assert.equal(body.disposition, "committed");
  assert.equal(body.thread.status, "archived");
  assert.equal(body.thread.revision, 2);
  assert.notEqual(body.thread.archivedAt, null);

  const replayed = await archive();
  assert.equal(replayed.statusCode, 200, replayed.body);
  assert.deepEqual(replayed.json(), { ...body, disposition: "replayed" });
  const events = await runtime.store.listThreadEvents(
    { tenantId: "standalone-tenant", threadId: "thread-1" },
    1,
    10,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "thread.archived");

  const stale = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:archive",
    headers: mutationHeaders("archive-thread-stale"),
    payload: { expectedRevision: 1 },
  });
  assertError(stale, 409, "conflict", "revision_conflict");

  const injected = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:archive",
    headers: mutationHeaders("archive-thread-injected"),
    payload: { expectedRevision: 2, actorId: "attacker" },
  });
  assertError(injected, 400, "validation", "archive_thread_fields_invalid");
});

test("restores, renames and tombstones a Thread while atomically clearing its idle Goal", async (context) => {
  const poller = new ManualThreadGoalEventPoller();
  const runtime = await testRuntime(context, { threadEventPoller: poller });
  const created = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("lifecycle-thread-create"),
    payload: { title: "Lifecycle thread" },
  });
  assert.equal(created.statusCode, 201, created.body);

  const appended = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1/messages",
    headers: mutationHeaders("lifecycle-message"),
    payload: { expectedRevision: 1, content: "retained audit content" },
  });
  assert.equal(appended.statusCode, 201, appended.body);

  const goal = await runtime.app.inject({
    method: "PUT",
    url: "/api/v1/threads/thread-1/goal",
    headers: mutationHeaders("lifecycle-goal"),
    payload: {
      expectedRevision: null,
      objective: "must be cleared with the tombstone",
      status: "paused",
      tokenBudget: { kind: "set", value: null },
    },
  });
  assert.equal(goal.statusCode, 201, goal.body);

  const archived = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:archive",
    headers: mutationHeaders("lifecycle-archive"),
    payload: { expectedRevision: 2 },
  });
  assert.equal(archived.statusCode, 200, archived.body);
  const renamed = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:rename",
    headers: mutationHeaders("lifecycle-rename"),
    payload: { expectedRevision: 3, title: "Restored later" },
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(
    renamed.json<ThreadMutationResponse>().thread.status,
    "archived",
  );
  const unarchived = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads/thread-1:unarchive",
    headers: mutationHeaders("lifecycle-unarchive"),
    payload: { expectedRevision: 4 },
  });
  assert.equal(unarchived.statusCode, 200, unarchived.body);
  assert.equal(
    unarchived.json<ThreadMutationResponse>().thread.status,
    "active",
  );

  const remove = () =>
    runtime.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread-1:delete",
      headers: mutationHeaders("lifecycle-delete"),
      payload: { expectedRevision: 5 },
    });
  const removed = await remove();
  assert.equal(removed.statusCode, 200, removed.body);
  const removedBody = removed.json<ThreadMutationResponse>();
  assert.deepEqual(
    {
      disposition: removedBody.disposition,
      status: removedBody.thread.status,
      revision: removedBody.thread.revision,
      title: removedBody.thread.title,
      archivedAt: removedBody.thread.archivedAt,
      deletedAt: removedBody.thread.deletedAt,
    },
    {
      disposition: "committed",
      status: "deleted",
      revision: 6,
      title: null,
      archivedAt: null,
      deletedAt: removedBody.thread.updatedAt,
    },
  );
  const replayed = await remove();
  assert.equal(replayed.statusCode, 200, replayed.body);
  assert.deepEqual(replayed.json(), {
    ...removedBody,
    disposition: "replayed",
  });

  assert.equal(
    await runtime.store.loadThreadGoal({
      tenantId: "standalone-tenant",
      threadId: "thread-1",
    }),
    null,
  );
  assert.deepEqual(
    (
      await runtime.store.listThreadGoalEvents(
        { tenantId: "standalone-tenant", threadId: "thread-1" },
        0,
        10,
      )
    ).map((event) => event.type),
    ["goal.updated", "goal.cleared"],
  );

  const hiddenRequests = [
    runtime.app.inject({
      method: "GET",
      url: "/api/v1/threads/thread-1",
      headers: readHeaders(),
    }),
    runtime.app.inject({
      method: "GET",
      url: "/api/v1/threads/thread-1/messages",
      headers: readHeaders(),
    }),
    runtime.app.inject({
      method: "GET",
      url: "/api/v1/threads/thread-1/goal",
      headers: readHeaders(),
    }),
    runtime.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread-1/messages",
      headers: mutationHeaders("lifecycle-append-after-delete"),
      payload: { expectedRevision: 6, content: "must not append" },
    }),
    runtime.app.inject({
      method: "POST",
      url: "/api/v1/threads/thread-1/turns",
      headers: mutationHeaders("lifecycle-turn-after-delete"),
      payload: {
        expectedRevision: 6,
        content: "must not run",
        agentVersionId: null,
        executionIntent: "none",
      },
    }),
  ];
  for (const response of await Promise.all(hiddenRequests)) {
    assertError(response, 404, "notFound", "thread_not_found");
  }
  const listed = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/threads",
    headers: readHeaders(),
  });
  assert.deepEqual(listed.json<ListThreadsResponse>(), {
    data: [],
    nextCursor: null,
  });
  const auditedMessages = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/threads/thread-1/messages?view=audit",
    headers: readHeaders(),
  });
  assert.equal(auditedMessages.statusCode, 200, auditedMessages.body);
  assert.deepEqual(
    auditedMessages
      .json<ListThreadMessagesResponse>()
      .data.map((message) => message.content),
    ["retained audit content"],
  );
  assert.equal(
    (
      await runtime.store.listMessages(
        { tenantId: "standalone-tenant", threadId: "thread-1" },
        0,
        10,
      )
    ).length,
    1,
  );
  assert.deepEqual(
    await runtime.store.listThreadRuns({
      tenantId: "standalone-tenant",
      spaceId: "standalone-space",
      threadId: "thread-1",
      before: null,
      limit: 10,
    }),
    [],
  );

  await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = serverBaseUrl(runtime.app);
  const standardAbort = new AbortController();
  const standard = await fetch(`${baseUrl}/api/v1/threads/thread-1/events`, {
    headers: readHeaders(),
    signal: standardAbort.signal,
  });
  const standardReader = new ThreadSseReader(
    requiredBody(standard).getReader(),
  );
  const tombstone = await standardReader.nextFrame();
  assert.deepEqual(
    { id: tombstone.id, event: tombstone.event },
    { id: "6", event: "thread.deleted" },
  );
  await standardReader.cancel();
  standardAbort.abort();

  const auditAbort = new AbortController();
  const audit = await fetch(
    `${baseUrl}/api/v1/threads/thread-1/events?view=audit`,
    { headers: readHeaders(), signal: auditAbort.signal },
  );
  const auditReader = new ThreadSseReader(requiredBody(audit).getReader());
  const auditTypes: string[] = [];
  for (let sequence = 1; sequence <= 6; sequence += 1) {
    auditTypes.push((await auditReader.nextFrame()).event);
  }
  assert.deepEqual(auditTypes, [
    "thread.created",
    "thread.message.appended",
    "thread.archived",
    "thread.renamed",
    "thread.unarchived",
    "thread.deleted",
  ]);
  await auditReader.cancel();
  auditAbort.abort();
});

test("resumes durable Thread event SSE from Last-Event-ID without a Run outbox", async (context) => {
  const poller = new ManualThreadGoalEventPoller();
  const runtime = await testRuntime(context, { threadEventPoller: poller });
  await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = serverBaseUrl(runtime.app);

  const created = await fetch(`${baseUrl}/api/v1/threads`, {
    method: "POST",
    headers: jsonMutationHeaders("thread-events-create"),
    body: JSON.stringify({ title: "Thread events" }),
  });
  assert.equal(created.status, 201);
  await created.body?.cancel();

  const firstAbort = new AbortController();
  const firstStream = await fetch(`${baseUrl}/api/v1/threads/thread-1/events`, {
    headers: readHeaders(),
    signal: firstAbort.signal,
  });
  const firstReader = new ThreadSseReader(
    requiredBody(firstStream).getReader(),
  );
  const createdFrame = await firstReader.nextFrame();
  assert.equal(createdFrame.id, "1");
  assert.equal(createdFrame.event, "thread.created");
  assert.equal(createdFrame.data.threadId, "thread-1");
  assert.equal("data" in createdFrame.data, false);
  await firstReader.cancel();
  firstAbort.abort();

  const archived = await fetch(`${baseUrl}/api/v1/threads/thread-1:archive`, {
    method: "POST",
    headers: jsonMutationHeaders("thread-events-archive"),
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  assert.equal(archived.status, 200);
  await archived.body?.cancel();

  const resumedAbort = new AbortController();
  const resumedStream = await fetch(
    `${baseUrl}/api/v1/threads/thread-1/events`,
    {
      headers: { ...readHeaders(), "last-event-id": "1" },
      signal: resumedAbort.signal,
    },
  );
  const resumedReader = new ThreadSseReader(
    requiredBody(resumedStream).getReader(),
  );
  const archivedFrame = await resumedReader.nextFrame();
  assert.equal(archivedFrame.id, "2");
  assert.equal(archivedFrame.event, "thread.archived");
  assert.equal(archivedFrame.data.sequence, 2);
  assert.equal("data" in archivedFrame.data, false);
  await resumedReader.cancel();
  resumedAbort.abort();
});

test("serves authorized Artifact metadata and verified bytes without storage internals", async (context) => {
  const runtime = await testRuntime(context);
  const artifact = await runtime.artifacts.persistToolOutput({
    tenantId: "standalone-tenant",
    spaceId: "standalone-space",
    ownerActorId: "standalone-actor",
    runId: "run-artifact-1",
    stepId: "step-artifact-1",
    attemptId: "attempt-artifact-1",
    callId: "call-artifact-1",
    output: "complete raw Tool output",
    idempotencyKey: "artifact-http-1",
    maxArtifactBytes: 1024,
  });

  const metadata = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/artifacts/${artifact.artifactId}`,
    headers: readHeaders(),
  });
  assert.equal(metadata.statusCode, 200, metadata.body);
  assert.deepEqual(metadata.json(), {
    artifact: {
      artifactId: artifact.artifactId,
      kind: "toolOutput",
      mediaType: "text/plain",
      sensitivity: "workspaceSensitive",
      contentDigest: artifact.contentDigest,
      byteLength: artifact.byteLength,
      source: {
        kind: "toolOutput",
        runId: "run-artifact-1",
        stepId: "step-artifact-1",
        callId: "call-artifact-1",
      },
      retention: artifact.retention,
      encryption: { scheme: "aes256gcm" },
      scan: { status: "notRequired", scannedAt: null },
      createdAt: artifact.createdAt,
    },
  });
  for (const forbidden of ["ownerActorId", "attemptId", "keyId", "path"]) {
    assert.equal(metadata.body.includes(forbidden), false);
  }

  const content = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/artifacts/${artifact.artifactId}/content`,
    headers: readHeaders(),
  });
  assert.equal(content.statusCode, 200, content.body);
  assert.equal(content.headers["content-type"], "text/plain");
  assert.equal(content.headers.etag, `"${artifact.contentDigest}"`);
  assert.equal(content.body, "complete raw Tool output");
});

test("fails closed on missing identity, origin, CSRF and injected authority fields", async (context) => {
  const runtime = await testRuntime(context);

  const missingSession = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/runs",
    payload: { threadId: "thread-1" },
  });
  assertError(missingSession, 401, "authentication", "session_invalid");

  const badOrigin = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/runs",
    headers: {
      ...mutationHeaders("bad-origin"),
      origin: "https://attacker.invalid",
    },
    payload: { threadId: "thread-1" },
  });
  assertError(badOrigin, 403, "authorization", "origin_not_allowed");

  const missingCsrf = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/runs",
    headers: {
      "authorization": `Bearer ${SESSION_TOKEN}`,
      "origin": ORIGIN,
      "idempotency-key": "missing-csrf",
    },
    payload: { threadId: "thread-1" },
  });
  assertError(missingCsrf, 403, "authorization", "csrf_invalid");

  const injectedAuthority = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/runs",
    headers: mutationHeaders("injected-authority"),
    payload: {
      threadId: "thread-1",
      tenantId: "tenant-attacker",
      authorityId: "authority-attacker",
    },
  });
  assertError(
    injectedAuthority,
    400,
    "validation",
    "create_run_fields_invalid",
  );

  const missingThread = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/runs",
    headers: mutationHeaders("missing-thread"),
    payload: { threadId: "thread-does-not-exist" },
  });
  assertError(missingThread, 404, "notFound", "thread_not_found");

  const malformedJson = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/runs",
    headers: {
      ...mutationHeaders("malformed-json"),
      "content-type": "application/json",
    },
    payload: "{",
  });
  assertError(malformedJson, 400, "validation", "request_body_invalid");

  const unauthenticatedStream = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/runs/run-1/events",
    headers: { "last-event-id": "not-a-sequence" },
  });
  assertError(unauthenticatedStream, 401, "authentication", "session_invalid");

  const invalidCursor = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/runs/run-1/events",
    headers: { ...readHeaders(), "last-event-id": "not-a-sequence" },
  });
  assertError(invalidCursor, 400, "validation", "last_event_id_invalid");

  const missingRoute = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/not-a-route",
  });
  assertError(missingRoute, 404, "notFound", "route_not_found");
});

test("publishes, replays and discovers immutable tenant AgentVersions", async (context) => {
  const runtime = await testRuntime(context);
  const source = agentVersionSource();

  const published = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/agent-versions",
    headers: mutationHeaders("unused-agent-version-key"),
    payload: source,
  });
  assert.equal(published.statusCode, 201, published.body);
  const publishedBody = published.json<AgentVersionMutationResponse>();
  assert.equal(publishedBody.disposition, "registered");
  assert.equal(
    publishedBody.agentVersion.agentVersionId,
    "agent-version-api-1",
  );
  assert.match(
    publishedBody.agentVersion.contentDigest,
    /^sha256:[a-f0-9]{64}$/u,
  );
  assert.equal(JSON.stringify(publishedBody).includes("instructions"), false);
  assert.equal(JSON.stringify(publishedBody).includes("inputSchema"), false);
  const priorRelease = await runtime.store.loadActiveAgentVersionRelease({
    tenantId: "standalone-tenant",
  });
  assert.ok(priorRelease !== null);
  const selectedBundle = compileAgentVersionReleaseBundle(
    {
      tenantId: "standalone-tenant",
      defaultAgentVersionId: priorRelease.bundle.defaultAgentVersionId,
      deployments: [
        ...priorRelease.bundle.deployments,
        {
          schemaVersion: "crewon.agent-version-deployment.v0",
          tenantId: "standalone-tenant",
          agentVersionId: publishedBody.agentVersion.agentVersionId,
          contentDigest: publishedBody.agentVersion.contentDigest,
          materializationDigest: `sha256:${"d".repeat(64)}`,
          authorityId: "selected-authority",
          workspaceBindingId: null,
        },
      ],
    },
    new NodeSha256ContentDigester(),
  );
  await runtime.store.activateAgentVersionRelease({
    bundle: selectedBundle,
    activation: {
      schemaVersion: "crewon.agent-version-release-activation.v0",
      tenantId: "standalone-tenant",
      releaseId: selectedBundle.releaseId,
      activationId: "activation-selected-version",
      previousReleaseId: priorRelease.bundle.releaseId,
      operator: {
        principalId: "standalone-principal",
        actorId: "standalone-actor",
        spaceId: "standalone-space",
      },
      activatedAt: "2026-08-08T00:00:02Z",
    },
    expectedActiveReleaseId: priorRelease.bundle.releaseId,
  });

  const activeCatalog = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/agent-versions/active",
    headers: readHeaders(),
  });
  assert.equal(activeCatalog.statusCode, 200, activeCatalog.body);
  const activeCatalogBody =
    activeCatalog.json<ActiveAgentVersionCatalogResponse>();
  assert.equal(activeCatalogBody.releaseId, selectedBundle.releaseId);
  assert.equal(
    activeCatalogBody.defaultAgentVersionId,
    priorRelease.bundle.defaultAgentVersionId,
  );
  assert.deepEqual(
    activeCatalogBody.data.map((version) => version.agentVersionId),
    ["agent-version-1", "agent-version-api-1"],
  );
  const serializedCatalog = JSON.stringify(activeCatalogBody);
  for (const forbidden of [
    "instructions",
    "inputSchema",
    "authorityId",
    "workspaceBindingId",
    "materializationDigest",
  ]) {
    assert.equal(serializedCatalog.includes(forbidden), false);
  }

  const replayed = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/agent-versions",
    headers: mutationHeaders("unused-agent-version-key-2"),
    payload: structuredClone(source),
  });
  assert.equal(replayed.statusCode, 200, replayed.body);
  assert.deepEqual(replayed.json(), {
    ...publishedBody,
    disposition: "existing",
  });

  const read = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/agent-versions/agent-version-api-1",
    headers: readHeaders(),
  });
  assert.equal(read.statusCode, 200, read.body);
  assert.deepEqual(read.json<GetAgentVersionResponse>(), {
    agentVersion: publishedBody.agentVersion,
  });

  const listed = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/agent-versions?limit=10",
    headers: readHeaders(),
  });
  assert.equal(listed.statusCode, 200, listed.body);
  const listedBody = listed.json<ListAgentVersionsResponse>();
  assert.deepEqual(
    listedBody.data.map((version) => version.agentVersionId),
    ["agent-version-1", "agent-version-api-1"],
  );
  assert.deepEqual(listedBody.data[1], publishedBody.agentVersion);
  assert.equal(listedBody.nextCursor, null);

  const thread = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("selected-version-thread"),
    payload: { title: "Selected AgentVersion" },
  });
  assert.equal(thread.statusCode, 201, thread.body);
  const threadId = thread.json<ThreadMutationResponse>().thread.threadId;
  const selected = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/runs",
    headers: mutationHeaders("selected-version-run"),
    payload: { threadId, agentVersionId: "agent-version-api-1" },
  });
  assert.equal(selected.statusCode, 201, selected.body);
  const selectedRunId = selected.json<RunMutationResponse>().run.runId;
  const storedRun = await runtime.store.loadRun({
    tenantId: "standalone-tenant",
    runId: selectedRunId,
  });
  assert.equal(storedRun?.agentVersionId, "agent-version-api-1");
  assert.equal(storedRun?.authorityId, "selected-authority");
  assert.equal(storedRun?.runtimeGeneration, "ts-v0");
  assert.equal(storedRun?.policySnapshotId, "policy-api-1");
  assert.equal(storedRun?.workspaceBindingId, null);

  const notAdmittedSource = {
    ...source,
    agentVersionId: "agent-version-not-admitted",
  };
  const notAdmittedPublished = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/agent-versions",
    headers: mutationHeaders("not-admitted-publish"),
    payload: notAdmittedSource,
  });
  assert.equal(notAdmittedPublished.statusCode, 201, notAdmittedPublished.body);
  const secondThread = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("not-admitted-thread"),
    payload: { title: null },
  });
  const secondThreadId =
    secondThread.json<ThreadMutationResponse>().thread.threadId;
  const notAdmitted = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/runs",
    headers: mutationHeaders("not-admitted-run"),
    payload: {
      threadId: secondThreadId,
      agentVersionId: notAdmittedSource.agentVersionId,
    },
  });
  assertError(notAdmitted, 409, "conflict", "agent_version_not_admitted");

  const conflict = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/agent-versions",
    headers: mutationHeaders("unused-agent-version-key-3"),
    payload: { ...source, instructions: "changed immutable content" },
  });
  assertError(conflict, 409, "conflict", "agent_version_id_conflict");

  const invalid = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/agent-versions",
    headers: mutationHeaders("unused-agent-version-key-4"),
    payload: {
      ...source,
      model: {
        ...source.model,
        autoCompactAtTokens: source.model.contextWindowTokens,
      },
    },
  });
  assertError(invalid, 400, "validation", "agent_version_model_window_invalid");
});

test("publishes, replays and pages tenant WorkflowVersions without exposing authority context", async (context) => {
  const runtime = await testRuntime(context);
  const verifier = {
    ...agentVersionSource(),
    agentVersionId: "workflow-verifier-1",
  };
  const verifierPublished = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/agent-versions",
    headers: mutationHeaders("workflow-verifier-publish"),
    payload: verifier,
  });
  assert.equal(verifierPublished.statusCode, 201, verifierPublished.body);
  const first = workflowVersionSource("workflow-version-1");
  const published = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/workflow-versions",
    headers: mutationHeaders("ignored-workflow-key"),
    payload: first,
  });
  assert.equal(published.statusCode, 201, published.body);
  const firstBody = published.json<WorkflowVersionMutationResponse>();
  assert.equal(firstBody.disposition, "registered");
  assert.equal(
    firstBody.workflowVersion.workflowVersionId,
    "workflow-version-1",
  );
  assert.equal(JSON.stringify(firstBody).includes("tenantId"), false);
  assert.equal(JSON.stringify(firstBody).includes("spaceId"), false);

  const replay = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/workflow-versions",
    headers: mutationHeaders("ignored-workflow-key-2"),
    payload: first,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(
    replay.json<WorkflowVersionMutationResponse>().disposition,
    "existing",
  );

  const fetched = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/workflow-versions/workflow-version-1",
    headers: readHeaders(),
  });
  assert.equal(fetched.statusCode, 200, fetched.body);
  assert.equal(
    fetched.json<GetWorkflowVersionResponse>().workflowVersion.contentDigest,
    firstBody.workflowVersion.contentDigest,
  );

  const listed = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/workflow-versions?workflowId=workflow-1&limit=1",
    headers: readHeaders(),
  });
  assert.equal(listed.statusCode, 200, listed.body);
  const page = listed.json<ListWorkflowVersionsResponse>();
  assert.equal(page.data.length, 1);
  assert.equal(typeof page.nextCursor, "string");
  assert.deepEqual(Object.keys(page.data[0]!).sort(), [
    "contentDigest",
    "createdAt",
    "description",
    "name",
    "workflowId",
    "workflowVersionId",
  ]);
  for (const forbidden of [
    "definitionJson",
    "nodes",
    "inputSchema",
    "outputSchema",
    "executionOrder",
  ]) {
    assert.equal(JSON.stringify(page).includes(forbidden), false, forbidden);
  }
  const wrongWorkflowCursor = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/workflow-versions?workflowId=workflow-2&cursor=${page.nextCursor}`,
    headers: readHeaders(),
  });
  assertError(
    wrongWorkflowCursor,
    400,
    "validation",
    "workflow_version_cursor_invalid",
  );
});

test("queries and decides a durable Tool approval without exposing execution bindings", async (context) => {
  const runtime = await testRuntime(context);
  await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: mutationHeaders("approval-thread-1"),
    payload: { title: null },
  });
  const created = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/runs",
    headers: mutationHeaders("approval-run-1"),
    payload: { threadId: "thread-1" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const runId = created.json<RunMutationResponse>().run.runId;
  const claim = await runtime.store.claimNextWorkItem({
    ownerId: "approval-seed-worker",
    leaseId: "approval-seed-lease",
    leaseDurationMs: 10_000,
  });
  assert.ok(claim !== null);
  await runtime.execution.startRun(claim);
  const prepared = await runtime.execution.beginToolExecution(
    claim,
    {
      segmentId: "segment-approval-api",
      callId: "call-approval-api",
      kind: "function",
      name: "filesystem.write",
      input: '{"path":"result.txt"}',
    },
    {
      effect: "mutation",
      recovery: "reconcilable",
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: { kind: "control", bindingId: "control-api-test" },
      capability: "workspace.write",
      approvalRequirement: "perAction",
      limits: {
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
        maxArtifactBytes: 1024 * 1024,
      },
    },
  );
  const required = await runtime.execution.requireToolApproval(
    claim,
    prepared.receipt,
    { expiresAfterMs: null, retryAfterMs: 24 * 60 * 60 * 1_000 },
  );

  const read = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/tool-approvals/${required.approval.approvalId}`,
    headers: readHeaders(),
  });
  assert.equal(read.statusCode, 200, read.body);
  const readBody = read.json<GetToolApprovalResponse>();
  assert.equal(readBody.approval.status, "required");
  assert.equal(JSON.stringify(readBody).includes("actionDigest"), false);
  assert.equal(JSON.stringify(readBody).includes("policySnapshotId"), false);

  const decided = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/tool-approvals/${required.approval.approvalId}:decide`,
    headers: mutationHeaders("approval-decide-api-1"),
    payload: {
      expectedRevision: readBody.approval.revision,
      decision: "approved",
      comment: "approved over HTTP",
    },
  });
  assert.equal(decided.statusCode, 200, decided.body);
  const decidedBody = decided.json<ToolApprovalMutationResponse>();
  assert.equal(decidedBody.approval.status, "approved");
  assert.equal(decidedBody.run.runId, runId);
  assert.equal(decidedBody.run.status, "running");
  const resumed = await runtime.store.claimNextWorkItem({
    ownerId: "approval-resumed-worker",
    leaseId: "approval-resumed-lease",
    leaseDurationMs: 10_000,
  });
  assert.equal(resumed?.workItem.runId, runId);
  assert.equal(resumed?.lease.epoch, 2);
});

test("projects Run events without internal identity, routing or approval digest", () => {
  const event: RunLifecycleEvent = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-1" },
    eventId: "event-1",
    sequence: 1,
    occurredAt: "2026-08-08T00:00:01Z",
    type: "run.created",
    data: {
      threadId: "thread-1",
      tenantId: "tenant-secret",
      spaceId: "space-secret",
      createdByActorId: "actor-secret",
      authorityId: "authority-secret",
      runtimeGeneration: "runtime-secret",
      agentVersionId: "agent-secret",
      policySnapshotId: "policy-secret",
      workspaceBindingId: "workspace-secret",
      collaborationMode: "default",
      goalBinding: null,
    },
  };
  assert.deepEqual(projectRunEvent(event), {
    eventId: "event-1",
    runId: "run-1",
    sequence: 1,
    occurredAt: "2026-08-08T00:00:01Z",
    type: "run.created",
    data: { threadId: "thread-1" },
  });

  assert.deepEqual(
    projectRunEvent({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-message-1",
      sequence: 2,
      occurredAt: "2026-08-08T00:00:02Z",
      type: "message.completed",
      data: {
        messageId: "message-1",
        messageSequence: 1,
        role: "assistant",
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
    }),
    {
      eventId: "event-message-1",
      runId: "run-1",
      sequence: 2,
      occurredAt: "2026-08-08T00:00:02Z",
      type: "message.completed",
      data: {
        messageId: "message-1",
        messageSequence: 1,
        role: "assistant",
      },
    },
  );

  assert.deepEqual(
    projectRunEvent({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-plan-1",
      sequence: 3,
      occurredAt: "2026-08-08T00:00:03Z",
      type: "plan.proposed",
      data: {
        planId: "plan-1",
        messageId: "message-1",
        messageSequence: 1,
        contentDigest: `sha256:${"f".repeat(64)}`,
      },
    }),
    {
      eventId: "event-plan-1",
      runId: "run-1",
      sequence: 3,
      occurredAt: "2026-08-08T00:00:03Z",
      type: "plan.proposed",
      data: {
        planId: "plan-1",
        messageId: "message-1",
        messageSequence: 1,
      },
    },
  );

  assert.deepEqual(
    projectRunEvent({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-checkpoint-1",
      sequence: 3,
      occurredAt: "2026-08-08T00:00:03Z",
      type: "segment.checkpointed",
      data: {
        segmentId: "segment-1",
        segmentSequence: 4,
        checkpointDigest: `sha256:${"b".repeat(64)}`,
      },
    }),
    {
      eventId: "event-checkpoint-1",
      runId: "run-1",
      sequence: 3,
      occurredAt: "2026-08-08T00:00:03Z",
      type: "segment.checkpointed",
      data: { segmentId: "segment-1" },
    },
  );

  assert.deepEqual(
    projectRunEvent({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-fallback-1",
      sequence: 4,
      occurredAt: "2026-08-08T00:00:04Z",
      type: "model.transport.fallback",
      data: {
        segmentId: "segment-1",
        segmentSequence: 3,
        fromTransport: "websocket",
        toTransport: "http",
        code: "responses_websocket_closed",
        discardedOutput: true,
      },
    }),
    {
      eventId: "event-fallback-1",
      runId: "run-1",
      sequence: 4,
      occurredAt: "2026-08-08T00:00:04Z",
      type: "model.transport.fallback",
      data: {
        segmentId: "segment-1",
        fromTransport: "websocket",
        toTransport: "http",
        code: "responses_websocket_closed",
        discardedOutput: true,
      },
    },
  );

  assert.deepEqual(
    projectRunEvent({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-goal-accounting-1",
      sequence: 5,
      occurredAt: "2026-08-08T00:00:05Z",
      type: "run.goal.accounting.updated",
      data: {
        next: {
          schemaVersion: "crewon.run-goal-accounting.v0",
          revision: 2,
          policy: "nonCachedInputPlusOutput.v1",
          throughRunSequence: 4,
          accountedUsage: {
            inputTokens: 13,
            cachedInputTokens: 8,
            outputTokens: 3,
            totalTokens: 16,
          },
          timeBaselineAt: "2026-08-08T00:00:01Z",
          attribution: {
            goalId: "goal-1",
            goalRevision: 2,
            objectiveDigest: `sha256:${"c".repeat(64)}`,
          },
          pendingSteering: {
            handoffId: "internal-handoff-secret",
            kind: "objectiveUpdated",
            target: {
              goalId: "goal-1",
              revision: 2,
              objectiveDigest: `sha256:${"c".repeat(64)}`,
            },
            createdAt: "2026-08-08T00:00:05Z",
          },
          updatedAt: "2026-08-08T00:00:05Z",
        },
      },
    }),
    {
      eventId: "event-goal-accounting-1",
      runId: "run-1",
      sequence: 5,
      occurredAt: "2026-08-08T00:00:05Z",
      type: "run.goal.accounting.updated",
      data: {
        goalId: "goal-1",
        goalRevision: 2,
        steeringPending: true,
      },
    },
  );

  assert.deepEqual(
    projectRunEvent({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-goal-steering-1",
      sequence: 6,
      occurredAt: "2026-08-08T00:00:06Z",
      type: "run.goal.steering.consumed",
      data: { handoffId: "internal-handoff-secret" },
    }),
    {
      eventId: "event-goal-steering-1",
      runId: "run-1",
      sequence: 6,
      occurredAt: "2026-08-08T00:00:06Z",
      type: "run.goal.steering.consumed",
      data: {},
    },
  );
});

test("projects exact frozen WorkflowVersion provenance and normalizes non-Workflow binding", () => {
  const binding = {
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
  } as const;
  const event: RunLifecycleEvent = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "workflow-run-1" },
    eventId: "workflow-run-created-1",
    sequence: 1,
    occurredAt: "2026-08-12T00:00:00.000Z",
    type: "run.created",
    data: {
      threadId: "thread-1",
      tenantId: "tenant-secret",
      spaceId: "space-secret",
      createdByActorId: "actor-secret",
      authorityId: "authority-secret",
      runtimeGeneration: "runtime-1",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-secret",
      workspaceBindingId: null,
      workflowVersionBinding: binding,
      collaborationMode: "default",
      goalBinding: null,
      purpose: "workflow",
    },
  };
  const state = reduceRunLifecycleEvent(null, event);
  const projected = projectRun(state);
  assert.equal(projected.purpose, "workflow");
  assert.deepEqual(projected.workflowVersionBinding, binding);
  assert.equal(JSON.stringify(projected).includes("definitionJson"), false);
  assert.equal(JSON.stringify(projected).includes("tenant-secret"), false);
});

test("projects a bounded proposed Plan without tenant or digest authority", () => {
  const projected = projectMessage({
    messageId: "message-plan-1",
    tenantId: "tenant-secret",
    threadId: "thread-1",
    sequence: 2,
    role: "assistant",
    content: "Inspect, migrate, verify.",
    contentDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-08T00:00:02Z",
    proposedPlan: {
      schemaVersion: "crewon.proposed-plan.v0",
      planId: "plan-1",
      tenantId: "tenant-secret",
      threadId: "thread-1",
      runId: "run-1",
      messageId: "message-plan-1",
      content: "Inspect, migrate, verify.",
      contentDigest: `sha256:${"a".repeat(64)}`,
      createdAt: "2026-08-08T00:00:02Z",
    },
  });

  assert.deepEqual(projected.proposedPlan, {
    schemaVersion: "crewon.proposed-plan.v0",
    planId: "plan-1",
    threadId: "thread-1",
    runId: "run-1",
    messageId: "message-plan-1",
    content: "Inspect, migrate, verify.",
    createdAt: "2026-08-08T00:00:02Z",
  });
  assert.equal(JSON.stringify(projected).includes("tenant-secret"), false);
  assert.equal(JSON.stringify(projected).includes("contentDigest"), false);
});

test("disconnects a slow Run event subscriber at its hard queue limit", async () => {
  const hub = new RunEventHub(1);
  const subscription = hub.subscribe("run-1");
  hub.publish([runStartedEvent(1)]);
  assert.deepEqual(await subscription.next(), {
    done: false,
    value: runStartedEvent(1),
  });

  hub.publish([runStartedEvent(2), runStartedEvent(3)]);
  assert.deepEqual(await subscription.next(), {
    done: true,
    value: undefined,
  });
  hub.close();
});

test("matches AR-006 client visibility while retaining the full durable audit", () => {
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/test-contracts/fixtures/websocket-transport.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Readonly<{
    fallback: Readonly<{
      streamMaxRetries: number;
      firstTurn: Readonly<{ retryAttempts: readonly number[] }>;
      debugVisibleRetryAttempts: readonly number[];
      releaseVisibleRetryAttempts: readonly number[];
    }>;
  }>;
  const events = reference.fallback.firstTurn.retryAttempts.map(
    (
      samplingAttempt,
      index,
    ): Extract<RunLifecycleEvent, { type: "model.sampling.retry" }> => ({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-visibility" },
      eventId: `event-retry-${samplingAttempt}`,
      sequence: index + 1,
      occurredAt: `2026-08-08T00:00:0${index + 1}Z`,
      type: "model.sampling.retry",
      data: {
        segmentId: "segment-1",
        segmentSequence: index + 1,
        samplingAttempt,
        maxRetries: reference.fallback.streamMaxRetries,
        code: "responses_websocket_closed",
        discardedOutput: false,
      },
    }),
  );

  const audit = events.flatMap((event) => {
    const projected = projectRunEventForView(event, "audit");
    return projected?.type === "model.sampling.retry"
      ? [projected.data.samplingAttempt]
      : [];
  });
  const client = events.flatMap((event) => {
    const projected = projectRunEventForView(event, "client");
    return projected?.type === "model.sampling.retry"
      ? [projected.data.samplingAttempt]
      : [];
  });

  assert.deepEqual(audit, reference.fallback.debugVisibleRetryAttempts);
  assert.deepEqual(client, reference.fallback.releaseVisibleRetryAttempts);
});

test("projects provider continuation metadata in client and audit views", () => {
  const event: Extract<
    RunLifecycleEvent,
    { type: "segment.provider_continuation" }
  > = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-continuation" },
    eventId: "event-continuation-1",
    sequence: 7,
    occurredAt: "2026-08-08T00:00:07Z",
    type: "segment.provider_continuation",
    data: {
      segmentId: "segment-1",
      segmentSequence: 3,
      sampleIndex: 2,
      throughHistorySequence: 11,
    },
  };
  const expected = {
    eventId: "event-continuation-1",
    runId: "run-continuation",
    sequence: 7,
    occurredAt: "2026-08-08T00:00:07Z",
    type: "segment.provider_continuation",
    data: {
      segmentId: "segment-1",
      sampleIndex: 2,
      throughHistorySequence: 11,
    },
  };

  assert.deepEqual(projectRunEventForView(event, "client"), expected);
  assert.deepEqual(projectRunEventForView(event, "audit"), expected);
});

async function testRuntime(
  context: TestContext,
  options: Readonly<{
    threadEventPoller?: ThreadEventPoller;
    threadGoalEventPoller?: ThreadGoalEventPoller;
  }> = {},
) {
  const actor = standaloneActor();
  const store = new InMemoryRunStore();
  const eventHub = new RunEventHub();
  const ids = new IncrementingIds();
  const authorization = new StandaloneAuthorization(actor);
  const clock = new IncrementingClock();
  const application = new RunApplicationService({
    store,
    authorization,
    clock,
    ids,
  });
  const execution = new RunExecutionService({
    store,
    clock,
    ids,
    digester: new NodeSha256ContentDigester(),
  });
  const threads = new ThreadApplicationService({
    store,
    authorization,
    clock,
    ids,
    digester: new NodeSha256ContentDigester(),
  });
  const approvals = new ToolApprovalApplicationService({
    store,
    authorization,
    clock,
    ids,
  });
  const digester = new NodeSha256ContentDigester();
  const turns = new TurnApplicationService({
    store,
    authorization,
    clock,
    ids,
    digester,
  });
  const compactions = new ThreadCompactionApplicationService({
    store,
    authorization,
    clock,
    ids,
  });
  const rollbacks = new ThreadRollbackApplicationService({
    store,
    authorization,
    clock,
    ids,
  });
  const artifactStore = new InMemoryArtifactStore();
  const artifacts = new ArtifactApplicationService({
    store: artifactStore,
    authorization,
    clock,
    ids,
    digester,
    encryptionKeyId: "artifact-test-key",
  });
  const agentVersions = new AgentVersionApplicationService({
    store,
    authorization,
  });
  const workflowVersions = new WorkflowVersionApplicationService({
    store: new InMemoryWorkflowVersionStore(digester),
    agentVersions: store,
    authorization,
    digester,
    now: () => "2026-08-08T00:00:00.000Z",
  });
  const agentVersionCatalogs = new AgentVersionCatalogApplicationService({
    store,
    authorization,
  });
  const defaultVersion = compileAgentVersion(
    defaultAgentVersionSource(),
    digester,
  );
  await store.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: actor.tenantId,
      version: defaultVersion,
      createdAt: "2026-08-08T00:00:00Z",
    }),
  );
  const defaultBundle = compileAgentVersionReleaseBundle(
    {
      tenantId: actor.tenantId,
      defaultAgentVersionId: defaultVersion.agentVersionId,
      deployments: [
        {
          schemaVersion: "crewon.agent-version-deployment.v0",
          tenantId: actor.tenantId,
          agentVersionId: defaultVersion.agentVersionId,
          contentDigest: defaultVersion.contentDigest,
          materializationDigest: `sha256:${"c".repeat(64)}`,
          authorityId: "standalone-authority",
          workspaceBindingId: "workspace-1",
        },
      ],
    },
    digester,
  );
  await store.activateAgentVersionRelease({
    bundle: defaultBundle,
    activation: {
      schemaVersion: "crewon.agent-version-release-activation.v0",
      tenantId: actor.tenantId,
      releaseId: defaultBundle.releaseId,
      activationId: "activation-default-version",
      previousReleaseId: null,
      operator: {
        principalId: actor.principalId,
        actorId: actor.actorId,
        spaceId: actor.spaceId,
      },
      activatedAt: "2026-08-08T00:00:00Z",
    },
    expectedActiveReleaseId: null,
  });
  const routeResolver = new AdmittedAgentVersionRunRouteResolver({
    actor,
    defaultAgentVersionId: defaultVersion.agentVersionId,
    agentVersions,
    digester,
    admission: new StoreBackedAgentVersionAdmission(store),
  });
  const automations = new AutomationApplicationService({
    store,
    authorization,
    clock,
    ids,
    digester,
    routeResolver,
  });
  const providerSettings = new ModelProviderSettingsApplicationService({
    store,
    authorization,
    digester,
  });
  const providerProbes = {
    probe: async () => ({
      providerId: "gateway",
      catalogRevision: 1,
      runtimeBindingId: "desktop-supervisor:generation-test",
      status: "unreachable" as const,
      models: null,
      modelCount: null,
      latencyMs: 0,
      retryable: true,
      retryAfterMs: null,
    }),
  };
  const goals = new ThreadGoalApplicationService({
    store,
    authorization,
    clock,
    ids,
    digester,
    routeResolver,
  });
  const outboxDispatcher = new OutboxDispatcher(
    { store, eventHub },
    {
      ownerId: "test-dispatcher",
      nextLeaseId: () => ids.nextId("outboxLease"),
      scanIntervalMs: null,
    },
  );
  let outboxWakeups = 0;
  const workspaceQueries = new WorkspaceOperationQueryService({
    store,
    authorization,
  });
  const dependencies = {
    application,
    threads,
    goals,
    turns,
    compactions,
    rollbacks,
    approvals,
    agentVersions,
    workflowVersions,
    agentVersionCatalogs,
    artifacts,
    automations,
    providerSettings,
    providerProbes,
    providerRuntimeAvailability: "available" as const,
    workspaceLists: null,
    workspaceQueries,
    agentVersionDigester: digester,
    workflowVersionDigester: digester,
    clock,
    identity: new StandaloneIdentity({
      actor,
      sessionToken: SESSION_TOKEN,
      csrfToken: CSRF_TOKEN,
      allowedOrigins: [ORIGIN],
    }),
    routeResolver,
    readiness: new StoreReadiness(store, {
      tenantId: actor.tenantId,
      defaultAgentVersionId: defaultVersion.agentVersionId,
    }),
    eventHub,
    threadEventPoller: options.threadEventPoller,
    threadGoalEventPoller: options.threadGoalEventPoller,
    outboxWakeup: {
      wake: async () => {
        outboxWakeups += 1;
        await outboxDispatcher.wake();
      },
    },
    heartbeatIntervalMs: null,
  };
  const app = buildControlApi(dependencies);
  context.after(async () => {
    await outboxDispatcher.close();
    eventHub.close();
    await app.close();
    await artifactStore.close();
    await store.close();
  });
  return {
    app,
    store,
    execution,
    artifacts,
    dependencies,
    outboxWakeups: () => outboxWakeups,
  };
}

function defaultAgentVersionSource(): AgentVersionSource {
  return {
    schemaVersion: "crewon.agent-version-source.v0",
    agentVersionId: "agent-version-1",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy-1",
    instructions: null,
    model: {
      adapterName: "deterministic-fake",
      adapterVersion: "1",
      modelId: "fake-model",
      contextWindowTokens: 128_000,
      autoCompactAtTokens: 96_000,
    },
    execution: { streamMaxRetries: 2, maxToolRounds: 16 },
    resources: {
      workspaceRequired: true,
      governedContextDigest: null,
    },
    tools: [],
  };
}

async function seedThread(
  store: InMemoryRunStore,
  identity: Readonly<{
    tenantId: string;
    spaceId: string;
    threadId: string;
  }>,
): Promise<void> {
  await store.commitThread({
    tenantId: identity.tenantId,
    idempotency: {
      scope: `seed:${identity.tenantId}`,
      key: `seed:${identity.threadId}`,
      requestFingerprint: `seed:${identity.threadId}`,
    },
    expectedRevision: 0,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: identity.threadId },
        eventId: `event:${identity.threadId}`,
        sequence: 1,
        occurredAt: "2026-08-08T00:00:00Z",
        type: "thread.created",
        data: {
          tenantId: identity.tenantId,
          spaceId: identity.spaceId,
          createdByActorId: "actor-seed",
          title: null,
        },
      },
    ],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
  });
}

class ManualThreadGoalEventPoller
  implements ThreadGoalEventPoller, ThreadEventPoller
{
  readonly #pending = new Set<() => void>();
  readonly #startedObservers: Array<{
    target: number;
    resolve: () => void;
  }> = [];
  #started = 0;

  get started(): number {
    return this.#started;
  }

  waitForNextPoll(signal: AbortSignal): Promise<void> {
    this.#started += 1;
    this.#notifyStarted();
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.#pending.delete(finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      this.#pending.add(finish);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  waitUntilStarted(target: number): Promise<void> {
    if (this.#started >= target) return Promise.resolve();
    return new Promise((resolve) => {
      this.#startedObservers.push({ target, resolve });
    });
  }

  advance(): void {
    for (const finish of [...this.#pending]) finish();
  }

  #notifyStarted(): void {
    for (
      let index = this.#startedObservers.length - 1;
      index >= 0;
      index -= 1
    ) {
      const observer = this.#startedObservers[index];
      if (observer !== undefined && this.#started >= observer.target) {
        this.#startedObservers.splice(index, 1);
        observer.resolve();
      }
    }
  }
}

class GoalSseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  async nextFrame(): Promise<{
    id: string;
    event: string;
    data: ThreadGoalEventView;
  }> {
    while (true) {
      const boundary = this.#buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const raw = this.#buffer.slice(0, boundary);
        this.#buffer = this.#buffer.slice(boundary + 2);
        if (raw.startsWith(":")) continue;
        return parseGoalSseFrame(raw);
      }
      const chunk = await this.#reader.read();
      if (chunk.done) {
        throw new Error("Goal SSE stream ended before the next event");
      }
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel();
  }
}

class ThreadSseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  async nextFrame(): Promise<{
    id: string;
    event: string;
    data: ThreadEventView;
  }> {
    while (true) {
      const boundary = this.#buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const raw = this.#buffer.slice(0, boundary);
        this.#buffer = this.#buffer.slice(boundary + 2);
        if (raw.startsWith(":")) continue;
        const fields = new Map(
          raw.split("\n").map((line) => {
            const separator = line.indexOf(":");
            assert.notEqual(separator, -1);
            return [
              line.slice(0, separator),
              line.slice(separator + 1).trimStart(),
            ];
          }),
        );
        return {
          id: requiredSseField(fields.get("id")),
          event: requiredSseField(fields.get("event")),
          data: JSON.parse(
            requiredSseField(fields.get("data")),
          ) as ThreadEventView,
        };
      }
      const chunk = await this.#reader.read();
      if (chunk.done) {
        throw new Error("Thread SSE stream ended before the next event");
      }
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel();
  }
}

function parseGoalSseFrame(raw: string): {
  id: string;
  event: string;
  data: ThreadGoalEventView;
} {
  const fields = new Map(
    raw.split("\n").map((line) => {
      const separator = line.indexOf(":");
      assert.notEqual(separator, -1);
      return [line.slice(0, separator), line.slice(separator + 1).trimStart()];
    }),
  );
  return {
    id: requiredSseField(fields.get("id")),
    event: requiredSseField(fields.get("event")),
    data: JSON.parse(
      requiredSseField(fields.get("data")),
    ) as ThreadGoalEventView,
  };
}

function requiredSseField(value: string | undefined): string {
  if (value === undefined) throw new Error("Goal SSE field missing");
  return value;
}

function requiredBody(response: Response): ReadableStream<Uint8Array> {
  if (response.body === null) throw new Error("response body missing");
  return response.body;
}

function serverBaseUrl(app: FastifyInstance): string {
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("control API address unavailable");
  }
  return `http://127.0.0.1:${address.port}`;
}

class IncrementingIds
  implements ApplicationIdGenerator, AutomationApplicationIdGenerator
{
  readonly #counters = new Map<
    ApplicationIdKind | AutomationApplicationIdKind,
    number
  >();

  nextId(kind: ApplicationIdKind | AutomationApplicationIdKind): string {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return `${kind}-${next}`;
  }
}

class IncrementingClock implements ApplicationClock {
  #second = 0;

  now(): string {
    this.#second += 1;
    return `2026-08-08T00:00:${this.#second.toString().padStart(2, "0")}Z`;
  }
}

function standaloneActor(): ActorContext {
  return {
    principalId: "standalone-principal",
    actorId: "standalone-actor",
    tenantId: "standalone-tenant",
    spaceId: "standalone-space",
  };
}

function workflowVersionSource(
  workflowVersionId: string,
): WorkflowVersionSource {
  const schema = {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: false as const,
  };
  return {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "workflow-1",
    workflowVersionId,
    name: "Production workflow",
    description: "A compiled immutable workflow",
    inputSchema: schema,
    outputSchema: schema,
    entryNodeIds: ["agent"],
    outputNodeIds: ["verify"],
    nodes: [
      {
        nodeId: "agent",
        title: "Agent",
        instruction: "Complete the workflow",
        dependsOn: [],
        inputSchema: schema,
        outputSchema: schema,
        kind: "agent" as const,
        agentVersionId: "agent-version-1",
      },
      {
        nodeId: "verify",
        title: "Verify",
        instruction: "Verify the output",
        dependsOn: ["agent"],
        inputSchema: schema,
        outputSchema: schema,
        kind: "verification" as const,
        verifierAgentVersionId: "workflow-verifier-1",
      },
    ],
  };
}

function agentVersionSource() {
  return {
    schemaVersion: "crewon.agent-version-source.v0" as const,
    agentVersionId: "agent-version-api-1",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy-api-1",
    instructions: "Keep the runtime stable.",
    model: {
      adapterName: "responses-http",
      adapterVersion: "1",
      modelId: "model-api-1",
      contextWindowTokens: 128_000,
      autoCompactAtTokens: 96_000,
    },
    execution: { streamMaxRetries: 2, maxToolRounds: 16 },
    resources: {
      workspaceRequired: false,
      governedContextDigest: null,
    },
    tools: [
      {
        schemaVersion: "crewon.tool-definition.v0" as const,
        kind: "function" as const,
        name: "read_file",
        description: "Read one bounded file.",
        execution: "parallel" as const,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  };
}

function readHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${SESSION_TOKEN}`,
    origin: ORIGIN,
  };
}

function mutationHeaders(idempotencyKey: string): Record<string, string> {
  return {
    ...readHeaders(),
    "idempotency-key": idempotencyKey,
    "x-csrf-token": CSRF_TOKEN,
  };
}

function jsonMutationHeaders(idempotencyKey: string): Record<string, string> {
  return {
    ...mutationHeaders(idempotencyKey),
    "content-type": "application/json",
  };
}

function assertPublicProjection(response: RunMutationResponse): void {
  const serialized = JSON.stringify(response);
  for (const forbidden of [
    "tenant",
    "space",
    "actor",
    "authority",
    "runtimeGeneration",
    "policySnapshot",
    "workspaceBinding",
    "actionDigest",
    "checkpointDigest",
    "opaquePayload",
    "responseId",
    SESSION_TOKEN,
    CSRF_TOKEN,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
}

function assertGoalMutationProjectionSafe(
  response: ThreadGoalMutationResponse,
): void {
  const serialized = JSON.stringify(response);
  for (const forbidden of [
    "tenantId",
    "spaceId",
    "actorId",
    "authorityId",
    "runtimeGeneration",
    "policySnapshotId",
    "workspaceBindingId",
    "historyItem",
    "runEvents",
    "outbox",
    "workItems",
    SESSION_TOKEN,
    CSRF_TOKEN,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
}

function assertGoalEventSafe(event: ThreadGoalEventView): void {
  assert.deepEqual(Object.keys(event).sort(), [
    "data",
    "eventId",
    "occurredAt",
    "schemaVersion",
    "sequence",
    "threadId",
    "type",
  ]);
  const serialized = JSON.stringify(event);
  for (const forbidden of [
    "tenantId",
    "authorityId",
    "runtimeGeneration",
    "policySnapshotId",
    "workspaceBindingId",
    "historyItem",
    "outbox",
    SESSION_TOKEN,
    CSRF_TOKEN,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  if (event.type === "goal.updated") {
    assert.equal("schemaVersion" in event.data.goal, false);
    assert.equal("tenantId" in event.data.goal, false);
  }
}

function assertError(
  response: {
    statusCode: number;
    headers: Record<string, string | string[] | number | undefined>;
    json<T>(): T;
    body: string;
  },
  statusCode: number,
  category: ErrorEnvelope["error"]["category"],
  code: string,
): void {
  assert.equal(response.statusCode, statusCode);
  const body = response.json<ErrorEnvelope>();
  assert.equal(body.error.category, category);
  assert.equal(body.error.code, code);
  assert.equal(body.error.requestId, String(response.headers["x-request-id"]));
  assert.equal(response.body.includes(SESSION_TOKEN), false);
  assert.equal(response.body.includes(CSRF_TOKEN), false);
  assert.equal(response.body.includes("stack"), false);
}

function runStartedEvent(sequence: number): RunLifecycleEvent {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-1" },
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: `2026-08-08T00:00:${sequence.toString().padStart(2, "0")}Z`,
    type: "run.started",
    data: {},
  };
}
