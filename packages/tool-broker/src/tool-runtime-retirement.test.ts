import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryToolBroker } from "./in-memory-tool-broker.ts";
import { CompositeToolRuntime } from "./composite-tool-runtime.ts";
import {
  command,
  committedResult,
  definition,
  policy,
} from "./tool-execution.test-support.ts";
import {
  ToolBrokerError,
  type ToolExecutionPolicy,
  type ToolInvocation,
} from "./tool-broker-port.ts";

function fixture(
  handler: (
    input: ToolInvocation,
  ) => Promise<{ output: string }> = async () => ({ output: "value" }),
  executionPolicy: ToolExecutionPolicy = policy("readOnly", "replaySafe"),
) {
  return new InMemoryToolBroker(
    [definition("tool")],
    new Map([["function:tool", handler]]),
    new Map([["function:tool", executionPolicy]]),
  );
}

test("unstarted reservations prevent retirement even though result scans are empty", () => {
  const runtime = fixture(),
    input = command();
  assert.equal(runtime.canRetire(), true);
  const reservation = runtime.reserveExecution(
    input,
    new AbortController().signal,
  );
  assert.equal(runtime.retainedExecutionCount, 0);
  assert.deepEqual(runtime.scanRetainedExecutionResults({ limit: 1 }), []);
  assert.equal(runtime.canRetire(), false);
  reservation.release();
  reservation.release();
  assert.equal(runtime.canRetire(), true);
  assert.throws(
    () => reservation.execute(),
    /tool_execution_reservation_released/,
  );
});

for (const consumeDuplicate of [true, false]) {
  test(`duplicate reservations retain ownership until each is consumed or released, consume=${consumeDuplicate}`, async () => {
    let calls = 0;
    const runtime = fixture(async () => {
        calls++;
        return { output: "value" };
      }),
      input = command();
    const first = runtime.reserveExecution(input, new AbortController().signal);
    const second = runtime.reserveExecution(
      input,
      new AbortController().signal,
    );
    const result = await first.execute();
    assert.equal(runtime.canRetire(), false);
    if (consumeDuplicate) assert.deepEqual(await second.execute(), result);
    runtime.acknowledgeExecutionResult(
      committedResult(input, result.providerReceiptId),
    );
    assert.equal(runtime.canRetire(), consumeDuplicate);
    second.release();
    assert.equal(runtime.canRetire(), true);
    assert.equal(calls, 1);
  });
}

test("unscoped completed results cannot be mistaken for an empty owner", async () => {
  const runtime = fixture(),
    input = command();
  const result = await runtime.execute(input, new AbortController().signal);
  assert.deepEqual(runtime.scanRetainedExecutionResults({ limit: 128 }), []);
  assert.equal(runtime.canRetire(), false);
  runtime.acknowledgeExecutionResult(
    committedResult(input, result.providerReceiptId),
  );
  assert.equal(runtime.canRetire(), true);
});

test("an acknowledged unknown mutation stays protected until physical completion and its stronger receipt is acknowledged", async () => {
  let finish!: (value: { output: string }) => void;
  const pending = new Promise<{ output: string }>((resolve) => {
    finish = resolve;
  });
  const executionPolicy = policy("mutation", "reconcilable");
  const runtime = fixture(() => pending, executionPolicy),
    input = command({}, executionPolicy),
    controller = new AbortController();
  const logical = runtime.execute(input, controller.signal);
  controller.abort("cancel");
  const unknown = await logical;
  assert.equal(unknown.status, "unknownOutcome");
  assert.equal(
    runtime.acknowledgeExecutionResult({
      ...committedResult(input, null),
      status: "unknownOutcome",
    }),
    false,
  );
  assert.equal(runtime.canRetire(), false);
  finish({ output: "actual result" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const completed = runtime.readRetainedExecutionResult(input);
  assert.equal(completed?.status, "completed");
  assert.equal(runtime.canRetire(), false);
  assert.ok(completed);
  runtime.acknowledgeExecutionResult(
    committedResult(input, completed.providerReceiptId),
  );
  assert.equal(runtime.canRetire(), true);
});

test("only a settled replay-safe failure may release execution ownership without a result ACK", async () => {
  const read = fixture(async () => {
    throw new ToolBrokerError("read_failed");
  });
  await assert.rejects(read.execute(command(), new AbortController().signal));
  assert.equal(read.canRetire(), true);
  const executionPolicy = policy("mutation", "reconcilable"),
    input = command({}, executionPolicy);
  const mutation = fixture(async () => {
    throw new ToolBrokerError("mutation_failed");
  }, executionPolicy);
  await assert.rejects(mutation.execute(input, new AbortController().signal));
  assert.equal(mutation.canRetire(), false);
  mutation.acknowledgeExecutionResult({
    ...committedResult(input, null),
    status: "unknownOutcome",
  });
  assert.equal(mutation.canRetire(), true);
});

test("composite retirement requires every child to provide a positive ownership proof", async () => {
  const first = fixture(),
    second = new InMemoryToolBroker();
  const composite = new CompositeToolRuntime([first, second]);
  assert.equal(composite.canRetire(), true);
  const reserved = first.reserveExecution(
    command(),
    new AbortController().signal,
  );
  assert.equal(composite.canRetire(), false);
  reserved.release();
  assert.equal(composite.canRetire(), true);
  const unknown = {
    definitions: () => [],
    executionPolicy: () => null,
    execute: first.execute.bind(first),
    reconcile: first.reconcile.bind(first),
    cancel: first.cancel.bind(first),
  };
  const mixed = new CompositeToolRuntime([first, unknown]);
  assert.equal(mixed.canRetire(), false);
  await composite.close();
  assert.equal(composite.canRetire(), false);
});
