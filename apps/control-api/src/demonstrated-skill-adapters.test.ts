import assert from "node:assert/strict";
import test from "node:test";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import {
  ApplicationError,
  type AgentVersionAsset,
  type ModelCallEntry,
  type RunRoute,
} from "@crewon/application";
import type { ModelCallObservation, RunState } from "@crewon/domain";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import {
  ConfiguredSkillExecutionAuthorization,
  StoreBackedSkillRunEvidence,
} from "./demonstrated-skill-adapters.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const digester = new NodeSha256ContentDigester();
const route: RunRoute = {
  authorityId: "authority-1",
  agentVersionId: "agent-1",
  runtimeGeneration: "ts-v0",
  policySnapshotId: "policy-1",
  workspaceBindingId: "workspace-1",
};
function asset() {
  return createAgentVersionAsset({
    tenantId: actor.tenantId,
    createdAt: "2026-09-14T00:00:00Z",
    version: compileAgentVersion(
      {
        schemaVersion: "crewon.agent-version-source.v0",
        agentVersionId: route.agentVersionId,
        runtimeGeneration: route.runtimeGeneration,
        policySnapshotId: route.policySnapshotId,
        instructions: null,
        model: {
          adapterName: "direct-responses",
          adapterVersion: "1",
          modelId: "model-1",
          contextWindowTokens: 128000,
          autoCompactAtTokens: 96000,
        },
        execution: { streamMaxRetries: 2, maxToolRounds: 16 },
        resources: { workspaceRequired: true, governedContextDigest: null },
        tools: [
          {
            schemaVersion: "crewon.tool-definition.v0",
            kind: "function",
            name: "browser",
            description: "Browser",
            execution: "serial",
            inputSchema: { type: "object" },
          },
        ],
      },
      digester,
    ),
  });
}
test("Skill authorization binds the configured actor and immutable selected AgentVersion tools and route", async () => {
  let stored: AgentVersionAsset | null = asset();
  const reads: unknown[] = [];
  const auth = new ConfiguredSkillExecutionAuthorization({
    actor,
    digester,
    agentVersions: {
      async loadAgentVersion(query) {
        reads.push(query);
        return stored;
      },
    },
  });
  const request = {
    actor,
    skillId: "skill-1",
    purpose: "trial" as const,
    route,
    requiredToolRefs: ["browser"],
  };
  assert.deepEqual(await auth.authorize(request), { outcome: "allow" });
  assert.deepEqual(reads[0], {
    tenantId: actor.tenantId,
    agentVersionId: route.agentVersionId,
  });
  for (const key of [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ] as const) {
    assert.deepEqual(
      await auth.authorize({ ...request, actor: { ...actor, [key]: "other" } }),
      { outcome: "deny", reasonCode: "skill_scope_mismatch" },
    );
  }
  for (const purpose of ["read", "write"] as const)
    assert.deepEqual(
      await auth.authorize({
        ...request,
        purpose,
        route: null,
        requiredToolRefs: [],
      }),
      { outcome: "allow" },
    );
  assert.deepEqual(await auth.authorize({ ...request, route: null }), {
    outcome: "deny",
    reasonCode: "skill_route_required",
  });
  assert.deepEqual(
    await auth.authorize({
      ...request,
      requiredToolRefs: ["browser", "shell"],
    }),
    { outcome: "deny", reasonCode: "skill_tool_unavailable" },
  );
  for (const key of ["runtimeGeneration", "policySnapshotId"] as const)
    assert.deepEqual(
      await auth.authorize({ ...request, route: { ...route, [key]: "other" } }),
      { outcome: "deny", reasonCode: "skill_route_mismatch" },
    );
  assert.deepEqual(
    await auth.authorize({
      ...request,
      route: { ...route, workspaceBindingId: null },
    }),
    { outcome: "deny", reasonCode: "skill_workspace_required" },
  );
  stored = { ...asset(), tenantId: "other" };
  assert.deepEqual(await auth.authorize(request), {
    outcome: "deny",
    reasonCode: "skill_agent_version_invalid",
  });
  stored = { ...asset(), contentDigest: `sha256:${"f".repeat(64)}` };
  assert.deepEqual(await auth.authorize(request), {
    outcome: "deny",
    reasonCode: "skill_agent_version_invalid",
  });
  stored = null;
  assert.deepEqual(await auth.authorize(request), {
    outcome: "deny",
    reasonCode: "skill_agent_version_not_found",
  });
});

const run: RunState = {
  ...route,
  runId: "run-1",
  threadId: "thread-1",
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  createdByActorId: actor.actorId,
  collaborationMode: "default",
  goalBinding: null,
  goalAccounting: null,
  usage: {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  },
  status: "completed",
  revision: 2,
  lastSequence: 2,
  cancelRequested: false,
  waitingApproval: null,
  suspensionReasonCode: null,
  reconciliationReceiptId: null,
  outputRef: null,
  failure: null,
  createdAt: "2026-09-14T00:00:00Z",
  updatedAt: "2026-09-14T00:01:00Z",
  terminalAt: "2026-09-14T00:01:00Z",
};
function call(patch: Partial<ModelCallObservation> = {}): ModelCallEntry {
  return {
    order: 1,
    record: {
      tenantId: actor.tenantId,
      runId: run.runId,
      stepId: "step-1",
      attemptId: "attempt-1",
      observation: {
        schemaVersion: "crewon.model-call-observation.v0",
        callId: "call-1",
        purpose: "agent",
        agentVersionId: route.agentVersionId,
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: "model-1",
        transport: "http",
        operation: "generate",
        startedAt: "2026-09-14T00:00:00Z",
        finishedAt: "2026-09-14T00:01:00Z",
        outcome: "completed",
        providerResponseId: "response-1",
        firstOutputLatencyMs: 20,
        usageEventObserved: true,
        ...patch,
      },
    },
  };
}
test("Skill evidence authorizes Run reads before querying durable model calls and never trusts review input", async () => {
  let entries: readonly ModelCallEntry[] = [];
  let denied = false;
  const queries: unknown[] = [];
  const evidence = new StoreBackedSkillRunEvidence({
    application: {
      async getRun(actualActor, runId) {
        assert.deepEqual(actualActor, actor);
        assert.equal(runId, run.runId);
        if (denied) throw new ApplicationError("authorization", "run_denied");
        return run;
      },
    },
    store: {
      async listModelCalls(query) {
        queries.push(query);
        return entries;
      },
    },
  });
  const cases: readonly [readonly ModelCallEntry[], string][] = [
    [[], "unknown"],
    [[call()], "real"],
    [[call({ adapterName: "cloud-agent", transport: "cloudAgent" })], "real"],
    [[call({ adapterName: "deterministic-fake" })], "simulated"],
    [[call({ adapterName: "mock-model" })], "simulated"],
    [[call({ adapterName: "custom-provider" })], "unknown"],
    [[call({ purpose: "compaction" })], "unknown"],
    [[call({ outcome: "failed" })], "unknown"],
    [[call({ agentVersionId: "other" })], "unknown"],
    [[call({ adapterName: "cloud-agent", transport: "http" })], "unknown"],
    [
      [
        call(),
        {
          ...call(),
          order: 2,
          record: {
            ...call().record,
            observation: {
              ...call().record.observation,
              callId: "fake-2",
              adapterName: "deterministic-fake",
            },
          },
        },
      ],
      "simulated",
    ],
  ];
  for (const [rows, verification] of cases) {
    entries = rows;
    assert.equal(
      (await evidence.observe(actor, run.runId)).verification,
      verification,
    );
  }
  assert.deepEqual(queries[0], {
    tenantId: actor.tenantId,
    runId: run.runId,
    afterOrder: 0,
    limit: 128,
  });
  denied = true;
  const count = queries.length;
  await assert.rejects(evidence.observe(actor, run.runId), {
    code: "run_denied",
  });
  assert.equal(queries.length, count);
});

test("Skill evidence paging is bounded and an incomplete inventory remains unknown", async () => {
  let queries = 0;
  const evidence = new StoreBackedSkillRunEvidence({
    application: {
      async getRun() {
        return run;
      },
    },
    store: {
      async listModelCalls(query) {
        queries++;
        return Array.from({ length: 128 }, (_, index) => ({
          ...call(),
          order: query.afterOrder + index + 1,
        }));
      },
    },
  });
  assert.equal(
    (await evidence.observe(actor, run.runId)).verification,
    "unknown",
  );
  assert.equal(queries, 8);
});
