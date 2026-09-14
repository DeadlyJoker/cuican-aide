import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryToolBroker } from "./in-memory-tool-broker.ts";
import {
  ToolBrokerError,
  ToolExecutionUnknownOutcomeError,
  type ToolHandler,
} from "./index.ts";
import {
  ToolResultCapacity,
  ToolResultCapacityError,
} from "./tool-result-capacity.ts";
import {
  command,
  committedResult,
  definition,
  policy,
} from "./tool-execution.test-support.ts";

const signal = () => new AbortController().signal;
const call = (number: number, effect: "readOnly" | "mutation" = "readOnly") =>
  command(
    {
      name: "fixture",
      executionId: `execution-${number}`,
      idempotencyKey: `key-${number}`,
      callId: `call-${number}`,
    },
    policy(effect, effect === "mutation" ? "reconcilable" : "replaySafe"),
  );
function broker(
  capacity: ToolResultCapacity,
  handler: ToolHandler,
  effect: "readOnly" | "mutation" = "readOnly",
) {
  return new InMemoryToolBroker(
    [definition("fixture")],
    new Map([["function:fixture", handler]]),
    new Map([
      [
        "function:fixture",
        policy(effect, effect === "mutation" ? "reconcilable" : "replaySafe"),
      ],
    ]),
    { resultCapacity: capacity },
  );
}

test("retained lookup is synchronous, identity-bound and never executes or frees a result", async () => {
  const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
  let effects = 0;
  let finish!: () => void;
  const runtime = broker(capacity, async () => {
    effects += 1;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { output: "owned result" };
  });
  const execution = call(1);
  assert.equal(runtime.readRetainedExecutionResult(execution), null);
  assert.equal(effects, 0);
  const pending = runtime.execute(execution, signal());
  assert.equal(runtime.readRetainedExecutionResult(execution), null);
  assert.throws(
    () =>
      runtime.readRetainedExecutionResult({
        ...execution,
        executionId: "wrong",
      }),
    ToolBrokerError,
  );
  assert.throws(
    () =>
      runtime.readRetainedExecutionResult({
        ...execution,
        actionIntent: { ...execution.actionIntent, runId: "other-run" },
      }),
    ToolBrokerError,
  );
  const other = call(2);
  assert.throws(
    () =>
      runtime.readRetainedExecutionResult({
        ...other,
        idempotencyKey: execution.idempotencyKey,
      }),
    ToolBrokerError,
  );
  finish();
  const result = await pending;
  for (let i = 0; i < 1000; i += 1)
    assert.deepEqual(runtime.readRetainedExecutionResult(execution), result);
  const copy = runtime.readRetainedExecutionResult(execution);
  assert.ok(copy?.status === "completed");
  Object.assign(copy.result, { output: "not owned" });
  assert.deepEqual(runtime.readRetainedExecutionResult(execution), result);
  assert.equal(effects, 1);
  assert.equal(capacity.resourceSnapshot().executionCount, 1);
  runtime.acknowledgeExecutionResult(
    committedResult(execution, result.providerReceiptId),
  );
  assert.equal(runtime.readRetainedExecutionResult(execution), null);
  assert.equal(effects, 1);
  assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
});

test("shared capacity rejects before dispatch and duplicates replay while full", async () => {
  const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
  let effects = 0;
  let finish!: () => void;
  const first = broker(capacity, async () => {
    effects += 1;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { output: "x".repeat(256 * 1024) };
  });
  const second = broker(capacity, async () => {
    effects += 1;
    return { output: "next" };
  });
  const running = first.execute(call(1), signal());
  const before = capacity.resourceSnapshot();
  assert.equal(before.executionCount, 1);
  for (let i = 0; i < 1000; i += 1) {
    assert.throws(
      () => second.reserveExecution(call(2), signal()),
      ToolResultCapacityError,
    );
    assert.equal(first.execute(call(1), signal()), running);
  }
  assert.equal(effects, 1);
  finish();
  const result = await running;
  assert.equal(capacity.resourceSnapshot().executionCount, 1);
  assert.ok(capacity.resourceSnapshot().reservedBytes < before.reservedBytes);
  assert.deepEqual(await first.reconcile(call(1), signal()), result);
  first.acknowledgeExecutionResult(
    committedResult(call(1), result.providerReceiptId),
  );
  assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
  const next = await second.execute(call(2), signal());
  second.acknowledgeExecutionResult(
    committedResult(call(2), next.providerReceiptId),
  );
  assert.equal(effects, 2);
});

test("byte capacity is independent of count and includes worst-case pending results", async () => {
  const capacity = new ToolResultCapacity({
    maximumBytes: 600 * 1024,
    maximumExecutions: 100,
  });
  const runtime = broker(capacity, async () => ({
    output: "x".repeat(256 * 1024),
  }));
  const one = await runtime.execute(call(1), signal());
  const two = await runtime.execute(call(2), signal());
  assert.equal(capacity.resourceSnapshot().executionCount, 2);
  assert.throws(
    () => runtime.execute(call(3), signal()),
    ToolResultCapacityError,
  );
  runtime.acknowledgeExecutionResult(
    committedResult(call(1), one.providerReceiptId),
  );
  runtime.acknowledgeExecutionResult(
    committedResult(call(2), two.providerReceiptId),
  );
  assert.equal(capacity.resourceSnapshot().executionCount, 0);
});

test("abandoned reservations and aborted dispatch release without executing handlers", async () => {
  const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
  let effects = 0;
  const runtime = broker(capacity, async () => {
    effects += 1;
    return { output: "done" };
  });
  const reserved = runtime.reserveExecution(call(1), signal());
  reserved.release();
  reserved.release();
  assert.throws(() => reserved.execute(), ToolBrokerError);
  assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
  const controller = new AbortController();
  const canceled = runtime.reserveExecution(call(2), controller.signal);
  controller.abort();
  const result = await canceled.execute();
  canceled.release();
  assert.equal(result.status, "canceled");
  assert.equal(capacity.resourceSnapshot().executionCount, 1);
  runtime.acknowledgeExecutionResult({
    ...committedResult(call(2), null),
    status: "canceled",
  });
  assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
  assert.equal(effects, 0);
});

test("unknown mutation fences release only after durable acknowledgement and never reconcile by executing", async () => {
  const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
  let effects = 0;
  const runtime = broker(
    capacity,
    async () => {
      effects += 1;
      throw new ToolExecutionUnknownOutcomeError();
    },
    "mutation",
  );
  const execution = call(1, "mutation");
  const unknown = await runtime.execute(execution, signal());
  assert.equal(unknown.status, "unknownOutcome");
  assert.throws(
    () => runtime.execute(call(2, "mutation"), signal()),
    ToolResultCapacityError,
  );
  runtime.acknowledgeExecutionResult({
    ...committedResult(execution, null),
    status: "unknownOutcome",
  });
  assert.equal(capacity.resourceSnapshot().executionCount, 0);
  assert.deepEqual(await runtime.reconcile(execution, signal()), unknown);
  assert.equal(effects, 1);
});

test("replay-safe failures release capacity while mutation failures retain a bounded fence", async () => {
  const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
  const runtime = broker(capacity, async () => {
    throw new ToolBrokerError("provider_input_invalid", {
      cause: "x".repeat(1024 * 1024),
    });
  });
  for (let i = 0; i < 1000; i += 1) {
    await assert.rejects(
      runtime.execute(call(i), signal()),
      (error: unknown) =>
        error instanceof ToolBrokerError && error.cause === undefined,
    );
    assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
  }
  let mutations = 0;
  const mutation = broker(
    capacity,
    async () => {
      mutations += 1;
      throw new ToolBrokerError("provider_failure", { cause: "private" });
    },
    "mutation",
  );
  const result = mutation.execute(call(1001, "mutation"), signal());
  await assert.rejects(result, ToolBrokerError);
  assert.equal(mutation.execute(call(1001, "mutation"), signal()), result);
  assert.ok(capacity.resourceSnapshot().reservedBytes < 2048);
  assert.equal(mutations, 1);
  assert.throws(
    () => runtime.execute(call(2000), signal()),
    ToolResultCapacityError,
  );
  const execution = call(1001, "mutation");
  const recovery = mutation.reconcile(execution, signal());
  const unknown = {
    status: "unknownOutcome" as const,
    executionId: execution.executionId,
    providerReceiptId: null,
  };
  for (let i = 0; i < 1000; i++)
    assert.equal(mutation.reconcile(execution, signal()), recovery);
  assert.deepEqual(await recovery, unknown);
  assert.deepEqual(await mutation.cancel(execution, signal()), unknown);
  assert.deepEqual(mutation.readRetainedExecutionResult(execution), unknown);
  assert.equal(
    mutation.retainedExecutionResults({ runId: execution.runId, limit: 128 })[0]
      ?.status,
    "unknownOutcome",
  );
  assert.throws(
    () => mutation.reconcile({ ...execution, executionId: "other" }, signal()),
    ToolBrokerError,
  );
  assert.throws(
    () =>
      mutation.acknowledgeExecutionResult({
        ...committedResult(execution, null),
        status: "canceled",
      }),
    ToolBrokerError,
  );
  assert.equal(mutation.execute(execution, signal()), result);
  mutation.acknowledgeExecutionResult({
    ...committedResult(execution, null),
    status: "unknownOutcome",
  });
  assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
  assert.equal(mutation.retainedExecutionCount, 0);
  assert.deepEqual(await mutation.reconcile(execution, signal()), unknown);
  assert.equal(mutations, 1);
});

test("bounded retained scans rotate past pending work so later committed results can be acknowledged", async () => {
  const capacity = new ToolResultCapacity({ maximumExecutions: 3 });
  let finish!: () => void;
  const runtime = broker(capacity, async (invocation) => {
    if (invocation.callId === "call-1")
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return { output: "done" };
  });
  const first = runtime.execute(call(1), signal());
  const second = await runtime.execute(call(2), signal());
  assert.deepEqual(
    runtime.retainedExecutionResults({ runId: "run-1", limit: 1 }),
    [],
  );
  assert.equal(
    runtime.retainedExecutionResults({ runId: "run-1", limit: 1 })[0]
      ?.executionId,
    "execution-2",
  );
  runtime.acknowledgeExecutionResult(
    committedResult(call(2), second.providerReceiptId),
  );
  finish();
  runtime.acknowledgeExecutionResult(
    committedResult(call(1), (await first).providerReceiptId),
  );
  assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
});

test("capacity options reject invalid or excessive budgets", () => {
  for (const options of [
    { maximumExecutions: 0 },
    { maximumExecutions: 16385 },
    { maximumBytes: 0 },
    { maximumBytes: Infinity },
  ])
    assert.throws(() => new ToolResultCapacity(options), ToolBrokerError);
});
