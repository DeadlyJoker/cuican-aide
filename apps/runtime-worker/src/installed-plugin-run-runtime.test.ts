import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { installedWorkerFixture } from "./installed-plugin-run-runtime.test-support.ts";
import {
  deferred,
  storeAccessClock,
  until,
} from "./runtime-store-access.test-support.ts";

test("v1 paid task without an installed owner permanently fails before borrowing or dispatching the old bundle", async (t) => {
  const f = await installedWorkerFixture(t);
  const result = await f.worker({ resolver: null }).wake();
  assert.deepEqual(result, {
    kind: "failed",
    runId: f.task.binding.runId,
    code: "installed_plugin_runtime_owner_unavailable",
  });
  assert.equal(f.state.baseCalls, 0);
  assert.equal(f.state.installedCalls, 0);
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.policyCalls, 0);
  assert.equal(f.state.acquires, 0);
  const failed = (await f.events()).find(
    (event) => event.type === "run.failed",
  );
  assert.ok(failed?.type === "run.failed");
  assert.equal(failed.data.retryable, false);
  assert.deepEqual(
    await f.first.store.loadPluginTaskAdmission(f.task.binding),
    f.admission,
  );
  assert.equal(await f.count("plugin_credit_reservations"), 1);
  assert.equal(
    (await f.first.parent.pluginCreditStore().getAccount(f.creditScope))
      ?.reservedCredits,
    "30",
  );
});

test("authoritative absent v1 record preserves the real legacy task path without an installed owner", async (t) => {
  const f = await installedWorkerFixture(t, { legacy: true });
  assert.equal(f.admission, null);
  assert.equal((await f.worker({ resolver: null }).wake()).kind, "completed");
  assert.equal(f.state.baseCalls, 1);
  assert.equal(f.state.installedCalls, 0);
  assert.equal(f.state.acquires, 0);
  assert.match(
    f.state.requests[1]!.input.items.find(
      (item) => item.type === "tool_result",
    )!.output,
    /base-result/u,
  );
});

test("installed task replaces only tools while retaining the original kernel, policy, compiled catalog and paid receipt", async (t) => {
  const f = await installedWorkerFixture(t);
  const outcome = await f.worker().wake();
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.equal(f.state.baseCalls, 0);
  assert.equal(f.state.installedCalls, 1);
  assert.ok(f.state.policyCalls > 0);
  assert.ok(f.state.acquires > 0);
  assert.equal(f.state.releases, f.state.acquires);
  for (const input of f.acquired) {
    assert.equal(input.base, f.base);
    assert.equal(input.run.runId, f.task.binding.runId);
    assert.equal(input.signal instanceof AbortSignal, true);
  }
  assert.equal(f.state.purposes[0], "submit");
  assert.ok(f.state.purposes.some((purpose) => purpose === "observe"));
  assert.equal(f.state.requests.length, 2);
  for (const request of f.state.requests) {
    assert.deepEqual(
      request.tools.slice(0, f.base.version.tools.length),
      f.base.version.tools,
    );
    assert.equal(request.instructions, f.base.version.instructions);
  }
  assert.deepEqual(f.state.requests[0]!.tools, f.state.requests[1]!.tools);
  assert.match(
    f.state.requests[1]!.input.items.find(
      (item) => item.type === "tool_result",
    )!.output,
    /installed-result/u,
  );
  assert.equal(await f.count("run_snapshots"), 1);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
  assert.deepEqual(
    await f.first.store.loadExtensionRunBinding(f.task.binding),
    f.task.binding,
  );
  assert.deepEqual(
    await f.first.store.loadPluginTaskAdmission(f.task.binding),
    f.admission,
  );
});

test("missing provenance capability cannot be interpreted as an absent installed task", async (t) => {
  const f = await installedWorkerFixture(t);
  let reads = 0;
  const result = await f
    .worker({
      admissions: {
        loadPluginTaskAdmission: async () => {
          reads++;
          return null;
        },
      },
    })
    .wake();
  assert.deepEqual(result, {
    kind: "failed",
    runId: f.task.binding.runId,
    code: "installed_plugin_admission_port_unavailable",
  });
  assert.equal(reads, 0);
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.baseCalls, 0);
});

test("a provenance database failure never falls back to bundled tools", async (t) => {
  const f = await installedWorkerFixture(t);
  const result = await f
    .worker({
      admissions: {
        pluginAdmissionVersion: "crewon.plugin-task-admission.v1",
        loadPluginTaskAdmission: async () => {
          throw new Error("fixture_admission_db_unavailable");
        },
      },
    })
    .wake();
  assert.equal(result.kind, "retried");
  assert.equal(f.state.baseCalls, 0);
  assert.equal(f.state.installedCalls, 0);
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.acquires, 0);
});

test("a foreign persisted admission is rejected before any installed owner acquisition", async (t) => {
  const f = await installedWorkerFixture(t);
  assert.ok(f.admission);
  const result = await f
    .worker({
      admissions: {
        pluginAdmissionVersion: "crewon.plugin-task-admission.v1",
        loadPluginTaskAdmission: async () => ({
          ...f.admission!,
          spaceId: "foreign-space",
        }),
      },
    })
    .wake();
  assert.deepEqual(result, {
    kind: "failed",
    runId: f.task.binding.runId,
    code: "installed_plugin_admission_scope_mismatch",
  });
  assert.equal(f.state.acquires, 0);
  assert.equal(f.state.requests.length, 0);
});

test("v1 cannot use a base catalog without a constructed materialization proof", async (t) => {
  const f = await installedWorkerFixture(t);
  const { extensions: _extensions, ...unproved } = f.base;
  const result = await f.worker({ base: unproved }).wake();
  assert.deepEqual(result, {
    kind: "failed",
    runId: f.task.binding.runId,
    code: "installed_plugin_materialization_unavailable",
  });
  assert.equal(f.state.acquires, 0);
  assert.equal(f.state.baseCalls, 0);
  assert.equal(f.state.requests.length, 0);
});

test("v1 refuses another actual base target instead of rebuilding proof from the saved binding", async (t) => {
  const f = await installedWorkerFixture(t);
  const proof = f.base.extensions![0]!;
  const result = await f
    .worker({
      base: {
        ...f.base,
        extensions: [
          {
            ...proof,
            target: { ...proof.target, authorityId: "another-authority" },
          },
        ],
      },
    })
    .wake();
  assert.deepEqual(result, {
    kind: "failed",
    runId: f.task.binding.runId,
    code: "installed_plugin_materialization_mismatch",
  });
  assert.equal(f.state.acquires, 0);
  assert.equal(f.state.requests.length, 0);
});

test("a mismatched installed catalog is rejected and its owned lease is released", async (t) => {
  const f = await installedWorkerFixture(t);
  let released = 0;
  const result = await f
    .worker({
      resolver: {
        acquire: async () => ({
          resource: new InMemoryToolBroker(),
          release() {
            released++;
          },
        }),
      },
    })
    .wake();
  assert.deepEqual(result, {
    kind: "failed",
    runId: f.task.binding.runId,
    code: "installed_plugin_runtime_tools_mismatch",
  });
  assert.equal(released, 1);
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.baseCalls, 0);
});

test("a confirmed v1 with unavailable exact owner never borrows legacy tools", async (t) => {
  const f = await installedWorkerFixture(t);
  const result = await f
    .worker({ resolver: { acquire: async () => null } })
    .wake();
  assert.deepEqual(result, {
    kind: "failed",
    runId: f.task.binding.runId,
    code: "installed_plugin_runtime_unavailable",
  });
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.baseCalls, 0);
});

test("approval inspection and cancellation acquire the same Run owner with observe authority", async (t) => {
  const f = await installedWorkerFixture(t, { approval: true });
  const worker = f.worker();
  const outcome = await worker.wake();
  assert.equal(outcome.kind, "waitingApproval", JSON.stringify(outcome));
  assert.equal(f.state.installedCalls, 0);
  const first = f.acquired.length;
  await f.makeDue();
  assert.equal((await worker.wake()).kind, "waitingApproval");
  assert.ok(f.acquired.slice(first).length > 0);
  assert.ok(
    f.acquired.slice(first).every((input) => input.purpose === "observe"),
  );
  const inspected = f.acquired.length;
  await f.cancel();
  await f.makeDue();
  assert.equal((await worker.wake()).kind, "canceled");
  assert.ok(f.acquired.slice(inspected).length > 0);
  assert.ok(
    f.acquired.slice(inspected).every((input) => input.purpose === "observe"),
  );
  assert.equal(f.state.baseCalls, 0);
  assert.equal(f.state.installedCalls, 0);
  assert.equal(f.state.releases, f.state.acquires);
});

test("a disabled plugin recovers its already dispatched running receipt with a single effect and credit hold", async (t) => {
  const f = await installedWorkerFixture(t);
  let crash = true;
  const worker = f.worker({
    config: {
      afterToolProviderResolved: async () => {
        if (crash) {
          crash = false;
          throw new Error("fixture_after_effect");
        }
      },
    },
  });
  assert.equal((await worker.wake()).kind, "retried");
  assert.equal(f.state.installedCalls, 1);
  assert.equal(
    (await f.first.parent.loadRun(f.task.binding))?.status,
    "running",
  );
  await f.disable();
  const first = f.acquired.length;
  await f.makeDue();
  assert.equal((await worker.wake()).kind, "completed");
  assert.ok(f.acquired.slice(first).length > 0);
  assert.ok(
    f.acquired.slice(first).every((input) => input.purpose === "observe"),
  );
  assert.equal(f.state.installedCalls, 1);
  assert.equal(f.state.baseCalls, 0);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
  assert.equal(
    (await f.events()).filter((event) => event.type === "tool.completed")
      .length,
    1,
  );
});

test("observe acquisition still denies a new effect while the plugin is disabled", async (t) => {
  const f = await installedWorkerFixture(t);
  let crash = true;
  const worker = f.worker({
    config: {
      afterAttemptStarted: async () => {
        if (crash) {
          crash = false;
          throw new Error("fixture_before_new_effect");
        }
      },
    },
  });
  assert.equal((await worker.wake()).kind, "retried");
  assert.equal(
    (await f.first.parent.loadRun(f.task.binding))?.status,
    "running",
  );
  assert.equal(f.state.installedCalls, 0);
  await f.disable();
  const first = f.acquired.length;
  await f.makeDue();
  const outcome = await worker.wake();
  assert.notEqual(outcome.kind, "completed");
  assert.ok(
    f.acquired.slice(first).some((input) => input.purpose === "observe"),
  );
  assert.equal(f.state.installedCalls, 0);
  assert.equal(f.state.baseCalls, 0);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});

test("replaySafe recovery uses the actual fresh broker to repeat a permitted read after local state is lost", async (t) => {
  const f = await installedWorkerFixture(t, {
    replaySafe: true,
    reservation: "absent",
  });
  const crashed = f.worker({
    config: {
      afterToolProviderResolved: async () => {
        throw new Error("fixture_before_read_result_commit");
      },
    },
  });
  assert.equal((await crashed.wake()).kind, "retried");
  assert.equal(f.state.installedCalls, 1);
  assert.equal(
    (await f.first.parent.loadRun(f.task.binding))?.status,
    "running",
  );
  await crashed.close();
  assert.notEqual(f.forgetInstalledResults(), f.installedTools);
  const before = f.state.operations.length;
  await f.makeDue();
  assert.equal((await f.worker().wake()).kind, "completed");
  assert.equal(f.state.installedCalls, 2);
  assert.equal(f.state.baseCalls, 0);
  assert.ok(
    f.state.operations
      .slice(before)
      .some(
        (operation) =>
          operation.method === "reconcile" &&
          operation.recovery === "replaySafe" &&
          operation.purpose === "observe",
      ),
  );
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});

test("disabling a plugin still permits authorized replaySafe read recovery without a new mutation", async (t) => {
  const f = await installedWorkerFixture(t, {
    replaySafe: true,
    reservation: "absent",
  });
  const crashed = f.worker({
    config: {
      afterToolProviderResolved: async () => {
        throw new Error("fixture_before_read_result_commit");
      },
    },
  });
  assert.equal((await crashed.wake()).kind, "retried");
  assert.equal(f.state.installedCalls, 1);
  assert.equal(
    (await f.first.parent.loadRun(f.task.binding))?.status,
    "running",
  );
  await crashed.close();
  assert.notEqual(f.forgetInstalledResults(), f.installedTools);
  await f.disable();
  const before = f.state.operations.length;
  await f.makeDue();
  assert.equal((await f.worker().wake()).kind, "completed");
  assert.equal(f.state.installedCalls, 2);
  assert.equal(f.state.baseCalls, 0);
  assert.ok(
    f.state.operations
      .slice(before)
      .some(
        (operation) =>
          operation.method === "reconcile" &&
          operation.recovery === "replaySafe" &&
          operation.purpose === "observe",
      ),
  );
  assert.equal(
    (await f.events()).filter((event) => event.type === "tool.completed")
      .length,
    1,
  );
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});

test("revoking observe permission denies replaySafe read recovery before the fresh broker executes", async (t) => {
  const f = await installedWorkerFixture(t, {
    replaySafe: true,
    reservation: "absent",
  });
  const crashed = f.worker({
    config: {
      afterToolProviderResolved: async () => {
        throw new Error("fixture_before_read_commit");
      },
    },
  });
  assert.equal((await crashed.wake()).kind, "retried");
  assert.equal(f.state.installedCalls, 1);
  await crashed.close();
  f.forgetInstalledResults();
  await f.disable();
  const authorize = f.dependencies.authorization.authorize.bind(
    f.dependencies.authorization,
  );
  t.mock.method(
    f.dependencies.authorization,
    "authorize",
    (request: Parameters<typeof authorize>[0]) =>
      request.action === "extension:query"
        ? Promise.resolve({
            outcome: "deny" as const,
            reasonCode: "fixture_observe_revoked",
          })
        : authorize(request),
  );
  await f.makeDue();
  assert.notEqual((await f.worker().wake()).kind, "completed");
  assert.equal(f.state.installedCalls, 1);
  assert.equal(f.state.baseCalls, 0);
  assert.equal(
    (await f.events()).filter((event) => event.type === "tool.completed")
      .length,
    0,
  );
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});

test("unknown mutation reconciliation uses observe without repeating its submission", async (t) => {
  const f = await installedWorkerFixture(t, { unknownOutcome: true });
  const worker = f.worker();
  assert.equal((await worker.wake()).kind, "retried");
  assert.equal(
    (await f.first.parent.loadRun(f.task.binding))?.status,
    "reconciling",
  );
  assert.equal(f.state.installedCalls, 1);
  const first = f.acquired.length;
  // Synthetic passive observation of the original external effect; this is not a second execute.
  f.installedTools.reconcile = async (command) => ({
    status: "completed",
    executionId: command.executionId,
    providerReceiptId: "fixture-original-external-effect",
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: command.callId,
      output: "observed-original-result",
      isError: false,
      artifactRef: null,
    },
  });
  await f.makeDue();
  assert.equal((await worker.wake()).kind, "completed");
  assert.ok(
    f.acquired.slice(first).some((input) => input.purpose === "observe"),
  );
  assert.equal(f.state.installedCalls, 1);
  assert.equal(f.state.baseCalls, 0);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});

test("a timed-out installed acquisition retains the base physical owner and releases its late lease after shutdown", async (t) => {
  const clock = storeAccessClock();
  const held = deferred();
  const entered = deferred();
  const f = await installedWorkerFixture(t, { preflightTime: clock.time });
  let released = 0;
  let signal: AbortSignal | null = null;
  t.after(() => held.resolve());
  const worker = f.worker({
    resolver: {
      async acquire(input) {
        signal = input.signal;
        entered.resolve();
        await held.promise;
        return {
          resource: f.installedTools,
          release() {
            released++;
          },
        };
      },
    },
  });
  const wake = worker.wake();
  await entered.promise;
  clock.advance(10_000);
  assert.equal((await wake).kind, "leaseLost");
  assert.equal(released, 0);
  assert.equal(f.registry.resourceSnapshot().activeLeases, 1);
  assert.equal(worker.preflightSnapshot().pendingRequests, 1);
  await worker.close();
  assert.equal(signal!.aborted, true);
  assert.equal(released, 0);
  assert.equal(f.registry.resourceSnapshot().activeLeases, 1);
  held.resolve();
  await until(() => worker.preflightSnapshot().pendingRequests === 0);
  assert.equal(released, 1);
  assert.equal(f.registry.resourceSnapshot().activeLeases, 0);
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.baseCalls, 0);
  assert.equal(f.state.installedCalls, 0);
});
