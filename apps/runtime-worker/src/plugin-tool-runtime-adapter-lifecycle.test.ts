import assert from "node:assert/strict";
import test from "node:test";
import {
  adapt,
  broker,
  command,
  committedResult,
  deferred,
  lookup,
  policy,
  rawRuntime,
  result,
  tick,
} from "./plugin-tool-runtime-adapter.test-support.ts";

test("failed reservation authorization releases capacity exactly once and never dispatches", async () => {
  let releases = 0,
    executions = 0;
  const signal = new AbortController().signal;
  const port = adapt(
    rawRuntime({
      reserveExecution(value, actual, options) {
        assert.equal(actual, signal);
        assert.deepEqual(options, { resultOwner: { tenantId: "tenant-1" } });
        return {
          execute: async () => {
            executions++;
            return result(value);
          },
          release() {
            releases++;
          },
        };
      },
    }),
    {
      authorize: async () => {
        throw new Error("denied");
      },
    },
  );
  const reservation = port.reserveExecution!(command(), signal, {
    resultOwner: { tenantId: "tenant-1" },
  })!;
  const started = reservation.execute();
  assert.equal(reservation.execute(), started);
  await assert.rejects(started, /denied/u);
  reservation.release();
  reservation.release();
  assert.equal(releases, 1);
  assert.equal(executions, 0);
});

test("started reservations retain physical ownership, late completion and a single execution promise", async () => {
  const gate = deferred(),
    entered = deferred();
  let releases = 0,
    executions = 0,
    authorizations = 0;
  const port = adapt(
    rawRuntime({
      reserveExecution(value) {
        return {
          execute: async () => {
            executions++;
            entered.resolve();
            await gate.promise;
            return result(value);
          },
          release() {
            releases++;
          },
        };
      },
      canRetire: () => true,
    }),
    {
      authorize: async () => {
        authorizations++;
      },
    },
  );
  const reservation = port.reserveExecution!(
    command(),
    new AbortController().signal,
  )!;
  assert.equal(port.canRetire!(), false);
  const started = reservation.execute();
  await entered.promise;
  assert.equal(port.canRetire!(), false);
  reservation.release();
  assert.equal(reservation.execute(), started);
  assert.equal(releases, 0);
  gate.resolve();
  assert.equal((await started).status, "completed");
  await tick();
  assert.equal(port.canRetire!(), true);
  assert.equal(executions, 1);
  assert.equal(authorizations, 1);
});

test("manual release before execution is idempotent and prevents dispatch", async () => {
  let releases = 0,
    executes = 0;
  const port = adapt(
    rawRuntime({
      reserveExecution(value) {
        return {
          execute: async () => {
            executes++;
            return result(value);
          },
          release() {
            releases++;
          },
        };
      },
    }),
  );
  const reservation = port.reserveExecution!(
    command(),
    new AbortController().signal,
  )!;
  reservation.release();
  reservation.release();
  await assert.rejects(
    reservation.execute(),
    /plugin_tool_reservation_released/u,
  );
  assert.equal(releases, 1);
  assert.equal(executes, 0);
});

test("invalid reservation execute accessor never runs and valid release cleans pre-execution capacity", () => {
  let accesses = 0;
  let releases = 0;
  const port = adapt(
    rawRuntime({
      reserveExecution() {
        return {
          get execute(): never {
            accesses++;
            throw new Error("execute getter invoked");
          },
          release() {
            releases++;
          },
        };
      },
    }),
  );
  assert.throws(
    () => port.reserveExecution!(command(), new AbortController().signal),
    /plugin_tool_runtime_method_invalid/u,
  );
  assert.equal(accesses, 0);
  assert.equal(releases, 1);
});

test("explicit close calls the original shutdown immediately, waits for physical completion and preserves the late receipt", async () => {
  const physical = deferred(),
    entered = deferred(),
    cleaned = deferred();
  let closeCalls = 0;
  const controller = new AbortController();
  const port = adapt(
    rawRuntime({
      execute: async (value, signal) => {
        assert.equal(signal, controller.signal);
        entered.resolve();
        await physical.promise;
        return result(value, "late completed receipt");
      },
      canRetire: () => false,
      close: async () => {
        closeCalls++;
        controller.abort("plugin shutdown");
        await cleaned.promise;
      },
    }),
  );
  const execution = port.execute(command(), controller.signal);
  await entered.promise;
  let closed = false;
  const closing = port.close!().then(() => {
    closed = true;
  });
  assert.equal(port.close!(), port.close!());
  await tick();
  assert.equal(closeCalls, 1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(closed, false);
  await assert.rejects(
    port.execute(command(), new AbortController().signal),
    /plugin_tool_runtime_closed/u,
  );
  physical.resolve();
  const receipt = await execution;
  assert.equal(
    receipt.status === "completed" && receipt.result.output,
    "late completed receipt",
  );
  assert.equal(closed, false);
  cleaned.resolve();
  await closing;
  assert.equal(closed, true);
});

test("close releases only unused reservations and leaves an already started operation owned by the provider", async () => {
  const physical = deferred(),
    entered = deferred();
  const released: string[] = [];
  const port = adapt(
    rawRuntime({
      reserveExecution(value) {
        return {
          execute: async () => {
            entered.resolve();
            await physical.promise;
            return result(value);
          },
          release() {
            released.push(value.executionId);
          },
        };
      },
      close: async () => {},
    }),
  );
  port.reserveExecution!(
    command({ executionId: "unused" }),
    new AbortController().signal,
  );
  const running = port.reserveExecution!(
    command({ executionId: "started" }),
    new AbortController().signal,
  )!;
  const executed = running.execute();
  await entered.promise;
  const closing = port.close!();
  await tick();
  assert.deepEqual(released, ["unused"]);
  running.release();
  assert.deepEqual(released, ["unused"]);
  physical.resolve();
  assert.equal((await executed).status, "completed");
  await closing;
});

test("real mutation broker keeps unknown outcome pending until late completion and never re-executes on recovery", async () => {
  const physical = deferred(),
    entered = deferred();
  let executions = 0;
  const mutationPolicy = policy("mutation", "reconcilable");
  const runtime = broker(async () => {
    executions++;
    entered.resolve();
    await physical.promise;
    return { output: "late physical completion" };
  }, mutationPolicy);
  const port = adapt(runtime);
  const execution = command({}, mutationPolicy);
  const controller = new AbortController();
  const started = port.execute(execution, controller.signal);
  await entered.promise;
  controller.abort("cancel_requested");
  const unknown = await started;
  assert.equal(unknown.status, "unknownOutcome");
  assert.equal(port.canRetire!(), false);
  const unknownAck = {
    ...lookup(execution),
    status: "unknownOutcome" as const,
    providerReceiptId: null,
  };
  assert.equal(port.acknowledgeExecutionResult!(unknownAck), false);
  assert.equal(
    (await port.reconcile(execution, new AbortController().signal)).status,
    "unknownOutcome",
  );
  assert.equal(
    (await port.cancel(execution, new AbortController().signal)).status,
    "unknownOutcome",
  );
  physical.resolve();
  await tick();
  const completed = await port.reconcile(
    execution,
    new AbortController().signal,
  );
  assert.equal(
    completed.status === "completed" && completed.result.output,
    "late physical completion",
  );
  assert.equal(port.canRetire!(), false);
  assert.equal(
    port.acknowledgeExecutionResult!(
      committedResult(execution, completed.providerReceiptId),
    ),
    true,
  );
  assert.equal(port.canRetire!(), true);
  assert.equal(executions, 1);
});

test("adapter limits active authorization and reserved capacity without executing excess commands", async () => {
  const gate = deferred();
  let dispatched = 0;
  const port = adapt(
    rawRuntime({
      execute: async (value) => {
        dispatched++;
        return result(value);
      },
    }),
    {
      authorize: async () => {
        await gate.promise;
      },
    },
  );
  const pending = Array.from({ length: 128 }, () =>
    port.execute(command(), new AbortController().signal),
  );
  await assert.rejects(
    port.execute(command(), new AbortController().signal),
    /plugin_tool_runtime_busy/u,
  );
  gate.resolve();
  await Promise.all(pending);
  assert.equal(dispatched, 128);
  let reserved = 0,
    released = 0;
  const reserving = adapt(
    rawRuntime({
      reserveExecution(value) {
        reserved++;
        return {
          execute: async () => result(value),
          release() {
            released++;
          },
        };
      },
    }),
  );
  const reservations = Array.from(
    { length: 128 },
    () => reserving.reserveExecution!(command(), new AbortController().signal)!,
  );
  assert.throws(
    () => reserving.reserveExecution!(command(), new AbortController().signal),
    /plugin_tool_runtime_busy/u,
  );
  reservations.forEach((reservation) => reservation.release());
  assert.equal(reserved, 128);
  assert.equal(released, 128);
});
