import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  InMemoryToolBroker,
  ToolExecutionPendingError,
  ToolResultCapacity,
  ToolResultCapacityError,
} from "./index.ts";
import {
  command,
  committedResult,
  definition,
  policy,
} from "./tool-execution.test-support.ts";

const signal = () => new AbortController().signal;
for (const reason of [
  "runtime_lease_unconfirmed",
  "cancellation_watch_failed",
]) {
  test(`infrastructure interruption ${reason} preserves late read evidence`, async () => {
    const f = fixture("readOnly", 60000),
      parent = new AbortController();
    const pending = f.broker.execute(f.execution, parent.signal);
    const reserved = f.capacity.resourceSnapshot();
    parent.abort(reason);
    await assert.rejects(pending, ToolExecutionPendingError);
    assert.deepEqual(f.capacity.resourceSnapshot(), reserved);
    f.physical.resolve({ output: "late read" });
    await setImmediate();
    const result = await f.broker.reconcile(f.execution, signal());
    assert.equal(result.status, "completed");
    assert.ok(
      result.status === "completed" && result.result.output === "late read",
    );
    assert.equal(f.dispatched(), 1);
    assert.equal(
      f.broker.acknowledgeExecutionResult(
        committedResult(f.execution, result.providerReceiptId),
      ),
      true,
    );
    assert.equal(f.capacity.resourceSnapshot().reservedBytes, 0);
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  });
}
function fixture(effect: "readOnly" | "mutation", timeoutMs = 10) {
  const basePolicy = policy(
    effect,
    effect === "mutation" ? "reconcilable" : "replaySafe",
  );
  const executionPolicy = {
    ...basePolicy,
    limits: { ...basePolicy.limits, timeoutMs },
  };
  const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
  const physical = deferred<{ output: string }>();
  let dispatched = 0;
  let toolSignal!: AbortSignal;
  const broker = new InMemoryToolBroker(
    [definition("tool")],
    new Map([
      [
        "function:tool",
        async (_, executionSignal) => {
          dispatched++;
          toolSignal = executionSignal;
          return physical.promise;
        },
      ],
    ]),
    new Map([["function:tool", executionPolicy]]),
    { resultCapacity: capacity },
  );
  const execution = command({}, executionPolicy);
  return {
    broker,
    capacity,
    physical,
    execution,
    dispatched: () => dispatched,
    toolSignal: () => toolSignal,
  };
}

test(
  "read timeout retains physical capacity and rejects repeated waits without redispatch",
  { timeout: 5000 },
  async () => {
    const f = fixture("readOnly");
    const parent = new AbortController();
    const waiting = f.broker.execute(f.execution, parent.signal);
    const reserved = f.capacity.resourceSnapshot();
    assert.equal(getEventListeners(parent.signal, "abort").length, 1);
    await assert.rejects(waiting, ToolExecutionPendingError);
    assert.equal(f.toolSignal().aborted, true);
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
    for (let i = 0; i < 20_000; i++) {
      assert.throws(
        () => f.broker.reserveExecution(f.execution, signal()),
        ToolExecutionPendingError,
      );
      assert.throws(
        () => f.broker.reconcile(f.execution, signal()),
        ToolExecutionPendingError,
      );
    }
    assert.deepEqual(f.capacity.resourceSnapshot(), reserved);
    assert.throws(
      () =>
        f.broker.execute({ ...f.execution, idempotencyKey: "other" }, signal()),
      ToolResultCapacityError,
    );
    f.physical.resolve({ output: "late read" });
    await setImmediate();
    const result = await f.broker.reconcile(f.execution, signal());
    assert.equal(result.status, "completed");
    assert.equal(f.dispatched(), 1);
    assert.equal(
      f.broker.acknowledgeExecutionResult(
        committedResult(f.execution, result.providerReceiptId),
      ),
      true,
    );
    assert.equal(f.capacity.resourceSnapshot().reservedBytes, 0);
  },
);

test("failed physical read releases capacity only after it has ended and permits safe retry", async () => {
  const f = fixture("readOnly");
  await assert.rejects(
    f.broker.execute(f.execution, signal()),
    ToolExecutionPendingError,
  );
  assert.equal(f.capacity.resourceSnapshot().executionCount, 1);
  f.physical.reject(new Error("reader ended"));
  await setImmediate();
  assert.equal(f.capacity.resourceSnapshot().reservedBytes, 0);
  const result = await f.broker.reconcile(f.execution, signal());
  assert.equal(result.status, "completed");
  assert.ok(result.status === "completed" && result.result.isError);
  assert.equal(f.dispatched(), 2);
  f.broker.acknowledgeExecutionResult(
    committedResult(f.execution, result.providerReceiptId),
  );
});

test("unknown mutation ACK defers release and cannot discard a stronger late completion", async () => {
  const f = fixture("mutation");
  const parent = new AbortController();
  const pending = f.broker.execute(f.execution, parent.signal);
  const reserved = f.capacity.resourceSnapshot();
  const unknown = await pending;
  assert.equal(unknown.status, "unknownOutcome");
  const ack = {
    ...committedResult(f.execution, null),
    status: "unknownOutcome" as const,
  };
  for (let i = 0; i < 1000; i++) {
    assert.equal(f.broker.acknowledgeExecutionResult(ack), false);
    assert.deepEqual(await f.broker.reconcile(f.execution, signal()), unknown);
  }
  assert.deepEqual(f.capacity.resourceSnapshot(), reserved);
  f.physical.resolve({ output: "write succeeded" });
  await setImmediate();
  const completed = await f.broker.reconcile(f.execution, signal());
  assert.equal(completed.status, "completed");
  assert.deepEqual(await f.broker.execute(f.execution, signal()), unknown);
  assert.equal(f.dispatched(), 1);
  assert.equal(f.capacity.resourceSnapshot().executionCount, 1);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  assert.throws(() => f.broker.acknowledgeExecutionResult(ack));
  f.broker.acknowledgeExecutionResult(
    committedResult(f.execution, completed.providerReceiptId),
  );
  assert.equal(f.capacity.resourceSnapshot().reservedBytes, 0);
});

test("matching deferred unknown ACK releases once the physical mutation ends without evidence", async () => {
  const f = fixture("mutation");
  await f.broker.execute(f.execution, signal());
  assert.equal(
    f.broker.acknowledgeExecutionResult({
      ...committedResult(f.execution, null),
      status: "unknownOutcome",
    }),
    false,
  );
  f.physical.reject(new Error("unknown provider failure"));
  await setImmediate();
  assert.equal(f.capacity.resourceSnapshot().reservedBytes, 0);
  assert.equal(
    (await f.broker.reconcile(f.execution, signal())).status,
    "unknownOutcome",
  );
  assert.equal(f.dispatched(), 1);
});

for (const effect of ["readOnly", "mutation"] as const) {
  test(`${effect}: user cancellation releases the logical caller while retaining physical ownership`, async () => {
    const f = fixture(effect, 60_000);
    const parent = new AbortController();
    const pending = f.broker.execute(f.execution, parent.signal);
    parent.abort("run_canceled");
    const result = await pending;
    const status = effect === "mutation" ? "unknownOutcome" : "canceled";
    assert.equal(result.status, status);
    assert.equal(
      f.broker.acknowledgeExecutionResult({
        ...committedResult(f.execution, null),
        status,
      }),
      false,
    );
    assert.equal(f.capacity.resourceSnapshot().executionCount, 1);
    f.physical.resolve({ output: "late evidence" });
    await setImmediate();
    assert.equal(
      f.capacity.resourceSnapshot().executionCount,
      effect === "mutation" ? 1 : 0,
    );
    if (effect === "mutation") {
      const completed = await f.broker.reconcile(f.execution, signal());
      assert.equal(completed.status, "completed");
      f.broker.acknowledgeExecutionResult(
        committedResult(f.execution, completed.providerReceiptId),
      );
    }
    assert.equal(f.dispatched(), 1);
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  });
}

test("durable cancellation overrides a read timeout and retires only after the physical read", async () => {
  const f = fixture("readOnly");
  await assert.rejects(
    f.broker.execute(f.execution, signal()),
    ToolExecutionPendingError,
  );
  const result = await f.broker.cancel(f.execution, signal());
  assert.equal(result.status, "canceled");
  assert.equal(
    f.broker.acknowledgeExecutionResult({
      ...committedResult(f.execution, null),
      status: "canceled",
    }),
    false,
  );
  f.physical.resolve({ output: "discardable canceled read" });
  await setImmediate();
  assert.equal(f.capacity.resourceSnapshot().reservedBytes, 0);
  assert.equal(f.dispatched(), 1);
});

test("canceled reservation before dispatch never starts a mutation and clears the deadline", async () => {
  const f = fixture("mutation", 60_000);
  const parent = new AbortController();
  const reservation = f.broker.reserveExecution(f.execution, parent.signal);
  parent.abort();
  assert.equal((await reservation.execute()).status, "canceled");
  assert.equal(f.dispatched(), 0);
  assert.equal(
    f.broker.acknowledgeExecutionResult({
      ...committedResult(f.execution, null),
      status: "canceled",
    }),
    true,
  );
  assert.equal(f.capacity.resourceSnapshot().reservedBytes, 0);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("local pending cancellation verifies execution identity and never dispatches missing work", async () => {
  const f = fixture("readOnly", 60_000);
  const parent = new AbortController();
  const pending = f.broker.execute(f.execution, parent.signal);
  assert.equal(
    f.broker.retainedExecutionResults({
      runId: f.execution.runId,
      limit: 1,
      visibility: "includePending",
    }).length,
    1,
  );
  assert.throws(() =>
    f.broker.cancelRetainedExecution({ ...f.execution, executionId: "wrong" }),
  );
  assert.equal(f.toolSignal().aborted, false);
  assert.equal(
    f.broker.cancelRetainedExecution({
      ...f.execution,
      idempotencyKey: "missing",
    }),
    null,
  );
  assert.equal(
    f.broker.cancelRetainedExecution(f.execution)?.status,
    "canceled",
  );
  assert.equal((await pending).status, "canceled");
  assert.equal(
    f.broker.acknowledgeExecutionResult({
      ...committedResult(f.execution, null),
      status: "canceled",
    }),
    false,
  );
  f.physical.resolve({ output: "late" });
  await setImmediate();
  assert.equal(f.dispatched(), 1);
  assert.equal(f.capacity.resourceSnapshot().reservedBytes, 0);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
