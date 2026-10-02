import assert from "node:assert/strict";
import test from "node:test";
import type { DomainStore } from "@crewon/application";
import type {
  ToolExecutionCommand,
  ToolExecutionResolution,
  ToolRuntimePort,
} from "@crewon/tool-broker";
import {
  adaptPluginToolRuntime,
  type PluginToolRuntimeAdapterInput,
} from "./plugins/plugin-tool-runtime-adapter.ts";
import {
  assertWorkerToolDispatch,
  assertWorkerToolDispatchIdentity,
} from "./plugins/worker-tool-dispatch-authority.ts";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
import {
  context,
  deferred,
  definition,
  policy,
  rawRuntime,
} from "./plugin-tool-runtime-adapter.test-support.ts";

function completion(value: ToolExecutionCommand): ToolExecutionResolution {
  return {
    status: "completed",
    executionId: value.executionId,
    providerReceiptId: `receipt/${value.executionId}`,
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: value.callId,
      output: "ok",
      isError: false,
      artifactRef: null,
    },
  };
}

function installedIoRuntime(input: {
  store(): DomainStore;
  callback?: PluginToolRuntimeAdapterInput["dispatchAuthority"];
  raw?: Partial<ToolRuntimePort>;
  reserve?: boolean;
  parallel?: boolean;
}) {
  const entered: string[] = [];
  const privateCommands: ToolExecutionCommand[] = [];
  let preflight = 0,
    physical = 0;
  const raw = rawRuntime({
    definitions: () => [
      {
        ...definition("tool"),
        execution: input.parallel ? "parallel" : "serial",
      },
    ],
    execute: async (value) => {
      physical++;
      return completion(value);
    },
    reconcile: async (value) => completion(value),
    ...input.raw,
  });
  if (input.reserve)
    raw.reserveExecution = (value, signal) => {
      preflight++;
      assert.throws(
        () =>
          assertWorkerToolDispatch({
            command: value,
            signal,
            method: "execute",
          }),
        /dispatch_authority_denied/,
      );
      return { release() {}, execute: () => raw.execute(value, signal) };
    };
  const instances = new Map<string, ToolRuntimePort>();
  const owner = (value: ToolExecutionCommand) => {
    let runtime = instances.get(value.runId);
    if (runtime === undefined) {
      const supplied = context();
      runtime = adaptPluginToolRuntime({
        runtime: raw,
        definitions: raw.definitions(),
        context: {
          ...supplied,
          run: { ...supplied.run, runId: value.runId },
          target: { ...supplied.target, workspaceBindingId: null },
        },
        authorize: async () => {},
        dispatchAuthority: async (invocation, delegate) => {
          const identity = assertWorkerToolDispatch(invocation);
          const receipt = await input
            .store()
            .loadToolExecutionReceipt(identity);
          assert.ok(receipt);
          assert.ok(
            receipt.status === "dispatched" ||
              receipt.status === "unknownOutcome",
          );
          assert.equal(receipt.executionId, invocation.command.executionId);
          assertWorkerToolDispatch(invocation);
          privateCommands.push(invocation.command);
          entered.push(invocation.method);
          return input.callback === undefined
            ? delegate()
            : input.callback(invocation, delegate);
        },
      });
      instances.set(value.runId, runtime);
    }
    return runtime;
  };
  const port: ToolRuntimePort = {
    definitions: raw.definitions.bind(raw),
    executionPolicy: raw.executionPolicy.bind(raw),
    execute: (value, signal) => owner(value).execute(value, signal),
    reconcile: (value, signal) => owner(value).reconcile(value, signal),
    cancel: (value, signal) => owner(value).cancel(value, signal),
    ...(input.reserve
      ? {
          reserveExecution: (value, signal, options) =>
            owner(value).reserveExecution!(value, signal, options),
        }
      : {}),
  };
  return {
    port,
    entered,
    privateCommands,
    preflight: () => preflight,
    physical: () => physical,
  };
}

test("SQLite Worker grants exact checked command only after persisted dispatch and preserves capacity command identity", async (t) => {
  let fixture!: Awaited<ReturnType<typeof createFixture>>;
  const runtime = installedIoRuntime({
    store: () => fixture.store(),
    reserve: true,
  });
  fixture = await createFixture(t, {
    backend: "sqlite",
    storeResponses: true,
    crashAfterCommit: false,
    toolName: "tool",
    toolRuntime: runtime.port,
  });
  assert.equal((await fixture.worker().wake()).kind, "completed");
  assert.deepEqual(runtime.entered, ["execute"]);
  assert.equal(runtime.preflight(), 1);
  assert.equal(runtime.physical(), 1);
  assert.equal((await fixture.receipts())[0]?.status, "completed");
  assert.throws(
    () =>
      assertWorkerToolDispatch({
        command: runtime.privateCommands[0]!,
        method: "execute",
        signal: new AbortController().signal,
      }),
    /dispatch_authority_denied/,
  );
});

test("SQLite dispatch transaction failure creates no I/O grant or provider call", async (t) => {
  let fixture!: Awaited<ReturnType<typeof createFixture>>;
  const runtime = installedIoRuntime({
    store: () => fixture.store(),
    reserve: true,
  });
  fixture = await createFixture(t, {
    backend: "sqlite",
    storeResponses: true,
    crashAfterCommit: false,
    toolName: "tool",
    toolRuntime: runtime.port,
    decorateStore: (store) =>
      new Proxy(store, {
        get(target, key) {
          if (key === "transitionToolExecution")
            return async (
              input: Parameters<DomainStore["transitionToolExecution"]>[0],
            ) => {
              if (input.transition.kind === "dispatch")
                throw new Error("fixture_dispatch_write_failed");
              return target.transitionToolExecution(input);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  });
  assert.equal((await fixture.worker().wake()).kind, "retried");
  assert.equal((await fixture.receipts())[0]?.status, "prepared");
  assert.equal(runtime.entered.length, 0);
  assert.equal(runtime.physical(), 0);
});

test("SQLite dispatched crash recovery confirms a new claim and grants only real reconcile calls, including parallel capacity preflight", async (t) => {
  let fixture!: Awaited<ReturnType<typeof createFixture>>;
  const runtime = installedIoRuntime({
    store: () => fixture.store(),
    reserve: true,
    parallel: true,
  });
  fixture = await createFixture(t, {
    backend: "sqlite",
    storeResponses: true,
    crashAfterCommit: false,
    crashAfterResolved: true,
    toolCount: 2,
    toolName: "tool",
    toolRuntime: runtime.port,
  });
  assert.equal((await fixture.worker().wake()).kind, "retried");
  await fixture.reopen();
  await fixture.makeDue();
  const resumed = await fixture.worker().wake();
  assert.equal(resumed.kind, "completed", JSON.stringify(resumed));
  // readOnly/replaySafe recovery uses the existing reserved execute ABI under a reconcile grant.
  assert.equal(runtime.entered.length, 4);
  assert.equal(runtime.preflight(), 6);
  assert.equal(runtime.physical(), 4);
  assert.ok(
    (await fixture.receipts()).every((saved) => saved?.status === "completed"),
  );
  assert.equal(
    runtime.privateCommands[2]!.executionId,
    runtime.privateCommands[0]!.executionId,
  );
  assert.notEqual(
    runtime.privateCommands[2]!.executionLease.leaseId,
    runtime.privateCommands[0]!.executionLease.leaseId,
  );
});

for (const canceled of [false, true])
  test(`SQLite durable unknown mutation grants ${canceled ? "cancel" : "reconcile"} only with actual recovery receipt/current claim`, async (t) => {
    let fixture!: Awaited<ReturnType<typeof createFixture>>;
    const runtime = installedIoRuntime({
      store: () => fixture.store(),
      raw: {
        executionPolicy: () => policy("mutation", "reconcilable"),
        execute: async (value): Promise<ToolExecutionResolution> => ({
          status: "unknownOutcome",
          executionId: value.executionId,
          providerReceiptId: "external-1",
        }),
        cancel: async (value) => ({
          status: "canceled",
          executionId: value.executionId,
          providerReceiptId: "external-1",
        }),
      },
    });
    fixture = await createFixture(t, {
      backend: "sqlite",
      storeResponses: true,
      crashAfterCommit: false,
      toolName: "tool",
      toolRuntime: runtime.port,
    });
    assert.equal((await fixture.worker().wake()).kind, "retried");
    assert.equal((await fixture.receipts())[0]?.status, "unknownOutcome");
    if (canceled) await fixture.cancel();
    await fixture.reopen();
    await fixture.makeDue();
    const recovered = await fixture.worker().wake();
    assert.equal(
      recovered.kind,
      canceled ? "canceled" : "completed",
      JSON.stringify(recovered),
    );
    assert.deepEqual(runtime.entered, [
      "execute",
      canceled ? "cancel" : "reconcile",
    ]);
    assert.notEqual(
      runtime.privateCommands[1]!.executionLease.leaseId,
      runtime.privateCommands[0]!.executionLease.leaseId,
    );
  });

test("SQLite Worker close withdraws new I/O immediately while callback drains accepted-evidence identity", async (t) => {
  let fixture!: Awaited<ReturnType<typeof createFixture>>;
  const entered = deferred();
  const release = deferred();
  let invocation!: Parameters<
    NonNullable<PluginToolRuntimeAdapterInput["dispatchAuthority"]>
  >[0];
  const runtime = installedIoRuntime({
    store: () => fixture.store(),
    callback: async (input, delegate) => {
      invocation = input;
      entered.resolve();
      await release.promise;
      return delegate();
    },
  });
  fixture = await createFixture(t, {
    backend: "sqlite",
    storeResponses: true,
    crashAfterCommit: false,
    toolName: "tool",
    toolRuntime: runtime.port,
  });
  t.after(() => release.resolve());
  const running = fixture.worker().wake();
  await entered.promise;
  const closing = fixture.worker().close();
  assert.throws(() => assertWorkerToolDispatch(invocation));
  assertWorkerToolDispatchIdentity(invocation);
  release.resolve();
  await running;
  await closing;
  assert.equal(runtime.physical(), 0);
  assert.throws(
    () => assertWorkerToolDispatchIdentity(invocation),
    /dispatch_authority_denied/,
  );
});
