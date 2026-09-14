import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  CrewONAgentKernel,
  DeterministicFakeModelTransport,
  type AgentKernelPort,
  type AgentSegmentContract,
  type KernelAgentEvent,
} from "@crewon/agent-kernel";
import { compileAgentVersion } from "@crewon/agent-version";
import {
  RunExecutionService,
  ThreadApplicationService,
  TurnApplicationService,
} from "@crewon/application";
import { InMemoryRunStore } from "@crewon/store";
import {
  InMemoryToolBroker,
  type ToolExecutionCommand,
} from "@crewon/tool-broker";
import { RuntimeWorker } from "./runtime-worker.ts";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";

const actor = { principalId: "p", actorId: "a", tenantId: "t", spaceId: "s" };
const route = {
  authorityId: "authority",
  agentVersionId: "generator",
  runtimeGeneration: "gen",
  policySnapshotId: "policy",
  workspaceBindingId: null,
};
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

async function fixture(
  t: TestContext,
  kernel: AgentKernelPort,
  maxToolRounds = 0,
  executionAuthority: "crewonKernel" | "providerAgent" = "crewonKernel",
) {
  const store = new InMemoryRunStore();
  t.after(() => store.close());
  const common = {
    store,
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => randomUUID() },
    digester,
  };
  const authorization = {
    authorize: async () => ({ outcome: "allow" as const }),
  };
  const threads = new ThreadApplicationService({ ...common, authorization });
  const turns = new TurnApplicationService({ ...common, authorization });
  const execution = new RunExecutionService(common);
  const thread = await threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "thread",
    title: null,
  });
  const started = await turns.startTurn(actor, {
    kind: "turn.start",
    idempotencyKey: "turn",
    threadId: thread.state.threadId,
    expectedThreadRevision: 1,
    requestedAgentVersionId: route.agentVersionId,
    route,
    content: "Produce JSON only",
    executionIntent: "none",
    toolPermissionMode: "fullAccess",
  });
  let dispatches = 0;
  class ObservedTools extends InMemoryToolBroker {
    override reserveExecution(
      command: ToolExecutionCommand,
      signal: AbortSignal,
    ) {
      dispatches++;
      return super.reserveExecution(command, signal);
    }
    override async reconcile(
      ...args: Parameters<InMemoryToolBroker["reconcile"]>
    ) {
      dispatches++;
      return super.reconcile(...args);
    }
  }
  const toolRuntime = new ObservedTools();
  const policy = { evaluate: async () => ({ outcome: "allow" as const }) };
  const version = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: route.agentVersionId,
      runtimeGeneration: route.runtimeGeneration,
      policySnapshotId: route.policySnapshotId,
      instructions: null,
      model: {
        ...kernel.modelIdentity,
        contextWindowTokens: 128000,
        autoCompactAtTokens: null,
      },
      execution: { streamMaxRetries: 0, maxToolRounds },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    digester,
  );
  const runtime = {
    version,
    executionAuthority,
    kernel,
    policy,
    toolRuntime,
    contextCompactor: new KernelContextCompactor(kernel),
  };
  const worker = new RuntimeWorker(
    {
      store,
      execution,
      kernel,
      policy,
      toolRuntime,
      agentVersionRuntimeResolver: { resolve: () => runtime },
    },
    {
      ownerId: "worker",
      nextLeaseId: () => randomUUID(),
      scanIntervalMs: null,
      retryAfterMs: 0,
    },
  );
  t.after(() => worker.close());
  const locator = { tenantId: actor.tenantId, runId: started.runState.runId };
  return {
    store,
    execution,
    worker,
    locator,
    dispatches: () => dispatches,
    events: () => store.listRunEvents(locator, 0, 100),
  };
}

function hostileKernel(name: string) {
  const contracts: AgentSegmentContract[] = [];
  const kernel: AgentKernelPort = {
    modelIdentity: {
      adapterName: "test-kernel",
      adapterVersion: "1",
      modelId: "fixture",
    },
    async *runSegment(contract) {
      contracts.push(contract);
      yield requestEvent(contract.runId, contract.segmentId, name);
    },
  };
  return { kernel, contracts };
}
function requestEvent(
  runId: string,
  segmentId: string,
  name: string,
): Extract<KernelAgentEvent, { type: "tool.requested" }> {
  return {
    schemaVersion: "crewon.agent-event.v0",
    runId,
    segmentId,
    sequence: 1,
    type: "tool.requested",
    data: { callId: "call-1", kind: "function", name, input: "{}" },
  };
}

test("zero rounds still completes a real Worker text path with no model-visible tools", async (t) => {
  const transport = new DeterministicFakeModelTransport({
    expectedLastUserMessage: "Produce JSON only",
    events: [
      { type: "output.delta", delta: "{}" },
      { type: "completed", checkpoint: null },
    ],
  });
  const kernel = new CrewONAgentKernel({ transport });
  const f = await fixture(t, kernel);
  assert.equal((await f.worker.wake()).kind, "completed");
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(transport.requests[0]!.tools, []);
  assert.equal(f.dispatches(), 0);
});

for (const name of ["browser", "create_goal", "update_plan"]) {
  test(`zero rounds rejects ${name} before durable request, approval, or dispatch`, async (t) => {
    const hostile = hostileKernel(name);
    const f = await fixture(t, hostile.kernel);
    assert.deepEqual(await f.worker.wake(), {
      kind: "failed",
      runId: f.locator.runId,
      code: "agent_tools_disabled",
    });
    assert.deepEqual(hostile.contracts[0]!.allowedTools, []);
    assert.deepEqual(hostile.contracts[0]!.runtimeTools, []);
    assert.equal(
      (await f.events()).some(
        (event) =>
          event.type === "tool.requested" ||
          event.type === "run.approval.required",
      ),
      false,
    );
    assert.equal(f.dispatches(), 0);
  });
}

test("zero rounds rejects a durable pending tool on resume without model or tool calls", async (t) => {
  const hostile = hostileKernel("browser");
  const f = await fixture(t, hostile.kernel);
  const claim = await f.store.claimNextWorkItem({
    ownerId: "prior-worker",
    leaseId: "prior-lease",
    leaseDurationMs: 10000,
  });
  assert.ok(claim);
  await f.execution.startRun(claim);
  await f.execution.recordAgentEvent(
    claim,
    requestEvent(f.locator.runId, "prior-segment", "browser"),
  );
  await f.store.retryWorkItem({
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
    retryAfterMs: 0,
    reasonCode: "resume",
  });
  assert.deepEqual(await f.worker.wake(), {
    kind: "failed",
    runId: f.locator.runId,
    code: "agent_tools_disabled",
  });
  assert.equal(hostile.contracts.length, 0);
  assert.equal(f.dispatches(), 0);
});

test("zero rounds refuses provider-owned execution because internal tools cannot be fenced", async (t) => {
  const hostile = hostileKernel("browser");
  const f = await fixture(t, hostile.kernel, 0, "providerAgent");
  assert.deepEqual(await f.worker.wake(), {
    kind: "failed",
    runId: f.locator.runId,
    code: "agent_version_provider_authority_mismatch",
  });
  assert.equal(hostile.contracts.length, 0);
  assert.equal(f.dispatches(), 0);
});
