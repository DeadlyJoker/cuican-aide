import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  InMemoryToolBroker,
  ToolResultCapacity,
  type ToolExecutionCommand,
} from "@crewon/tool-broker";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function readRuntime() {
  const physical = deferred<{ output: string }>(),
    entered = deferred<void>();
  const capacity = new ToolResultCapacity({ maximumExecutions: 2 });
  let calls = 0;
  const commands: ToolExecutionCommand[] = [];
  const broker = new InMemoryToolBroker(
    [
      {
        schemaVersion: "crewon.tool-definition.v0",
        kind: "function",
        name: "fixture_tool",
        description: "Fixture",
        execution: "serial",
        inputSchema: { type: "object" },
      },
    ],
    new Map([
      [
        "function:fixture_tool",
        async () => {
          if (++calls > 1) return { output: "second-result" };
          entered.resolve();
          return physical.promise;
        },
      ],
    ]),
    new Map([
      [
        "function:fixture_tool",
        {
          effect: "readOnly",
          recovery: "replaySafe",
          resourceBindingId: null,
          credentialBindingId: null,
          executionTarget: {
            kind: "control",
            bindingId: "in-memory-tool-broker",
          },
          capability: "workspace.read",
          approvalRequirement: "none",
          limits: {
            timeoutMs: 60000,
            maxOutputBytes: 256 * 1024,
            maxArtifactBytes: 1024 * 1024,
          },
        },
      ],
    ]),
    { resultCapacity: capacity },
  );
  const reserve = broker.reserveExecution.bind(broker);
  broker.reserveExecution = (command, signal, options) => {
    commands.push(structuredClone(command));
    return reserve(command, signal, options);
  };
  return { broker, capacity, entered, physical, commands, calls: () => calls };
}
async function waitUntil(condition: () => boolean) {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await setImmediate();
  }
  assert.ok(condition(), "physical query did not settle");
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 30000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: unconfirmed renewal stops a read, bounds 20,000 wakes and preserves cache continuation`,
    options,
    async (context) => {
      const r = readRuntime(),
        renewal = deferred<void>();
      let blocked = false;
      context.after(() => {
        r.physical.resolve({ output: "tool-result" });
        renewal.resolve();
      });
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        toolRuntime: r.broker,
        leaseDurationMs: 6000,
        beforeLeaseRenew: async () => {
          if (blocked) await renewal.promise;
        },
      });
      const active = f.worker().wake();
      await r.entered.promise;
      blocked = true;
      const lost = await active;
      assert.equal(lost.kind, "leaseLost", JSON.stringify(lost));
      assert.equal(f.worker().watcherResourceSnapshot().renewalPending, true);
      assert.equal(
        f.worker().watcherResourceSnapshot().confirmationListeners,
        0,
      );
      assert.equal((await f.run())?.cancelRequested, false);
      assert.equal((await f.receipts())[0]?.status, "dispatched");
      const stable = {
        events: await f.events(),
        history: await f.history(),
        attempts: await f.toolAttempts(),
        requests: structuredClone(f.requests),
      };
      const reserved = r.capacity.resourceSnapshot();
      const claimQueries = f.claimQueries();
      for (let i = 0; i < 20000; i++)
        assert.equal((await f.worker().wake()).kind, "idle");
      assert.equal(f.claimQueries(), claimQueries);
      assert.deepEqual(
        {
          events: await f.events(),
          history: await f.history(),
          attempts: await f.toolAttempts(),
          requests: f.requests,
        },
        stable,
      );
      assert.deepEqual(r.capacity.resourceSnapshot(), reserved);
      blocked = false;
      renewal.resolve();
      await waitUntil(
        () => !f.worker().watcherResourceSnapshot().renewalPending,
      );
      r.physical.resolve({ output: "tool-result" });
      await setImmediate();
      await f.expireLease();
      await f.reopen();
      const done = await f.worker().wake();
      assert.equal(done.kind, "completed", JSON.stringify(done));
      assert.equal(r.calls(), 1);
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
      for (const field of ["model", "tools", "instructions"])
        assert.deepEqual(f.requests[1]?.[field], f.requests[0]?.[field]);
    },
  );

  test(
    `${backend}: close releases logical heartbeat wait but retains the blocked physical owner`,
    options,
    async (context) => {
      const r = readRuntime(),
        renewal = deferred<void>(),
        enteredRenewal = deferred<void>();
      let blocked = false;
      context.after(() => {
        r.physical.resolve({ output: "tool-result" });
        renewal.resolve();
      });
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        toolRuntime: r.broker,
        leaseDurationMs: 6000,
        beforeLeaseRenew: async () => {
          if (blocked) {
            enteredRenewal.resolve();
            await renewal.promise;
          }
        },
      });
      const active = f.worker().wake();
      await r.entered.promise;
      blocked = true;
      await enteredRenewal.promise;
      await f.worker().close();
      assert.equal((await active).kind, "leaseLost");
      assert.equal(f.worker().watcherResourceSnapshot().renewalPending, false);
      assert.equal(f.worker().storeAccessSnapshot().pendingRequests, 1);
      assert.ok(f.worker().storeAccessSnapshot().processRequests >= 1);
      assert.equal(f.worker().watcherResourceSnapshot().closed, true);
      assert.equal(
        f.worker().watcherResourceSnapshot().confirmationListeners,
        0,
      );
      assert.equal(r.capacity.resourceSnapshot().executionCount, 1);
      blocked = false;
      renewal.resolve();
      await waitUntil(
        () => f.worker().storeAccessSnapshot().pendingRequests === 0,
      );
      r.physical.resolve({ output: "tool-result" });
      await setImmediate();
      await f.expireLease();
      await f.reopen();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(r.calls(), 1);
      assert.equal(r.capacity.resourceSnapshot().reservedBytes, 0);
    },
  );

  test(
    `${backend}: cancellation-query loss yields authority without canonically canceling the read`,
    options,
    async (context) => {
      const r = readRuntime(),
        reading = deferred<void>();
      let blocked = false;
      let tick!: () => Promise<void>;
      context.after(() => {
        r.physical.resolve({ output: "tool-result" });
        reading.resolve();
      });
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        toolRuntime: r.broker,
        beforeRunLoad: async () => {
          if (blocked) await reading.promise;
        },
        cancellationScheduler: {
          every: (_, callback) => {
            tick = callback;
            return () => {};
          },
        },
      });
      const active = f.worker().wake();
      await r.entered.promise;
      blocked = true;
      await tick();
      assert.equal((await active).kind, "leaseLost");
      assert.equal(
        f.worker().watcherResourceSnapshot().cancellationPending,
        true,
      );
      assert.equal((await f.run())?.cancelRequested, false);
      assert.equal((await f.receipts())[0]?.status, "dispatched");
      assert.equal(r.capacity.resourceSnapshot().executionCount, 1);
      blocked = false;
      reading.resolve();
      await waitUntil(
        () => !f.worker().watcherResourceSnapshot().cancellationPending,
      );
      r.physical.resolve({ output: "tool-result" });
      await setImmediate();
      await f.expireLease();
      await f.reopen();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(r.calls(), 1);
      assert.equal(r.capacity.resourceSnapshot().reservedBytes, 0);
      assert.equal(f.requests.length, 2);
      assert.equal(f.requests[1]?.previous_response_id, "resp-tools");
    },
  );

  test(
    `${backend}: HTTP model stream stops on renewal loss and retrieves the checkpoint without resampling`,
    options,
    async (context) => {
      const renewal = deferred<void>(),
        stream = deferred<void>();
      let blocked = false;
      context.after(() => {
        renewal.resolve();
        stream.resolve();
      });
      const response = {
        id: "response-held",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 10,
          total_tokens: 110,
        },
      };
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        leaseDurationMs: 6000,
        beforeLeaseRenew: async () => {
          if (blocked) await renewal.promise;
        },
        afterProviderResponseCheckpointed: async () => {
          blocked = true;
        },
        holdFirstStream: { entered() {}, wait: stream.promise },
        modelResponseEvents: () => [
          {
            type: "response.created",
            sequence_number: 0,
            response: { id: response.id },
          },
        ],
        retrievedResponse: response,
      });
      const lost = await f.worker().wake();
      assert.equal(lost.kind, "leaseLost", JSON.stringify(lost));
      assert.equal(f.requests.length, 1);
      assert.equal((await f.usageRecords()).length, 0);
      assert.equal((await f.accountingReport()).generations.missingUsage, 1);
      blocked = false;
      renewal.resolve();
      stream.resolve();
      await waitUntil(
        () => !f.worker().watcherResourceSnapshot().renewalPending,
      );
      await f.expireLease();
      await f.reopen();
      const done = await f.worker().wake();
      assert.equal(done.kind, "completed", JSON.stringify(done));
      assert.equal(f.requests.length, 1);
      assert.equal(f.retrievals(), 1);
      const report = await f.accountingReport();
      assert.equal(report.total.usage.inputTokens, 100);
      assert.equal(report.total.usage.cacheReadHitRate, 0.8);
      assert.equal((await f.usageRecords()).length, 1);
      assert.deepEqual(
        (await f.callRecords()).map((row) => row.record.observation.operation),
        ["generate", "retrieve"],
      );
    },
  );

  test(
    `${backend}: serial successor receives the latest confirmed lease after a long tool`,
    options,
    async (context) => {
      const r = readRuntime();
      let toolEntered = false,
        latestExpiry = "";
      context.after(() => r.physical.resolve({ output: "tool-result" }));
      const renewed = deferred<void>();
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        toolRuntime: r.broker,
        toolCount: 2,
        leaseDurationMs: 6000,
        afterLeaseRenew: (lease) => {
          latestExpiry = lease.expiresAt;
          if (toolEntered) renewed.resolve();
        },
      });
      const active = f.worker().wake();
      await r.entered.promise;
      toolEntered = true;
      await renewed.promise;
      const expected = latestExpiry;
      r.physical.resolve({ output: "tool-result" });
      const done = await active;
      assert.equal(done.kind, "completed", JSON.stringify(done));
      assert.equal(r.calls(), 2);
      assert.equal(r.commands[1]?.executionLease.expiresAt, expected);
      if (backend === "postgres")
        assert.notEqual(
          r.commands[1]?.executionLease.expiresAt,
          r.commands[0]?.executionLease.expiresAt,
        );
      assert.equal(f.requests.length, 2);
      assert.equal(f.requests[1]?.previous_response_id, "resp-tools");
    },
  );
}
