import { waitForWorkerQueries } from "./runtime-background-query.test-support.ts";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  InMemoryToolBroker,
  ToolResultCapacity,
  type ToolExecutionPolicy,
} from "@crewon/tool-broker";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

function runtime(
  effect: "readOnly" | "mutation",
  timeoutMs: number,
  execution: "serial" | "parallel" = "serial",
) {
  const physical = deferred<{ output: string }>();
  const entered = deferred<void>();
  const secondEntered = deferred<void>();
  const dispatchOrder: string[] = [];
  const capacity = new ToolResultCapacity({ maximumExecutions: 2 });
  let dispatched = 0;
  const policy: ToolExecutionPolicy = {
    effect,
    recovery: effect === "mutation" ? "reconcilable" : "replaySafe",
    resourceBindingId: null,
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "in-memory-tool-broker" },
    capability: effect === "mutation" ? "workspace.write" : "workspace.read",
    approvalRequirement: "none",
    limits: {
      timeoutMs,
      maxOutputBytes: 256 * 1024,
      maxArtifactBytes: 1024 * 1024,
    },
  };
  const broker = new InMemoryToolBroker(
    [
      {
        schemaVersion: "crewon.tool-definition.v0",
        kind: "function",
        name: "fixture_tool",
        description: "Fixture",
        execution,
        inputSchema: { type: "object" },
      },
    ],
    new Map([
      [
        "function:fixture_tool",
        async (invocation) => {
          dispatched++;
          dispatchOrder.push(invocation.callId);
          if (invocation.callId === "call-2") {
            secondEntered.resolve();
            return { output: "second-result" };
          }
          assert.equal(invocation.callId, "call-1");
          entered.resolve();
          return physical.promise;
        },
      ],
    ]),
    new Map([["function:fixture_tool", policy]]),
    { resultCapacity: capacity },
  );
  return {
    broker,
    capacity,
    physical,
    entered,
    secondEntered,
    dispatchOrder,
    dispatched: () => dispatched,
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 15_000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };

  test(
    `${backend}: timed-out physical read survives repeated wakes with no new attempts or model calls`,
    options,
    async (context) => {
      const r = runtime("readOnly", 10);
      context.after(() => r.physical.resolve({ output: "tool-result" }));
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        toolRuntime: r.broker,
      });
      const outcome = await f.worker().wake();
      assert.equal(outcome.kind, "retried", JSON.stringify(outcome));
      assert.ok(
        outcome.kind === "retried" &&
          outcome.code === "tool_execution_still_running",
      );
      const stable = {
        events: await f.events(),
        history: await f.history(),
        attempts: await f.toolAttempts(),
        requests: structuredClone(f.requests),
      };
      const capacity = r.capacity.resourceSnapshot();
      for (let i = 0; i < 30; i++) {
        await f.makeDue();
        const retried = await f.worker().wake();
        assert.ok(
          retried.kind === "retried" &&
            retried.code === "tool_execution_still_running",
          JSON.stringify(retried),
        );
      }
      assert.deepEqual(
        {
          events: await f.events(),
          history: await f.history(),
          attempts: await f.toolAttempts(),
          requests: f.requests,
        },
        stable,
      );
      assert.deepEqual(r.capacity.resourceSnapshot(), capacity);
      assert.equal(r.dispatched(), 1);
      await f.reopen();
      r.physical.resolve({ output: "tool-result" });
      await setImmediate();
      await f.makeDue();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(r.dispatched(), 1);
      assert.equal(r.capacity.resourceSnapshot().reservedBytes, 0);
      assert.equal(f.requests.length, 2);
      assert.equal(f.requests[1]?.previous_response_id, "resp-tools");
      assert.deepEqual(f.requests[1]?.input, [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "tool-result",
        },
      ]);
      for (const field of ["instructions", "tools", "model"])
        assert.deepEqual(f.requests[1]?.[field], f.requests[0]?.[field]);
    },
  );

  test(
    `${backend}: a hung parallel read does not repeatedly create attempts for its completed sibling`,
    options,
    async (context) => {
      const r = runtime("readOnly", 10, "parallel");
      context.after(() => r.physical.resolve({ output: "tool-result" }));
      context.after(() => r.secondEntered.resolve());
      const reserve = r.broker.reserveExecution.bind(r.broker);
      r.broker.reserveExecution = (command, signal, options) => {
        const reservation = reserve(command, signal, options);
        return {
          release: reservation.release,
          execute: async () => {
            // Database scheduling can dispatch the second parallel call first.
            if (command.callId === "call-1") await r.secondEntered.promise;
            return reservation.execute();
          },
        };
      };
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        toolRuntime: r.broker,
        toolCount: 2,
      });
      assert.equal((await f.worker().wake()).kind, "retried");
      assert.equal(r.dispatched(), 2);
      assert.deepEqual(r.dispatchOrder, ["call-2", "call-1"]);
      const stable = {
        events: await f.events(),
        history: await f.history(),
        attempts: await f.toolAttempts(),
        requests: structuredClone(f.requests),
      };
      for (let i = 0; i < 30; i++) {
        await f.makeDue();
        assert.equal((await f.worker().wake()).kind, "retried");
      }
      assert.deepEqual(
        {
          events: await f.events(),
          history: await f.history(),
          attempts: await f.toolAttempts(),
          requests: f.requests,
        },
        stable,
      );
      r.physical.resolve({ output: "tool-result" });
      await setImmediate();
      await f.makeDue();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(r.dispatched(), 2);
      assert.equal(r.capacity.resourceSnapshot().reservedBytes, 0);
      assert.equal(f.requests.length, 2);
      assert.deepEqual(f.requests[1]?.input, [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "tool-result",
        },
        {
          type: "function_call_output",
          call_id: "call-2",
          output: "second-result",
        },
      ]);
    },
  );

  test(
    `${backend}: unknown physical mutation stops serial successors and resumes from late evidence`,
    options,
    async (context) => {
      const r = runtime("mutation", 10);
      context.after(() => r.physical.resolve({ output: "tool-result" }));
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        toolRuntime: r.broker,
        toolCount: 2,
      });
      const outcome = await f.worker().wake();
      assert.ok(
        outcome.kind === "retried" && outcome.code === "tool_outcome_unknown",
        JSON.stringify(outcome),
      );
      assert.equal(r.dispatched(), 1);
      assert.equal((await f.run())?.status, "reconciling");
      assert.equal(
        (await f.receipts()).filter((receipt) => receipt?.status === "prepared")
          .length,
        1,
      );
      assert.equal(r.capacity.resourceSnapshot().executionCount, 1);
      assert.ok(r.capacity.resourceSnapshot().reservedBytes > 256 * 1024);
      await f.makeDue();
      const waiting = await f.worker().wake();
      assert.equal(waiting.kind, "retried", JSON.stringify(waiting));
      assert.equal(f.worker().toolResultMaintenanceSnapshot().acknowledged, 0);
      assert.equal(r.dispatched(), 1);
      assert.equal(f.requests.length, 1);
      r.physical.resolve({ output: "tool-result" });
      await setImmediate();
      await f.reopen();
      await f.makeDue();
      const completed = await f.worker().wake();
      assert.equal(completed.kind, "completed", JSON.stringify(completed));
      assert.equal(r.dispatched(), 2);
      assert.equal(r.capacity.resourceSnapshot().reservedBytes, 0);
      assert.equal(f.requests.length, 2);
      assert.equal(f.requests[1]?.previous_response_id, "resp-tools");
      assert.deepEqual(f.requests[1]?.input, [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "tool-result",
        },
        {
          type: "function_call_output",
          call_id: "call-2",
          output: "second-result",
        },
      ]);
    },
  );

  for (const maxBoundariesPerWake of [8, 1])
    for (const interruptedQuery of [false, true])
      test(
        `${backend}: Worker close interrupts an ignored tool signal and preserves resumable read, boundaries=${maxBoundariesPerWake}, interruptedQuery=${interruptedQuery}`,
        options,
        async (context) => {
          const r = runtime("readOnly", 60_000);
          const queryEntered = deferred<void>(),
            queryRelease = deferred<void>();
          let holdQuery = false;
          let tick!: () => Promise<void>;
          context.after(() => queryRelease.resolve());
          context.after(() => r.physical.resolve({ output: "tool-result" }));
          const f = await createFixture(context, {
            backend,
            storeResponses: true,
            crashAfterCommit: false,
            toolRuntime: r.broker,
            executionBudget: { maxBoundariesPerWake },
            cancellationScheduler: {
              every: (_, callback) => {
                tick = callback;
                return () => {};
              },
            },
            beforeRunLoad: async () => {
              if (holdQuery) {
                holdQuery = false;
                queryEntered.resolve();
                await queryRelease.promise;
              }
            },
          });
          const { pending } = await wakeUntilToolEntered(f, r.entered.promise);
          await waitForWorkerQueries(f.worker(), { pendingRequests: 0 });
          holdQuery = interruptedQuery;
          const checking = tick();
          if (interruptedQuery) {
            await queryEntered.promise;
            assert.equal(
              f.worker().watcherResourceSnapshot().cancellationPending,
              true,
            );
          } else {
            await checking;
            await waitForWorkerQueries(f.worker(), { pendingRequests: 0 });
          }
          const closing = f.worker().close();
          if (interruptedQuery)
            assert.equal(
              f.worker().storeAccessSnapshot().failureCode,
              "runtime_worker_closing",
            );
          await closing;
          const stopped = await pending;
          if (interruptedQuery) {
            assert.equal(stopped.kind, "leaseLost", JSON.stringify(stopped));
            assert.equal(
              f.worker().watcherResourceSnapshot().lastFailureCode,
              // Closing a pending Store read invalidates confirmation before settlement.
              "lease_confirmation_timeout",
            );
            assert.equal(f.worker().storeAccessSnapshot().pendingRequests, 1);
          } else {
            assert.ok(
              stopped.kind === "retried" &&
                stopped.code === "tool_execution_still_running",
              JSON.stringify(stopped),
            );
          }
          holdQuery = false;
          queryRelease.resolve();
          await checking;
          await waitForWorkerQueries(f.worker(), { pendingRequests: 0 });
          assert.equal(r.capacity.resourceSnapshot().executionCount, 1);
          assert.equal(f.requests.length, 1);
          r.physical.resolve({ output: "tool-result" });
          await setImmediate();
          if (interruptedQuery) await f.expireLease();
          await f.reopen();
          await f.makeDue();
          assert.equal((await finishYieldedWake(f)).kind, "completed");
          assert.equal(r.dispatched(), 1);
          assert.equal(r.capacity.resourceSnapshot().reservedBytes, 0);
          assert.equal(f.requests[1]?.previous_response_id, "resp-tools");
        },
      );

  test(
    `${backend}: durable cancellation settles a timed-out read without freeing its live reservation`,
    options,
    async (context) => {
      const r = runtime("readOnly", 10);
      context.after(() => r.physical.resolve({ output: "late read" }));
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        toolRuntime: r.broker,
      });
      assert.equal((await f.worker().wake()).kind, "retried");
      await f.cancel();
      await f.makeDue();
      const canceled = await f.worker().wake();
      assert.equal(canceled.kind, "canceled", JSON.stringify(canceled));
      assert.equal(r.capacity.resourceSnapshot().executionCount, 1);
      assert.equal(f.requests.length, 1);
      r.physical.resolve({ output: "late read" });
      await setImmediate();
      assert.equal(r.capacity.resourceSnapshot().reservedBytes, 0);
      assert.equal(r.dispatched(), 1);
      assert.equal((await f.run())?.status, "canceled");
    },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// A wake may yield at a committed boundary before it reaches the blocked tool.
// Waiting only for the tool would hide an early terminal outcome until timeout.
async function wakeUntilToolEntered(
  f: Awaited<ReturnType<typeof createFixture>>,
  entered: Promise<void>,
) {
  for (let boundaries = 0; boundaries < 8; boundaries++) {
    const pending = f.worker().wake();
    const outcome = await Promise.race([entered.then(() => null), pending]);
    if (outcome === null) return { pending };
    assert.ok(
      outcome.kind === "retried" && outcome.code === "run_execution_yield",
      JSON.stringify(outcome),
    );
    await f.makeDue();
  }
  assert.fail("tool did not start within eight committed boundaries");
}

async function finishYieldedWake(f: Awaited<ReturnType<typeof createFixture>>) {
  for (let boundaries = 0; boundaries < 8; boundaries++) {
    const outcome = await f.worker().wake();
    if (outcome.kind !== "retried" || outcome.code !== "run_execution_yield")
      return outcome;
    await f.makeDue();
  }
  assert.fail("resumed tool did not finish within eight committed boundaries");
}
