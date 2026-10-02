import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PluginExecutionPackage } from "./plugin-execution-package.ts";
import { PluginExecutionRegistry } from "./plugin-execution-registry.ts";
import { PluginNodeHost } from "./plugin-node-host.ts";
import {
  executionPackage,
  executionContext,
} from "./plugin-execution-registry.test-support.ts";
import {
  allowPreparedCommit,
  preparedBorrow,
} from "./plugin-node-preparation.test-support.ts";

const historical = {
  purpose: "historicalOperation" as const,
  authorizeBorrow: () => "allow" as const,
};

test("loads an exact installed execution package in a fresh host, closes, and reconstructs it", async (t) => {
  const installed = await executionPackage(t, { version: "1.0.0" });
  for (let index = 0; index < 2; index++) {
    const owner = await PluginExecutionPackage.open({
      activation: installed,
      commit: allowPreparedCommit,
    });
    assert.equal(owner.identity.packageDigest, installed.expectedPackageDigest);
    const borrow = owner.acquire(historical);
    const runtime = await borrow.factory.create(
      executionContext(borrow.identity),
    );
    assert.equal(runtime.canRetire?.(), true);
    await runtime.close?.();
    borrow.release();
    borrow.release();
    await owner.close();
    await owner.close();
    assert.throws(
      () => owner.acquire(historical),
      /plugin_execution_package_closed/,
    );
  }
  const records = await installed.records();
  assert.equal(records.filter((value) => value === "setup").length, 2);
  assert.equal(records.filter((value) => value === "dispose").length, 2);
  assert.equal(records.filter((value) => value === "runtime-close").length, 2);
});

test("historical loading never changes the separate current host or its version", async (t) => {
  const oldPackage = await executionPackage(t, { version: "1.0.0" });
  const currentPackage = await executionPackage(t, { version: "2.0.0" });
  const registry = new PluginExecutionRegistry();
  const currentHost = new PluginNodeHost({
    services: [registry.hostService()],
  });
  await currentHost.activate(currentPackage);
  const owner = await PluginExecutionPackage.open({
    activation: oldPackage,
    commit: allowPreparedCommit,
  });
  const borrow = owner.acquire(historical);
  const historicalRuntime = await borrow.factory.create(
    executionContext(borrow.identity),
  );
  const current = currentHost.acquire(
    preparedBorrow(
      currentPackage.expectedPluginId,
      currentPackage.expectedPackageDigest,
    ),
  );
  const currentRuntime = await registry
    .acquire(current)
    .create(executionContext(current.identity));
  assert.equal(borrow.identity.version, "1.0.0");
  assert.equal(current.identity.version, "2.0.0");
  assert.equal(
    currentHost.snapshot()[0].identity.packageDigest,
    currentPackage.expectedPackageDigest,
  );
  await historicalRuntime.close?.();
  await currentRuntime.close?.();
  borrow.release();
  current.release();
  await owner.close();
  await currentHost.close();
  registry.close();
});

test("shutdown refuses to invent completion for live borrows and remains retryable after release", async (t) => {
  const installed = await executionPackage(t);
  const owner = await PluginExecutionPackage.open({
    activation: installed,
    commit: allowPreparedCommit,
  });
  const borrow = owner.acquire(historical);
  const runtime = await borrow.factory.create(
    executionContext(borrow.identity),
  );
  await assert.rejects(owner.close(), /plugin_host_has_live_leases/);
  assert.equal((await installed.records()).includes("dispose"), false);
  assert.throws(
    () => borrow.factory.create(executionContext(borrow.identity)),
    /plugin_host_closed/,
  );
  await runtime.close?.();
  borrow.release();
  await owner.close();
  assert.equal(
    (await installed.records()).filter((value) => value === "dispose").length,
    1,
  );
});

test("checks commit authority and every borrow instead of treating installation as permission", async (t) => {
  const installed = await executionPackage(t);
  await assert.rejects(
    PluginExecutionPackage.open({
      activation: installed,
      commit: { authorizeCommit: () => "deny" },
    }),
    /plugin_commit_denied/,
  );
  assert.equal((await installed.records()).includes("dispose"), true);
  const owner = await PluginExecutionPackage.open({
    activation: installed,
    commit: allowPreparedCommit,
  });
  assert.throws(
    () =>
      owner.acquire({
        purpose: "historicalOperation",
        authorizeBorrow: () => "deny",
      }),
    /plugin_borrow_denied/,
  );
  await owner.close();
});

test("does not silently borrow current foreign service dependencies", async (t) => {
  const installed = await executionPackage(t, {
    requires: [
      { service: "foreign.provider", apiVersion: "1", optional: false },
    ],
  });
  await assert.rejects(
    PluginExecutionPackage.open({
      activation: installed,
      commit: allowPreparedCommit,
    }),
    /plugin_dependency_unavailable/,
  );
  assert.equal((await installed.records()).includes("setup"), false);
});

test("rejects a package that never registers an execution factory and cleans its instance", async (t) => {
  const installed = await executionPackage(t, { setup: "" });
  await assert.rejects(
    PluginExecutionPackage.open({
      activation: installed,
      commit: allowPreparedCommit,
    }),
    /plugin_execution_factory_unavailable/,
  );
  assert.equal(
    (await installed.records()).filter((value) => value === "dispose").length,
    1,
  );
});

test("reverifies installed bytes on cold open before running package setup", async (t) => {
  const installed = await executionPackage(t);
  const path = join(
    installed.installRoot,
    "packages",
    installed.expectedPackageDigest.slice(7),
    "entry.mjs",
  );
  await chmod(path, 0o600);
  await writeFile(
    path,
    "throw new Error('tampered package must never execute');",
  );
  await assert.rejects(
    PluginExecutionPackage.open({
      activation: installed,
      commit: allowPreparedCommit,
    }),
  );
  assert.deepEqual(await installed.records(), []);
});
