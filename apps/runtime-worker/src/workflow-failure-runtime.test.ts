import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ModelRequest, ModelTransportPort } from "@crewon/agent-kernel";
import {
  InMemoryToolBroker,
  ToolExecutionUnknownOutcomeError,
  ToolResultCapacity,
} from "@crewon/tool-broker";
import {
  compositionFixture,
  compositionInput,
  claimCompositionWork,
  parallelVersion,
} from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import { cancellationChildDispatch } from "../../../packages/store/src/workflow-cancellation.test-support.ts";
import { childWorker } from "./workflow-child-worker.test-support.ts";
import { oversizedSiblingVersion } from "../../../packages/store/src/workflow-preparation-failure.test-support.ts";

async function fixture(t: TestContext, asset = parallelVersion(2)) {
  const f = await compositionFixture(t, {
    nowEpochMs: Date.now(),
    asset,
    composition: { dispatchChildren: cancellationChildDispatch },
  });
  await f.composition.admitWorkflowNodes(f.input);
  return f;
}
function invalidModel() {
  let calls = 0;
  const transport: ModelTransportPort = {
    adapterName: "failure-fixture",
    adapterVersion: "1",
    modelId: "synthetic",
    async *stream() {
      calls++;
      yield { type: "output.delta", delta: "invalid-json" };
      yield { type: "completed", checkpoint: null };
    },
  };
  return { transport, calls: () => calls };
}
async function finishFailure(
  f: Awaited<ReturnType<typeof fixture>>,
  completedCount = 0,
) {
  const store = f.open(),
    scheduler = store.experimentalWorkflowRunCompositionStore({
      dispatchChildren: cancellationChildDispatch,
    });
  const state = (await scheduler.admitWorkflowNodes(f.input)).execution;
  assert.equal(state.status, "failed");
  assert.equal(state.cancelRequested, false);
  assert.equal(state.nodes.filter((n) => n.status === "failed").length, 1);
  assert.equal(
    state.nodes.filter((n) => n.status === "canceled").length,
    2 - completedCount,
  );
  assert.equal(
    state.nodes.filter((n) => n.status === "completed").length,
    completedCount,
  );
  const final = await scheduler.finalizeWorkflowRun(f.input);
  assert.equal(final.run.status, "failed");
  assert.equal(final.run.cancelRequested, false);
  assert.equal(final.run.failure?.code, "workflow_node_failed");
  for (let i = 0; i < 2; i++) {
    const wake = compositionInput(
      f.input.binding,
      await claimCompositionWork(store, `failure-wake-${i}`),
    );
    assert.equal(
      (await scheduler.finalizeWorkflowRun(wake)).disposition,
      "replayed",
    );
  }
  assert.deepEqual(await store.listPendingWorkItems(10), []);
  assert.deepEqual(
    await store.listModelUsage({ ...f.input, afterOrder: 0, limit: 10 }),
    [],
  );
  await store.close();
}

test("failure stops a queued sibling before any model request and never starts the verifier", async (t) => {
  const f = await fixture(t),
    bad = invalidModel();
  const first = childWorker(f, t, bad.transport, undefined, "agent-0");
  assert.equal((await first.wakeChild()).kind, "completed");
  await first.worker.close();
  await f.composition.admitWorkflowNodes(f.input);
  const skipped = invalidModel(),
    second = childWorker(f, t, skipped.transport, undefined, "agent-1");
  assert.equal((await second.wakeChild()).kind, "canceled");
  assert.equal(skipped.calls(), 0);
  assert.equal(bad.calls(), 1);
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM workflow_node_children")
      .get()!.n,
    2,
  );
  await second.worker.close();
  await finishFailure(f);
});

test("failure preserves a sibling's already committed successful result without extra model calls", async (t) => {
  const f = await fixture(t),
    bad = invalidModel();
  const first = childWorker(f, t, bad.transport, undefined, "agent-0");
  assert.equal((await first.wakeChild()).kind, "completed");
  await first.worker.close();
  let calls = 0;
  const transport: ModelTransportPort = {
    adapterName: "known-success",
    adapterVersion: "1",
    modelId: "synthetic",
    async *stream() {
      calls++;
      yield { type: "output.delta", delta: '{"topic":"already-done"}' };
      yield { type: "completed", checkpoint: null };
    },
  };
  const second = childWorker(f, t, transport, undefined, "agent-1");
  assert.equal((await second.wakeChild()).kind, "completed");
  await second.worker.close();
  const state = (await f.composition.admitWorkflowNodes(f.input)).execution;
  assert.deepEqual(
    state.nodes.map((n) => n.status),
    ["failed", "completed", "canceled"],
  );
  const output = f.database
    .prepare(
      "SELECT output_json FROM workflow_node_admissions WHERE node_id='root-1'",
    )
    .get()!.output_json;
  assert.deepEqual(JSON.parse(String(output)), { topic: "already-done" });
  assert.equal(calls, 1);
  assert.equal(bad.calls(), 1);
  await finishFailure(f, 1);
});

test(
  "a known invalid output stops an active sibling stream without another sample, retaining prefix and reported cache usage",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t),
      bad = invalidModel();
    const first = childWorker(f, t, bad.transport, undefined, "agent-0");
    assert.equal((await first.wakeChild()).kind, "completed");
    await first.worker.close();
    let entered!: () => void,
      released = 0;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const requests: ModelRequest[] = [];
    const transport: ModelTransportPort = {
      adapterName: "failure-stream-fixture",
      adapterVersion: "1",
      modelId: "synthetic",
      releaseRun: () => {
        released++;
      },
      async *stream(request, signal) {
        requests.push(request);
        yield { type: "output.delta", delta: '{"topic":"unfinished' };
        yield {
          type: "usage",
          inputTokens: 90,
          cachedInputTokens: 64,
          outputTokens: 4,
          totalTokens: 94,
        };
        entered();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
      },
    };
    const active = childWorker(f, t, transport, undefined, "agent-1");
    const pending = active.wakeChild();
    void pending.catch(() => {});
    assert.equal(
      await Promise.race([
        started.then(() => "stream"),
        pending.then((r) => JSON.stringify(r)),
      ]),
      "stream",
    );
    const child = (await active.store.loadRun({
      tenantId: f.input.tenantId,
      runId: requests[0]!.runId,
    }))!;
    const prefix = await active.store.listModelHistoryItems(child, 0, 10);
    const stopping = await f.composition.admitWorkflowNodes(f.input);
    assert.deepEqual(
      stopping.execution.nodes.map((n) => n.status),
      ["failed", "running", "canceled"],
    );
    assert.equal((await active.store.loadRun(child))!.cancelRequested, true);
    await assert.rejects(f.composition.finalizeWorkflowRun(f.input), {
      code: "workflow_finalization_pending",
    });
    await active.tick();
    assert.equal((await pending).kind, "canceled");
    assert.equal(bad.calls(), 1);
    assert.equal(requests.length, 1);
    const history = await active.store.listModelHistoryItems(child, 0, 10);
    assert.deepEqual(history.slice(0, prefix.length), prefix);
    const usage = await active.store.listModelUsage({
      ...child,
      afterOrder: 0,
      limit: 10,
    });
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.record.observation.usage.cachedInputTokens, 64);
    assert.equal(
      usage[0]!.record.observation.usage.cachedInputTokensReported,
      true,
    );
    await active.worker.close();
    assert.equal(active.callbacks.size, 0);
    assert.equal(released, 1);
    await finishFailure(f);
  },
);

for (const source of ["output", "preparation"] as const)
  test(
    `a ${source} failure keeps an unknown sibling effect reconciling through Worker restart without repeating its model or mutation`,
    { timeout: 15_000 },
    async (t) => {
      const f = await fixture(
          t,
          source === "preparation" ? oversizedSiblingVersion() : undefined,
        ),
        capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      let calls = 0,
        effects = 0;
      const broker = new InMemoryToolBroker(
        [
          {
            schemaVersion: "crewon.tool-definition.v0",
            kind: "function",
            name: "uncertain_write",
            description: "Fixture",
            execution: "serial",
            inputSchema: { type: "object" },
          },
        ],
        new Map([
          [
            "function:uncertain_write",
            async () => {
              effects++;
              throw new ToolExecutionUnknownOutcomeError();
            },
          ],
        ]),
        new Map([
          [
            "function:uncertain_write",
            {
              effect: "mutation",
              recovery: "reconcilable",
              resourceBindingId: null,
              credentialBindingId: null,
              executionTarget: {
                kind: "control",
                bindingId: "in-memory-tool-broker",
              },
              capability: "workspace.write",
              approvalRequirement: "none",
              limits: {
                timeoutMs: 30000,
                maxOutputBytes: 262144,
                maxArtifactBytes: 1048576,
              },
            },
          ],
        ]),
        { resultCapacity: capacity },
      );
      const transport: ModelTransportPort = {
        adapterName: "failure-tool-fixture",
        adapterVersion: "1",
        modelId: "synthetic",
        async *stream() {
          calls++;
          yield {
            type: "tool.call",
            kind: "function",
            callId: "uncertain-call",
            name: "uncertain_write",
            input: "{}",
          };
          yield { type: "completed", checkpoint: null };
        },
      };
      const first = childWorker(f, t, transport, broker, "agent-0");
      const result = await first.wakeChild();
      assert.equal(result.kind, "retried", JSON.stringify(result));
      assert.equal("code" in result && result.code, "tool_outcome_unknown");
      await first.worker.close();
      await first.store.close();
      const bad = invalidModel(),
        expectedBadCalls = source === "output" ? 1 : 0;
      if (source === "output") {
        const other = childWorker(f, t, bad.transport, undefined, "agent-1");
        assert.equal((await other.wakeChild()).kind, "completed");
        await other.worker.close();
      }
      await f.composition.admitWorkflowNodes(f.input);
      let checks = 0;
      const cancel = broker.cancel.bind(broker);
      broker.cancel = (command, signal) => {
        checks++;
        return cancel(command, signal);
      };
      const recovered = childWorker(f, t, transport, broker, "agent-0");
      const unknown = await recovered.wakeChild();
      assert.equal(unknown.kind, "retried", JSON.stringify(unknown));
      assert.equal("code" in unknown && unknown.code, "tool_outcome_unknown");
      assert.equal(checks, 1);
      const waiting = (await f.composition.admitWorkflowNodes(f.input))
        .execution;
      assert.deepEqual(
        waiting.nodes.map((n) => n.status),
        ["running", "failed", "canceled"],
      );
      await assert.rejects(f.composition.finalizeWorkflowRun(f.input), {
        code: "workflow_finalization_pending",
      });
      assert.equal((await f.store.loadRun(f.input))!.status, "running");
      assert.equal(calls, 1);
      assert.equal(effects, 1);
      assert.equal(bad.calls(), expectedBadCalls);
      assert.equal(capacity.resourceSnapshot().executionCount, 0);
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      // The fake Provider must supply a definitive outcome before the real Worker can finish cancellation.
      broker.cancel = async (command) => ({
        status: "canceled",
        executionId: command.executionId,
        providerReceiptId: "failure-provider-confirmed",
      });
      // Hold the failed child's existing scheduler wake while the unknown child becomes eligible again.
      const wake = compositionInput(
        f.input.binding,
        await claimCompositionWork(f.store, "hold-failed-wake"),
      );
      assert.equal(wake.runId, f.input.runId);
      f.clock.advance(5000);
      assert.equal((await recovered.wakeChild()).kind, "canceled");
      assert.equal(calls, 1);
      assert.equal(effects, 1);
      await recovered.worker.close();
      // Return the same wake for the final replay acknowledgement; do not create another work item.
      await f.store.retryWorkItem({
        ...wake.lease,
        retryAfterMs: 0,
        reasonCode: "test-release",
      });
      await finishFailure(f);
    },
  );
