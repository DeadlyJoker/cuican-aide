import assert from "node:assert/strict";
import test from "node:test";
import {
  PluginNodeHost,
  type PluginNodePreparedCommit,
} from "./plugin-node-host.ts";
import {
  allowPreparedCommit,
  preparedBorrow,
  preparedPackage,
} from "./plugin-node-preparation.test-support.ts";

const resultProvision = [{ service: "story.result", apiVersion: "1" }];
const resultRequirement = [
  { service: "story.result", apiVersion: "1", optional: false },
];
const resultSetup = (value: number) =>
  `ctx.services.provide('story.result','1',{read:()=>${value}});`;

test("prepare stages actual setup while synchronous authorized commit preserves old selection until publication", async (t) => {
  let disposed = 0;
  const observer = {
    mark: () => {
      disposed += 1;
    },
  };
  const first = await preparedPackage(t, {
    provides: resultProvision,
    requires: [{ service: "host.observe", apiVersion: "1", optional: false }],
    setup: `${resultSetup(1)}ctx.onDispose(()=>ctx.services.get('host.observe','1').mark());`,
  });
  const next = await preparedPackage(t, {
    version: "2.0.0",
    provides: resultProvision,
    setup: resultSetup(2),
  });
  const host = new PluginNodeHost({
    services: [{ service: "host.observe", apiVersion: "1", value: observer }],
  });
  const old = await host.activate(first);
  const prepared = await host.prepare(next);
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared.identity));
  assert.ok(Object.isFrozen(prepared.dependencyIdentities));
  assert.deepEqual(await next.records(), ["load", "setup"]);
  assert.throws(
    () =>
      host.acquire(
        preparedBorrow(
          prepared.identity.pluginId,
          prepared.identity.packageDigest,
        ),
      ),
    { code: "plugin_instance_unavailable" },
  );
  const oldLease = host.acquire(
    preparedBorrow(old.pluginId, old.packageDigest),
  );
  assert.equal(
    oldLease.getService<{ read(): number }>("story.result", "1").read(),
    1,
  );
  oldLease.release();
  let calls = 0;
  const selected = prepared.commit({
    authorizeCommit(candidate) {
      calls += 1;
      assert.deepEqual(candidate.previousIdentity, old);
      assert.deepEqual(candidate.identity, prepared.identity);
      assert.ok(Object.isFrozen(candidate));
      return "allow";
    },
  });
  assert.equal(calls, 1);
  assert.equal(disposed, 0); // No plugin callback ran inside synchronous publication.
  const lease = host.acquire(
    preparedBorrow(selected.pluginId, selected.packageDigest),
  );
  assert.equal(
    lease.getService<{ read(): number }>("story.result", "1").read(),
    2,
  );
  lease.release();
  await prepared.abort(); // A committed handle cannot dispose the published instance.
  await host.drain();
  assert.equal(disposed, 1);
  assert.deepEqual(await first.records(), ["load", "setup", "dispose"]);
  assert.deepEqual(await next.records(), ["load", "setup"]);
  await host.close();
});

test("abort is idempotent, withdraws only its candidate, and releases exact provider borrows", async (t) => {
  const provider = await preparedPackage(t, {
    provides: resultProvision,
    setup: resultSetup(1),
  });
  const consumer = await preparedPackage(t, {
    pluginId: "example.consumer",
    requires: resultRequirement,
  });
  const host = new PluginNodeHost({ services: [] });
  const identity = await host.activate(provider);
  const first = await host.prepare(consumer);
  const second = await host.prepare(consumer);
  assert.deepEqual(first.dependencyIdentities, [
    { service: "story.result", apiVersion: "1", provider: identity },
  ]);
  assert.ok(Object.isFrozen(first.dependencyIdentities[0]));
  assert.equal(
    host
      .snapshot()
      .find(({ identity: item }) => item.pluginId === identity.pluginId)
      ?.borrowers,
    2,
  );
  const abort = first.abort();
  assert.equal(first.abort(), abort);
  await abort;
  assert.equal(
    host
      .snapshot()
      .find(({ identity: item }) => item.pluginId === identity.pluginId)
      ?.borrowers,
    1,
  );
  assert.throws(() => first.commit(allowPreparedCommit), {
    code: "plugin_preparation_not_available",
  });
  second.commit(allowPreparedCommit);
  assert.deepEqual(await consumer.records(), [
    "load",
    "setup",
    "setup",
    "dispose",
  ]);
  await host.close();
  assert.deepEqual(host.snapshot(), []);
});

test("commit requires explicit synchronous authority and cleans denied candidates without changing current", async (t) => {
  const first = await preparedPackage(t);
  const host = new PluginNodeHost({ services: [] });
  const old = await host.activate(first);
  for (const authorizeCommit of [
    undefined,
    () => "deny",
    async () => "allow",
    () => {
      throw new Error("fence read failed");
    },
  ]) {
    const next = await preparedPackage(t, { version: "2.0.0" });
    const prepared = await host.prepare(next);
    assert.throws(
      () => prepared.commit({ authorizeCommit } as PluginNodePreparedCommit),
      authorizeCommit?.toString().includes("fence read failed")
        ? /fence read failed/
        : { code: "plugin_commit_denied" },
    );
    await prepared.abort();
    assert.deepEqual(await next.records(), ["load", "setup", "dispose"]);
    const lease = host.acquire(preparedBorrow(old.pluginId, old.packageDigest));
    lease.release();
  }
  assert.deepEqual(await first.records(), ["load", "setup"]);
  await host.close();
});

test("commit rechecks revocation and closure after host authority reenters", async (t) => {
  for (const action of ["deactivate", "close"] as const) {
    const pkg = await preparedPackage(t);
    const host = new PluginNodeHost({ services: [] });
    const prepared = await host.prepare(pkg);
    let closing: Promise<void> | undefined;
    assert.throws(
      () =>
        prepared.commit({
          authorizeCommit: () => {
            if (action === "deactivate") host.deactivate(pkg.expectedPluginId);
            else closing = host.close();
            return "allow";
          },
        }),
      {
        code:
          action === "close"
            ? "plugin_host_closed"
            : "plugin_activation_canceled",
      },
    );
    await prepared.abort();
    if (closing) await closing;
    else await host.close();
    assert.deepEqual(await pkg.records(), ["load", "setup", "dispose"]);
    assert.deepEqual(host.snapshot(), []);
  }
});

test("dependency object identity is checked before and after authority even with unchanged service version", async (t) => {
  const provider = await preparedPackage(t, {
    provides: resultProvision,
    setup: resultSetup(1),
  });
  const providerNext = await preparedPackage(t, {
    version: "2.0.0",
    provides: resultProvision,
    setup: resultSetup(1),
  });
  const consumer = await preparedPackage(t, {
    pluginId: "example.consumer",
    requires: resultRequirement,
  });
  const host = new PluginNodeHost({ services: [] });
  await host.activate(provider);
  const stale = await host.prepare(consumer);
  await host.activate(providerNext);
  let invoked = false;
  assert.throws(
    () =>
      stale.commit({
        authorizeCommit: () => {
          invoked = true;
          return "allow";
        },
      }),
    { code: "plugin_dependency_changed_during_activation" },
  );
  assert.equal(invoked, false);
  await stale.abort();
  const fresh = await host.prepare(consumer);
  const providerLease = host.acquire(
    preparedBorrow(
      providerNext.expectedPluginId,
      providerNext.expectedPackageDigest,
    ),
  );
  // Withdrawing a provider registration inside authority invalidates the exact dependency.
  const withdrawable = await preparedPackage(t, {
    pluginId: "example.withdrawable",
    provides: [{ service: "host.withdrawable", apiVersion: "1" }],
    setup:
      "let registration;registration=ctx.services.provide('host.withdrawable','1',{withdraw:()=>registration.dispose()});",
  });
  const client = await preparedPackage(t, {
    pluginId: "example.client",
    requires: [
      { service: "host.withdrawable", apiVersion: "1", optional: false },
    ],
  });
  const w = await host.activate(withdrawable);
  const candidate = await host.prepare(client);
  const wLease = host.acquire(preparedBorrow(w.pluginId, w.packageDigest));
  assert.throws(
    () =>
      candidate.commit({
        authorizeCommit: () => {
          wLease
            .getService<{ withdraw(): void }>("host.withdrawable", "1")
            .withdraw();
          return "allow";
        },
      }),
    { code: "plugin_dependency_changed_during_activation" },
  );
  await candidate.abort();
  await fresh.abort();
  providerLease.release();
  wLease.release();
  await host.close();
});

test("optional dependency availability is captured rather than silently changing at commit", async (t) => {
  const consumer = await preparedPackage(t, {
    pluginId: "example.consumer",
    requires: [{ service: "story.result", apiVersion: "1", optional: true }],
  });
  const provider = await preparedPackage(t, {
    provides: resultProvision,
    setup: resultSetup(1),
  });
  const host = new PluginNodeHost({ services: [] });
  const prepared = await host.prepare(consumer);
  assert.deepEqual(prepared.dependencyIdentities, []);
  await host.activate(provider);
  assert.throws(() => prepared.commit(allowPreparedCommit), {
    code: "plugin_dependency_changed_during_activation",
  });
  await prepared.abort();
  await host.close();
});

test("competing prepared commits and reentrant publication cannot overwrite a newer current", async (t) => {
  const first = await preparedPackage(t, { version: "1.0.0" });
  const second = await preparedPackage(t, { version: "2.0.0" });
  const host = new PluginNodeHost({ services: [] });
  const p1 = await host.prepare(first);
  const p2 = await host.prepare(second);
  assert.throws(
    () =>
      p1.commit({
        authorizeCommit: () => {
          p2.commit(allowPreparedCommit);
          return "allow";
        },
      }),
    { code: "plugin_current_changed_during_preparation" },
  );
  await p1.abort();
  assert.throws(() => p2.commit(allowPreparedCommit), {
    code: "plugin_preparation_not_available",
  });
  const lease = host.acquire(
    preparedBorrow(p2.identity.pluginId, p2.identity.packageDigest),
  );
  lease.release();
  assert.deepEqual(await first.records(), ["load", "setup", "dispose"]);
  assert.deepEqual(await second.records(), ["load", "setup"]);
  await host.close();
});

test("same-current preparation never owns or withdraws the current instance", async (t) => {
  const first = await preparedPackage(t);
  const next = await preparedPackage(t, { version: "2.0.0" });
  const host = new PluginNodeHost({ services: [] });
  const old = await host.activate(first);
  const cancelled = await host.prepare(first);
  await cancelled.abort();
  const noop = await host.prepare(first);
  let calls = 0;
  assert.equal(
    noop.commit({
      authorizeCommit: () => {
        calls += 1;
        return "allow";
      },
    }),
    old,
  );
  assert.equal(calls, 1);
  const stale = await host.prepare(first);
  const selected = await host.activate(next);
  assert.throws(() => stale.commit(allowPreparedCommit), {
    code: "plugin_current_changed_during_preparation",
  });
  await stale.abort();
  const lease = host.acquire(
    preparedBorrow(selected.pluginId, selected.packageDigest),
  );
  lease.release();
  assert.deepEqual(await next.records(), ["load", "setup"]);
  await host.close();
  assert.deepEqual(await first.records(), ["load", "setup", "dispose"]);
});

test("provider upgrades reject active consumers before entry evaluation and recheck newly active consumers at commit", async (t) => {
  const provider = await preparedPackage(t, {
    provides: resultProvision,
    setup: resultSetup(1),
  });
  const next = await preparedPackage(t, {
    version: "2.0.0",
    provides: resultProvision,
    setup: resultSetup(2),
  });
  const consumer = await preparedPackage(t, {
    pluginId: "example.consumer",
    requires: resultRequirement,
  });
  const host = new PluginNodeHost({ services: [] });
  const p = await host.activate(provider);
  const stagedUpgrade = await host.prepare(next);
  const c = await host.activate(consumer);
  assert.throws(() => stagedUpgrade.commit(allowPreparedCommit), {
    code: "plugin_dependency_upgrade_unsupported",
  });
  await stagedUpgrade.abort();
  const later = await preparedPackage(t, {
    version: "3.0.0",
    provides: resultProvision,
    setup: resultSetup(3),
  });
  await assert.rejects(host.prepare(later), {
    code: "plugin_dependency_upgrade_unsupported",
  });
  assert.deepEqual(await later.records(), []);
  const oldLease = host.acquire(preparedBorrow(p.pluginId, p.packageDigest));
  const consumerLease = host.acquire(
    preparedBorrow(c.pluginId, c.packageDigest),
  );
  host.deactivate(c.pluginId);
  await host.activate(later); // Historical borrowers retain the old provider; no active consumer is withdrawn.
  assert.equal(
    oldLease.getService<{ read(): number }>("story.result", "1").read(),
    1,
  );
  consumerLease.release();
  oldLease.release();
  await host.close();
});

test("deactivate and close revoke all prepared candidates, while pending handles consume the bounded quota", async (t) => {
  const pkg = await preparedPackage(t);
  const host = new PluginNodeHost({ services: [] });
  await host.activate(pkg);
  const handles = await Promise.all(
    Array.from({ length: 64 }, () => host.prepare(pkg)),
  );
  await assert.rejects(host.prepare(pkg), {
    code: "plugin_host_activation_limit",
  });
  await handles[0]!.abort();
  const replacement = await host.prepare(pkg);
  host.deactivate(pkg.expectedPluginId);
  for (const handle of [...handles.slice(1), replacement]) {
    assert.throws(() => handle.commit(allowPreparedCommit), {
      code: "plugin_preparation_not_available",
    });
    await handle.abort();
  }
  await host.drain();
  const prepared = await host.prepare(pkg);
  await host.close();
  assert.throws(() => prepared.commit(allowPreparedCommit), {
    code: "plugin_preparation_not_available",
  });
  await prepared.abort();
  assert.deepEqual(host.snapshot(), []);
});

test("aborted cleanup failures retain dependency leases and count toward the bounded instance ceiling", async (t) => {
  const pkg = await preparedPackage(t, {
    dispose: "throw new Error('cleanup refused');",
  });
  const host = new PluginNodeHost({ services: [] });
  for (let index = 0; index < 256; index += 1) {
    const prepared = await host.prepare(pkg);
    await assert.rejects(prepared.abort(), /plugin_cleanup_failed/);
    assert.equal(prepared.abort(), prepared.abort());
  }
  assert.equal(host.snapshot().length, 256);
  assert.ok(host.snapshot().every(({ phase }) => phase === "cleanupFailed"));
  await assert.rejects(host.prepare(pkg), {
    code: "plugin_host_instance_limit",
  });
  await assert.rejects(host.close(), /plugin_cleanup_failed/);
  const provider = await preparedPackage(t, {
    provides: resultProvision,
    setup: resultSetup(1),
  });
  const consumer = await preparedPackage(t, {
    pluginId: "example.consumer",
    requires: resultRequirement,
    dispose: "throw new Error('cleanup refused');",
  });
  const borrowedHost = new PluginNodeHost({ services: [] });
  const p = await borrowedHost.activate(provider);
  const prepared = await borrowedHost.prepare(consumer);
  await assert.rejects(prepared.abort(), /plugin_cleanup_failed/);
  assert.equal(
    borrowedHost
      .snapshot()
      .find(({ identity }) => identity.pluginId === p.pluginId)?.borrowers,
    1,
  );
  borrowedHost.deactivate(p.pluginId);
  await assert.rejects(borrowedHost.close(), /plugin_cleanup_failed/);
  assert.deepEqual(await provider.records(), ["load", "setup"]);
});

test("withdrawing a staged provision invalidates its candidate instead of publishing the disposed registration", async (t) => {
  let withdraw!: () => void;
  const pkg = await preparedPackage(t, {
    requires: [
      { service: "host.registration", apiVersion: "1", optional: false },
    ],
    provides: resultProvision,
    setup:
      "const registration=ctx.services.provide('story.result','1',{read:()=>1});ctx.services.get('host.registration','1').capture(()=>registration.dispose());",
  });
  const host = new PluginNodeHost({
    services: [
      {
        service: "host.registration",
        apiVersion: "1",
        value: {
          capture: (callback: () => void) => {
            withdraw = callback;
          },
        },
      },
    ],
  });
  const prepared = await host.prepare(pkg);
  withdraw();
  assert.throws(() => prepared.commit(allowPreparedCommit), {
    code: "plugin_service_provision_missing",
  });
  await prepared.abort();
  await host.close();
});

test("abort waits only for its own candidate, and callback detachment precedes the captured-current check", async (t) => {
  let finish!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const slow = await preparedPackage(t, {
    pluginId: "example.slow",
    requires: [{ service: "host.cleanup", apiVersion: "1", optional: false }],
    setup: "ctx.onDispose(()=>ctx.services.get('host.cleanup','1').wait());",
  });
  const first = await preparedPackage(t);
  const next = await preparedPackage(t, { version: "2.0.0" });
  const host = new PluginNodeHost({
    services: [
      {
        service: "host.cleanup",
        apiVersion: "1",
        value: {
          wait: () => {
            entered();
            return gate;
          },
        },
      },
    ],
  });
  const slowCandidate = await host.prepare(slow);
  const fastCandidate = await host.prepare(first);
  const slowAbort = slowCandidate.abort();
  await started;
  try {
    await fastCandidate.abort(); // Must complete while the unrelated gate remains closed.
    const stale = await host.prepare(first);
    const newer = await host.prepare(next);
    let called = false;
    const input = Object.defineProperty({}, "authorizeCommit", {
      get() {
        newer.commit(allowPreparedCommit);
        return () => {
          called = true;
          return "allow";
        };
      },
    }) as PluginNodePreparedCommit;
    assert.throws(() => stale.commit(input), {
      code: "plugin_current_changed_during_preparation",
    });
    assert.equal(called, false);
    await stale.abort();
  } finally {
    finish();
    await slowAbort;
    await host.close();
  }
});
