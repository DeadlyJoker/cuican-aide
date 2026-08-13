import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
} from "./control-api-client.ts";

test("reads and updates device-local settings through the typed client", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "csrf",
    fetch: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      return jsonResponse(200, {
        settings: {
          locale: "zh",
          theme: "light",
          revision: requests.length - 1,
          updatedAt: null,
        },
      });
    },
  });
  await client.getLocalSettings();
  await client.putLocalSettings({
    locale: "en",
    theme: "dark",
    expectedRevision: 0,
  });
  assert.deepEqual(
    requests.map(({ input, init }) => [init.method, input]),
    [
      ["GET", "https://control.example/api/v1/local-settings"],
      ["PUT", "https://control.example/api/v1/local-settings"],
    ],
  );
  assert.equal(
    new Headers(requests[1]!.init.headers).get("x-csrf-token"),
    "csrf",
  );
});

test("reads the safe account snapshot through the typed client", async () => {
  let requested = "";
  const response = {
    account: {
      identity: {
        principalId: "principal-1",
        actorId: "actor-1",
        tenantId: "tenant-1",
        spaceId: "space-1",
      },
      authentication: { status: "authenticated", authority: "control" },
      usage: { status: "unavailable", reason: "notOwned" },
      rateLimits: { status: "unavailable", reason: "notOwned" },
    },
  } as const;
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (input) => {
      requested = String(input);
      return jsonResponse(200, response);
    },
  });
  assert.deepEqual(await client.getAccountSnapshot(), response);
  assert.equal(requested, "https://control.example/api/v1/account-snapshot");
});

test("lists the active capability catalog with an opaque cursor", async () => {
  let requested = "";
  const response = {
    releaseId: `sha256:${"a".repeat(64)}`,
    activatedAt: "2026-08-13T00:00:00Z",
    data: [],
    nextCursor: null,
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (input) => {
      requested = String(input);
      return jsonResponse(200, response);
    },
  });
  assert.deepEqual(
    await client.listActiveCapabilities({ cursor: "opaque", limit: 25 }),
    response,
  );
  assert.equal(
    requested,
    "https://control.example/api/v1/capabilities?cursor=opaque&limit=25",
  );
});

test("calls the bounded typed Workspace read-only product route", async () => {
  const captured: { url: string; init: RequestInit }[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "csrf-token",
    fetch: async (input, init = {}) => {
      captured.push({ url: String(input), init });
      return jsonResponse(200, {
        schemaVersion: "crewon.workspace-native-readonly-response.v0",
        operation: "contentSearch",
        matches: [],
        scannedFiles: 0,
        scannedBytes: 0,
        truncated: false,
      });
    },
  });
  const result = await client.executeWorkspaceReadonly("thread/1", {
    schemaVersion: "crewon.workspace-native-readonly-request.v0",
    operation: "contentSearch",
    pathSegments: [],
    query: "needle",
    maxMatches: 10,
  });
  assert.equal(result.operation, "contentSearch");
  assert.equal(
    captured[0]?.url,
    "https://control.example/api/v1/threads/thread%2F1/workspace-readonly",
  );
  assert.deepEqual(JSON.parse(String(captured[0]?.init.body)), {
    schemaVersion: "crewon.workspace-native-readonly-request.v0",
    operation: "contentSearch",
    pathSegments: [],
    query: "needle",
    maxMatches: 10,
  });
});

test("uses typed Knowledge create, read and pagination routes", async () => {
  const requests: { input: string; init: RequestInit }[] = [];
  const knowledge = {
    schemaVersion: "crewon.knowledge.v0" as const,
    knowledgeId: "knowledge/1",
    kind: "memory" as const,
    sourceId: "capture-1",
    title: "Memory",
    content: "Text",
    contentDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-13T00:00:00.000Z",
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "csrf",
    fetch: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      return jsonResponse(
        200,
        String(input).includes("?")
          ? { data: [knowledge], nextCursor: null }
          : String(input).endsWith("knowledge%2F1")
            ? { knowledge }
            : { disposition: "replayed", knowledge },
      );
    },
  });
  await client.createKnowledge(
    { kind: "memory", sourceId: "capture-1", title: "Memory", content: "Text" },
    "knowledge-key",
  );
  await client.getKnowledge("knowledge/1");
  await client.listKnowledge({ cursor: "cursor", limit: 10 });
  assert.deepEqual(
    requests.map(({ input, init }) => [init.method, input]),
    [
      ["POST", "https://control.example/api/v1/knowledge"],
      ["GET", "https://control.example/api/v1/knowledge/knowledge%2F1"],
      [
        "GET",
        "https://control.example/api/v1/knowledge?cursor=cursor&limit=10",
      ],
    ],
  );
  const headers = new Headers(requests[0]!.init.headers);
  assert.equal(headers.get("idempotency-key"), "knowledge-key");
  assert.equal(headers.get("x-csrf-token"), "csrf");
});

test("reads and probes model provider settings through Control API", async () => {
  const requests: { input: string; init: RequestInit }[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      return String(input).endsWith("/probe")
        ? jsonResponse(200, {
            disposition: "completed",
            providerId: "openai",
            catalogRevision: 2,
            status: "ok",
            models: [],
            modelCount: 0,
            latencyMs: 1,
            retryable: false,
            retryAfterMs: null,
          })
        : jsonResponse(200, {
            settings: {
              revision: 2,
              activeProviderId: "openai",
              providers: [],
              runtimeAvailability: "available",
              updatedAt: null,
            },
          });
    },
  });

  await client.getModelProviderSettings();
  await client.probeModelProvider("provider-probe-1");

  assert.deepEqual(
    requests.map(({ input, init }) => ({ method: init.method, input })),
    [
      {
        method: "GET",
        input: "https://control.example/api/v1/model-provider-settings",
      },
      {
        method: "POST",
        input: "https://control.example/api/v1/model-provider-settings/probe",
      },
    ],
  );
  assert.equal(
    new Headers(requests[1]?.init.headers).get("idempotency-key"),
    "provider-probe-1",
  );
});

test("uses typed Control Automation routes with CAS and idempotency", async () => {
  const requests: { input: string; init: RequestInit }[] = [];
  const automation = {
    automationId: "automation/1",
    threadId: "thread-1",
    title: "Daily summary",
    prompt: "Summarize progress",
    agentVersionId: "agent-version-1",
    executionMode: "manualOnly" as const,
    automaticScheduling: false as const,
    revision: 1 as const,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "automation-csrf",
    fetch: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      if (String(input).endsWith(":run-now")) {
        return jsonResponse(201, {
          disposition: "committed",
          automation,
          invocation: { automationId: automation.automationId, runId: "run-1" },
          run: runResponse().run,
        });
      }
      return jsonResponse(201, { disposition: "committed", automation });
    },
  });

  await client.createAutomation(
    {
      threadId: "thread-1",
      expectedThreadRevision: 2,
      title: automation.title,
      prompt: automation.prompt,
      agentVersionId: automation.agentVersionId,
    },
    "automation-create-1",
  );
  await client.runAutomationNow(
    automation.automationId,
    { expectedAutomationRevision: 1, expectedThreadRevision: 2 },
    "automation-run-1",
  );

  assert.deepEqual(
    requests.map(({ input }) => input),
    [
      "https://control.example/api/v1/automations",
      "https://control.example/api/v1/automations/automation%2F1:run-now",
    ],
  );
  assert.deepEqual(
    requests.map(({ init }) =>
      new Headers(init.headers).get("idempotency-key"),
    ),
    ["automation-create-1", "automation-run-1"],
  );
  assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), {
    expectedAutomationRevision: 1,
    expectedThreadRevision: 2,
  });
});

test("lists and reads bounded Control Automation views", async () => {
  const requestedUrls: string[] = [];
  const automation = {
    automationId: "automation-1",
    threadId: "thread-1",
    title: "Summary",
    prompt: "Summarize",
    agentVersionId: "agent-version-1",
    executionMode: "manualOnly" as const,
    automaticScheduling: false as const,
    revision: 1 as const,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      return url.includes("?limit=")
        ? jsonResponse(200, { data: [automation], nextCursor: null })
        : jsonResponse(200, { automation });
    },
  });

  assert.deepEqual(await client.listAutomations({ limit: 25 }), {
    data: [automation],
    nextCursor: null,
  });
  assert.deepEqual(await client.getAutomation("automation/1"), { automation });
  assert.deepEqual(requestedUrls, [
    "https://control.example/api/v1/automations?limit=25",
    "https://control.example/api/v1/automations/automation%2F1",
  ]);
});

test("sends a typed selected-version Run without client-owned route fields", async () => {
  const requests: { input: string; init: RequestInit }[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    accessToken: "access-token",
    csrfToken: "csrf-token",
    origin: "https://app.example",
    fetch: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      return jsonResponse(201, runResponse());
    },
  });

  assert.deepEqual(
    await client.createRun(
      {
        threadId: "thread/with separator",
        agentVersionId: "agent-version-1",
      },
      "idempotency-1",
    ),
    runResponse(),
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.input, "https://control.example/api/v1/runs");
  const headers = new Headers(requests[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer access-token");
  assert.equal(headers.get("x-csrf-token"), "csrf-token");
  assert.equal(headers.get("origin"), "https://app.example");
  assert.equal(headers.get("idempotency-key"), "idempotency-1");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    threadId: "thread/with separator",
    agentVersionId: "agent-version-1",
  });
});

test("preserves exact frozen WorkflowVersion provenance on Run reads", async () => {
  const binding = {
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
  } as const;
  const response = {
    run: {
      ...runResponse().run,
      purpose: "workflow" as const,
      workflowVersionBinding: binding,
    },
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () => jsonResponse(200, response),
  });
  assert.deepEqual(await client.getRun("workflow-run-1"), response);
  assert.equal(JSON.stringify(response).includes("definitionJson"), false);
});

test("starts a Workflow Run without client-owned digest or root Agent identity", async () => {
  const requests: { input: string; init: RequestInit }[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "csrf-token",
    fetch: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      return jsonResponse(201, runResponse());
    },
  });
  const body = {
    workflowVersionId: "workflow-version-1",
    threadId: "thread-1",
    input: { prompt: "ship" },
  } as const;
  assert.deepEqual(
    await client.startWorkflowRun(body, "workflow-run-start-1"),
    runResponse(),
  );
  assert.equal(
    requests[0]?.input,
    "https://control.example/api/v1/workflow-runs",
  );
  const headers = new Headers(requests[0]?.init.headers);
  assert.equal(headers.get("idempotency-key"), "workflow-run-start-1");
  assert.equal(headers.get("x-csrf-token"), "csrf-token");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), body);
  assert.equal(String(requests[0]?.init.body).includes("contentDigest"), false);
  assert.equal(
    String(requests[0]?.init.body).includes("agentVersionId"),
    false,
  );
});

test("decides a Workflow Human Gate with only public claim authority", async () => {
  let request: { input: string; init: RequestInit } | undefined;
  const response = {
    disposition: "recorded" as const,
    runId: "run-1",
    nodeId: "gate",
    gateRequestId: "gate-request-1",
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    csrfToken: "csrf",
    fetch: async (input, init = {}) => {
      request = { input: String(input), init };
      return jsonResponse(200, response);
    },
  });
  const body = {
    runId: "run-1",
    nodeId: "gate",
    claimId: "claim-1",
    claimEpoch: 1,
    gateRequestId: "gate-request-1",
    decision: "approve" as const,
  };
  assert.deepEqual(
    await client.decideWorkflowHumanGate(body, "decision-1"),
    response,
  );
  assert.equal(
    request?.input,
    "https://control.example/api/v1/workflow-gates:decide",
  );
  assert.deepEqual(JSON.parse(String(request?.init.body)), body);
  assert.equal(
    new Headers(request?.init.headers).get("idempotency-key"),
    "decision-1",
  );
});

test("lists bounded WorkflowVersion summaries without definition fields", async () => {
  const summary = {
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
    name: "Workflow",
    description: "Bounded metadata",
    createdAt: "2026-08-12T00:00:00.000Z",
  };
  const response = { data: [summary], nextCursor: null };
  let requestedUrl = "";
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (input) => {
      requestedUrl = String(input);
      return jsonResponse(200, response);
    },
  });
  assert.deepEqual(
    await client.listWorkflowVersions("workflow-1", { limit: 100 }),
    response,
  );
  assert.equal(
    requestedUrl,
    "https://control.example/api/v1/workflow-versions?workflowId=workflow-1&limit=100",
  );
  for (const forbidden of [
    "definitionJson",
    "nodes",
    "inputSchema",
    "outputSchema",
  ]) {
    assert.equal(
      JSON.stringify(response).includes(forbidden),
      false,
      forbidden,
    );
  }
});

test("starts a Turn through one atomic typed mutation", async () => {
  const requests: { input: string; init: RequestInit }[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      return jsonResponse(201, startTurnResponse());
    },
  });

  assert.deepEqual(
    await client.startTurn(
      "thread/with separator",
      {
        expectedRevision: 1,
        content: "hello atomically",
        agentVersionId: null,
        executionIntent: "plan",
      },
      "turn-start-1",
    ),
    startTurnResponse(),
  );
  assert.equal(
    requests[0]?.input,
    "https://control.example/api/v1/threads/thread%2Fwith%20separator/turns",
  );
  assert.equal(
    new Headers(requests[0]?.init.headers).get("idempotency-key"),
    "turn-start-1",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    expectedRevision: 1,
    content: "hello atomically",
    agentVersionId: null,
    executionIntent: "plan",
  });
});

test("starts a manual compaction with CAS, CSRF and idempotency", async () => {
  const requests: { input: string; init: RequestInit }[] = [];
  const response = {
    ...runResponse(),
    run: { ...runResponse().run, purpose: "manualCompaction" as const },
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "compact-csrf",
    fetch: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      return jsonResponse(201, response);
    },
  });

  assert.deepEqual(
    await client.compactThread(
      "thread/with separator",
      { expectedRevision: 3, agentVersionId: "agent-version-1" },
      "compact-1",
    ),
    response,
  );
  assert.equal(
    requests[0]?.input,
    "https://control.example/api/v1/threads/thread%2Fwith%20separator:compact",
  );
  const headers = new Headers(requests[0]?.init.headers);
  assert.equal(headers.get("x-csrf-token"), "compact-csrf");
  assert.equal(headers.get("idempotency-key"), "compact-1");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    expectedRevision: 3,
    agentVersionId: "agent-version-1",
  });
});

test("rolls back a Thread with CAS, CSRF and idempotency", async () => {
  const requests: { input: string; init: RequestInit }[] = [];
  const response = {
    disposition: "committed" as const,
    thread: {
      threadId: "thread/with separator",
      title: "Rollback target",
      status: "active" as const,
      revision: 4,
      lastMessageSequence: 2,
      forkedFromThreadId: null,
      forkedThroughHistorySequence: null,
      createdAt: "2026-08-09T00:00:00Z",
      updatedAt: "2026-08-09T00:00:01Z",
      archivedAt: null,
      deletedAt: null,
    },
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "rollback-csrf",
    fetch: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      return jsonResponse(201, response);
    },
  });

  assert.deepEqual(
    await client.rollbackThread(
      "thread/with separator",
      { expectedRevision: 3, numTurns: 2 },
      "rollback-1",
    ),
    response,
  );
  assert.equal(
    requests[0]?.input,
    "https://control.example/api/v1/threads/thread%2Fwith%20separator:rollback",
  );
  const headers = new Headers(requests[0]?.init.headers);
  assert.equal(headers.get("x-csrf-token"), "rollback-csrf");
  assert.equal(headers.get("idempotency-key"), "rollback-1");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    expectedRevision: 3,
    numTurns: 2,
  });
});

test("fails closed before rollback when CSRF is unavailable", async () => {
  let requested = false;
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () => {
      requested = true;
      return jsonResponse(500, {});
    },
  });

  await assert.rejects(
    client.rollbackThread(
      "thread-1",
      { expectedRevision: 3, numTurns: 1 },
      "rollback-no-csrf",
    ),
    hasProtocolCode("control_client_csrf_token_required"),
  );
  assert.equal(requested, false);
});

test("reads the active runnable AgentVersion catalog", async () => {
  const requests: string[] = [];
  const response = activeAgentVersionCatalogResponse();
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (input) => {
      requests.push(String(input));
      return jsonResponse(200, response);
    },
  });

  assert.deepEqual(await client.getActiveAgentVersionCatalog(), response);
  assert.deepEqual(requests, [
    "https://control.example/api/v1/agent-versions/active",
  ]);
});

test("reads the safe persistent Thread Goal projection", async () => {
  const requests: string[] = [];
  const response = {
    goal: {
      threadId: "thread/1",
      goalId: "goal-1",
      revision: 2,
      objective: "finish the migration",
      status: "active" as const,
      tokenBudget: 200_000,
      tokensUsed: 10,
      timeUsedSeconds: 3,
      createdAt: "2026-08-09T00:00:00Z",
      updatedAt: "2026-08-09T00:00:03Z",
    },
    eventSequence: 7,
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async (input) => {
      requests.push(String(input));
      return jsonResponse(200, response);
    },
  });

  assert.deepEqual(await client.getThreadGoal("thread/1"), response);
  assert.deepEqual(requests, [
    "https://control.example/api/v1/threads/thread%2F1/goal",
  ]);
});

test("sets and clears a Goal with fixed concurrency and mutation headers", async () => {
  const requests: { input: string; init: RequestInit }[] = [];
  const goal = {
    threadId: "thread/1",
    goalId: "goal-1",
    revision: 5,
    objective: "finish the migration",
    status: "active" as const,
    tokenBudget: null,
    tokensUsed: 10,
    timeUsedSeconds: 3,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:03Z",
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "goal-csrf",
    fetch: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      return jsonResponse(
        init.method === "PUT" ? 201 : 200,
        init.method === "PUT"
          ? {
              disposition: "committed",
              goal,
              canceledRun: null,
              retainedRun: null,
              continuationRun: null,
            }
          : {
              disposition: "committed",
              goal: null,
              canceledRun: null,
              retainedRun: null,
              continuationRun: null,
            },
      );
    },
  });

  const setResponse = await client.setThreadGoal(
    "thread/1",
    {
      expectedRevision: 4,
      objective: null,
      status: null,
      tokenBudget: { kind: "keep" },
    },
    "goal-set-1",
  );
  assert.equal(setResponse.goal?.tokenBudget, null);
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    expectedRevision: 4,
    objective: null,
    status: null,
    tokenBudget: { kind: "keep" },
  });

  assert.equal(
    (
      await client.clearThreadGoal(
        "thread/1",
        { expectedRevision: 5 },
        "goal-clear-1",
      )
    ).goal,
    null,
  );
  assert.deepEqual(
    requests.map(({ input, init }) => ({
      input,
      method: init.method,
      csrf: new Headers(init.headers).get("x-csrf-token"),
      idempotencyKey: new Headers(init.headers).get("idempotency-key"),
      body: JSON.parse(String(init.body)),
    })),
    [
      {
        input: "https://control.example/api/v1/threads/thread%2F1/goal",
        method: "PUT",
        csrf: "goal-csrf",
        idempotencyKey: "goal-set-1",
        body: {
          expectedRevision: 4,
          objective: null,
          status: null,
          tokenBudget: { kind: "keep" },
        },
      },
      {
        input: "https://control.example/api/v1/threads/thread%2F1/goal",
        method: "DELETE",
        csrf: "goal-csrf",
        idempotencyKey: "goal-clear-1",
        body: { expectedRevision: 5 },
      },
    ],
  );
});

test("fails closed before a Goal mutation when CSRF is unavailable", async () => {
  let fetchCalls = 0;
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse(500, {});
    },
  });

  await assert.rejects(
    client.setThreadGoal(
      "thread-1",
      {
        expectedRevision: null,
        objective: "create a goal",
        status: null,
        tokenBudget: { kind: "set", value: null },
      },
      "goal-create-1",
    ),
    hasProtocolCode("control_client_csrf_token_required"),
  );
  assert.equal(fetchCalls, 0);
});

test("archives a Thread with CSRF, idempotency and an encoded resource id", async () => {
  const requests: Array<{ input: RequestInfo | URL; init: RequestInit }> = [];
  const thread = {
    threadId: "thread/1",
    title: "Archived",
    status: "archived" as const,
    revision: 2,
    lastMessageSequence: 0,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:01Z",
    archivedAt: "2026-08-09T00:00:01Z",
    deletedAt: null,
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "archive-token",
    csrfToken: "archive-csrf",
    origin: "https://app.example",
    fetch: async (input, init = {}) => {
      requests.push({ input, init });
      return jsonResponse(200, {
        disposition: "committed",
        thread,
      });
    },
  });

  assert.deepEqual(
    await client.archiveThread(
      "thread/1",
      { expectedRevision: 1 },
      "thread-archive-1",
    ),
    { disposition: "committed", thread },
  );

  assert.deepEqual(
    requests.map(({ input, init }) => ({
      input: String(input),
      method: init.method,
      csrf: new Headers(init.headers).get("x-csrf-token"),
      idempotencyKey: new Headers(init.headers).get("idempotency-key"),
      body: JSON.parse(String(init.body)),
    })),
    [
      {
        input: "https://control.example/api/v1/threads/thread%2F1:archive",
        method: "POST",
        csrf: "archive-csrf",
        idempotencyKey: "thread-archive-1",
        body: { expectedRevision: 1 },
      },
    ],
  );
});

test("unarchives, renames and tombstones a Thread with exact CAS bodies", async () => {
  const requests: Array<{ input: RequestInfo | URL; init: RequestInit }> = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    csrfToken: "lifecycle-csrf",
    fetch: async (input, init = {}) => {
      requests.push({ input, init });
      return jsonResponse(200, {
        disposition: "committed",
        thread: {
          threadId: "thread/1",
          title: init.body === '{"expectedRevision":3}' ? null : "Renamed",
          status: String(input).endsWith(":delete") ? "deleted" : "active",
          revision: requests.length + 1,
          lastMessageSequence: 0,
          forkedFromThreadId: null,
          forkedThroughHistorySequence: null,
          createdAt: "2026-08-09T00:00:00Z",
          updatedAt: "2026-08-09T00:00:03Z",
          archivedAt: null,
          deletedAt: String(input).endsWith(":delete")
            ? "2026-08-09T00:00:03Z"
            : null,
        },
      });
    },
  });

  await client.unarchiveThread(
    "thread/1",
    { expectedRevision: 1 },
    "thread-unarchive-1",
  );
  await client.renameThread(
    "thread/1",
    { expectedRevision: 2, title: "Renamed" },
    "thread-rename-1",
  );
  await client.deleteThread(
    "thread/1",
    { expectedRevision: 3 },
    "thread-delete-1",
  );

  assert.deepEqual(
    requests.map(({ input, init }) => ({
      url: String(input),
      method: init.method,
      csrf: new Headers(init.headers).get("x-csrf-token"),
      idempotencyKey: new Headers(init.headers).get("idempotency-key"),
      body: JSON.parse(String(init.body)),
    })),
    [
      {
        url: "https://control.example/api/v1/threads/thread%2F1:unarchive",
        method: "POST",
        csrf: "lifecycle-csrf",
        idempotencyKey: "thread-unarchive-1",
        body: { expectedRevision: 1 },
      },
      {
        url: "https://control.example/api/v1/threads/thread%2F1:rename",
        method: "POST",
        csrf: "lifecycle-csrf",
        idempotencyKey: "thread-rename-1",
        body: { expectedRevision: 2, title: "Renamed" },
      },
      {
        url: "https://control.example/api/v1/threads/thread%2F1:delete",
        method: "POST",
        csrf: "lifecycle-csrf",
        idempotencyKey: "thread-delete-1",
        body: { expectedRevision: 3 },
      },
    ],
  );
});

test("opens Thread event catch-up with Last-Event-ID", async () => {
  const requests: Array<{ input: RequestInfo | URL; init: RequestInit }> = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "event-token",
    origin: "https://app.example",
    fetch: async (input, init = {}) => {
      requests.push({ input, init });
      return new Response(null, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  await client.openThreadEventStream({
    threadId: "thread/1",
    afterSequence: 4,
    view: "audit",
  });

  const request = requests[0];
  assert.ok(request);
  assert.equal(
    String(request.input),
    "https://control.example/api/v1/threads/thread%2F1/events?view=audit",
  );
  assert.equal(new Headers(request.init.headers).get("last-event-id"), "4");
});

test("fails closed before a Goal mutation when idempotency is unavailable", async () => {
  let fetchCalls = 0;
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "goal-csrf",
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse(500, {});
    },
  });

  await assert.rejects(
    client.clearThreadGoal(
      "thread-1",
      { expectedRevision: 1 },
      undefined as unknown as string,
    ),
    hasProtocolCode("control_client_idempotency_key_required"),
  );
  assert.equal(fetchCalls, 0);
});

test("encodes resource IDs and bounded pagination without leaking credentials", async () => {
  const inputs: string[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/base/",
    accessToken: "secret-access-token",
    fetch: async (input) => {
      inputs.push(String(input));
      return jsonResponse(200, { data: [], nextCursor: null });
    },
  });

  await client.listThreadMessages("thread/1", {
    cursor: "cursor-value",
    limit: 25,
    view: "audit",
  });
  assert.equal(
    inputs[0],
    "https://control.example/api/v1/threads/thread%2F1/messages?cursor=cursor-value&limit=25&view=audit",
  );
  await client.listThreads({ cursor: "thread-cursor", limit: 10 });
  await client.listThreadRuns("thread/1", {
    cursor: "run-cursor",
    limit: 5,
  });
  assert.deepEqual(inputs.slice(1), [
    "https://control.example/api/v1/threads?cursor=thread-cursor&limit=10",
    "https://control.example/api/v1/threads/thread%2F1/runs?cursor=run-cursor&limit=5",
  ]);
  assert.equal(inputs[0]?.includes("secret-access-token"), false);
  assert.throws(
    () => client.listAgentVersions({ limit: 101 }),
    hasProtocolCode("control_client_page_limit_invalid"),
  );
});

test("maps safe error envelopes and rejects malformed remote bodies", async () => {
  const denied = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      jsonResponse(409, {
        error: {
          category: "conflict",
          code: "agent_version_not_admitted",
          message: "safe server message",
          requestId: "request-1",
        },
      }),
  });
  await assert.rejects(
    denied.createRun({ threadId: "thread-1" }, "request-1"),
    (error) =>
      error instanceof ControlApiClientError &&
      error.status === 409 &&
      error.category === "conflict" &&
      error.code === "agent_version_not_admitted" &&
      error.requestId === "request-1",
  );

  const malformed = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response("not-json", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
  });
  await assert.rejects(
    malformed.getRun("run-1"),
    hasProtocolCode("control_api_error_envelope_invalid"),
  );
});

test("downloads one bounded digest-verified Artifact through the narrow client surface", async () => {
  const requests: string[] = [];
  const content = new TextEncoder().encode("complete Artifact content");
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    accessToken: "artifact-token",
    fetch: async (input) => {
      requests.push(String(input));
      if (String(input).endsWith("/content")) {
        return new Response(content, {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-disposition": "attachment; filename=artifact",
            "etag": `"${digest}"`,
          },
        });
      }
      return jsonResponse(200, {
        artifact: {
          artifactId: "artifact:1",
          kind: "toolOutput",
          mediaType: "text/plain",
          sensitivity: "workspaceSensitive",
          contentDigest: digest,
          byteLength: content.byteLength,
          source: {
            kind: "toolOutput",
            runId: "run-1",
            stepId: "step-1",
            callId: "call-1",
          },
          retention: {
            kind: "run",
            expiresAt: "2026-09-08T00:00:00Z",
          },
          encryption: { scheme: "aes256gcm" },
          scan: { status: "notRequired", scannedAt: null },
          createdAt: "2026-08-09T00:00:00Z",
        },
      });
    },
  });

  assert.equal(
    (await client.getArtifact("artifact:1")).artifact.contentDigest,
    digest,
  );
  assert.deepEqual(await client.downloadArtifact("artifact:1"), {
    mediaType: "text/plain",
    contentDigest: digest,
    content,
  });
  assert.deepEqual(requests, [
    "https://control.example/api/v1/artifacts/artifact%3A1",
    "https://control.example/api/v1/artifacts/artifact%3A1/content",
  ]);
});

test("rejects Artifact bytes that do not match the immutable ETag digest", async () => {
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response("tampered", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-disposition": "attachment; filename=artifact",
          "etag": `"sha256:${"a".repeat(64)}"`,
        },
      }),
  });

  await assert.rejects(
    client.downloadArtifact("artifact-1"),
    hasProtocolCode("control_client_artifact_digest_mismatch"),
  );
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function runResponse() {
  return {
    disposition: "committed" as const,
    run: {
      runId: "run-1",
      threadId: "thread/with separator",
      status: "queued" as const,
      revision: 1,
      lastSequence: 1,
      cancelRequested: false,
      waitingApproval: null,
      collaborationMode: "default" as const,
      goalBinding: null,
      outputRef: null,
      failure: null,
      createdAt: "2026-08-09T00:00:00Z",
      updatedAt: "2026-08-09T00:00:00Z",
      terminalAt: null,
    },
  };
}

function startTurnResponse() {
  return {
    ...runResponse(),
    thread: {
      threadId: "thread/with separator",
      title: null,
      status: "active" as const,
      revision: 2,
      lastMessageSequence: 1,
      forkedFromThreadId: null,
      forkedThroughHistorySequence: null,
      createdAt: "2026-08-09T00:00:00Z",
      updatedAt: "2026-08-09T00:00:00Z",
      archivedAt: null,
    },
    message: {
      messageId: "message-1",
      threadId: "thread/with separator",
      sequence: 1,
      role: "user" as const,
      content: "hello atomically",
      createdAt: "2026-08-09T00:00:00Z",
    },
  };
}

function activeAgentVersionCatalogResponse() {
  return {
    releaseId: `sha256:${"a".repeat(64)}`,
    activatedAt: "2026-08-09T00:00:00Z",
    defaultAgentVersionId: "agent-version-1",
    data: [
      {
        agentVersionId: "agent-version-1",
        contentDigest: `sha256:${"b".repeat(64)}`,
        runtimeGeneration: "ts-v0",
        policySnapshotId: "policy-1",
        model: {
          adapterName: "responses-http",
          adapterVersion: "1",
          modelId: "model-1",
        },
        createdAt: "2026-08-09T00:00:00Z",
      },
    ],
  };
}

function hasProtocolCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ControlApiProtocolError && error.code === code;
}
