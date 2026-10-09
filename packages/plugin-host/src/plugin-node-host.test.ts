import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginNodeHost } from "./plugin-node-host.ts";
import { verifyLocalPluginPackage } from "./local-plugin-package-verifier.ts";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";

type Requirement = { service: string; apiVersion: string; optional: boolean };
type Provision = { service: string; apiVersion: string };
async function fixture(
  t: test.TestContext,
  input: {
    pluginId?: string;
    version?: string;
    setup?: string;
    load?: string;
    requires?: Requirement[];
    provides?: Provision[];
    dispose?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-plugin-node-"));
  const installRoot = await mkdtemp(
    join(tmpdir(), "crewon-plugin-node-installed-"),
  );
  const log = join(
    tmpdir(),
    `crewon-plugin-node-${directory.split("/").at(-1)}.log`,
  );
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await removeInstalled(installRoot);
    await rm(log, { force: true });
  });
  const pluginId = input.pluginId ?? "example.story";
  const source = `import {appendFileSync} from 'node:fs';
const record = (text) => appendFileSync(${JSON.stringify(log)}, text+'\\n');
record('load'); ${input.load ?? ""}
export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(pluginId)},
setup(ctx){ record('setup'); ${input.setup ?? ""}
return {dispose(){record('dispose'); ${input.dispose ?? ""}}}; }};`;
  const bytes = Buffer.from(source);
  await writeFile(join(directory, "entry.mjs"), bytes);
  await writeFile(
    join(directory, "crewon.plugin.json"),
    JSON.stringify({
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId,
      version: input.version ?? "1.0.0",
      title: "Example",
      description: "Fixture",
      publisherId: "example",
      entrypoints: { node: "entry.mjs", ui: null },
      businessManifestPath: null,
      requires: input.requires ?? [],
      provides: input.provides ?? [],
      contributions: [],
      files: [
        {
          path: "entry.mjs",
          byteLength: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    }),
  );
  const verified = await verifyLocalPluginPackage({ directory });
  const installed = await installLocalPluginPackage({
    directory,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  return {
    directory: installed.directory,
    installRoot,
    expectedPluginId: pluginId,
    log,
    expectedPackageDigest: verified.packageDigest,
    authorizeActivation: () => "allow" as const,
    async records(): Promise<string[]> {
      try {
        return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
  };
}
async function removeInstalled(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await removeInstalled(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}
const borrow = (pluginId: string, packageDigest: string) => ({
  pluginId,
  packageDigest,
  purpose: "newOperation" as const,
  authorizeBorrow: () => "allow" as const,
});

test("actual ESM runtime resources reject new acquisition after withdrawal and preserve borrowed resources until release", async (t) => {
  const pkg = await fixture(t, {
    provides: [{ service: "story.result", apiVersion: "1" }],
    setup:
      "ctx.services.provide('story.result','1',{open:()=>ctx.resources.acquire(()=>({value:'runtime-resource',dispose(){record('resource-dispose')}}))});",
  });
  const host = new PluginNodeHost({ services: [] });
  const identity = await host.activate(pkg);
  const lease = host.acquire(borrow(identity.pluginId, identity.packageDigest));
  const service = lease.getService<{
    open(): Promise<{ value: string; dispose(): Promise<void> }>;
  }>("story.result", "1");
  const resource = await service.open();
  assert.equal(resource.value, "runtime-resource");
  host.deactivate(identity.pluginId);
  await host.drain();
  assert.equal((await pkg.records()).includes("resource-dispose"), false);
  await assert.rejects(service.open(), /plugin_resource_unavailable/);
  lease.release();
  await host.drain();
  assert.deepEqual(await pkg.records(), [
    "load",
    "setup",
    "resource-dispose",
    "dispose",
  ]);
  await host.close();
});

test("withdrawal during actual ESM setup aborts acquisition and cleans a late resource before rollback completes", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pkg = await fixture(t, {
    requires: [{ service: "host.gate", apiVersion: "1", optional: false }],
    setup:
      "return ctx.resources.acquire(async({signal})=>{await ctx.services.get('host.gate','1').wait(signal);return {value:1,dispose(){record('late-resource-dispose')}}}).then(()=>undefined);",
  });
  const host = new PluginNodeHost({
    services: [
      {
        service: "host.gate",
        apiVersion: "1",
        value: {
          wait(signal: AbortSignal) {
            entered();
            return new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        },
      },
    ],
  });
  const activation = host.activate(pkg);
  const rejected = assert.rejects(activation, /plugin_resource_withdrawn/);
  await started;
  host.deactivate(pkg.expectedPluginId);
  await rejected;
  assert.deepEqual(await pkg.records(), [
    "load",
    "setup",
    "late-resource-dispose",
  ]);
  assert.deepEqual(host.snapshot(), []);
  await host.close();
});

test("actual ESM resource cleanup failure retains the instance diagnostic fence", async (t) => {
  const pkg = await fixture(t, {
    provides: [{ service: "story.result", apiVersion: "1" }],
    setup:
      "ctx.services.provide('story.result','1',{open:()=>ctx.resources.acquire(()=>({value:1,dispose(){record('failed-resource-dispose');throw new Error('resource-close-failed')}}))});",
  });
  const host = new PluginNodeHost({ services: [] });
  const identity = await host.activate(pkg);
  const lease = host.acquire(borrow(identity.pluginId, identity.packageDigest));
  await lease
    .getService<{ open(): Promise<unknown> }>("story.result", "1")
    .open();
  host.deactivate(identity.pluginId);
  lease.release();
  await assert.rejects(host.drain(), /plugin_cleanup_failed/);
  assert.equal(host.snapshot()[0]?.phase, "cleanupFailed");
  await assert.rejects(host.close(), /plugin_cleanup_failed/);
  assert.equal(
    (await pkg.records()).filter(
      (record) => record === "failed-resource-dispose",
    ).length,
    1,
  );
});

test("activation denies missing dependencies and authority before evaluating entry code", async (t) => {
  const pkg = await fixture(t, {
    requires: [{ service: "host.config", apiVersion: "1", optional: false }],
  });
  const host = new PluginNodeHost({ services: [] });
  await assert.rejects(host.activate(pkg), {
    code: "plugin_dependency_unavailable",
  });
  await assert.rejects(
    host.activate({ ...pkg, authorizeActivation: () => "deny" }),
    { code: "plugin_activation_denied" },
  );
  await assert.rejects(
    host.activate({
      ...pkg,
      expectedPackageDigest: `sha256:${"0".repeat(64)}`,
    }),
    { code: "plugin_package_filesystem_unavailable" },
  );
  assert.deepEqual(await pkg.records(), []);
  assert.deepEqual(host.snapshot(), []);
  await host.close();
});

test("actual ESM setup publishes only declared versioned services and cleanup waits for leases", async (t) => {
  const pkg = await fixture(t, {
    requires: [{ service: "host.config", apiVersion: "1", optional: false }],
    provides: [{ service: "story.result", apiVersion: "1" }],
    setup:
      "const config=ctx.services.get('host.config','1'); ctx.onDispose(()=>record('onDispose')); ctx.services.provide('story.result','1',{read:()=>config.value});",
  });
  const host = new PluginNodeHost({
    services: [
      { service: "host.config", apiVersion: "1", value: { value: "current" } },
    ],
  });
  const identity = await host.activate(pkg);
  const lease = host.acquire(borrow(identity.pluginId, identity.packageDigest));
  assert.equal(
    lease.getService<{ read(): string }>("story.result", "1").read(),
    "current",
  );
  host.deactivate(identity.pluginId);
  assert.throws(
    () => host.acquire(borrow(identity.pluginId, identity.packageDigest)),
    { code: "plugin_instance_unavailable" },
  );
  await host.drain();
  assert.deepEqual(await pkg.records(), ["load", "setup"]);
  assert.equal(
    lease.getService<{ read(): string }>("story.result", "1").read(),
    "current",
  );
  lease.release();
  lease.release();
  await host.drain();
  assert.deepEqual(await pkg.records(), [
    "load",
    "setup",
    "dispose",
    "onDispose",
  ]);
  assert.throws(() => lease.getService("story.result", "1"), {
    code: "plugin_lease_released",
  });
  await host.close();
});

test("failed setup rolls back staged services and runs all registered cleanup in reverse order", async (t) => {
  const pkg = await fixture(t, {
    provides: [{ service: "story.result", apiVersion: "1" }],
    setup:
      "ctx.onDispose(()=>record('first')); ctx.onDispose(()=>record('second')); ctx.services.provide('story.result','1',{}); throw new Error('broken setup');",
  });
  const host = new PluginNodeHost({ services: [] });
  await assert.rejects(host.activate(pkg), /broken setup/);
  assert.deepEqual(await pkg.records(), ["load", "setup", "second", "first"]);
  assert.deepEqual(host.snapshot(), []);
  const consumer = await fixture(t, {
    pluginId: "example.consumer",
    requires: [{ service: "story.result", apiVersion: "1", optional: false }],
  });
  await assert.rejects(host.activate(consumer), {
    code: "plugin_dependency_unavailable",
  });
  assert.deepEqual(await consumer.records(), []);
  await host.close();
});

test("upgrade selects the new version while leases retain the previous implementation", async (t) => {
  const make = (version: string) =>
    fixture(t, {
      version,
      provides: [{ service: "story.result", apiVersion: "1" }],
      setup: `ctx.services.provide('story.result','1',{read:()=>${JSON.stringify(version)}});`,
    });
  const old = await make("1.0.0");
  const next = await make("2.0.0");
  const host = new PluginNodeHost({ services: [] });
  const oldIdentity = await host.activate(old);
  const oldLease = host.acquire(
    borrow(oldIdentity.pluginId, oldIdentity.packageDigest),
  );
  const nextIdentity = await host.activate(next);
  const nextLease = host.acquire(
    borrow(nextIdentity.pluginId, nextIdentity.packageDigest),
  );
  assert.equal(
    oldLease.getService<{ read(): string }>("story.result", "1").read(),
    "1.0.0",
  );
  assert.equal(
    nextLease.getService<{ read(): string }>("story.result", "1").read(),
    "2.0.0",
  );
  assert.throws(
    () => host.acquire(borrow(oldIdentity.pluginId, oldIdentity.packageDigest)),
    { code: "plugin_instance_unavailable" },
  );
  assert.deepEqual(await old.records(), ["load", "setup"]);
  oldLease.release();
  await host.drain();
  assert.deepEqual(await old.records(), ["load", "setup", "dispose"]);
  nextLease.release();
  await host.close();
});

test("a failed upgrade leaves the currently selected service untouched", async (t) => {
  const old = await fixture(t, {
    provides: [{ service: "story.result", apiVersion: "1" }],
    setup: "ctx.services.provide('story.result','1',{read:()=>1});",
  });
  const next = await fixture(t, {
    version: "2.0.0",
    provides: [{ service: "story.result", apiVersion: "1" }],
    setup: "throw new Error('upgrade failed');",
  });
  const host = new PluginNodeHost({ services: [] });
  const identity = await host.activate(old);
  await assert.rejects(host.activate(next), /upgrade failed/);
  const lease = host.acquire(borrow(identity.pluginId, identity.packageDigest));
  assert.equal(
    lease.getService<{ read(): number }>("story.result", "1").read(),
    1,
  );
  lease.release();
  await host.close();
});

test("withdrawing a dependency stops consumers and retires providers after consumer cleanup", async (t) => {
  const provider = await fixture(t, {
    provides: [{ service: "story.result", apiVersion: "1" }],
    setup: "ctx.services.provide('story.result','1',{read:()=>1});",
  });
  const consumer = await fixture(t, {
    pluginId: "example.consumer",
    requires: [{ service: "story.result", apiVersion: "1", optional: false }],
    provides: [{ service: "consumer.result", apiVersion: "1" }],
    setup:
      "const v=ctx.services.get('story.result','1'); ctx.services.provide('consumer.result','1',v);",
  });
  const host = new PluginNodeHost({ services: [] });
  const p = await host.activate(provider);
  const c = await host.activate(consumer);
  const lease = host.acquire(borrow(c.pluginId, c.packageDigest));
  host.deactivate(p.pluginId);
  assert.throws(() => host.acquire(borrow(c.pluginId, c.packageDigest)), {
    code: "plugin_instance_unavailable",
  });
  await host.drain();
  assert.deepEqual(await provider.records(), ["load", "setup"]);
  assert.deepEqual(await consumer.records(), ["load", "setup"]);
  lease.release();
  await host.drain();
  assert.deepEqual(await consumer.records(), ["load", "setup", "dispose"]);
  assert.deepEqual(await provider.records(), ["load", "setup", "dispose"]);
  await host.close();
});

test("undeclared dependencies, missing provisions and version mismatches fail closed", async (t) => {
  const host = new PluginNodeHost({
    services: [{ service: "host.config", apiVersion: "2", value: {} }],
  });
  const missing = await fixture(t, {
    provides: [{ service: "story.result", apiVersion: "1" }],
  });
  await assert.rejects(host.activate(missing), {
    code: "plugin_service_provision_missing",
  });
  assert.deepEqual(await missing.records(), ["load", "setup", "dispose"]);
  const undeclared = await fixture(t, {
    setup: "ctx.services.get('host.config','2');",
  });
  await assert.rejects(host.activate(undeclared), {
    code: "plugin_dependency_undeclared",
  });
  const wrongVersion = await fixture(t, {
    requires: [{ service: "host.config", apiVersion: "1", optional: false }],
  });
  await assert.rejects(host.activate(wrongVersion), {
    code: "plugin_dependency_unavailable",
  });
  assert.deepEqual(await wrongVersion.records(), []);
  await host.close();
});

test("cleanup failure preserves a diagnostic fence instead of claiming disposal", async (t) => {
  const pkg = await fixture(t, {
    setup: "ctx.onDispose(()=>record('still cleaned'));",
    dispose: "throw new Error('cannot dispose');",
  });
  const host = new PluginNodeHost({ services: [] });
  const identity = await host.activate(pkg);
  host.deactivate(identity.pluginId);
  await assert.rejects(host.drain(), /plugin_cleanup_failed/);
  assert.deepEqual(await pkg.records(), [
    "load",
    "setup",
    "dispose",
    "still cleaned",
  ]);
  assert.equal(host.snapshot()[0]?.phase, "cleanupFailed");
  assert.throws(
    () => host.acquire(borrow(identity.pluginId, identity.packageDigest)),
    { code: "plugin_instance_unavailable" },
  );
});

test("borrow authorization cannot admit an instance it revoked and close reports live leases", async (t) => {
  const pkg = await fixture(t);
  const host = new PluginNodeHost({ services: [] });
  const identity = await host.activate(pkg);
  const lease = host.acquire(borrow(identity.pluginId, identity.packageDigest));
  assert.throws(
    () =>
      host.acquire({
        ...borrow(identity.pluginId, identity.packageDigest),
        authorizeBorrow: () => {
          host.deactivate(identity.pluginId);
          return "allow";
        },
      }),
    { code: "plugin_instance_unavailable" },
  );
  await assert.rejects(host.close(), { code: "plugin_host_has_live_leases" });
  assert.deepEqual(await pkg.records(), ["load", "setup"]);
  lease.release();
  await host.close();
  assert.deepEqual(await pkg.records(), ["load", "setup", "dispose"]);
});

test("deactivation cancels starting and queued activations without publishing their services", async (t) => {
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pkg = await fixture(t, {
    requires: [{ service: "host.gate", apiVersion: "1", optional: false }],
    provides: [{ service: "story.result", apiVersion: "1" }],
    setup:
      "return (async()=>{ctx.onDispose(()=>record('cleanup')); await ctx.services.get('host.gate','1').wait(); ctx.services.provide('story.result','1',{read:()=>1}); return {dispose(){record('dispose');}};})();",
  });
  const host = new PluginNodeHost({
    services: [
      {
        service: "host.gate",
        apiVersion: "1",
        value: {
          wait() {
            started();
            return gate;
          },
        },
      },
    ],
  });
  const first = host.activate(pkg);
  const firstRejected = assert.rejects(first, {
    code: "plugin_activation_canceled",
  });
  await entered;
  const queued = host.activate(pkg);
  const queuedRejected = assert.rejects(queued, {
    code: "plugin_activation_canceled",
  });
  host.deactivate(pkg.expectedPluginId);
  finish();
  await Promise.all([firstRejected, queuedRejected]);
  assert.deepEqual(host.snapshot(), []);
  assert.deepEqual(await pkg.records(), [
    "load",
    "setup",
    "dispose",
    "cleanup",
  ]);
  const identity = await host.activate(pkg); // An explicit later activation is a new intent.
  const lease = host.acquire(borrow(identity.pluginId, identity.packageDigest));
  assert.equal(
    lease.getService<{ read(): number }>("story.result", "1").read(),
    1,
  );
  lease.release();
  await host.close();
});

test("upgrade rejects a dependency chain that would be withdrawn with the previous version", async (t) => {
  const provider = await fixture(t, {
    provides: [{ service: "story.result", apiVersion: "1" }],
    setup: "ctx.services.provide('story.result','1',{read:()=>1});",
  });
  const consumer = await fixture(t, {
    pluginId: "example.consumer",
    requires: [{ service: "story.result", apiVersion: "1", optional: false }],
    provides: [{ service: "consumer.result", apiVersion: "1" }],
    setup:
      "ctx.services.provide('consumer.result','1',ctx.services.get('story.result','1'));",
  });
  const upgrade = await fixture(t, {
    version: "2.0.0",
    requires: [
      { service: "consumer.result", apiVersion: "1", optional: false },
    ],
    provides: [{ service: "story.result", apiVersion: "1" }],
    setup:
      "ctx.services.provide('story.result','1',ctx.services.get('consumer.result','1'));",
  });
  const host = new PluginNodeHost({ services: [] });
  const p = await host.activate(provider);
  const c = await host.activate(consumer);
  await assert.rejects(host.activate(upgrade), {
    code: "plugin_dependency_upgrade_cycle",
  });
  assert.deepEqual(await upgrade.records(), []); // The incompatible package was never evaluated.
  const lease = host.acquire(borrow(c.pluginId, c.packageDigest));
  assert.equal(
    lease.getService<{ read(): number }>("consumer.result", "1").read(),
    1,
  );
  assert.equal(
    host.snapshot().find(({ identity }) => identity.pluginId === p.pluginId)
      ?.phase,
    "accepting",
  );
  lease.release();
  await host.close();
});

test("repeated activation does not restart the selected instance and service withdrawal preserves earlier leases", async (t) => {
  const pkg = await fixture(t, {
    provides: [{ service: "story.result", apiVersion: "1" }],
    setup:
      "let registration; registration=ctx.services.provide('story.result','1',{read:()=>1,withdraw:()=>registration.dispose()});",
  });
  const host = new PluginNodeHost({ services: [] });
  const identity = await host.activate(pkg);
  assert.deepEqual(await host.activate(pkg), identity);
  assert.deepEqual(await pkg.records(), ["load", "setup"]);
  const existing = host.acquire(
    borrow(identity.pluginId, identity.packageDigest),
  );
  existing.getService<{ withdraw(): void }>("story.result", "1").withdraw();
  assert.equal(
    existing.getService<{ read(): number }>("story.result", "1").read(),
    1,
  );
  const later = host.acquire(borrow(identity.pluginId, identity.packageDigest));
  assert.throws(() => later.getService("story.result", "1"), {
    code: "plugin_service_unavailable",
  });
  existing.release();
  later.release();
  await host.close();
});

test("loading is restricted to installed content-addressed versions and the expected package identity", async (t) => {
  const pkg = await fixture(t);
  const host = new PluginNodeHost({ services: [] });
  await assert.rejects(host.activate({ ...pkg, installRoot: pkg.directory }), {
    code: "plugin_package_filesystem_unavailable",
  });
  await assert.rejects(
    host.activate({ ...pkg, expectedPluginId: "example.wrong" }),
    { code: "plugin_node_identity_mismatch" },
  );
  assert.deepEqual(await pkg.records(), []);
  await host.close();
});

test("dependency reconciliation with fresh commit authority preserves old borrowed values and does not restart unrelated plugins", async (t) => {
  const provider1 = await fixture(t, {
    pluginId: "example.provider",
    version: "1.0.0",
    provides: [{ service: "story.source", apiVersion: "1" }],
    setup: "ctx.services.provide('story.source','1',{read:()=>1});",
  });
  const provider2 = await fixture(t, {
    pluginId: "example.provider",
    version: "2.0.0",
    provides: [{ service: "story.source", apiVersion: "1" }],
    setup: "ctx.services.provide('story.source','1',{read:()=>2});",
  });
  const consumer = await fixture(t, {
    pluginId: "example.consumer",
    requires: [{ service: "story.source", apiVersion: "1", optional: false }],
    provides: [{ service: "story.result", apiVersion: "1" }],
    setup:
      "const source=ctx.services.get('story.source','1');ctx.services.provide('story.result','1',{read:()=>source.read()});",
  });
  const unrelated = await fixture(t, { pluginId: "example.unrelated" });
  const host = new PluginNodeHost({ services: [] });
  const p1 = await host.activate(provider1);
  const c1 = await host.activate(consumer);
  await host.activate(unrelated);
  const original = host.acquire(borrow(c1.pluginId, c1.packageDigest));
  const old = original.getService<{ read(): number }>("story.result", "1");
  assert.equal(old.read(), 1);
  host.deactivate(c1.pluginId);
  const replacement = await host.prepare(provider2);
  replacement.commit({
    authorizeCommit: (candidate) =>
      candidate.previousIdentity?.packageDigest === p1.packageDigest
        ? "allow"
        : "deny",
  });
  assert.equal(old.read(), 1);
  assert.equal(
    host
      .snapshot()
      .find((entry) => entry.identity.packageDigest === p1.packageDigest)
      ?.phase,
    "retained",
  );
  const denied = await host.prepare(consumer);
  assert.throws(() => denied.commit({ authorizeCommit: () => "deny" }), {
    code: "plugin_commit_denied",
  });
  await denied.abort();
  assert.throws(() => host.acquire(borrow(c1.pluginId, c1.packageDigest)), {
    code: "plugin_instance_unavailable",
  });
  const restored = await host.prepare(consumer);
  assert.equal(
    restored.dependencyIdentities[0]?.provider?.packageDigest,
    replacement.identity.packageDigest,
  );
  restored.commit({
    authorizeCommit: (candidate) =>
      candidate.dependencyIdentities[0]?.provider?.packageDigest ===
      replacement.identity.packageDigest
        ? "allow"
        : "deny",
  });
  const current = host.acquire(
    borrow(restored.identity.pluginId, restored.identity.packageDigest),
  );
  assert.equal(
    current.getService<{ read(): number }>("story.result", "1").read(),
    2,
  );
  assert.equal(old.read(), 1);
  assert.deepEqual(await unrelated.records(), ["load", "setup"]);
  original.release();
  await host.drain();
  assert.equal(
    host
      .snapshot()
      .some((entry) => entry.identity.packageDigest === p1.packageDigest),
    false,
  );
  assert.equal(
    current.getService<{ read(): number }>("story.result", "1").read(),
    2,
  );
  current.release();
  await host.close();
});
