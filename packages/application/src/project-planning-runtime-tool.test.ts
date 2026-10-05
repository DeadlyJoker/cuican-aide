import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectPlanningCapability } from "@crewon/contracts/project-planning";
import type { RunState } from "@crewon/domain";
import type { WorkItemClaim } from "./durable-queue-port.ts";
import {
  captureProjectPlanningRuntimePort,
  type ProjectPlanningRuntimePort,
} from "./project-planning-runtime-port.ts";
import {
  executeProjectPlanningRuntimeTool,
  type ProjectPlanningRequestedTool,
} from "./project-planning-runtime-tool.ts";
import { ApplicationError } from "./application-error.ts";

const capability: ProjectPlanningCapability = {
  capabilityId: `sha256:${"a".repeat(64)}`,
  source: {
    pluginId: "crewon.short-drama",
    publisherId: "crewon.examples",
    version: "18.0.0",
    packageDigest: `sha256:${"b".repeat(64)}`,
    contributionId: "workbench",
  },
  title: "短剧创作",
  kind: "short-drama",
  stages: ["brief", "outline", "script"],
  maximumEpisodes: 16,
  moduleAvailable: true,
  textPlansAvailable: true,
  executionReady: false,
};
const proposal = {
  capabilityId: capability.capabilityId,
  title: "雨夜来信",
  briefText: "摄影师在雨夜收到父亲寄来的旧信。",
  instruction: "保留悬疑氛围，逐步讨论人物动机。",
  start: "brief",
  target: "script",
  episodeCount: 2,
  adoption: "manual",
};

function fixture() {
  const run: RunState = {
    runId: "planning-run",
    threadId: "planning-thread",
    tenantId: "planning-tenant",
    spaceId: "planning-space",
    createdByActorId: "planning-actor",
    authorityId: "planning-kernel",
    runtimeGeneration: "runtime-1",
    agentVersionId: "agent-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
    collaborationMode: "default",
    origin: null,
    goalBinding: null,
    goalAccounting: null,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    status: "running",
    revision: 2,
    lastSequence: 2,
    cancelRequested: false,
    waitingApproval: null,
    suspensionReasonCode: null,
    reconciliationReceiptId: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-10-06T00:00:00Z",
    updatedAt: "2026-10-06T00:00:01Z",
    terminalAt: null,
  };
  const claim: WorkItemClaim = {
    workItem: {
      workItemId: "planning-work",
      tenantId: run.tenantId,
      runId: run.runId,
      kind: "run.execute",
      payload: {},
      createdAt: run.createdAt,
    },
    lease: {
      ownerId: "planning-worker",
      leaseId: "planning-lease",
      epoch: 1,
      expiresAt: "2026-10-06T00:01:00Z",
    },
  };
  let current = run,
    active = true,
    reads = 0,
    policyChecks = 0;
  const port: ProjectPlanningRuntimePort = {
    version: "crewon.project-planning-runtime.v1",
    canPublish: (value) => value.createdByActorId === "planning-actor",
    assertActive() {
      if (!active)
        throw new ApplicationError("authorization", "metadata_revoked");
    },
    async assertCurrent(input) {
      policyChecks++;
      assert.equal(input.run.createdByActorId, "planning-actor");
      assert.equal(input.claim.workItem.runId, input.run.runId);
      this.assertActive();
    },
    async readCapabilities() {
      reads++;
      return [capability];
    },
  };
  const request = (
    name: ProjectPlanningRequestedTool["data"]["name"],
    input: unknown,
  ): ProjectPlanningRequestedTool => ({
    schemaVersion: "crewon.agent-event.v0",
    runId: run.runId,
    segmentId: "planning-segment",
    sequence: 1,
    type: "tool.requested",
    data: {
      kind: "function",
      name,
      callId: "planning-call",
      input: JSON.stringify(input),
    },
  });
  const options = {
    claim,
    port: captureProjectPlanningRuntimePort(port),
    signal: new AbortController().signal,
    loadRun: async () => current,
    assertClaimCurrent() {},
  };
  return {
    options,
    port,
    request,
    run,
    setRun: (value: RunState) => {
      current = value;
    },
    withdraw: () => {
      active = false;
    },
    counters: () => ({ reads, policyChecks }),
  };
}

test("named metadata ports publish a detached bounded proposal with only the actual Run origin", async () => {
  const f = fixture();
  const result = await executeProjectPlanningRuntimeTool({
    ...f.options,
    requested: f.request("crewon_project_propose", proposal),
  });
  assert.equal(result.isError, false);
  const output = JSON.parse(result.output);
  assert.deepEqual(output.origin, {
    runId: f.run.runId,
    threadId: f.run.threadId,
    callId: "planning-call",
  });
  assert.deepEqual(output.input, proposal);
  assert.equal(output.capability.executionReady, false);
  assert.ok(Buffer.byteLength(result.output) <= 8192);
  assert.equal(f.counters().reads, 1);
  f.withdraw();
  assert.throws(result.assertActive, { code: "metadata_revoked" });
});

test("model-supplied origin or delegation is rejected before any capability read", async () => {
  for (const extra of [{ origin: { runId: "another" } }, { delegation: {} }]) {
    const f = fixture();
    const result = await executeProjectPlanningRuntimeTool({
      ...f.options,
      requested: f.request("crewon_project_propose", { ...proposal, ...extra }),
    });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.output), {
      error: "project_planning_arguments_invalid",
    });
    assert.equal(f.counters().reads, 0);
  }
});

test("a stale capability does not silently retarget the proposal", async () => {
  const f = fixture();
  const result = await executeProjectPlanningRuntimeTool({
    ...f.options,
    requested: f.request("crewon_project_propose", {
      ...proposal,
      capabilityId: `sha256:${"c".repeat(64)}`,
    }),
  });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.output), {
    error: "project_planning_capability_unavailable",
  });
});

test("actual cancellation or metadata withdrawal during a read prevents a late result", async () => {
  for (const failure of ["cancel", "withdraw"] as const) {
    const f = fixture();
    const port = captureProjectPlanningRuntimePort({
      ...f.port,
      async readCapabilities() {
        if (failure === "cancel") f.setRun({ ...f.run, cancelRequested: true });
        else f.withdraw();
        return [capability];
      },
    });
    await assert.rejects(
      executeProjectPlanningRuntimeTool({
        ...f.options,
        port,
        requested: f.request("crewon_project_capabilities", {}),
      }),
      {
        code:
          failure === "cancel"
            ? "execution_cancel_pending"
            : "metadata_revoked",
      },
    );
  }
});

test("expired claim and a changed actual Run owner are independently fenced", async () => {
  const f = fixture();
  let active = true;
  const port = captureProjectPlanningRuntimePort({
    ...f.port,
    async readCapabilities() {
      active = false;
      return [capability];
    },
  });
  await assert.rejects(
    executeProjectPlanningRuntimeTool({
      ...f.options,
      port,
      assertClaimCurrent() {
        if (!active) throw new Error("lease_lost");
      },
      requested: f.request("crewon_project_capabilities", {}),
    }),
    /lease_lost/u,
  );
  const second = fixture();
  await assert.rejects(
    executeProjectPlanningRuntimeTool({
      ...second.options,
      port: captureProjectPlanningRuntimePort({
        ...second.port,
        async readCapabilities() {
          second.setRun({ ...second.run, createdByActorId: "another-actor" });
          return [capability];
        },
      }),
      requested: second.request("crewon_project_capabilities", {}),
    }),
    { code: "project_planning_run_changed" },
  );
});

test("malformed or over-budget metadata cannot become a partial advertised capability list", async () => {
  const f = fixture();
  await assert.rejects(
    executeProjectPlanningRuntimeTool({
      ...f.options,
      port: captureProjectPlanningRuntimePort({
        ...f.port,
        async readCapabilities() {
          return Array.from({ length: 9 }, (_, index) => ({
            ...capability,
            capabilityId: `sha256:${String(index).repeat(64)}`,
          }));
        },
      }),
      requested: f.request("crewon_project_capabilities", {}),
    }),
  );
});

test("a valid large proposal and capability yield a bounded error rather than a failed Run retry", async () => {
  const f = fixture();
  const largeCapability = {
    ...capability,
    title: "z".repeat(256),
    source: {
      ...capability.source,
      pluginId: "p".repeat(128),
      publisherId: "s".repeat(128),
      contributionId: "c".repeat(128),
    },
  };
  const largeProposal = {
    ...proposal,
    title: "t".repeat(128),
    briefText: '"'.repeat(1000) + "a".repeat(3096),
    instruction: "b".repeat(2048),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(largeProposal)) < 8192);
  const result = await executeProjectPlanningRuntimeTool({
    ...f.options,
    port: captureProjectPlanningRuntimePort({
      ...f.port,
      async readCapabilities() {
        return [largeCapability];
      },
    }),
    requested: f.request("crewon_project_propose", largeProposal),
  });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.output), {
    error: "project_planning_result_too_large",
  });
  assert.ok(Buffer.byteLength(result.output) <= 8192);
});

test("a coarse publication flag never bypasses current principal authorization", async () => {
  const f = fixture();
  const port = captureProjectPlanningRuntimePort({
    ...f.port,
    canPublish: () => true,
    async assertCurrent() {
      throw new ApplicationError("authorization", "principal_changed");
    },
  });
  await assert.rejects(
    executeProjectPlanningRuntimeTool({
      ...f.options,
      port,
      requested: f.request("crewon_project_capabilities", {}),
    }),
    { code: "principal_changed" },
  );
  assert.equal(f.counters().reads, 0);
});

test("captured deployment callbacks are not replaced while a tool call is awaiting", async () => {
  const f = fixture();
  const captured = captureProjectPlanningRuntimePort(f.port);
  Object.assign(f.port, {
    assertCurrent: () =>
      assert.fail("later caller callback must not replace captured owner"),
    readCapabilities: () =>
      assert.fail("later caller callback must not replace captured reader"),
  });
  const result = await executeProjectPlanningRuntimeTool({
    ...f.options,
    port: captured,
    requested: f.request("crewon_project_capabilities", {}),
  });
  assert.equal(result.isError, false);
  assert.equal(f.counters().reads, 1);
});

test("deployment callback capture rejects incompatible versions and getters without evaluating them", () => {
  const f = fixture();
  assert.throws(
    () =>
      captureProjectPlanningRuntimePort({
        ...f.port,
        version: "invalid",
      } as unknown as ProjectPlanningRuntimePort),
    { code: "project_planning_runtime_invalid" },
  );
  let evaluated = 0;
  const value = { ...f.port };
  Object.defineProperty(value, "assertCurrent", {
    enumerable: true,
    get() {
      evaluated++;
      return f.port.assertCurrent;
    },
  });
  assert.throws(() => captureProjectPlanningRuntimePort(value), {
    code: "project_planning_runtime_invalid",
  });
  assert.equal(evaluated, 0);
});
