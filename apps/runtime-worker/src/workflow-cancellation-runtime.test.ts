import { childWorker } from "./workflow-child-worker.test-support.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  type ModelRequest,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import {
  InMemoryToolBroker,
  ToolExecutionUnknownOutcomeError,
  ToolResultCapacity,
} from "@crewon/tool-broker";
import {
  compositionFixture,
  compositionInput,
  claimCompositionWork,
} from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import {
  cancellationChildDispatch,
  requestWorkflowCancel,
} from "../../../packages/store/src/workflow-cancellation.test-support.ts";

async function fixture(t: TestContext) {
  const f = await compositionFixture(t, {
    nowEpochMs: Date.now(),
    composition: { dispatchChildren: cancellationChildDispatch },
  });
  await f.composition.admitWorkflowNodes(f.input);
  return f;
}
async function finishCancellation(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.completeWorkItem(f.input.lease);
  const reopened = f.open(),
    scheduler = reopened.experimentalWorkflowRunCompositionStore({
      dispatchChildren: cancellationChildDispatch,
    });
  const input = compositionInput(
    f.input.binding,
    await claimCompositionWork(reopened, "root-cancel"),
  );
  const state = await scheduler.propagateWorkflowCancellation(input);
  assert.equal(state.status, "canceled");
  assert.ok(state.nodes.every((node) => node.status === "canceled"));
  assert.equal(
    (await scheduler.finalizeWorkflowRun(input)).run.status,
    "canceled",
  );
  const extra = compositionInput(
    f.input.binding,
    await claimCompositionWork(reopened, "child-terminal-wake"),
  );
  assert.equal(
    (await scheduler.finalizeWorkflowRun(extra)).disposition,
    "replayed",
  );
  assert.deepEqual(await reopened.listPendingWorkItems(10), []);
  assert.deepEqual(
    await reopened.listModelUsage({
      tenantId: f.input.tenantId,
      runId: f.input.runId,
      afterOrder: 0,
      limit: 10,
    }),
    [],
  );
  await reopened.close();
}

test("ordinary Worker cancels a queued workflow child without a model call; reopened scheduler finishes the root", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const transport: ModelTransportPort = {
    adapterName: "cancel-fixture",
    adapterVersion: "1",
    modelId: "synthetic",
    async *stream() {
      calls++;
      throw Error("canceled child must not sample");
    },
  };
  await requestWorkflowCancel(f.store, f.input, f.clock.nowEpochMilliseconds());
  await f.composition.propagateWorkflowCancellation(f.input);
  const { worker, wakeChild } = childWorker(f, t, transport);
  assert.equal((await wakeChild()).kind, "canceled");
  assert.equal(calls, 0);
  await worker.close();
  await finishCancellation(f);
});

test(
  "workflow cancellation aborts an active model stream, closes its watcher and preserves prefix and reported cache usage",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    let started!: () => void,
      released = 0,
      streamSignal: AbortSignal | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const requests: ModelRequest[] = [];
    const transport: ModelTransportPort = {
      adapterName: "cancel-stream-fixture",
      adapterVersion: "1",
      modelId: "synthetic",
      releaseRun: () => {
        released++;
      },
      async *stream(request, signal) {
        requests.push(request);
        streamSignal = signal;
        yield { type: "output.delta", delta: '{"topic":"partial' };
        yield {
          type: "usage",
          inputTokens: 90,
          cachedInputTokens: 64,
          outputTokens: 4,
          totalTokens: 94,
        };
        started();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    };
    const { worker, wakeChild, tick, callbacks, store } = childWorker(f, t, transport);
    const pending = wakeChild();
    void pending.catch(() => {});
    assert.equal(
      await Promise.race([
        entered.then(() => "stream"),
        pending.then((result) => JSON.stringify(result)),
      ]),
      "stream",
    );
    const child = await store.loadRun({
      tenantId: f.input.tenantId,
      runId: requests[0]!.runId,
    });
    const prefix = await store.listModelHistoryItems(
      { tenantId: child!.tenantId, threadId: child!.threadId },
      0,
      10,
    );
    await requestWorkflowCancel(
      f.store,
      f.input,
      f.clock.nowEpochMilliseconds(),
    );
    assert.equal(
      (await store.loadRun({ tenantId: child!.tenantId, runId: child!.runId }))!
        .cancelRequested,
      true,
    );
    // No scheduler pass runs while the only Worker is occupied by the stream.
    await tick();
    const result = await pending;
    assert.equal(result.kind, "canceled", JSON.stringify(result));
    assert.equal(streamSignal?.aborted, true);
    assert.equal(requests.length, 1);
    const history = await store.listModelHistoryItems(
      { tenantId: child!.tenantId, threadId: child!.threadId },
      0,
      10,
    );
    assert.deepEqual(history.slice(0, prefix.length), prefix);
    assert.equal(history.length, prefix.length + 1);
    const usage = await store.listModelUsage({
      tenantId: child!.tenantId,
      runId: child!.runId,
      afterOrder: 0,
      limit: 10,
    });
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.record.observation.usage.cachedInputTokens, 64);
    assert.equal(
      usage[0]!.record.observation.usage.cachedInputTokensReported,
      true,
    );
    await worker.close();
    assert.equal(callbacks.size, 0);
    assert.equal(released, 1);
    await finishCancellation(f);
  },
);

test(
  "workflow cancellation leaves an actual unknown tool effect reconciling without another model call or mutation",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
    let effects = 0,
      calls = 0;
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
      adapterName: "cancel-tool-fixture",
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
    const first = childWorker(f, t, transport, broker);
    const unknown = await first.wakeChild();
    assert.equal(unknown.kind, "retried", JSON.stringify(unknown));
    assert.equal("code" in unknown && unknown.code, "tool_outcome_unknown");
    const childId = String(
      f.database
        .prepare("SELECT child_run_id FROM workflow_node_children")
        .get()!.child_run_id,
    );
    assert.equal(
      (await first.store.loadRun({
        tenantId: f.input.tenantId,
        runId: childId,
      }))!.status,
      "reconciling",
    );
    await first.worker.close();
    await first.store.close();
    await requestWorkflowCancel(
      f.store,
      f.input,
      f.clock.nowEpochMilliseconds(),
    );
    await f.composition.propagateWorkflowCancellation(f.input);
    let cancellationChecks = 0;
    const cancel = broker.cancel.bind(broker);
    broker.cancel = (command, signal) => {
      cancellationChecks++;
      return cancel(command, signal);
    };
    const recovered = childWorker(f, t, transport, broker);
    const unresolved = await recovered.wakeChild();
    assert.equal(unresolved.kind, "retried", JSON.stringify(unresolved));
    assert.equal(
      "code" in unresolved && unresolved.code,
      "tool_outcome_unknown",
    );
    assert.equal(cancellationChecks, 1);
    const state = await f.composition.propagateWorkflowCancellation(f.input);
    assert.equal(state.status, "running");
    await assert.rejects(f.composition.finalizeWorkflowRun(f.input), {
      code: "workflow_cancellation_recovery_required",
    });
    assert.equal(
      (await recovered.store.loadRun({
        tenantId: f.input.tenantId,
        runId: childId,
      }))!.status,
      "reconciling",
    );
    assert.equal((await f.store.loadRun(f.input))!.status, "running");
    assert.equal(
      f.database
        .prepare(
          "SELECT count(*) AS n FROM run_events WHERE json_extract(event_json,'$.type')='run.canceled'",
        )
        .get()!.n,
      0,
    );
    assert.equal(calls, 1);
    assert.equal(effects, 1);
    assert.equal(capacity.resourceSnapshot().executionCount, 0);
    assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
    // Only an explicit definitive Provider result permits the existing reconciliation path to retire the child.
    broker.cancel = async (command) => ({
      status: "canceled",
      executionId: command.executionId,
      providerReceiptId: "provider-confirmed-cancel",
    });
    f.clock.advance(5000);
    const confirmed = await recovered.wakeChild();
    assert.equal(confirmed.kind, "canceled", JSON.stringify(confirmed));
    assert.equal(calls, 1);
    assert.equal(effects, 1);
    await recovered.worker.close();
    await finishCancellation(f);
  },
);
