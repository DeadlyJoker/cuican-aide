import assert from "node:assert/strict";
import test from "node:test";
import {
  committedResult,
  deferred,
  installedResolverFixture,
  signal,
  tick,
} from "./installed-plugin-runtime-resolver.test-support.ts";

test("installed maintenance does not instantiate or read a package when no admitted resident exists", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver();
  for (let wake = 0; wake < 100; wake++)
    assert.equal(resolver.nextToolResultMaintenanceLease(), null);
  assert.deepEqual(f.controls.records, []);
  assert.equal(f.controls.authorizations, 0);
  await resolver.close();
  assert.equal(resolver.nextToolResultMaintenanceLease(), null);
});

test("maintenance borrows an actual admitted adapter after actor and publisher revocation, without external operation", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver();
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  const command = f.execution();
  const result = await lease.resource.execute(command, signal());
  lease.release();
  f.controls.publisherAllowed = false;
  f.state.denied = "run:execute";
  const authorizations = f.controls.authorizations;
  const maintenance = resolver.nextToolResultMaintenanceLease();
  assert.ok(maintenance);
  assert.deepEqual(maintenance.resource.definitions(), [
    f.base.version.tools[0],
  ]);
  assert.deepEqual(
    maintenance.resource.readRetainedExecutionResult?.({
      executionId: command.executionId,
      idempotencyKey: command.idempotencyKey,
      actionDigest: command.actionDigest,
      actionIntent: command.actionIntent,
    }),
    result,
  );
  assert.equal(
    maintenance.resource.acknowledgeExecutionResult?.(
      committedResult(command, result.providerReceiptId),
    ),
    true,
  );
  assert.equal(f.controls.authorizations, authorizations);
  assert.equal(
    f.controls.records.filter((value) => value === "execute").length,
    1,
  );
  assert.equal(f.controls.records.includes("reconcile"), false);
  assert.equal(f.controls.records.includes("cancel"), false);
  f.controls.retireProof = true;
  let closed = false;
  const closing = resolver.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  assert.equal(f.controls.records.includes("runtime-close"), false);
  maintenance.release();
  maintenance.release();
  await closing;
  assert.deepEqual(f.controls.records.slice(-3), [
    "runtime-close",
    "runtime-closed",
    "node-dispose",
  ]);
});

test("empty installed scans and absent retirement proof preserve the bounded owner and capacity", async (t) => {
  const f = await installedResolverFixture(t, { proof: false });
  const resolver = f.resolver(1);
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  lease.release();
  for (let turn = 0; turn < 3; turn++) {
    const maintenance = resolver.nextToolResultMaintenanceLease();
    assert.ok(maintenance);
    assert.deepEqual(
      maintenance.resource.scanRetainedExecutionResults?.({ limit: 1 }),
      [],
    );
    assert.equal(maintenance.resource.canRetire, undefined);
    maintenance.release();
  }
  assert.equal(f.controls.records.includes("runtime-close"), false);
  const task = await f.createTask("empty-scan-capacity");
  const run = await f.first.parent.loadRunInSpace(task.binding);
  assert.ok(run);
  await assert.rejects(
    resolver.acquire({
      run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /installed_plugin_runtime_capacity_exhausted/,
  );
  assert.equal(
    f.controls.records.filter((value) => value === "factory").length,
    1,
  );
  await resolver.close();
});

test("idle maintenance cannot retire a physical pending SDK operation even after its original borrower releases", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver(1);
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  const physical = deferred();
  f.controls.executeGate = physical.promise;
  const command = f.execution();
  const execution = lease.resource.execute(command, signal());
  while (!f.controls.records.includes("execute")) await tick();
  lease.release();
  f.controls.retireProof = true;
  try {
    const maintenance = resolver.nextToolResultMaintenanceLease();
    assert.ok(maintenance);
    try {
      assert.equal(maintenance.resource.canRetire?.(), false);
      assert.deepEqual(
        maintenance.resource.scanRetainedExecutionResults?.({ limit: 1 }),
        [],
      );
      assert.equal(f.controls.records.includes("runtime-close"), false);
    } finally {
      maintenance.release();
    }
  } finally {
    physical.resolve();
  }
  const result = await execution;
  const completed = resolver.nextToolResultMaintenanceLease();
  assert.ok(completed);
  assert.equal(completed.resource.canRetire?.(), false);
  assert.equal(
    completed.resource.acknowledgeExecutionResult?.(
      committedResult(command, result.providerReceiptId),
    ),
    true,
  );
  completed.release();
  await resolver.close();
  assert.deepEqual(f.controls.records.slice(-3), [
    "runtime-close",
    "runtime-closed",
    "node-dispose",
  ]);
});

test("real Node cleanup failure after idle ACK stays quarantined and is never returned for maintenance", async (t) => {
  const f = await installedResolverFixture(t, { nodeDisposerFails: true });
  const resolver = f.resolver(1);
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  const command = f.execution();
  const result = await lease.resource.execute(command, signal());
  lease.release();
  f.controls.retireProof = true;
  const maintenance = resolver.nextToolResultMaintenanceLease();
  assert.ok(maintenance);
  assert.equal(
    maintenance.resource.acknowledgeExecutionResult?.(
      committedResult(command, result.providerReceiptId),
    ),
    true,
  );
  maintenance.release();
  while (!f.controls.records.includes("node-dispose")) await tick();
  for (let pass = 0; pass < 3; pass++)
    assert.equal(resolver.nextToolResultMaintenanceLease(), null);
  const task = await f.createTask("cleanup-quarantine");
  const run = await f.first.parent.loadRunInSpace(task.binding);
  assert.ok(run);
  await assert.rejects(
    resolver.acquire({
      run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /installed_plugin_runtime_capacity_exhausted/,
  );
  await assert.rejects(
    resolver.close(),
    /installed_plugin_runtime_close_failed/,
  );
  assert.equal(
    f.controls.records.filter((value) => value === "node-dispose").length,
    1,
  );
});
