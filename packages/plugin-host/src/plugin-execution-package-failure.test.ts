import assert from "node:assert/strict";
import test from "node:test";
import {
  PluginExecutionPackage,
  pluginExecutionPackageFailureOwner,
} from "./index.ts";
import { executionPackage } from "./plugin-execution-registry.test-support.ts";
import { allowPreparedCommit } from "./plugin-node-preparation.test-support.ts";

test("missing execution factory and failed Node disposal preserve a real failure owner", async (t) => {
  const installed = await executionPackage(t, {
    setup: "",
    dispose: "throw new Error('fixture_node_disposal_failed');",
  });
  const failure = await PluginExecutionPackage.open({
    activation: installed,
    commit: allowPreparedCommit,
  }).then(
    () => assert.fail("package without an execution factory was published"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.message, "plugin_execution_package_start_failed");
  assert.match(
    String(failure.errors[0]),
    /plugin_execution_factory_unavailable/,
  );
  const owner = pluginExecutionPackageFailureOwner(failure);
  assert.ok(owner);
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Object.keys(owner), ["close"]);
  assert.equal(pluginExecutionPackageFailureOwner(failure), owner);
  await assert.rejects(owner.close(), /plugin_cleanup_failed/);
  await assert.rejects(owner.close(), /plugin_cleanup_failed/);
  assert.equal(
    (await installed.records()).filter((value) => value === "dispose").length,
    1,
  );
});

test(
  "asynchronous post-setup authority rejection retains the Node owner when disposal fails",
  { timeout: 15000 },
  async (t) => {
    const installed = await executionPackage(t, {
      dispose: "throw new Error('fixture_node_disposal_failed');",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checked = false;
    let commits = 0;
    const opening = PluginExecutionPackage.open({
      activation: installed,
      beforeCommit: async () => {
        assert.ok((await installed.records()).includes("setup"));
        checked = true;
        await gate;
        throw new Error("fixture_current_authority_revoked");
      },
      commit: {
        authorizeCommit: () => {
          commits++;
          return "allow";
        },
      },
    });
    const failed = opening.then(
      () => assert.fail("revoked package was published"),
      (error: unknown) => error,
    );
    try {
      while (!checked) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(commits, 0);
      assert.equal((await installed.records()).includes("dispose"), false);
      release();
      const failure = await failed;
      assert.ok(failure instanceof AggregateError);
      assert.equal(failure.message, "plugin_execution_package_start_failed");
      assert.match(
        String(failure.errors[0]),
        /fixture_current_authority_revoked/,
      );
      const owner = pluginExecutionPackageFailureOwner(failure);
      assert.ok(owner);
      await assert.rejects(owner.close(), /plugin_cleanup_failed/);
      assert.equal(commits, 0);
      assert.equal(
        (await installed.records()).filter((value) => value === "dispose")
          .length,
        1,
      );
    } finally {
      release();
      await failed;
    }
  },
);

test("ordinary startup failures carry no failure owner after actual cleanup succeeds", async (t) => {
  const installed = await executionPackage(t, { setup: "" });
  const failure = await PluginExecutionPackage.open({
    activation: installed,
    commit: allowPreparedCommit,
  }).then(
    () => assert.fail("package without an execution factory was published"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /plugin_execution_factory_unavailable/);
  assert.equal(pluginExecutionPackageFailureOwner(failure), null);
  assert.equal(
    (await installed.records()).filter((value) => value === "dispose").length,
    1,
  );
});

test("a same-shaped or wrapped error cannot forge failure ownership", async (t) => {
  const installed = await executionPackage(t, {
    setup: "",
    dispose: "throw new Error('fixture_node_disposal_failed');",
  });
  const failure = await PluginExecutionPackage.open({
    activation: installed,
    commit: allowPreparedCommit,
  }).then(
    () => assert.fail("package without an execution factory was published"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof AggregateError);
  assert.ok(pluginExecutionPackageFailureOwner(failure));
  const forged = new AggregateError(failure.errors, failure.message);
  assert.equal(pluginExecutionPackageFailureOwner(forged), null);
  assert.equal(
    pluginExecutionPackageFailureOwner(
      new Error("wrapped", { cause: failure }),
    ),
    null,
  );
  assert.equal(pluginExecutionPackageFailureOwner({ ...failure }), null);
  assert.equal(pluginExecutionPackageFailureOwner(null), null);
  assert.equal(pluginExecutionPackageFailureOwner(failure.message), null);
});
