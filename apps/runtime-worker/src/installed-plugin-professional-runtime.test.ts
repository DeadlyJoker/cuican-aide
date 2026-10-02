import assert from "node:assert/strict";
import test from "node:test";
import type { PluginToolExecutionResolution } from "@crewon/plugin-sdk/node";
import { adaptPluginToolRuntime } from "./plugins/plugin-tool-runtime-adapter.ts";
import {
  acknowledgement,
  bounded,
  lookup,
  professionalRuntimeFixture,
} from "./installed-plugin-professional-runtime.test-support.ts";

const signal = () => new AbortController().signal;

test("installed professional runtime closes a non-2xx unfinished HTTP stream before retirement", async (t) => {
  const { runtime, provider, command } = await professionalRuntimeFixture(t);
  const stream = provider.plan("errorStream");
  const executing = runtime.execute(command("error_stream"), signal());
  await assert.rejects(
    bounded(executing),
    /professional_plugin_provider_response_invalid/,
  );
  await bounded(stream.started);
  await bounded(stream.connectionClosed);
  assert.equal(runtime.canRetire?.(), true);
  assert.deepEqual(runtime.scanRetainedExecutionResults?.({ limit: 128 }), []);
  assert.equal(provider.requests().length, 1);
});

test("installed professional runtime retains two receipts and releases only a complete matching acknowledgement", async (t) => {
  const { runtime, context, provider, command } =
    await professionalRuntimeFixture(t);
  const first = command("retained_first");
  const second = command("retained_second");
  const firstResult = await runtime.execute(first, signal());
  const secondResult = await runtime.execute(second, signal());
  assert.equal(runtime.canRetire?.(), false);
  assert.deepEqual(
    runtime.scanRetainedExecutionResults?.({ limit: 128 }),
    [first, second].map((value) => ({
      tenantId: context.scope.tenantId,
      runId: context.run.runId,
      executionId: value.executionId,
      idempotencyKey: value.idempotencyKey,
      actionDigest: value.actionDigest,
      kind: value.kind,
      name: value.name,
      status: "completed",
    })),
  );
  const projected = [first, second].map((value) => ({
    executionId: value.executionId,
    idempotencyKey: value.idempotencyKey,
    actionDigest: value.actionDigest,
    kind: value.kind,
    name: value.name,
    status: "completed" as const,
  }));
  assert.deepEqual(
    runtime.retainedExecutionResults?.({ runId: first.runId, limit: 128 }),
    projected,
    "Run metadata has exactly the six SDK receipt fields, without scope extras",
  );
  const adapter = adaptPluginToolRuntime({
    runtime,
    context,
    definitions: runtime.definitions(),
    authorize: async () => {
      throw new Error("local_receipt_operation_must_not_authorize_provider");
    },
  });
  assert.deepEqual(
    adapter.retainedExecutionResults?.({ runId: first.runId, limit: 128 }),
    projected,
    "the actual adapter accepts the package's exact receipt ABI",
  );
  const firstPage = adapter.scanRetainedExecutionResults?.({ limit: 1 });
  assert.deepEqual(firstPage, [
    {
      ...projected[0],
      tenantId: context.scope.tenantId,
      runId: context.run.runId,
    },
  ]);
  assert.deepEqual(
    runtime.retainedExecutionResults?.({ runId: first.runId, limit: 1 }),
    [projected[0]],
  );
  const secondPage = adapter.scanRetainedExecutionResults?.({ limit: 1 });
  assert.deepEqual(
    secondPage,
    [
      {
        ...projected[1],
        tenantId: context.scope.tenantId,
        runId: context.run.runId,
      },
    ],
    "bounded scans rotate past an unacknowledged first result, independently of Run queries",
  );
  assert.deepEqual(
    adapter.readRetainedExecutionResult?.(lookup(first)),
    firstResult,
  );
  assert.deepEqual(
    adapter.readRetainedExecutionResult?.(lookup(second)),
    secondResult,
  );
  assert.equal(
    runtime.retainedExecutionResults?.({ runId: first.runId, limit: 1 }).length,
    1,
  );
  assert.deepEqual(
    runtime.retainedExecutionResults?.({ runId: "other_run", limit: 128 }),
    [],
  );
  assert.throws(
    () => runtime.scanRetainedExecutionResults?.({ limit: 0 }),
    /professional_plugin_scan_limit_invalid/,
  );
  assert.throws(
    () => runtime.scanRetainedExecutionResults?.({ limit: 129 }),
    /professional_plugin_scan_limit_invalid/,
  );
  const ack = acknowledgement(first, firstResult);
  for (const forged of [
    { ...ack, idempotencyKey: "other_key" },
    { ...ack, actionDigest: "sha256:" + "b".repeat(64) },
    { ...ack, providerReceiptId: "report/other" },
    { ...ack, status: "unknownOutcome" as const },
    { ...ack, actionIntent: { ...ack.actionIntent, runId: "other_run" } },
    { ...ack, actionIntent: { ...ack.actionIntent, callId: "other_call" } },
    {
      ...ack,
      actionIntent: { ...ack.actionIntent, segmentId: "other_segment" },
    },
    {
      ...ack,
      actionIntent: { ...ack.actionIntent, policySnapshotId: "other_policy" },
    },
    {
      ...ack,
      actionIntent: {
        ...ack.actionIntent,
        tool: {
          ...ack.actionIntent.tool,
          inputDigest: "sha256:" + "b".repeat(64),
        },
      },
    },
  ]) {
    assert.equal(runtime.acknowledgeExecutionResult?.(forged), false);
    assert.equal(
      runtime.scanRetainedExecutionResults?.({ limit: 128 }).length,
      2,
    );
  }
  assert.deepEqual(
    runtime.readRetainedExecutionResult?.(lookup(first)),
    firstResult,
  );
  assert.equal(
    runtime.readRetainedExecutionResult?.({
      ...lookup(first),
      actionIntent: { ...first.actionIntent, policySnapshotId: "other_policy" },
    }),
    null,
  );
  assert.equal(runtime.acknowledgeExecutionResult?.(ack), true);
  assert.equal(runtime.acknowledgeExecutionResult?.(ack), false);
  assert.equal(runtime.readRetainedExecutionResult?.(lookup(first)), null);
  assert.deepEqual(
    runtime.readRetainedExecutionResult?.(lookup(second)),
    secondResult,
  );
  assert.equal(runtime.canRetire?.(), false);
  assert.equal(
    adapter.acknowledgeExecutionResult?.(acknowledgement(second, secondResult)),
    true,
  );
  assert.equal(runtime.canRetire?.(), true);
  assert.equal(
    provider.requests().length,
    2,
    "local lookup and ACK never dispatch the provider",
  );
});

test("installed professional runtime caches a completed execution and rejects changed input or intent without POST", async (t) => {
  const { runtime, provider, command } = await professionalRuntimeFixture(t);
  const original = command("cached");
  const saved = structuredClone(original);
  const result = await runtime.execute(original, signal());
  assert.equal(result.status, "completed");
  assert.equal(Object.isFrozen(result), true);
  if (result.status === "completed")
    assert.equal(Object.isFrozen(result.result), true);
  assert.deepEqual(
    await runtime.execute(structuredClone(saved), signal()),
    result,
  );
  assert.deepEqual(await runtime.reconcile(saved, signal()), result);
  assert.deepEqual(await runtime.cancel(saved, signal()), result);
  for (const conflict of [
    { ...saved, input: JSON.stringify({ subject: "other" }) },
    { ...saved, idempotencyKey: "other_key" },
    { ...saved, actionDigest: "sha256:" + "b".repeat(64) },
    {
      ...saved,
      callId: "other_call",
      actionIntent: { ...saved.actionIntent, callId: "other_call" },
    },
    {
      ...saved,
      actionIntent: { ...saved.actionIntent, policySnapshotId: "other_policy" },
    },
  ])
    await assert.rejects(
      runtime.execute(conflict, signal()),
      /professional_plugin_execution_conflict/,
    );
  Reflect.set(
    original.actionIntent,
    "policySnapshotId",
    "caller_mutated_policy",
  );
  assert.equal(runtime.readRetainedExecutionResult?.(lookup(original)), null);
  assert.deepEqual(
    runtime.readRetainedExecutionResult?.(lookup(saved)),
    result,
  );
  assert.equal(
    runtime.acknowledgeExecutionResult?.(acknowledgement(saved, result)),
    true,
  );
  assert.equal(provider.requests().length, 1);
  assert.equal(runtime.canRetire?.(), true);
});

test("installed professional runtime bounds unacknowledged receipts at 32 and reuses only an acknowledged slot", async (t) => {
  const { runtime, provider, command } = await professionalRuntimeFixture(t);
  const receipts: Array<{
    command: ReturnType<typeof command>;
    result: PluginToolExecutionResolution;
  }> = [];
  for (let index = 0; index < 32; index++) {
    const value = command("capacity_" + index);
    receipts.push({
      command: value,
      result: await runtime.execute(value, signal()),
    });
  }
  assert.equal(
    runtime.scanRetainedExecutionResults?.({ limit: 128 }).length,
    32,
  );
  const first = receipts[0]!;
  assert.deepEqual(
    await runtime.execute(first.command, signal()),
    first.result,
  );
  const next = command("capacity_32");
  await assert.rejects(
    runtime.execute(next, signal()),
    /professional_plugin_retained_capacity_exceeded/,
  );
  assert.equal(provider.requests().length, 32);
  assert.equal(
    runtime.acknowledgeExecutionResult?.({
      ...acknowledgement(first.command, first.result),
      status: "canceled",
    }),
    false,
  );
  await assert.rejects(
    runtime.execute(next, signal()),
    /professional_plugin_retained_capacity_exceeded/,
  );
  assert.equal(
    runtime.acknowledgeExecutionResult?.(
      acknowledgement(first.command, first.result),
    ),
    true,
  );
  const nextResult = await runtime.execute(next, signal());
  assert.equal(provider.requests().length, 33);
  assert.equal(
    runtime.scanRetainedExecutionResults?.({ limit: 128 }).length,
    32,
  );
  assert.deepEqual(
    runtime.readRetainedExecutionResult?.(lookup(receipts[1]!.command)),
    receipts[1]!.result,
  );
  for (const receipt of receipts.slice(1))
    assert.equal(
      runtime.acknowledgeExecutionResult?.(
        acknowledgement(receipt.command, receipt.result),
      ),
      true,
    );
  assert.equal(runtime.canRetire?.(), false);
  assert.equal(
    runtime.acknowledgeExecutionResult?.(acknowledgement(next, nextResult)),
    true,
  );
  assert.equal(runtime.canRetire?.(), true);
});

test("installed professional runtime serializes physical requests and cannot acknowledge unfinished execution", async (t) => {
  const { runtime, provider, command } = await professionalRuntimeFixture(t);
  const held = provider.plan("hold");
  const first = command("physical_first");
  const executing = runtime.execute(first, signal());
  try {
    await bounded(held.started);
    assert.equal(runtime.canRetire?.(), false);
    assert.deepEqual(
      runtime.scanRetainedExecutionResults?.({ limit: 128 }),
      [],
    );
    assert.equal(
      runtime.acknowledgeExecutionResult?.({
        ...lookup(first),
        status: "completed",
        providerReceiptId: "report/" + first.executionId,
      }),
      false,
    );
    const second = command("physical_second");
    await assert.rejects(
      runtime.execute(second, signal()),
      /professional_plugin_runtime_busy/,
    );
    await assert.rejects(
      runtime.reconcile(second, signal()),
      /professional_plugin_runtime_busy/,
    );
    await assert.rejects(
      runtime.cancel(second, signal()),
      /professional_plugin_runtime_busy/,
    );
    await assert.rejects(
      runtime.execute(first, signal()),
      /professional_plugin_runtime_busy/,
    );
    assert.equal(provider.requests().length, 1);
  } finally {
    held.release();
  }
  const result = await bounded(executing);
  assert.equal(
    runtime.acknowledgeExecutionResult?.(acknowledgement(first, result)),
    true,
  );
  const second = command("physical_second");
  const secondResult = await runtime.execute(second, signal());
  assert.equal(provider.requests().length, 2);
  assert.equal(
    runtime.acknowledgeExecutionResult?.(acknowledgement(second, secondResult)),
    true,
  );
  assert.equal(runtime.canRetire?.(), true);
});

test("installed professional runtime keeps unknown outcomes and recovers by GET without a second submission", async (t) => {
  const { runtime, provider, command } = await professionalRuntimeFixture(t);
  provider.plan("unknown");
  const value = command("unknown_recovery");
  const unknown = await runtime.execute(value, signal());
  assert.equal(unknown.status, "unknownOutcome");
  await assert.rejects(
    runtime.execute(value, signal()),
    /professional_plugin_execution_requires_reconciliation/,
  );
  assert.deepEqual(await runtime.reconcile(value, signal()), unknown);
  const canceledCommand = command("cancel_unknown");
  const canceledUnknown = await runtime.cancel(canceledCommand, signal());
  assert.equal(canceledUnknown.status, "unknownOutcome");
  assert.equal(
    runtime.scanRetainedExecutionResults?.({ limit: 128 }).length,
    2,
  );
  assert.equal(runtime.canRetire?.(), false);
  provider.resolve(value.executionId);
  const recovered = await runtime.reconcile(value, signal());
  assert.equal(recovered.status, "completed");
  assert.equal(
    runtime.acknowledgeExecutionResult?.(acknowledgement(value, unknown)),
    false,
    "old unknown evidence cannot release the recovered completion",
  );
  assert.equal(
    runtime.acknowledgeExecutionResult?.(acknowledgement(value, recovered)),
    true,
  );
  assert.deepEqual(
    runtime.readRetainedExecutionResult?.(lookup(canceledCommand)),
    canceledUnknown,
  );
  assert.equal(
    runtime.acknowledgeExecutionResult?.(
      acknowledgement(canceledCommand, canceledUnknown),
    ),
    true,
  );
  assert.equal(runtime.canRetire?.(), true);
  assert.deepEqual(
    provider.requests().map(({ method }) => method),
    ["POST", "GET", "DELETE", "GET"],
  );
});

test("installed professional runtime shutdown waits for physical completion and then withdraws execution", async (t) => {
  const { runtime, provider, command } = await professionalRuntimeFixture(t);
  const held = provider.plan("hold");
  const executing = runtime.execute(command("close_pending"), signal());
  await bounded(held.started);
  let closeFinished = false;
  const closing = runtime.close!().then(() => {
    closeFinished = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeFinished, false);
    assert.equal(runtime.canRetire?.(), false);
    await assert.rejects(
      runtime.execute(command("after_close"), signal()),
      /professional_plugin_runtime_closed/,
    );
  } finally {
    held.release();
  }
  assert.equal(
    (await bounded(executing)).status,
    "completed",
    "physical completion survives a concurrent shutdown",
  );
  await bounded(closing);
  assert.equal(runtime.canRetire?.(), true);
  assert.equal(provider.requests().length, 1);
});
