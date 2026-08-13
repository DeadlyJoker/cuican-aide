import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ContractValidationError } from "./contract-validation-error.ts";
import {
  formatAutomationCursor,
  formatAgentVersionCursor,
  formatCapabilityCursor,
  formatMessageCursor,
  formatThreadCursor,
  formatThreadRunCursor,
  parseAgentVersionId,
  parseAgentVersionListQuery,
  parseCapabilityListQuery,
  parseArchiveThreadRequest,
  parseAutomationId,
  parseAutomationListQuery,
  parseAppendThreadMessageRequest,
  parseCancelRunRequest,
  parseClearThreadGoalRequest,
  parseCompactThreadRequest,
  parseApprovalId,
  parseArtifactId,
  parseCreateRunRequest,
  parseCreateAutomationRequest,
  parseCreateThreadRequest,
  parseDeleteThreadRequest,
  parseDecideToolApprovalRequest,
  parseForkThreadRequest,
  parseIdempotencyKey,
  parseLastEventSequence,
  parseMessageListQuery,
  parseProbeModelProviderRequest,
  parsePutLocalSettingsRequest,
  parsePublishAgentVersionRequest,
  parseRunId,
  parseRunEventViewMode,
  parseRenameThreadRequest,
  parseRollbackThreadRequest,
  parseRunAutomationNowRequest,
  parseSetThreadGoalRequest,
  parseStartTurnRequest,
  parseStartWorkflowRunRequest,
  parseDecideWorkflowHumanGateRequest,
  parseThreadId,
  parseThreadHistoryView,
  parseThreadListQuery,
  parseThreadRunListQuery,
  parseUnarchiveThreadRequest,
  type GetThreadGoalResponse,
  type RunMutationResponse,
  type ThreadEventView,
  type ThreadGoalEventView,
  type ThreadGoalMutationResponse,
} from "./control-api-contract.ts";

test("parses exact bounded local settings mutations", () => {
  assert.deepEqual(
    parsePutLocalSettingsRequest({
      expectedRevision: 2,
      locale: "en",
      theme: "dark",
    }),
    { expectedRevision: 2, locale: "en", theme: "dark" },
  );
  for (const input of [
    { expectedRevision: -1, locale: "en", theme: "dark" },
    { expectedRevision: 0, locale: "fr", theme: "dark" },
    { expectedRevision: 0, locale: "en", theme: "system" },
    { expectedRevision: 0, locale: "en", theme: "dark", extra: true },
  ]) {
    assert.throws(
      () => parsePutLocalSettingsRequest(input),
      (error) =>
        error instanceof ContractValidationError &&
        error.code === "local_settings_request_invalid",
    );
  }
});
import { RUN_STATUSES } from "./run-contract.ts";

const openApi = JSON.parse(
  readFileSync(
    new URL("../openapi/control-api.v1.json", import.meta.url),
    "utf8",
  ),
) as OpenApiDocument;

test("freezes the Run API as OpenAPI 3.1 without client-owned authority fields", () => {
  assert.equal(openApi.openapi, "3.1.1");
  assert.deepEqual(Object.keys(openApi.paths).sort(), [
    "/api/v1/agent-versions",
    "/api/v1/agent-versions/active",
    "/api/v1/agent-versions/{agentVersionId}",
    "/api/v1/artifacts/{artifactId}",
    "/api/v1/artifacts/{artifactId}/content",
    "/api/v1/automations",
    "/api/v1/automations/{automationId}",
    "/api/v1/automations/{automationId}:run-now",
    "/api/v1/capabilities",
    "/api/v1/health/live",
    "/api/v1/health/ready",
    "/api/v1/knowledge",
    "/api/v1/knowledge/{knowledgeId}",
    "/api/v1/local-settings",
    "/api/v1/model-provider-settings",
    "/api/v1/model-provider-settings/probe",
    "/api/v1/offices",
    "/api/v1/offices/{officeVersionId}",
    "/api/v1/offices/{officeVersionId}:runs",
    "/api/v1/runs",
    "/api/v1/runs/{runId}",
    "/api/v1/runs/{runId}/events",
    "/api/v1/runs/{runId}:cancel",
    "/api/v1/threads",
    "/api/v1/threads/{threadId}",
    "/api/v1/threads/{threadId}/events",
    "/api/v1/threads/{threadId}/forks",
    "/api/v1/threads/{threadId}/goal",
    "/api/v1/threads/{threadId}/goal/events",
    "/api/v1/threads/{threadId}/messages",
    "/api/v1/threads/{threadId}/runs",
    "/api/v1/threads/{threadId}/turns",
    "/api/v1/threads/{threadId}/workspace-list",
    "/api/v1/threads/{threadId}/workspace-list/{executionId}",
    "/api/v1/threads/{threadId}/workspace-list/{executionId}/events",
    "/api/v1/threads/{threadId}/workspace-list/{executionId}:cancel",
    "/api/v1/threads/{threadId}/workspace-list/{executionId}:reconcile",
    "/api/v1/threads/{threadId}:archive",
    "/api/v1/threads/{threadId}:compact",
    "/api/v1/threads/{threadId}:delete",
    "/api/v1/threads/{threadId}:rename",
    "/api/v1/threads/{threadId}:rollback",
    "/api/v1/threads/{threadId}:unarchive",
    "/api/v1/tool-approvals/{approvalId}",
    "/api/v1/tool-approvals/{approvalId}:decide",
    "/api/v1/workflow-gates:decide",
    "/api/v1/workflow-runs",
    "/api/v1/workflow-versions",
    "/api/v1/workflow-versions/{workflowVersionId}",
  ]);
  assert.deepEqual(
    Object.keys(openApi.components.schemas.CreateRunRequest.properties),
    ["threadId", "agentVersionId"],
  );
  assert.deepEqual(openApi.components.schemas.RunStatus.enum, RUN_STATUSES);
  assert.deepEqual(openApi.components.schemas.RunView.properties.purpose.enum, [
    "turn",
    "manualCompaction",
    "workflow",
  ]);
  assert.equal(
    openApi.components.schemas.RunView.required.includes(
      "workflowVersionBinding",
    ),
    true,
  );
  assert.deepEqual(openApi.components.schemas.ThreadGoalStatus.enum, [
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
  ]);
  assert.equal(
    JSON.stringify(openApi.components.schemas.ThreadGoalView).includes(
      "tenantId",
    ),
    false,
  );
  for (const forbidden of [
    "tenantId",
    "spaceId",
    "actorId",
    "authorityId",
    "policySnapshotId",
    "workspaceBindingId",
    "actionDigest",
  ]) {
    assert.equal(
      JSON.stringify(openApi.paths["/api/v1/runs"].post).includes(forbidden),
      false,
    );
    assert.equal(
      JSON.stringify(openApi.components.schemas.RunView).includes(forbidden),
      false,
    );
  }
});

test("accepts only public Workflow Human Gate decision authority", () => {
  const input = {
    runId: "run-1",
    nodeId: "gate",
    claimId: "claim-1",
    claimEpoch: 1,
    gateRequestId: "gate-request-1",
    decision: "approve" as const,
  };
  assert.deepEqual(parseDecideWorkflowHumanGateRequest(input), input);
  for (const injected of [
    "binding",
    "decisionReceiptId",
    "failureCode",
    "tenantId",
  ]) {
    assert.throws(
      () =>
        parseDecideWorkflowHumanGateRequest({ ...input, [injected]: "forged" }),
      /workflow_gate_fields_invalid/u,
    );
  }
  assert.throws(
    () =>
      parseDecideWorkflowHumanGateRequest({
        ...input,
        nodeId: "界".repeat(86),
      }),
    /workflow_gate_node_id_invalid/u,
  );
  const schemas = openApi.components.schemas as Record<
    string,
    { properties: Record<string, { maxLength?: number }> }
  >;
  assert.equal(
    schemas.DecideWorkflowHumanGateRequest!.properties.nodeId!.maxLength,
    256,
  );
  assert.equal(
    schemas.DecideWorkflowHumanGateRequest!.properties.claimId!.maxLength,
    256,
  );
  assert.equal(
    schemas.DecideWorkflowHumanGateRequest!.properties.gateRequestId!.maxLength,
    256,
  );
  assert.equal(
    schemas.WorkflowHumanGateDecisionResponse!.properties.nodeId!.maxLength,
    256,
  );
  assert.equal(
    schemas.WorkflowHumanGateDecisionResponse!.properties.gateRequestId!
      .maxLength,
    256,
  );
});

test("parses only bounded Workflow Run start authority", () => {
  assert.deepEqual(
    parseStartWorkflowRunRequest({
      workflowVersionId: "workflow-version-1",
      threadId: "thread-1",
      input: { prompt: "ship", flags: [true, null, 3] },
    }),
    {
      workflowVersionId: "workflow-version-1",
      threadId: "thread-1",
      input: { prompt: "ship", flags: [true, null, 3] },
    },
  );
  for (const forbidden of ["contentDigest", "agentVersionId", "authorityId"]) {
    assert.throws(
      () =>
        parseStartWorkflowRunRequest({
          workflowVersionId: "workflow-version-1",
          threadId: "thread-1",
          input: {},
          [forbidden]: "caller-owned",
        }),
      ContractValidationError,
    );
  }
  assert.throws(
    () =>
      parseStartWorkflowRunRequest({
        workflowVersionId: "workflow-version-1",
        threadId: "thread-1",
        input: "x".repeat(8193),
      }),
    ContractValidationError,
  );
});

test("freezes strict manual-only Automation commands and pagination", () => {
  const create = {
    threadId: "thread-1",
    expectedThreadRevision: 3,
    title: "Review changes",
    prompt: "Review the current changes and summarize risks.",
    agentVersionId: null,
  };
  assert.deepEqual(parseCreateAutomationRequest(create), create);
  assert.deepEqual(
    parseCreateAutomationRequest({
      ...create,
      agentVersionId: "agent-version-1",
    }),
    { ...create, agentVersionId: "agent-version-1" },
  );
  assert.deepEqual(
    parseRunAutomationNowRequest({
      expectedAutomationRevision: 1,
      expectedThreadRevision: 4,
    }),
    { expectedAutomationRevision: 1, expectedThreadRevision: 4 },
  );
  assert.equal(parseAutomationId("automation-1"), "automation-1");

  const cursor = formatAutomationCursor({
    updatedAt: "2026-08-09T00:00:00Z",
    automationId: "automation-1",
  });
  assert.deepEqual(parseAutomationListQuery({ cursor, limit: "25" }), {
    before: {
      updatedAt: "2026-08-09T00:00:00Z",
      resourceId: "automation-1",
    },
    limit: 25,
  });
  assert.deepEqual(parseAutomationListQuery({}), { before: null, limit: 100 });

  for (const input of [
    { ...create, tenantId: "tenant-attacker" },
    { ...create, prompt: "😀".repeat(2_500) },
    { ...create, title: "x".repeat(257) },
    { ...create, expectedThreadRevision: 0 },
    { ...create, agentVersionId: "" },
  ]) {
    assert.throws(() => parseCreateAutomationRequest(input), isContractError);
  }
  for (const input of [
    { expectedAutomationRevision: 2, expectedThreadRevision: 4 },
    { expectedAutomationRevision: 1, expectedThreadRevision: 0 },
    {
      expectedAutomationRevision: 1,
      expectedThreadRevision: 4,
      routeDigest: `sha256:${"a".repeat(64)}`,
    },
  ]) {
    assert.throws(() => parseRunAutomationNowRequest(input), isContractError);
  }
  for (const query of [
    { cursor, limit: "0" },
    { cursor, limit: "101" },
    { cursor: `${cursor}injected`, limit: "25" },
    { cursor, limit: "25", tenantId: "tenant-attacker" },
  ]) {
    assert.throws(() => parseAutomationListQuery(query), isContractError);
  }

  const automationView = openApi.components.schemas.AutomationView as {
    required: string[];
    properties: Record<string, { const?: unknown }>;
  };
  assert.deepEqual(Object.keys(automationView.properties), [
    "automationId",
    "threadId",
    "title",
    "prompt",
    "agentVersionId",
    "executionMode",
    "automaticScheduling",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  assert.equal(automationView.properties.executionMode.const, "manualOnly");
  assert.equal(automationView.properties.automaticScheduling.const, false);
  assert.deepEqual(
    (
      openApi.components.schemas.ListAutomationsResponse as {
        required: string[];
      }
    ).required,
    ["data", "nextCursor"],
  );
  assert.deepEqual(
    (
      openApi.components.schemas.AutomationInvocationView as {
        required: string[];
      }
    ).required,
    ["automationId", "runId"],
  );
  const publicContract = JSON.stringify({
    paths: Object.fromEntries(
      Object.entries(openApi.paths).filter(([path]) =>
        path.startsWith("/api/v1/automations"),
      ),
    ),
    schemas: Object.fromEntries(
      Object.entries(openApi.components.schemas).filter(([name]) =>
        name.includes("Automation"),
      ),
    ),
  });
  for (const forbidden of [
    "tenantId",
    "spaceId",
    "actorId",
    "createdByActorId",
    "definitionDigest",
    "instructionDigest",
    "routeDigest",
    "invocationId",
    "providerSettings",
    "workspaceBinding",
  ]) {
    assert.equal(publicContract.includes(forbidden), false, forbidden);
  }
});

test("freezes a redacted Provider snapshot and strict bounded probe", () => {
  assert.deepEqual(parseProbeModelProviderRequest({}), {});
  for (const input of [
    null,
    [],
    { providerId: "attacker" },
    { endpoint: "https://attacker.invalid" },
  ]) {
    assert.throws(() => parseProbeModelProviderRequest(input), isContractError);
  }

  const binding = openApi.components.schemas.ModelProviderBindingView as {
    required: string[];
    properties: Record<string, unknown>;
  };
  assert.deepEqual(binding.required, [
    "providerId",
    "displayName",
    "endpoint",
    "credentialKind",
    "environmentVariable",
    "isActive",
  ]);
  assert.deepEqual(Object.keys(binding.properties), binding.required);

  const snapshot = openApi.components.schemas.ModelProviderSettingsSnapshot as {
    required: string[];
    properties: {
      activeProviderId: { type: string[] };
      updatedAt: { type: string[] };
      providers: { maxItems: number; items: { $ref: string } };
      runtimeAvailability: { $ref: string };
    };
  };
  assert.deepEqual(snapshot.required, [
    "revision",
    "activeProviderId",
    "providers",
    "runtimeAvailability",
    "updatedAt",
  ]);
  assert.deepEqual(snapshot.properties.activeProviderId.type, [
    "string",
    "null",
  ]);
  assert.deepEqual(snapshot.properties.updatedAt.type, ["string", "null"]);
  assert.equal(snapshot.properties.providers.maxItems, 128);
  assert.equal(
    snapshot.properties.providers.items.$ref,
    "#/components/schemas/ModelProviderBindingView",
  );

  const probeStatus = openApi.components.schemas.ModelProviderProbeStatus as {
    enum: string[];
  };
  assert.deepEqual(probeStatus.enum, [
    "ok",
    "credentialMissing",
    "authenticationFailed",
    "rateLimited",
    "providerError",
    "unreachable",
    "invalidResponse",
    "bindingMismatch",
  ]);
  const probe = openApi.components.schemas.ProbeModelProviderResponse as {
    required: string[];
    properties: {
      models: { oneOf: [{ maxItems: number }, { type: string }] };
      modelCount: { type: string[]; maximum: number };
      retryAfterMs: { type: string[]; maximum: number };
    };
  };
  assert.deepEqual(probe.required, [
    "disposition",
    "providerId",
    "catalogRevision",
    "status",
    "models",
    "modelCount",
    "latencyMs",
    "retryable",
    "retryAfterMs",
  ]);
  assert.equal(probe.properties.models.oneOf[0].maxItems, 100);
  assert.equal(probe.properties.models.oneOf[1].type, "null");
  assert.deepEqual(probe.properties.modelCount.type, ["integer", "null"]);
  assert.deepEqual(probe.properties.retryAfterMs.type, ["integer", "null"]);

  const publicContract = JSON.stringify({
    paths: {
      settings: openApi.paths["/api/v1/model-provider-settings"],
      probe: openApi.paths["/api/v1/model-provider-settings/probe"],
    },
    schemas: {
      binding,
      snapshot,
      response: openApi.components.schemas.GetModelProviderSettingsResponse,
      probe,
    },
  });
  for (const forbidden of [
    "runtimeBindingId",
    "coordinatorBinding",
    "pendingOperation",
    "operationProof",
    "tenantId",
    "spaceId",
    "actorId",
    "apiKey",
    "accessToken",
    "clientSecret",
    "credentialValue",
  ]) {
    assert.equal(publicContract.includes(forbidden), false, forbidden);
  }
});

test("freezes authorized Artifact metadata/content without storage internals", () => {
  assert.equal(parseArtifactId("artifact-1"), "artifact-1");
  for (const input of ["../artifact", "artifact/1", "", "a".repeat(513)]) {
    assert.throws(() => parseArtifactId(input), isContractError);
  }
  const publicContract = JSON.stringify({
    metadata: openApi.paths["/api/v1/artifacts/{artifactId}"],
    content: openApi.paths["/api/v1/artifacts/{artifactId}/content"],
    view: openApi.components.schemas.ArtifactView,
  });
  for (const forbidden of [
    "tenantId",
    "spaceId",
    "ownerActorId",
    "attemptId",
    "keyId",
    "relativePath",
    "bucket",
  ]) {
    assert.equal(publicContract.includes(forbidden), false);
  }
});

test("freezes strict immutable AgentVersion publication and pagination", () => {
  const source = {
    schemaVersion: "crewon.agent-version-source.v0",
    agentVersionId: "agent-version-1",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy-1",
    instructions: null,
    model: {
      adapterName: "responses-http",
      adapterVersion: "1",
      modelId: "model-1",
      contextWindowTokens: 128_000,
      autoCompactAtTokens: 96_000,
    },
    execution: { streamMaxRetries: 2, maxToolRounds: 16 },
    resources: {
      workspaceRequired: false,
      governedContextDigest: null,
    },
    tools: [],
  };
  assert.deepEqual(parsePublishAgentVersionRequest(source), source);
  assert.equal(parseAgentVersionId("agent-version-1"), "agent-version-1");
  const cursor = formatAgentVersionCursor("agent-version-1");
  assert.deepEqual(parseAgentVersionListQuery({ cursor, limit: "25" }), {
    afterAgentVersionId: "agent-version-1",
    limit: 25,
  });
  const capabilityCursor = formatCapabilityCursor({
    releaseId: `sha256:${"a".repeat(64)}`,
    afterKey: '["agent-version-1","function","read_file"]',
  });
  assert.deepEqual(
    parseCapabilityListQuery({ cursor: capabilityCursor, limit: "10" }),
    {
      releaseId: `sha256:${"a".repeat(64)}`,
      afterKey: '["agent-version-1","function","read_file"]',
      limit: 10,
    },
  );
  assert.throws(
    () => parseCapabilityListQuery({ cursor: `${capabilityCursor}x` }),
    isContractError,
  );
  assert.throws(
    () => formatCapabilityCursor({ releaseId: "release-1", afterKey: "key" }),
    isContractError,
  );
  const malformedReleaseCursor = Buffer.from(
    'crewon.capability.cursor.v1:["release-1","key"]',
  ).toString("base64url");
  assert.throws(
    () => parseCapabilityListQuery({ cursor: malformedReleaseCursor }),
    isContractError,
  );
  for (const input of [
    { ...source, tenantId: "tenant-attacker" },
    { ...source, contentDigest: `sha256:${"a".repeat(64)}` },
    { ...source, createdAt: "2026-08-09T00:00:00Z" },
  ]) {
    assert.throws(
      () => parsePublishAgentVersionRequest(input),
      isContractError,
    );
  }
  for (const input of [
    { cursor: "not-an-agent-version-cursor" },
    { limit: "101" },
    { afterAgentVersionId: "agent-version-1" },
  ]) {
    assert.throws(() => parseAgentVersionListQuery(input), isContractError);
  }
  const publicContract = JSON.stringify({
    paths: {
      collection: openApi.paths["/api/v1/agent-versions"],
      active: openApi.paths["/api/v1/agent-versions/active"],
      item: openApi.paths["/api/v1/agent-versions/{agentVersionId}"],
    },
    schemas: {
      catalog: openApi.components.schemas.ActiveAgentVersionCatalogResponse,
      view: openApi.components.schemas.AgentVersionView,
    },
  });
  for (const forbidden of [
    "tenantId",
    "spaceId",
    "actorId",
    "definitionJson",
    "instructions",
    "authorityId",
    "workspaceBindingId",
    "materializationDigest",
  ]) {
    assert.equal(publicContract.includes(forbidden), false);
  }
});

test("bounds WorkflowVersion lists to metadata-only summaries", () => {
  const summary = openApi.components.schemas.WorkflowVersionSummaryView;
  assert.deepEqual(Object.keys(summary.properties).sort(), [
    "contentDigest",
    "createdAt",
    "description",
    "name",
    "workflowId",
    "workflowVersionId",
  ]);
  const list = openApi.components.schemas.ListWorkflowVersionsResponse;
  assert.deepEqual(list.properties.data.items, {
    $ref: "#/components/schemas/WorkflowVersionSummaryView",
  });
  for (const forbidden of [
    "definitionJson",
    "nodes",
    "inputSchema",
    "outputSchema",
    "executionOrder",
  ]) {
    assert.equal(JSON.stringify(summary).includes(forbidden), false, forbidden);
  }
});

test("freezes strict Thread and text Message authority without client scope fields", () => {
  assert.deepEqual(parseCreateThreadRequest({ title: null }), { title: null });
  assert.deepEqual(parseCreateThreadRequest({ title: "Planning" }), {
    title: "Planning",
  });
  assert.deepEqual(
    parseAppendThreadMessageRequest({
      expectedRevision: 1,
      content: "hello",
    }),
    { expectedRevision: 1, content: "hello" },
  );
  assert.equal(parseThreadId("thread-1"), "thread-1");
  assert.deepEqual(
    parseForkThreadRequest({
      expectedRevision: 3,
      throughHistorySequence: null,
    }),
    { expectedRevision: 3, throughHistorySequence: null },
  );
  assert.deepEqual(parseArchiveThreadRequest({ expectedRevision: 4 }), {
    expectedRevision: 4,
  });
  assert.deepEqual(
    parseRollbackThreadRequest({ expectedRevision: 4, numTurns: 2 }),
    { expectedRevision: 4, numTurns: 2 },
  );
  assert.deepEqual(parseUnarchiveThreadRequest({ expectedRevision: 5 }), {
    expectedRevision: 5,
  });
  assert.deepEqual(
    parseRenameThreadRequest({ expectedRevision: 5, title: "Renamed" }),
    { expectedRevision: 5, title: "Renamed" },
  );
  assert.deepEqual(
    parseRenameThreadRequest({ expectedRevision: 6, title: null }),
    { expectedRevision: 6, title: null },
  );
  assert.deepEqual(parseDeleteThreadRequest({ expectedRevision: 6 }), {
    expectedRevision: 6,
  });
  assert.equal(parseThreadHistoryView(undefined), "standard");
  assert.equal(parseThreadHistoryView("standard"), "standard");
  assert.equal(parseThreadHistoryView("audit"), "audit");
  assert.deepEqual(
    parseForkThreadRequest({
      expectedRevision: 3,
      throughHistorySequence: 8,
    }),
    { expectedRevision: 3, throughHistorySequence: 8 },
  );
  assert.deepEqual(parseMessageListQuery({}), {
    afterSequence: 0,
    limit: 100,
    view: "standard",
  });
  assert.deepEqual(
    parseMessageListQuery({
      cursor: formatMessageCursor(2),
      limit: "10",
      view: "audit",
    }),
    { afterSequence: 2, limit: 10, view: "audit" },
  );
  const threadCursor = formatThreadCursor({
    updatedAt: "2026-08-09T00:00:00Z",
    threadId: "thread-2",
  });
  assert.deepEqual(
    parseThreadListQuery({ cursor: threadCursor, limit: "10" }),
    {
      before: {
        updatedAt: "2026-08-09T00:00:00Z",
        resourceId: "thread-2",
      },
      limit: 10,
    },
  );
  const runCursor = formatThreadRunCursor({
    updatedAt: "2026-08-09T00:00:01Z",
    runId: "run-2",
  });
  assert.deepEqual(parseThreadRunListQuery({ cursor: runCursor, limit: "5" }), {
    before: {
      updatedAt: "2026-08-09T00:00:01Z",
      resourceId: "run-2",
    },
    limit: 5,
  });
  for (const input of [
    { cursor: "not-a-resource-cursor" },
    { limit: "0" },
    { offset: "1" },
  ]) {
    assert.throws(() => parseThreadListQuery(input), isContractError);
    assert.throws(() => parseThreadRunListQuery(input), isContractError);
  }

  for (const input of [
    {},
    { title: "" },
    { title: null, tenantId: "tenant-attacker" },
  ]) {
    assert.throws(() => parseCreateThreadRequest(input), isContractError);
  }
  for (const input of [
    { expectedRevision: 0, content: "hello" },
    { expectedRevision: 1, content: "" },
    { expectedRevision: 1, content: "hello", role: "assistant" },
  ]) {
    assert.throws(
      () => parseAppendThreadMessageRequest(input),
      isContractError,
    );
  }
  for (const input of [
    { cursor: "not-a-valid-cursor" },
    { limit: "0" },
    { limit: "101" },
    { afterSequence: "1" },
  ]) {
    assert.throws(() => parseMessageListQuery(input), isContractError);
  }
  for (const input of [
    { expectedRevision: 0, throughHistorySequence: null },
    { expectedRevision: 1, throughHistorySequence: -1 },
    { expectedRevision: 1 },
    {
      expectedRevision: 1,
      throughHistorySequence: null,
      tenantId: "tenant-attacker",
    },
  ]) {
    assert.throws(() => parseForkThreadRequest(input), isContractError);
  }
  for (const input of [
    {},
    { expectedRevision: 0, numTurns: 1 },
    { expectedRevision: 1, numTurns: 0 },
    { expectedRevision: 1, numTurns: 0x1_0000_0000 },
    { expectedRevision: 1, numTurns: 1, actorId: "actor-attacker" },
  ]) {
    assert.throws(() => parseRollbackThreadRequest(input), isContractError);
  }
  for (const input of [
    {},
    { expectedRevision: 0 },
    { expectedRevision: 1, tenantId: "tenant-attacker" },
  ]) {
    assert.throws(() => parseArchiveThreadRequest(input), isContractError);
    assert.throws(() => parseUnarchiveThreadRequest(input), isContractError);
    assert.throws(() => parseDeleteThreadRequest(input), isContractError);
  }
  for (const input of [
    { expectedRevision: 1 },
    { expectedRevision: 0, title: "Title" },
    { expectedRevision: 1, title: "" },
    { expectedRevision: 1, title: "Title", actorId: "actor-attacker" },
  ]) {
    assert.throws(() => parseRenameThreadRequest(input), isContractError);
  }
  assert.throws(() => parseThreadHistoryView("admin"), isContractError);

  const paths = JSON.stringify({
    create: openApi.paths["/api/v1/threads"],
    messages: openApi.paths["/api/v1/threads/{threadId}/messages"],
    fork: openApi.paths["/api/v1/threads/{threadId}/forks"],
    archive: openApi.paths["/api/v1/threads/{threadId}:archive"],
    rollback: openApi.paths["/api/v1/threads/{threadId}:rollback"],
    unarchive: openApi.paths["/api/v1/threads/{threadId}:unarchive"],
    rename: openApi.paths["/api/v1/threads/{threadId}:rename"],
    delete: openApi.paths["/api/v1/threads/{threadId}:delete"],
    events: openApi.paths["/api/v1/threads/{threadId}/events"],
  });
  for (const forbidden of ["tenantId", "spaceId", "actorId", "role"]) {
    assert.equal(paths.includes(forbidden), false);
  }
  const proposedPlanProjection = JSON.stringify(
    openApi.components.schemas.ProposedPlanView,
  );
  assert.equal(proposedPlanProjection.includes("content"), true);
  assert.equal(proposedPlanProjection.includes('maxLength":9999'), true);
  assert.equal(proposedPlanProjection.includes("9999-byte UTF-8"), true);
  for (const forbidden of ["tenantId", "contentDigest", "authorityId"]) {
    assert.equal(proposedPlanProjection.includes(forbidden), false);
  }
  const event: ThreadEventView = {
    schemaVersion: "crewon.thread-event.v0",
    threadId: "thread-1",
    eventId: "thread-event-2",
    sequence: 2,
    occurredAt: "2026-08-09T00:00:01Z",
    type: "thread.archived",
  };
  assert.deepEqual(Object.keys(event).sort(), [
    "eventId",
    "occurredAt",
    "schemaVersion",
    "sequence",
    "threadId",
    "type",
  ]);
  const rollbackEvent: ThreadEventView = {
    threadId: "thread-1",
    eventId: "thread-event-3",
    sequence: 3,
    occurredAt: "2026-08-09T00:00:02Z",
    type: "thread.rolled_back",
    requestedTurns: 2,
    removedTurns: 1,
  };
  assert.deepEqual(Object.keys(rollbackEvent).sort(), [
    "eventId",
    "occurredAt",
    "removedTurns",
    "requestedTurns",
    "sequence",
    "threadId",
    "type",
  ]);
  const rollbackEventSchema = JSON.stringify(
    openApi.components.schemas.ThreadRolledBackEventView,
  );
  for (const field of ["requestedTurns", "removedTurns"]) {
    assert.equal(rollbackEventSchema.includes(field), true);
  }
  for (const forbidden of [
    "schemaVersion",
    "tenantId",
    "actorId",
    "rollbackId",
    "markerItemId",
    "historyFromSequence",
    "historyThroughSequence",
    "markerHistorySequence",
  ]) {
    assert.equal(rollbackEventSchema.includes(forbidden), false);
  }
  const rollbackRoute = openApi.paths["/api/v1/threads/{threadId}:rollback"];
  assert.equal(rollbackRoute.post.operationId, "rollbackThread");
  assert.deepEqual(
    rollbackRoute.post.requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/RollbackThreadRequest" },
  );
  assert.deepEqual(Object.keys(rollbackRoute.post.responses).sort(), [
    "200",
    "201",
    "400",
    "401",
    "403",
    "404",
    "409",
    "500",
  ]);
  for (const [path, operationId] of [
    ["/api/v1/threads/{threadId}:archive", "archiveThread"],
    ["/api/v1/threads/{threadId}:rollback", "rollbackThread"],
    ["/api/v1/threads/{threadId}:unarchive", "unarchiveThread"],
    ["/api/v1/threads/{threadId}:rename", "renameThread"],
    ["/api/v1/threads/{threadId}:delete", "deleteThread"],
  ] as const) {
    const operation = openApi.paths[path].post;
    assert.equal(operation.operationId, operationId);
    for (const parameter of ["IdempotencyKey", "RequiredCsrfToken"]) {
      assert.equal(
        operation.parameters.some(
          (candidate) =>
            candidate.$ref === `#/components/parameters/${parameter}`,
        ),
        true,
      );
    }
  }
  assert.deepEqual(openApi.components.schemas.ThreadStatus.enum, [
    "active",
    "archived",
    "deleted",
  ]);
  assert.equal(
    openApi.components.schemas.ThreadView.required.includes("deletedAt"),
    true,
  );
});

test("freezes strict Thread Goal mutations and the double-option token budget", () => {
  const create = {
    expectedRevision: null,
    objective: "完成最终迁移",
    status: "active" as const,
    tokenBudget: { kind: "set" as const, value: null },
  };
  assert.deepEqual(parseSetThreadGoalRequest(create), create);
  assert.deepEqual(
    parseSetThreadGoalRequest({
      expectedRevision: 2,
      objective: null,
      status: null,
      tokenBudget: { kind: "keep" },
    }),
    {
      expectedRevision: 2,
      objective: null,
      status: null,
      tokenBudget: { kind: "keep" },
    },
  );
  assert.deepEqual(
    parseSetThreadGoalRequest({
      expectedRevision: 2,
      objective: null,
      status: "paused",
      tokenBudget: { kind: "set", value: 50_000 },
    }),
    {
      expectedRevision: 2,
      objective: null,
      status: "paused",
      tokenBudget: { kind: "set", value: 50_000 },
    },
  );
  assert.deepEqual(parseClearThreadGoalRequest({ expectedRevision: 3 }), {
    expectedRevision: 3,
  });

  for (const input of [
    { ...create, expectedRevision: 0 },
    { ...create, objective: "" },
    { ...create, objective: "a".repeat(4_001) },
    { ...create, status: "running" },
    { ...create, tokenBudget: { kind: "keep", value: null } },
    { ...create, tokenBudget: { kind: "set" } },
    { ...create, tokenBudget: { kind: "set", value: 0 } },
    { ...create, actorId: "actor-attacker" },
  ]) {
    assert.throws(() => parseSetThreadGoalRequest(input), isContractError);
  }
  for (const input of [
    { expectedRevision: null },
    { expectedRevision: 0 },
    { expectedRevision: 1, tenantId: "tenant-attacker" },
  ]) {
    assert.throws(() => parseClearThreadGoalRequest(input), isContractError);
  }

  const path = openApi.paths["/api/v1/threads/{threadId}/goal"];
  assert.equal(path.put.operationId, "setThreadGoal");
  assert.equal(path.delete.operationId, "clearThreadGoal");
  for (const operation of [path.put, path.delete]) {
    assert.equal(
      operation.parameters.some(
        (parameter) =>
          parameter.$ref === "#/components/parameters/IdempotencyKey",
      ),
      true,
    );
    assert.equal(
      operation.parameters.some(
        (parameter) =>
          parameter.$ref === "#/components/parameters/RequiredCsrfToken",
      ),
      true,
    );
  }
  assert.deepEqual(openApi.components.schemas.SetThreadGoalRequest.required, [
    "expectedRevision",
    "objective",
    "status",
    "tokenBudget",
  ]);
  assert.deepEqual(openApi.components.schemas.GetThreadGoalResponse.required, [
    "goal",
    "eventSequence",
  ]);
  const snapshot: GetThreadGoalResponse = {
    goal: null,
    eventSequence: 0,
  };
  assert.deepEqual(Object.keys(snapshot), ["goal", "eventSequence"]);

  const response: ThreadGoalMutationResponse = {
    disposition: "committed",
    goal: null,
    canceledRun: null,
    retainedRun: null,
    continuationRun: null,
  };
  assert.deepEqual(Object.keys(response), [
    "disposition",
    "goal",
    "canceledRun",
    "retainedRun",
    "continuationRun",
  ]);
  const publicContract = JSON.stringify({
    path,
    request: openApi.components.schemas.SetThreadGoalRequest,
    response: openApi.components.schemas.ThreadGoalMutationResponse,
  });
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
  ]) {
    assert.equal(publicContract.includes(forbidden), false);
  }
});

test("defines an independent durable Thread Goal SSE contract", () => {
  const operation = openApi.paths["/api/v1/threads/{threadId}/goal/events"].get;
  assert.equal(operation.operationId, "streamThreadGoalEvents");
  assert.equal(
    operation.parameters.some(
      (parameter) => parameter.$ref === "#/components/parameters/LastEventId",
    ),
    true,
  );
  assert.equal(
    operation.responses["200"].content["text/event-stream"][
      "x-crewon-event-schema"
    ].$ref,
    "#/components/schemas/ThreadGoalEventView",
  );
  assert.equal(openApi.components.schemas.ThreadGoalEventView.oneOf.length, 2);

  const event: ThreadGoalEventView = {
    schemaVersion: "crewon.thread-goal-event.v0",
    threadId: "thread-1",
    eventId: "goal-event-1",
    sequence: 1,
    occurredAt: "2026-08-09T00:00:01Z",
    type: "goal.cleared",
    data: { previousGoalId: "goal-1", previousRevision: 3 },
  };
  assert.equal(event.sequence, 1);

  const publicContract = JSON.stringify({
    operation,
    event: openApi.components.schemas.ThreadGoalEventView,
    updated: openApi.components.schemas.ThreadGoalUpdatedEventView,
    cleared: openApi.components.schemas.ThreadGoalClearedEventView,
  });
  for (const forbidden of [
    "tenantId",
    "runId",
    "authorityId",
    "policySnapshotId",
    "workspaceBindingId",
    "historyItem",
    "outbox",
  ]) {
    assert.equal(publicContract.includes(forbidden), false);
  }
});

test("defines sequence-based SSE resume and a bounded safe event projection", () => {
  const operation = openApi.paths["/api/v1/runs/{runId}/events"].get;
  assert.equal(operation.operationId, "streamRunEvents");
  assert.equal(
    operation.parameters.some(
      (parameter) => parameter.$ref === "#/components/parameters/LastEventId",
    ),
    true,
  );
  assert.equal(
    operation.parameters.some(
      (parameter) => parameter.$ref === "#/components/parameters/RunEventView",
    ),
    true,
  );
  assert.deepEqual(Object.keys(operation.responses["200"].content), [
    "text/event-stream",
  ]);
  assert.equal(openApi.components.schemas.RunEventView.oneOf.length, 27);
  assert.deepEqual(
    openApi.components.schemas.RunGoalAccountingUpdatedEventView.allOf[1]
      .properties.data.required,
    ["goalId", "goalRevision", "steeringPending"],
  );
  assert.deepEqual(
    openApi.components.schemas.ModelSamplingRetryEventView.allOf[1].properties
      .data.required,
    ["segmentId", "samplingAttempt", "maxRetries", "code", "discardedOutput"],
  );
  const fallbackProjection = JSON.stringify(
    openApi.components.schemas.ModelTransportFallbackEventView,
  );
  for (const required of [
    "segmentId",
    "fromTransport",
    "toTransport",
    "code",
    "discardedOutput",
  ]) {
    assert.equal(fallbackProjection.includes(required), true);
  }
  assert.deepEqual(
    openApi.components.schemas.SegmentProviderContinuationEventView.allOf[1]
      .properties.data.required,
    ["segmentId", "sampleIndex", "throughHistorySequence"],
  );
  const checkpointProjection = JSON.stringify(
    openApi.components.schemas.SegmentCheckpointedEventView,
  );
  assert.equal(checkpointProjection.includes("segmentId"), true);
  for (const forbidden of ["responseId", "opaquePayload", "adapterName"]) {
    assert.equal(checkpointProjection.includes(forbidden), false);
  }
  const rateLimitProjection = JSON.stringify(
    openApi.components.schemas.RateLimitUpdatedEventView,
  );
  assert.equal(rateLimitProjection.includes("snapshot"), true);
  for (const forbidden of ["providerBody", "providerMessage", "requestId"]) {
    assert.equal(rateLimitProjection.includes(forbidden), false);
  }
  const toolProjectionKeys = [
    ...Object.keys(
      openApi.components.schemas.ToolRequestedEventView.allOf[1].properties.data
        .properties,
    ),
    ...Object.keys(
      openApi.components.schemas.ToolCompletedEventView.allOf[1].properties.data
        .properties,
    ),
  ];
  for (const forbidden of ["input", "output", "artifactRef"]) {
    assert.equal(toolProjectionKeys.includes(forbidden), false);
  }
  const planProjectionKeys = Object.keys(
    openApi.components.schemas.PlanProposedEventView.allOf[1].properties.data
      .properties,
  );
  assert.deepEqual(planProjectionKeys.sort(), [
    "messageId",
    "messageSequence",
    "planId",
  ]);
  for (const forbidden of ["content", "contentDigest", "tenantId"]) {
    assert.equal(planProjectionKeys.includes(forbidden), false);
  }
});

test("parses the explicit client versus audit event view", () => {
  assert.equal(parseRunEventViewMode(undefined), "client");
  assert.equal(parseRunEventViewMode("client"), "client");
  assert.equal(parseRunEventViewMode("audit"), "audit");
  for (const input of [null, "", "debug", ["audit"]]) {
    assert.throws(() => parseRunEventViewMode(input), isContractError);
  }
});

test("parses strict Run requests and rejects authority injection", () => {
  assert.deepEqual(parseCreateRunRequest({ threadId: "thread-1" }), {
    threadId: "thread-1",
  });
  assert.deepEqual(
    parseCreateRunRequest({
      threadId: "thread-1",
      agentVersionId: "agent-version-1",
    }),
    { threadId: "thread-1", agentVersionId: "agent-version-1" },
  );
  assert.deepEqual(
    parseCreateRunRequest({ threadId: "thread-1", agentVersionId: null }),
    { threadId: "thread-1", agentVersionId: null },
  );
  assert.deepEqual(parseCancelRunRequest({ expectedRevision: 2 }), {
    expectedRevision: 2,
  });
  assert.equal(parseRunId("run-1"), "run-1");
  assert.equal(parseIdempotencyKey("request-1"), "request-1");
  assert.deepEqual(
    parseStartTurnRequest({
      expectedRevision: 1,
      content: "start atomically",
      agentVersionId: null,
      executionIntent: "goal",
    }),
    {
      expectedRevision: 1,
      content: "start atomically",
      agentVersionId: null,
      executionIntent: "goal",
    },
  );
  assert.deepEqual(
    parseCompactThreadRequest({
      expectedRevision: 2,
      agentVersionId: null,
    }),
    { expectedRevision: 2, agentVersionId: null },
  );

  for (const input of [
    { threadId: "thread-1", tenantId: "tenant-attacker" },
    { threadId: "thread-1", authorityId: "cloud-attacker" },
    { threadId: "thread-1", agentVersionId: "" },
    { threadId: "" },
    null,
  ]) {
    assert.throws(() => parseCreateRunRequest(input), isContractError);
  }
  for (const input of [
    { expectedRevision: 0 },
    { expectedRevision: 1, actorId: "actor-attacker" },
    { expectedRevision: 1.5 },
    null,
  ]) {
    assert.throws(() => parseCancelRunRequest(input), isContractError);
  }
  for (const input of [
    { expectedRevision: 1, content: "missing version" },
    {
      expectedRevision: 0,
      content: "invalid revision",
      agentVersionId: null,
      executionIntent: "none",
    },
    {
      expectedRevision: 1,
      content: "injected",
      agentVersionId: null,
      executionIntent: "none",
      authorityId: "attacker",
    },
  ]) {
    assert.throws(() => parseStartTurnRequest(input), isContractError);
  }
  for (const input of [
    { expectedRevision: 1 },
    { expectedRevision: 0, agentVersionId: null },
    {
      expectedRevision: 1,
      agentVersionId: null,
      authorityId: "attacker",
    },
  ]) {
    assert.throws(() => parseCompactThreadRequest(input), isContractError);
  }
});

test("parses a bounded Tool approval decision without exposing security bindings", () => {
  assert.equal(parseApprovalId("approval-1"), "approval-1");
  assert.deepEqual(
    parseDecideToolApprovalRequest({
      expectedRevision: 1,
      decision: "approved",
      comment: "reviewed",
    }),
    { expectedRevision: 1, decision: "approved", comment: "reviewed" },
  );
  for (const input of [
    { expectedRevision: 0, decision: "approved", comment: null },
    { expectedRevision: 1, decision: "allow", comment: null },
    {
      expectedRevision: 1,
      decision: "approved",
      comment: null,
      actionDigest: `sha256:${"a".repeat(64)}`,
    },
  ]) {
    assert.throws(() => parseDecideToolApprovalRequest(input), isContractError);
  }
  const publicApproval = JSON.stringify({
    get: openApi.paths["/api/v1/tool-approvals/{approvalId}"],
    decide: openApi.paths["/api/v1/tool-approvals/{approvalId}:decide"],
    view: openApi.components.schemas.ToolApprovalView,
  });
  for (const forbidden of [
    "actionDigest",
    "policySnapshotId",
    "workspaceBindingId",
    "credentialBindingId",
    "resourceBindingId",
    "requestedByActorId",
  ]) {
    assert.equal(publicApproval.includes(forbidden), false);
  }
});

test("parses Last-Event-ID as a safe integer sequence", () => {
  assert.equal(parseLastEventSequence(undefined), 0);
  assert.equal(parseLastEventSequence("0"), 0);
  assert.equal(parseLastEventSequence("42"), 42);
  for (const input of ["", "01", "-1", "1.5", "9007199254740992", ["1"]]) {
    assert.throws(() => parseLastEventSequence(input), isContractError);
  }
});

test("generated public responses cannot include internal Run routing fields", () => {
  const response: RunMutationResponse = {
    disposition: "committed",
    run: {
      runId: "run-1",
      threadId: "thread-1",
      status: "queued",
      revision: 1,
      lastSequence: 1,
      cancelRequested: false,
      waitingApproval: null,
      collaborationMode: "default",
      purpose: "turn",
      workflowVersionBinding: null,
      goalBinding: null,
      outputRef: null,
      failure: null,
      createdAt: "2026-08-08T00:00:01Z",
      updatedAt: "2026-08-08T00:00:01Z",
      terminalAt: null,
    },
  };
  assert.deepEqual(Object.keys(response.run).sort(), [
    "cancelRequested",
    "collaborationMode",
    "createdAt",
    "failure",
    "goalBinding",
    "lastSequence",
    "outputRef",
    "purpose",
    "revision",
    "runId",
    "status",
    "terminalAt",
    "threadId",
    "updatedAt",
    "waitingApproval",
    "workflowVersionBinding",
  ]);
});

function isContractError(error: unknown): boolean {
  return error instanceof ContractValidationError;
}

type OpenApiDocument = Readonly<{
  openapi: string;
  paths: Record<string, unknown> & {
    "/api/v1/agent-versions": unknown;
    "/api/v1/agent-versions/active": unknown;
    "/api/v1/agent-versions/{agentVersionId}": unknown;
    "/api/v1/artifacts/{artifactId}": unknown;
    "/api/v1/artifacts/{artifactId}/content": unknown;
    "/api/v1/threads": unknown;
    "/api/v1/threads/{threadId}:archive": {
      post: GoalMutationOperationSchema;
    };
    "/api/v1/threads/{threadId}:rollback": {
      post: RollbackMutationOperationSchema;
    };
    "/api/v1/threads/{threadId}:unarchive": {
      post: GoalMutationOperationSchema;
    };
    "/api/v1/threads/{threadId}:rename": {
      post: GoalMutationOperationSchema;
    };
    "/api/v1/threads/{threadId}:delete": {
      post: GoalMutationOperationSchema;
    };
    "/api/v1/threads/{threadId}/events": unknown;
    "/api/v1/threads/{threadId}/messages": unknown;
    "/api/v1/threads/{threadId}/goal": GoalPathSchema;
    "/api/v1/threads/{threadId}/goal/events": GoalEventPathSchema;
    "/api/v1/runs": { post: unknown };
    "/api/v1/runs/{runId}/events": {
      get: {
        operationId: string;
        parameters: { $ref?: string }[];
        responses: {
          "200": { content: Record<string, unknown> };
        };
      };
    };
  };
  components: {
    schemas: Record<string, unknown> & {
      CreateRunRequest: { properties: Record<string, unknown> };
      RunStatus: { enum: readonly string[] };
      RunView: {
        required: readonly string[];
        properties: { purpose: { enum: readonly string[] } };
      };
      WorkflowVersionSummaryView: {
        properties: Record<string, unknown>;
      };
      ListWorkflowVersionsResponse: {
        properties: { data: { items: unknown } };
      };
      ThreadGoalStatus: { enum: readonly string[] };
      ThreadStatus: { enum: readonly string[] };
      ThreadView: { required: readonly string[] };
      ThreadEventView: unknown;
      ThreadRolledBackEventView: unknown;
      ThreadGoalView: unknown;
      GetThreadGoalResponse: { required: string[] };
      SetThreadGoalRequest: {
        required: string[];
        properties: Record<string, unknown>;
      };
      ThreadGoalMutationResponse: unknown;
      ThreadGoalEventView: { oneOf: unknown[] };
      ThreadGoalUpdatedEventView: unknown;
      ThreadGoalClearedEventView: unknown;
      AgentVersionView: unknown;
      ActiveAgentVersionCatalogResponse: unknown;
      ArtifactView: unknown;
      RunEventView: { oneOf: unknown[] };
      ModelSamplingRetryEventView: {
        allOf: readonly [
          unknown,
          { properties: { data: { required: string[] } } },
        ];
      };
      SegmentProviderContinuationEventView: {
        allOf: readonly [
          unknown,
          { properties: { data: { required: string[] } } },
        ];
      };
      PlanProposedEventView: ToolEventSchema;
      RunGoalAccountingUpdatedEventView: {
        allOf: readonly [
          unknown,
          { properties: { data: { required: string[] } } },
        ];
      };
      ToolRequestedEventView: ToolEventSchema;
      ToolCompletedEventView: ToolEventSchema;
    };
  };
}>;

type ToolEventSchema = Readonly<{
  allOf: readonly [
    unknown,
    { properties: { data: { properties: Record<string, unknown> } } },
  ];
}>;

type GoalPathSchema = Readonly<{
  get: unknown;
  put: GoalMutationOperationSchema;
  delete: GoalMutationOperationSchema;
}>;

type GoalMutationOperationSchema = Readonly<{
  operationId: string;
  parameters: readonly Readonly<{ $ref?: string }>[];
}>;

type RollbackMutationOperationSchema = GoalMutationOperationSchema &
  Readonly<{
    requestBody: {
      content: {
        "application/json": { schema: { $ref: string } };
      };
    };
    responses: Record<string, unknown>;
  }>;

type GoalEventPathSchema = Readonly<{
  get: Readonly<{
    operationId: string;
    parameters: readonly Readonly<{ $ref?: string }>[];
    responses: {
      "200": {
        content: {
          "text/event-stream": {
            "x-crewon-event-schema": { $ref: string };
          };
        };
      };
    };
  }>;
}>;
