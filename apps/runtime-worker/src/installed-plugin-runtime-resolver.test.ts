import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { selectionRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { actor } from "../../../packages/store/src/extension-configuration-service.test-support.ts";
import {
  committedResult,
  deferred,
  installedResolverFixture,
  signal,
  tick,
  toolName,
} from "./installed-plugin-runtime-resolver.test-support.ts";

test("actual persisted admission loads exact installed ESM factory, routes its tool, and closes SDK before releasing the Node instance", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver();
  const originalSignal = signal();
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: originalSignal,
  });
  assert.ok(lease);
  assert.deepEqual(lease.resource.definitions(), f.base.version.tools);
  const execution = f.execution();
  const completed = await lease.resource.execute(execution, originalSignal);
  assert.equal(
    completed.status === "completed" && completed.result.output,
    "installed:0.1.0",
  );
  assert.equal(f.controls.baseCalls, 0);
  assert.equal(f.controls.signals[0], originalSignal);
  assert.equal(
    f.controls.records.filter((value) => value === "factory").length,
    1,
  );
  const snapshot = f.controls.contexts[0] as {
    identity: { packageDigest: string };
    run: { runId: string };
    scope: { profileId: string };
  };
  assert.equal(snapshot.identity.packageDigest, f.installed.packageDigest);
  assert.equal(snapshot.run.runId, f.run.runId);
  assert.equal(snapshot.scope.profileId, f.profile.profileId);
  let closed = false;
  const closing = resolver.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  assert.equal(f.controls.records.includes("runtime-close"), false);
  lease.release();
  lease.release();
  await closing;
  assert.deepEqual(f.controls.records.slice(-3), [
    "runtime-close",
    "runtime-closed",
    "node-dispose",
  ]);
});

test("the same original Run keeps its SDK owner and recovery evidence across borrows without provider re-execution", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver();
  const input = {
    run: f.run,
    base: f.base,
    purpose: "submit" as const,
    signal: signal(),
  };
  const first = await resolver.acquire(input);
  assert.ok(first);
  const execution = f.execution();
  const completed = await first.resource.execute(execution, signal());
  first.release();
  await tick();
  assert.equal(f.controls.records.includes("runtime-close"), false);
  const second = await resolver.acquire({
    ...input,
    purpose: "observe",
    signal: signal(),
  });
  assert.ok(second);
  assert.deepEqual(
    await second.resource.reconcile(execution, signal()),
    completed,
  );
  assert.deepEqual(
    await second.resource.cancel(execution, signal()),
    completed,
  );
  assert.equal(
    f.controls.records.filter((value) => value === "execute").length,
    1,
  );
  assert.equal(
    f.controls.records.filter((value) => value === "factory").length,
    1,
  );
  f.controls.retireProof = true;
  assert.equal(
    second.resource.acknowledgeExecutionResult!(
      committedResult(execution, completed.providerReceiptId),
    ),
    true,
  );
  second.release();
  await resolver.close();
  assert.deepEqual(f.controls.records.slice(-3), [
    "runtime-close",
    "runtime-closed",
    "node-dispose",
  ]);
});

test("publisher and actor authority are rechecked for every execution, recovery and cancellation", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver();
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  f.controls.publisherAllowed = false;
  const before = f.controls.authorizations;
  for (const method of ["execute", "reconcile", "cancel"] as const)
    await assert.rejects(
      lease.resource[method](f.execution(), signal()),
      /installed_plugin_runtime_publisher_denied/u,
    );
  assert.equal(f.controls.authorizations - before, 3);
  assert.equal(f.controls.records.includes("execute"), false);
  f.controls.publisherAllowed = true;
  f.state.denied = "run:execute";
  await assert.rejects(
    lease.resource.execute(f.execution(), signal()),
    /installed_plugin_execution_access_denied/u,
  );
  lease.release();
  await resolver.close();
});

test("disabled generation denies new dispatch but original reconcilable observation retains the completed receipt", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver();
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  const execution = f.execution();
  const completed = await lease.resource.execute(execution, signal());
  lease.release();
  await f.activation("disabled");
  await assert.rejects(
    resolver.acquire({
      run: f.run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /installed_plugin_generation_disabled/u,
  );
  assert.equal(f.controls.records.includes("runtime-close"), false);
  const observed = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "observe",
    signal: signal(),
  });
  assert.ok(observed);
  assert.deepEqual(
    await observed.resource.reconcile(execution, signal()),
    completed,
  );
  await assert.rejects(
    observed.resource.execute(execution, signal()),
    /installed_plugin_generation_disabled/u,
  );
  observed.release();
  await resolver.close();
});

test("post-setup async commit rechecks activation and disposes the unpublished instance when generation was disabled during setup", async (t) => {
  const f = await installedResolverFixture(t);
  f.controls.onSetup = () => f.activation("disabled");
  const resolver = f.resolver();
  await assert.rejects(
    resolver.acquire({
      run: f.run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /installed_plugin_generation_disabled/u,
  );
  assert.deepEqual(f.controls.records, ["setup", "node-dispose"]);
  await resolver.close();
});

test("persisted plugin selection disable blocks dispatch while the original completed receipt remains reconcilable", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver();
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  const execution = f.execution();
  const completed = await lease.resource.execute(execution, signal());
  const current = await f.installations.loadSelection({
    scope: f.profile,
    pluginId: f.recipe.package.pluginId,
  });
  assert.ok(current);
  await f.installations.commitSelection(
    selectionRecipe(current, "resolver-disable-selection", {
      actor,
      state: "disabled",
    }),
  );
  await assert.rejects(lease.resource.execute(execution, signal()));
  assert.deepEqual(
    await lease.resource.reconcile(execution, signal()),
    completed,
  );
  assert.equal(
    f.controls.records.filter((value) => value === "execute").length,
    1,
  );
  assert.equal(f.controls.records.includes("runtime-close"), false);
  lease.release();
  await resolver.close();
});

test("post-setup publisher denial cannot reuse an initial package authorization", async (t) => {
  const f = await installedResolverFixture(t);
  f.controls.onSetup = async () => {
    f.controls.publisherAllowed = false;
  };
  const resolver = f.resolver();
  await assert.rejects(
    resolver.acquire({
      run: f.run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /installed_plugin_runtime_publisher_denied/u,
  );
  assert.deepEqual(f.controls.records, ["setup", "node-dispose"]);
  await resolver.close();
});

test("denied warm borrow preserves the earlier unacknowledged completion instead of treating failed authorization as shutdown", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver();
  const input = {
    run: f.run,
    base: f.base,
    purpose: "submit" as const,
    signal: signal(),
  };
  const first = await resolver.acquire(input);
  assert.ok(first);
  const execution = f.execution();
  const completed = await first.resource.execute(execution, signal());
  first.release();
  f.controls.publisherAllowed = false;
  await assert.rejects(
    resolver.acquire({ ...input, purpose: "observe", signal: signal() }),
    /installed_plugin_runtime_publisher_denied/u,
  );
  await tick();
  assert.equal(f.controls.records.includes("runtime-close"), false);
  f.controls.publisherAllowed = true;
  const recovered = await resolver.acquire({
    ...input,
    purpose: "observe",
    signal: signal(),
  });
  assert.ok(recovered);
  assert.deepEqual(
    await recovered.resource.reconcile(execution, signal()),
    completed,
  );
  assert.equal(
    f.controls.records.filter((value) => value === "execute").length,
    1,
  );
  recovered.release();
  await resolver.close();
});

test("business manifest, publisher and exact installed bytes are checked before any package setup", async (t) => {
  for (const options of [
    { manifestMismatch: true },
    { publisher: "foreign.publisher" },
  ]) {
    await t.test(JSON.stringify(options), async (sub) => {
      const f = await installedResolverFixture(sub, options);
      const resolver = f.resolver();
      await assert.rejects(
        resolver.acquire({
          run: f.run,
          base: f.base,
          purpose: "submit",
          signal: signal(),
        }),
      );
      assert.deepEqual(f.controls.records, []);
      await resolver.close();
    });
  }
  await t.test("tampered payload", async (sub) => {
    const f = await installedResolverFixture(sub);
    const path = join(
      f.installRoot,
      "packages",
      f.installed.packageDigest.slice(7),
      "entry.mjs",
    );
    await chmod(path, 0o600);
    await writeFile(
      path,
      "throw new Error('tampered package must never execute')",
    );
    const resolver = f.resolver();
    await assert.rejects(
      resolver.acquire({
        run: f.run,
        base: f.base,
        purpose: "submit",
        signal: signal(),
      }),
    );
    assert.deepEqual(f.controls.records, []);
    await resolver.close();
  });
});

test("current context cannot be bypassed with another actor, policy target or base runtime", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver();
  await assert.rejects(
    resolver.acquire({
      run: { ...f.run, createdByActorId: "foreign-actor" },
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /installed_plugin_admission_scope_mismatch/u,
  );
  const base = {
    ...f.base,
    extensions: f.base.extensions!.map((proof) => ({
      ...proof,
      target: {
        ...proof.target,
        materializationDigest: `sha256:${"b".repeat(64)}`,
      },
    })),
  };
  await assert.rejects(
    resolver.acquire({ run: f.run, base, purpose: "submit", signal: signal() }),
    /installed_plugin_target_mismatch/u,
  );
  f.state.denied = "run:execute";
  await assert.rejects(
    resolver.acquire({
      run: f.run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /installed_plugin_execution_access_denied/u,
  );
  assert.deepEqual(f.controls.records, []);
  await resolver.close();
});

test("extra SDK tool definitions are rejected and the returned SDK runtime is physically closed before Node disposal", async (t) => {
  const f = await installedResolverFixture(t, { extraTools: true });
  const resolver = f.resolver();
  await assert.rejects(
    resolver.acquire({
      run: f.run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /plugin_tool_catalog_mismatch/u,
  );
  assert.deepEqual(f.controls.records, [
    "setup",
    "factory",
    "runtime-close",
    "runtime-closed",
    "node-dispose",
  ]);
  await resolver.close();
});

test("late factory completion after abort adopts and closes its actual SDK resource before releasing the Node lease", async (t) => {
  const f = await installedResolverFixture(t);
  const factory = deferred(),
    cleanup = deferred();
  f.controls.factoryGate = factory.promise;
  f.controls.closeGate = cleanup.promise;
  const resolver = f.resolver();
  const controller = new AbortController();
  const acquiring = resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: controller.signal,
  });
  const failed = assert.rejects(acquiring, /fixture aborted/u);
  while (!f.controls.records.includes("factory")) await tick();
  controller.abort(new Error("fixture aborted"));
  factory.resolve();
  while (!f.controls.records.includes("runtime-close")) await tick();
  assert.equal(f.controls.records.includes("node-dispose"), false);
  cleanup.resolve();
  await failed;
  await resolver.close();
  assert.deepEqual(f.controls.records.slice(-3), [
    "runtime-close",
    "runtime-closed",
    "node-dispose",
  ]);
});

test("resolver shutdown joins a physical factory and its SDK cleanup instead of releasing its Node lease early", async (t) => {
  const f = await installedResolverFixture(t);
  const factory = deferred(),
    cleanup = deferred();
  f.controls.factoryGate = factory.promise;
  f.controls.closeGate = cleanup.promise;
  const resolver = f.resolver();
  const acquiring = resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  const rejected = assert.rejects(
    acquiring,
    /installed_plugin_runtime_resolver_closed/u,
  );
  while (!f.controls.records.includes("factory")) await tick();
  let closed = false;
  const closing = resolver.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  assert.equal(f.controls.records.includes("node-dispose"), false);
  factory.resolve();
  while (!f.controls.records.includes("runtime-close")) await tick();
  assert.equal(closed, false);
  assert.equal(f.controls.records.includes("node-dispose"), false);
  cleanup.resolve();
  await rejected;
  await closing;
  assert.deepEqual(f.controls.records.slice(-3), [
    "runtime-close",
    "runtime-closed",
    "node-dispose",
  ]);
});

test("concurrent borrows deduplicate one exact factory while close waits for both consumers", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver();
  const input = {
    run: f.run,
    base: f.base,
    purpose: "submit" as const,
    signal: signal(),
  };
  const [first, second] = await Promise.all([
    resolver.acquire(input),
    resolver.acquire(input),
  ]);
  assert.ok(first);
  assert.ok(second);
  assert.equal(
    f.controls.records.filter((value) => value === "factory").length,
    1,
  );
  let closed = false;
  const closing = resolver.close().then(() => {
    closed = true;
  });
  first.release();
  first.release();
  await tick();
  assert.equal(closed, false);
  second.release();
  await closing;
  assert.equal(closed, true);
});

test("empty result scans and missing retirement proof cannot free a bounded owner slot", async (t) => {
  const f = await installedResolverFixture(t, { proof: false });
  const resolver = f.resolver(1);
  const first = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(first);
  assert.deepEqual(
    first.resource.scanRetainedExecutionResults!({ limit: 1 }),
    [],
  );
  first.release();
  await tick();
  const task = await f.createTask("second");
  const run = await f.first.parent.loadRunInSpace(task.binding);
  assert.ok(run);
  await assert.rejects(
    resolver.acquire({
      run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /installed_plugin_runtime_capacity_exhausted/u,
  );
  assert.equal(
    f.controls.records.filter((value) => value === "factory").length,
    1,
  );
  assert.equal(f.controls.records.includes("runtime-close"), false);
  await resolver.close();
});

test("missing close is usable only with an actual positive retirement proof", async (t) => {
  await t.test(
    "positive proof closes only the safe Node instance",
    async (sub) => {
      const f = await installedResolverFixture(sub, {
        close: false,
        proof: true,
      });
      const resolver = f.resolver();
      const lease = await resolver.acquire({
        run: f.run,
        base: f.base,
        purpose: "submit",
        signal: signal(),
      });
      assert.ok(lease);
      lease.release();
      await resolver.close();
      assert.deepEqual(f.controls.records, [
        "setup",
        "factory",
        "node-dispose",
      ]);
    },
  );
  await t.test(
    "unknown cleanup remains quarantined and cannot release the Node lease",
    async (sub) => {
      const f = await installedResolverFixture(sub, {
        close: false,
        proof: false,
      });
      const resolver = f.resolver(1);
      await assert.rejects(
        resolver.acquire({
          run: f.run,
          base: f.base,
          purpose: "submit",
          signal: signal(),
        }),
        /installed_plugin_runtime_start_failed/u,
      );
      await assert.rejects(
        resolver.close(),
        /installed_plugin_runtime_close_failed/u,
      );
      assert.equal(f.controls.records.includes("node-dispose"), false);
    },
  );
});

test("cold historical load uses the original package digest after logical uninstall and never falls back to current selection", async (t) => {
  const f = await installedResolverFixture(t);
  const first = f.resolver();
  const lease = await first.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  lease.release();
  await first.close();
  const current = await f.installations.loadSelection({
    scope: f.profile,
    pluginId: f.recipe.package.pluginId,
  });
  assert.ok(current);
  await f.installations.commitSelection(
    selectionRecipe(current, "resolver-uninstall", {
      actor,
      state: "uninstalled",
    }),
  );
  await f.activation("disabled");
  const cold = f.resolver();
  const observed = await cold.acquire({
    run: f.run,
    base: f.base,
    purpose: "observe",
    signal: signal(),
  });
  assert.ok(observed);
  assert.equal(
    f.controls.records.filter((value) => value === "factory").length,
    2,
  );
  const context = f.controls.contexts[1] as {
    identity: { packageDigest: string; version: string };
  };
  assert.equal(context.identity.packageDigest, f.installed.packageDigest);
  assert.equal(context.identity.version, "0.1.0");
  assert.equal(
    (await observed.resource.reconcile(f.execution(), signal())).status,
    "unknownOutcome",
  );
  observed.release();
  await cold.close();
});

test("SDK factory rejection closes its Node borrow and does not retain a phantom cache entry", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver(1);
  f.controls.onFactory = async () => {
    throw new Error("factory construction failed");
  };
  await assert.rejects(
    resolver.acquire({
      run: f.run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /factory construction failed/u,
  );
  assert.deepEqual(f.controls.records, ["setup", "factory", "node-dispose"]);
  f.controls.onFactory = null;
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  lease.release();
  await resolver.close();
});

test("the plugin tool name is a manifest-owned operation, not an arbitrary tool catalog injection", async (t) => {
  const f = await installedResolverFixture(t);
  const resolver = f.resolver();
  assert.equal(
    f.base.extensions![0]!.registration.manifest.tools[0]!.operationId,
    "submit",
  );
  assert.ok(f.base.version.tools.some((tool) => tool.name === toolName));
  const altered = {
    ...f.base,
    version: {
      ...f.base.version,
      tools: f.base.version.tools.filter((tool) => tool.name !== toolName),
    },
  };
  await assert.rejects(
    resolver.acquire({
      run: f.run,
      base: altered,
      purpose: "submit",
      signal: signal(),
    }),
    /installed_plugin_runtime_tools_mismatch/u,
  );
  assert.deepEqual(f.controls.records, []);
  await resolver.close();
});
