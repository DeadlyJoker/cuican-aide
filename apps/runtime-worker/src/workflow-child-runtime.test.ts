import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  CrewONAgentKernel,
  DeterministicFakeModelTransport,
} from "@crewon/agent-kernel";
import { RunExecutionService, type RunRoute } from "@crewon/application";
import {
  compositionFixture,
  claimCompositionWork,
  compositionInput,
} from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import { workflowAdmissionDigest } from "../../../packages/store/src/workflow-run-admission-validation.ts";
import type { SqliteWorkflowChildDispatchOptions } from "../../../packages/store/src/sqlite-workflow-child-dispatch.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";

for (const scenario of [
  { name: "malformed JSON", output: "not-json", outcome: "completed" as const },
  {
    name: "wrong output schema",
    output: '{"wrong":true}',
    outcome: "completed" as const,
  },
  {
    name: "over-budget model stream",
    output: '{"topic":"' + "x".repeat(40_000) + '"}',
    outcome: "failed" as const,
  },
])
  test(`workflow child ${scenario.name} terminates the node without another model sample or verifier`, async (t) => {
    const dispatchChildren: SqliteWorkflowChildDispatchOptions = {
      resolveRoute: ({ parent, node }) => ({
        authorityId: parent.authorityId,
        runtimeGeneration: parent.runtimeGeneration,
        policySnapshotId: parent.policySnapshotId,
        workspaceBindingId: parent.workspaceBindingId,
        agentVersionId:
          node.kind === "agent"
            ? node.agentVersionId
            : node.kind === "verification"
              ? node.verifierAgentVersionId
              : "invalid-gate",
      }),
    };
    const f = await compositionFixture(t, {
      nowEpochMs: Date.now(),
      composition: { dispatchChildren },
    });
    await f.composition.admitWorkflowNodes(f.input);
    await f.store.completeWorkItem(f.input.lease);
    const transport = await runChild(
      f,
      t,
      "agent-1",
      'Node input:\n{"topic":"safe"}',
      scenario.output,
      scenario.outcome,
    );
    const nextInput = compositionInput(
      f.input.binding,
      await claimCompositionWork(f.store, "invalid-result"),
    );
    const failed = await f.composition.admitWorkflowNodes(nextInput);
    assert.equal(failed.execution.status, "failed");
    assert.equal(failed.execution.nodes[1]!.status, "canceled");
    assert.equal(transport.requests.length, 1);
    assert.equal(
      f.database
        .prepare("SELECT count(*) AS n FROM workflow_node_children")
        .get()!.n,
      1,
    );
    const before = f.snapshot();
    await f.composition.admitWorkflowNodes(nextInput);
    assert.deepEqual(f.snapshot(), before);
    const terminal = await f.composition.finalizeWorkflowRun(nextInput);
    assert.equal(terminal.run.status, "failed");
    assert.equal(terminal.run.failure?.code, "workflow_node_failed");
    assert.equal(transport.requests.length, 1);
    assert.deepEqual(await f.store.listPendingWorkItems(10), []);
  });

test("ordinary Worker streams isolated workflow children and a reopened scheduler advances actual committed results without renderer state", async (t) => {
  const f = await compositionFixture(t, {
    nowEpochMs: Date.now(),
    composition: {
      dispatchChildren: {
        resolveRoute: ({ parent, node }) => ({
          authorityId: parent.authorityId,
          runtimeGeneration: parent.runtimeGeneration,
          policySnapshotId: parent.policySnapshotId,
          workspaceBindingId: parent.workspaceBindingId,
          agentVersionId:
            node.kind === "agent"
              ? node.agentVersionId
              : node.kind === "verification"
                ? node.verifierAgentVersionId
                : "invalid-gate",
        }),
      },
    },
  });
  const dispatched = await f.composition.admitWorkflowNodes({
    ...f.input,
    leaseDurationMs: 1,
  });
  assert.deepEqual(dispatched.admissions, []);
  await f.store.completeWorkItem(f.input.lease);
  await f.store.close();
  f.clock.advance(10); // Original 1 ms node lease has expired; the committed child owns execution.
  const first = await runChild(
    f,
    t,
    "agent-1",
    'Node input:\n{"topic":"safe"}',
    '{"topic":"agent-result"}',
  );
  const schedulerStore = f.open();
  const scheduler = schedulerStore.experimentalWorkflowRunCompositionStore({
    dispatchChildren: {
      resolveRoute: ({ parent, node }) => ({
        authorityId: parent.authorityId,
        runtimeGeneration: parent.runtimeGeneration,
        policySnapshotId: parent.policySnapshotId,
        workspaceBindingId: parent.workspaceBindingId,
        agentVersionId:
          node.kind === "verification"
            ? node.verifierAgentVersionId
            : node.kind === "agent"
              ? node.agentVersionId
              : "invalid-gate",
      }),
    },
  });
  const nextInput = compositionInput(
    f.input.binding,
    await claimCompositionWork(schedulerStore, "after-first"),
  );
  const secondDispatch = await scheduler.admitWorkflowNodes(nextInput);
  assert.equal(secondDispatch.execution.nodes[0]!.status, "completed");
  assert.equal(secondDispatch.execution.nodes[1]!.status, "running");
  await schedulerStore.completeWorkItem(nextInput.lease);
  await schedulerStore.close();
  const second = await runChild(
    f,
    t,
    "verifier-1",
    'Node input:\n{"topic":"agent-result"}',
    '{"topic":"verified"}',
  );
  const finalStore = f.open(),
    finalScheduler = finalStore.experimentalWorkflowRunCompositionStore({
      dispatchChildren: {
        resolveRoute: () => {
          throw new Error("no further child allowed");
        },
      },
    });
  const finalInput = compositionInput(
    f.input.binding,
    await claimCompositionWork(finalStore, "after-second"),
  );
  const done = await finalScheduler.admitWorkflowNodes(finalInput);
  assert.equal(done.execution.status, "completed");
  assert.deepEqual(done.admissions, []);
  const terminal = await finalScheduler.finalizeWorkflowRun(finalInput);
  assert.equal(terminal.run.status, "completed");
  const rootMessages = await finalStore.listMessages(
    {
      tenantId: f.input.tenantId,
      threadId: terminal.run.threadId,
    },
    0,
    10,
  );
  assert.equal(rootMessages.at(-1)!.content, '{"topic":"verified"}');
  assert.equal(
    terminal.run.outputRef,
    `message:${rootMessages.at(-1)!.messageId}`,
  );
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM workflow_node_children")
      .get()!.n,
    2,
  );
  assert.equal(first.requests.length, 1);
  assert.equal(second.requests.length, 1);
  assert.equal(first.requests[0]!.input.items.length, 3);
  assert.equal(second.requests[0]!.input.items.length, 3);
  assert.ok(
    second.requests[0]!.input.items.every(
      (item) =>
        item.type !== "message" || !item.content.includes('"topic":"safe"'),
    ),
  );
  const replayed = await finalScheduler.finalizeWorkflowRun(finalInput);
  assert.equal(replayed.disposition, "replayed");
  assert.equal(replayed.run.outputRef, terminal.run.outputRef);
  assert.deepEqual(await finalStore.listPendingWorkItems(10), []);
  assert.deepEqual(
    await finalStore.listModelUsage({
      tenantId: f.input.tenantId,
      runId: f.input.runId,
      afterOrder: 0,
      limit: 10,
    }),
    [],
  );
});

async function runChild(
  f: Awaited<ReturnType<typeof compositionFixture>>,
  t: TestContext,
  agentVersionId: string,
  expectedLastUserMessage: string,
  output: string,
  expectedOutcome: "completed" | "failed" = "completed",
) {
  const store = f.open();
  let ids = 0;
  const route: RunRoute = {
    authorityId: "authority-1",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    agentVersionId,
  };
  const transport = new DeterministicFakeModelTransport({
    expectedLastUserMessage,
    events: [
      ...Array.from(
        { length: Math.ceil(output.length / 8192) },
        (_, index) => ({
          type: "output.delta" as const,
          delta: output.slice(index * 8192, (index + 1) * 8192),
        }),
      ),
      {
        type: "usage",
        inputTokens: 90,
        cachedInputTokens: 64,
        outputTokens: 12,
        totalTokens: 102,
      },
      { type: "completed", checkpoint: null },
    ],
  });
  const worker = new RuntimeWorker(
    {
      store,
      execution: new RunExecutionService({
        store,
        clock: {
          now: () => new Date(f.clock.nowEpochMilliseconds()).toISOString(),
        },
        ids: { nextId: () => `${agentVersionId}-worker-${++ids}` },
        digester: workflowAdmissionDigest,
      }),
      kernel: new CrewONAgentKernel({ transport }),
      policy: new PinnedRunExecutionPolicy(route),
    },
    {
      ownerId: `worker-${agentVersionId}`,
      nextLeaseId: () => `${agentVersionId}-lease-${++ids}`,
      leaseDurationMs: 10_000,
      scanIntervalMs: null,
    },
  );
  t.after(() => worker.close());
  const outcome = await worker.wake();
  assert.equal(outcome.kind, expectedOutcome, JSON.stringify(outcome));
  if (expectedOutcome === "completed") {
    const records = await store.listModelUsage({
      tenantId: f.input.tenantId,
      runId: transport.requests[0]!.runId,
      afterOrder: 0,
      limit: 10,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.record.observation.usage.cachedInputTokens, 64);
    assert.equal(
      records[0]!.record.observation.usage.cachedInputTokensReported,
      true,
    );
  }
  await worker.close();
  await store.close();
  return transport;
}
