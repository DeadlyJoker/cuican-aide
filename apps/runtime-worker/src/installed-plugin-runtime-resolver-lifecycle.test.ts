import assert from "node:assert/strict";
import test from "node:test";
import {
  installedResolverFixture,
  deferred,
  signal,
  tick,
} from "./installed-plugin-runtime-resolver.test-support.ts";

test("router validation failure closes an unpublished SDK resource and frees the bounded entry for a real borrow", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver(1);
  let accesses = 0;
  const malformed = Object.create(
    f.base.toolRuntime,
  ) as typeof f.base.toolRuntime;
  Object.defineProperty(malformed, "definitions", {
    get() {
      accesses++;
      throw new Error("definitions getter executed");
    },
  });
  await assert.rejects(
    resolver.acquire({
      run: f.run,
      base: { ...f.base, toolRuntime: malformed },
      purpose: "submit",
      signal: signal(),
    }),
  );
  assert.equal(accesses, 0);
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  assert.equal(
    f.controls.records.filter((value) => value === "factory").length,
    2,
  );
  assert.deepEqual(f.controls.records.slice(0, 5), [
    "setup",
    "factory",
    "runtime-close",
    "runtime-closed",
    "node-dispose",
  ]);
  lease.release();
  await resolver.close();
});

test("explicit owner close keeps the Node borrow until an already started SDK call delivers its late completion receipt", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver();
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  const physical = deferred();
  f.controls.executeGate = physical.promise;
  const execution = lease.resource.execute(f.execution(), signal());
  while (!f.controls.records.includes("execute")) await tick();
  // The adapter still owns the physical delegate even if a caller releases bookkeeping early.
  lease.release();
  let closed = false;
  const closing = resolver.close().then(() => {
    closed = true;
  });
  while (!f.controls.records.includes("runtime-close")) await tick();
  assert.equal(closed, false);
  assert.equal(f.controls.records.includes("node-dispose"), false);
  physical.resolve();
  const completed = await execution;
  assert.equal(
    completed.status === "completed" && completed.result.output,
    "installed:0.1.0",
  );
  await closing;
  assert.equal(closed, true);
  assert.equal(f.controls.records.at(-1), "node-dispose");
});

for (const failure of ["no factory", "post-setup denied"] as const)
  test(`actual ${failure} startup with failed Node disposal remains in a bounded quarantine`, async (t) => {
    const f = await installedResolverFixture(t, {
      registerFactory: failure !== "no factory",
      nodeDisposerFails: true,
    });
    if (failure === "post-setup denied")
      f.controls.onSetup = async () => {
        f.controls.publisherAllowed = false;
      };
    const resolver = f.resolver(1);
    const input = {
      run: f.run,
      base: f.base,
      purpose: "submit" as const,
      signal: signal(),
    };
    await assert.rejects(
      resolver.acquire(input),
      /plugin_execution_package_start_failed/u,
    );
    assert.deepEqual(f.controls.records, ["setup", "node-dispose"]);
    await assert.rejects(resolver.acquire({ ...input, signal: signal() }));
    assert.deepEqual(f.controls.records, ["setup", "node-dispose"]);
    const task = await f.createTask("quarantined-second");
    const run = await f.first.parent.loadRunInSpace(task.binding);
    assert.ok(run);
    await assert.rejects(
      resolver.acquire({ ...input, run, signal: signal() }),
      /installed_plugin_runtime_capacity_exhausted/u,
    );
    assert.deepEqual(f.controls.records, ["setup", "node-dispose"]);
    await assert.rejects(
      resolver.close(),
      /installed_plugin_runtime_close_failed/u,
    );
    assert.deepEqual(f.controls.records, ["setup", "node-dispose"]);
  });

test("a caller cannot forge fullAccess instead of the host-verified original Run permission", async (t) => {
  const f = await installedResolverFixture(t);
  assert.notEqual(f.run.toolPermissionMode, "fullAccess");
  const resolver = f.resolver();
  await assert.rejects(
    resolver.acquire({
      run: { ...f.run, toolPermissionMode: "fullAccess" },
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /installed_plugin_runtime_permission_mismatch/u,
  );
  assert.deepEqual(f.controls.records, []);
  await resolver.close();
});

test("a startup failure whose actual Node cleanup completed frees its bounded slot", async (t) => {
  const f = await installedResolverFixture(t, { registerFactory: false });
  const resolver = f.resolver(1);
  await assert.rejects(
    resolver.acquire({
      run: f.run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /plugin_execution_factory_unavailable/u,
  );
  const task = await f.createTask("clean-startup-second");
  const run = await f.first.parent.loadRunInSpace(task.binding);
  assert.ok(run);
  await assert.rejects(
    resolver.acquire({
      run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /plugin_execution_factory_unavailable/u,
  );
  assert.deepEqual(f.controls.records, [
    "setup",
    "node-dispose",
    "setup",
    "node-dispose",
  ]);
  await resolver.close();
});
