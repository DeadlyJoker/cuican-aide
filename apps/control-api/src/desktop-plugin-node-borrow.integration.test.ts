import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  actor,
  scope,
  fixture,
  enableStandard,
} from "./desktop-plugin-instance-composition.test-support.ts";

test("the original installation profile lends the actual shared provider without another setup", async (t) => {
  const f = await fixture(t);
  await f.open("installation");
  await enableStandard(f);
  const runtime = f.runtime;
  assert.ok("service" in runtime);
  const source = f.source("provider");
  const events = [...f.probe.events];
  const lease = runtime.borrowNode({
    actor,
    scope,
    pluginId: source.pluginId,
    packageDigest: source.packageDigest,
    authorizeBorrow: () => "allow",
  });
  try {
    assert.equal(
      lease.lease.getService("test.instance-source", "1"),
      f.probe.consumers[0]!.provider,
    );
    assert.equal(lease.lease.identity.packageDigest, source.packageDigest);
    assert.deepEqual(f.probe.events, events);
  } finally {
    lease.release();
  }
});

test("private Node borrowing works with a mixed UI graph and rejects foreign scope, actor, package and authorization", async (t) => {
  const f = await fixture(t, [
    { id: "provider", kind: "provider" },
    { id: "ui", kind: "ui" },
  ]);
  await f.open("installation");
  for (const source of f.sources) {
    await f.install(source);
    await f.select(source, 1);
  }
  const runtime = f.runtime;
  assert.ok("service" in runtime);
  const provider = f.source("provider");
  const input = {
    actor,
    scope,
    pluginId: provider.pluginId,
    packageDigest: provider.packageDigest,
    authorizeBorrow: () => "allow" as const,
  };
  const lease = runtime.borrowNode(input);
  lease.release();
  const events = [...f.probe.events];
  for (const altered of [
    { ...input, scope: { ...scope, profileId: "other-profile" } },
    { ...input, actor: { ...actor, principalId: "other-user" } },
    { ...input, packageDigest: `sha256:${"0".repeat(64)}` },
    { ...input, authorizeBorrow: () => "deny" as const },
    {
      ...input,
      pluginId: f.source("ui").pluginId,
      packageDigest: f.source("ui").packageDigest,
    },
  ])
    assert.throws(() => runtime.borrowNode(altered));
  assert.deepEqual(f.probe.events, events);
  const unchanged = runtime.borrowNode(input);
  unchanged.release();
});

test("cold borrowing and original selection receipt replay never initialize an instance", async (t) => {
  const f = await fixture(t, [{ id: "provider", kind: "provider" }]);
  await f.open("installation");
  const provider = f.source("provider");
  await f.install(provider);
  await f.select(provider, 1, "enabled", "original-provider-selection");
  await f.close();
  const events = [...f.probe.events];
  await f.open("installation");
  const runtime = f.runtime;
  assert.ok("service" in runtime);
  const borrow = () =>
    runtime.borrowNode({
      actor,
      scope,
      pluginId: provider.pluginId,
      packageDigest: provider.packageDigest,
      authorizeBorrow: () => "allow",
    });
  assert.throws(borrow, /plugin_composition_node_unobserved/u);
  const replay = await f.select(
    provider,
    1,
    "enabled",
    "original-provider-selection",
  );
  assert.equal(replay.mutation.disposition, "replayed");
  assert.throws(borrow, /plugin_composition_node_unobserved/u);
  assert.deepEqual(f.probe.events, events);
});

test("a withdrawn provider cannot be borrowed, and a real new selection restores a fresh identity", async (t) => {
  const f = await fixture(t);
  await f.open("installation");
  await enableStandard(f);
  const runtime = f.runtime;
  assert.ok("service" in runtime);
  const provider = f.source("provider");
  const borrow = () =>
    runtime.borrowNode({
      actor,
      scope,
      pluginId: provider.pluginId,
      packageDigest: provider.packageDigest,
      authorizeBorrow: () => "allow",
    });
  const initial = borrow();
  const old = initial.lease.identity;
  initial.release();
  await f.select(provider, 2, "disabled");
  assert.throws(borrow);
  const events = [...f.probe.events];
  await f.status();
  assert.throws(borrow);
  assert.deepEqual(f.probe.events, events);
  await f.select(provider, 3);
  const restored = borrow();
  try {
    assert.notEqual(restored.lease.identity, old);
    assert.equal(
      restored.lease.getService("test.instance-source", "1"),
      f.probe.consumers[1]!.provider,
    );
  } finally {
    restored.release();
  }
});

test("the real Native file and held claim are checked synchronously at the borrowing front door", async (t) => {
  const f = await fixture(
    t,
    [{ id: "provider", kind: "provider" }],
    "private-file-v3",
  );
  await f.open("installation");
  const provider = f.source("provider");
  await f.install(provider);
  await f.select(provider, 1);
  const runtime = f.runtime;
  assert.ok("service" in runtime);
  writeFileSync(f.configurationPath, "{}", { mode: 0o600 });
  assert.throws(
    () =>
      runtime.borrowNode({
        actor,
        scope,
        pluginId: provider.pluginId,
        packageDigest: provider.packageDigest,
        authorizeBorrow: () => "allow",
      }),
    /desktop_plugin_configuration_invalid/u,
  );
  assert.throws(
    () =>
      f.probe.ports.provider!.register({
        create() {
          throw new Error("must-not-register");
        },
      }),
    /plugin_execution_registry_closed/u,
  );
});

test(
  "a live borrow leaves the original management queue available and a disabled installation does not replace its graph",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t, [
      { id: "provider", kind: "provider" },
      { id: "fresh", kind: "independent" },
    ]);
    await f.open("installation");
    const provider = f.source("provider");
    await f.install(provider);
    await f.select(provider, 1);
    const runtime = f.runtime;
    assert.ok("service" in runtime);
    const input = {
      actor,
      scope,
      pluginId: provider.pluginId,
      packageDigest: provider.packageDigest,
      authorizeBorrow: () => "allow" as const,
    };
    const lease = runtime.borrowNode(input);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const installing = f.install(f.source("fresh"));
    try {
      await Promise.race([
        installing,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("borrow_held_management_queue")),
            3_000,
          );
        }),
      ]);
      const stillCurrent = runtime.borrowNode(input);
      try {
        assert.equal(stillCurrent.lease.identity, lease.lease.identity);
        assert.equal(f.probe.counts.fresh, undefined);
        assert.equal(f.probe.counts.provider, 1);
      } finally {
        stillCurrent.release();
      }
    } finally {
      clearTimeout(timer);
      lease.release();
      await installing;
    }
  },
);

test("close withdraws new borrows synchronously and waits for an actual borrowed lease to release", async (t) => {
  const f = await fixture(t, [{ id: "provider", kind: "provider" }]);
  await f.open("installation");
  const provider = f.source("provider");
  await f.install(provider);
  await f.select(provider, 1);
  const runtime = f.runtime;
  assert.ok("service" in runtime);
  const input = {
    actor,
    scope,
    pluginId: provider.pluginId,
    packageDigest: provider.packageDigest,
    authorizeBorrow: () => "allow" as const,
  };
  const lease = runtime.borrowNode(input);
  let completed = false;
  const closing = runtime
    .close()
    .then(() => {
      completed = true;
    })
    .catch((error: unknown) => {
      const flatten = (value: unknown): string =>
        value instanceof AggregateError
          ? `${value.message}: ${value.errors.map(flatten).join("; ")}`
          : String(value);
      throw new Error(flatten(error), { cause: error });
    });
  try {
    assert.throws(
      () => runtime.borrowNode(input),
      /plugin_installation_runtime_closed/u,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
  } finally {
    lease.release();
    await closing;
  }
  assert.equal(completed, true);
});

test("actual saved graph-head tampering is rejected before the Host borrowing policy runs", async (t) => {
  const f = await fixture(t, [{ id: "provider", kind: "provider" }]);
  await f.open("installation");
  const provider = f.source("provider");
  await f.install(provider);
  await f.select(provider, 1);
  const runtime = f.runtime;
  assert.ok("service" in runtime);
  const db = new DatabaseSync(f.databasePath);
  let policyCalls = 0;
  try {
    // Deliberate corruption of the actual head is negative evidence, not another writer grant.
    const row = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE '%composition%head%'",
      )
      .get();
    assert.ok(row);
    const table = String(row.name);
    assert.match(table, /^[a-z_]+$/u);
    db.exec(
      `PRAGMA foreign_keys=OFF; UPDATE "${table}" SET revision = revision + 1`,
    );
    assert.throws(
      () =>
        runtime.borrowNode({
          actor,
          scope,
          pluginId: provider.pluginId,
          packageDigest: provider.packageDigest,
          authorizeBorrow: () => {
            policyCalls++;
            return "allow";
          },
        }),
      /plugin_composition_record_invalid/u,
    );
    assert.equal(policyCalls, 0);
  } finally {
    db.close();
  }
});
