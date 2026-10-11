import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqlitePluginInstallationStore, SqliteRunStore } from "@crewon/store";
import {
  actor,
  scope,
  standard,
  fixture,
  byPlugin,
  enableStandard,
  hasCause,
} from "./desktop-plugin-instance-composition.test-support.ts";

test("actual Desktop runtime shares one setup owner and automatically restores a desired consumer after provider withdrawal", async (t) => {
  const f = await fixture(t);
  await f.open();
  await enableStandard(f);
  assert.deepEqual(f.probe.counts, {
    provider: 1,
    consumer: 1,
    independent: 1,
  });
  const provider = f.source("provider"),
    consumer = f.source("consumer"),
    independent = f.source("independent");
  const oldCapture = f.probe.consumers[0]!;
  assert.equal(oldCapture.generation, 1);
  const oldPort = f.probe.ports.consumer!;
  const original = await f.store
    .pluginInstallationStore()
    .compositionStore()
    .loadCurrent({ scope });
  assert.ok(original);
  assert.deepEqual(
    (await f.status()).plugins.map((entry) => entry.node),
    [{ state: "ready" }, { state: "ready" }, { state: "ready" }],
  );
  assert.equal(
    (await f.select(provider, 2, "disabled")).projection.outcome,
    "applied",
  );
  const withdrawn = await f.status();
  assert.deepEqual(byPlugin(withdrawn, provider.pluginId).node, {
    state: "inactive",
  });
  assert.deepEqual(byPlugin(withdrawn, consumer.pluginId).node, {
    state: "unobserved",
  });
  assert.equal(
    byPlugin(withdrawn, consumer.pluginId).selection.state,
    "enabled",
  );
  assert.equal(byPlugin(withdrawn, consumer.pluginId).selection.revision, 2);
  assert.deepEqual(byPlugin(withdrawn, independent.pluginId).node, {
    state: "ready",
  });
  assert.equal(withdrawn.metadata.state, "failed");
  assert.throws(
    () =>
      oldPort.register({
        create() {
          throw new Error("must-not-register");
        },
      }),
    /plugin_execution_registration_closed/u,
  );
  assert.deepEqual(
    await f.store
      .pluginInstallationStore()
      .compositionStore()
      .loadCurrent({ scope }),
    original,
  );
  assert.equal((await f.select(provider, 3)).projection.outcome, "applied");
  const restored = await f.status();
  assert.equal(restored.metadata.state, "published");
  assert.deepEqual(
    restored.plugins.map((entry) => entry.node),
    [{ state: "ready" }, { state: "ready" }, { state: "ready" }],
  );
  assert.deepEqual(f.probe.counts, {
    provider: 2,
    consumer: 2,
    independent: 1,
  });
  const freshCapture = f.probe.consumers[1]!;
  assert.equal(freshCapture.generation, 2);
  assert.notEqual(freshCapture.provider, oldCapture.provider);
  assert.ok(
    f.probe.events.indexOf("consumer:dispose:1") <
      f.probe.events.indexOf("provider:dispose:1"),
  );
  const events = [...f.probe.events];
  await f.status();
  await f.selection(consumer);
  assert.deepEqual(
    f.probe.events,
    events,
    "reads do not reconcile or rerun setup",
  );
});

test("active dependent provider upgrades remain refused until explicit disable then version selection", async (t) => {
  const f = await fixture(t, [
    ...standard,
    {
      id: "provider-v2",
      pluginId: "test.provider",
      kind: "provider",
      version: "2.0.0",
    },
  ]);
  await f.open();
  await enableStandard(f);
  const first = f.source("provider"),
    second = f.source("provider-v2");
  await f.install(second, 2);
  await assert.rejects(f.select(second, 2), (error) =>
    hasCause(error, "plugin_dependency_upgrade_unsupported"),
  );
  assert.equal(
    (await f.selection(first))?.selectedPackageDigest,
    first.packageDigest,
  );
  assert.equal(f.probe.counts["provider-v2"], undefined);
  assert.equal(f.probe.counts.consumer, 1);
  assert.equal(
    (await f.select(first, 2, "disabled")).projection.outcome,
    "applied",
  );
  assert.equal((await f.select(second, 3)).projection.outcome, "applied");
  assert.equal(
    (await f.selection(second))?.selectedPackageDigest,
    second.packageDigest,
  );
  assert.equal(f.probe.counts["provider-v2"], 1);
  assert.equal(f.probe.counts.consumer, 2);
  assert.equal(f.probe.counts.independent, 1);
  assert.equal(f.probe.consumers[1]?.version, "2.0.0");
  assert.notEqual(
    f.probe.consumers[0]?.provider,
    f.probe.consumers[1]?.provider,
  );
});

test("full saved mixed graph keeps UI-only metadata while cold status and original receipt replay never resurrect modules", async (t) => {
  const f = await fixture(t, [
    ...standard,
    { id: "ui", kind: "ui" },
    { id: "fresh", kind: "independent" },
  ]);
  await f.open();
  for (const source of f.sources) await f.install(source);
  for (const id of ["provider", "consumer", "independent", "ui"])
    assert.equal(
      (await f.select(f.source(id), 1, "enabled", `original-${id}`)).projection
        .outcome,
      "applied",
    );
  const saved = await f.store
    .pluginInstallationStore()
    .compositionStore()
    .loadCurrent({ scope });
  assert.ok(saved);
  assert.equal(saved.nodes.length, 4);
  const ui = byPlugin(await f.status(), f.source("ui").pluginId);
  assert.equal(ui.selection.state, "enabled");
  assert.deepEqual(ui.node, { state: "unobserved" });
  assert.equal(f.probe.counts.ui, undefined);
  assert.deepEqual(f.probe.counts, {
    provider: 1,
    consumer: 1,
    independent: 1,
  });
  await f.close();
  const afterClose = [...f.probe.events];
  await f.open();
  const cold = await f.status();
  for (const entry of cold.plugins)
    assert.deepEqual(entry.node, {
      state: entry.selection.state === "enabled" ? "unobserved" : "inactive",
    });
  assert.equal(cold.metadata.state, "unobserved");
  await f.selection(f.source("consumer"));
  assert.deepEqual(f.probe.events, afterClose);
  const replay = await f.select(
    f.source("consumer"),
    1,
    "enabled",
    "original-consumer",
  );
  assert.equal(replay.mutation.disposition, "replayed");
  assert.equal(replay.projection.outcome, "unchanged");
  assert.deepEqual(f.probe.events, afterClose);
  assert.deepEqual(
    await f.store
      .pluginInstallationStore()
      .compositionStore()
      .loadCurrent({ scope }),
    saved,
  );
  assert.equal(
    (await f.select(f.source("fresh"), 1)).projection.outcome,
    "applied",
  );
  const recovered = await f.status();
  for (const id of ["provider", "consumer", "independent", "fresh"])
    assert.deepEqual(byPlugin(recovered, f.source(id).pluginId).node, {
      state: "ready",
    });
  assert.deepEqual(byPlugin(recovered, f.source("ui").pluginId).node, {
    state: "unobserved",
  });
  assert.deepEqual(f.probe.counts, {
    provider: 2,
    consumer: 2,
    independent: 2,
    fresh: 1,
  });
  assert.deepEqual(
    await f.store
      .pluginInstallationStore()
      .compositionStore()
      .loadLock({ scope, lockDigest: saved.lockDigest }),
    saved,
  );
});

test("actual SQLite metadata failure preserves the committed enabled selection and exact receipt with honest instance status", async (t) => {
  const f = await fixture(t);
  await f.open();
  const provider = f.source("provider"),
    independent = f.source("independent");
  await f.install(provider);
  await f.install(independent);
  await f.select(provider, 1);
  const original = await f.store
    .pluginInstallationStore()
    .compositionStore()
    .loadCurrent({ scope });
  assert.ok(original);
  const db = new DatabaseSync(f.databasePath);
  try {
    db.exec(
      "CREATE TRIGGER fail_instance_graph BEFORE INSERT ON plugin_composition_locks BEGIN SELECT RAISE(ABORT,'actual_instance_graph_insert_failure');END",
    );
    const selected = await f.select(
      independent,
      1,
      "enabled",
      "metadata-failure-original",
    );
    assert.equal(selected.mutation.disposition, "committed");
    assert.equal(selected.projection.outcome, "applied");
    assert.equal(selected.mutation.selection.state, "enabled");
    const status = await f.status();
    assert.equal(status.metadata.state, "failed");
    assert.deepEqual(byPlugin(status, independent.pluginId).node, {
      state: "ready",
    });
    assert.equal(byPlugin(status, independent.pluginId).selection.revision, 2);
    assert.deepEqual(
      await f.store
        .pluginInstallationStore()
        .compositionStore()
        .loadCurrent({ scope }),
      original,
    );
    const replay = await f.select(
      independent,
      1,
      "enabled",
      "metadata-failure-original",
    );
    assert.equal(replay.mutation.disposition, "replayed");
    assert.equal(replay.projection.outcome, "unchanged");
    assert.deepEqual(replay.mutation.selection, selected.mutation.selection);
    assert.deepEqual(f.probe.counts, { provider: 1, independent: 1 });
  } finally {
    db.exec("DROP TRIGGER fail_instance_graph");
    db.close();
  }
});

test("actual pending setup loses Native authority before durable selection and cleans its registration", async (t) => {
  const f = await fixture(t, [{ id: "pending", kind: "independent" }]);
  await f.open("installation");
  const source = f.source("pending");
  await f.install(source);
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.probe.gates.pending = { setupWait: gate, setupEntered: reached };
  const outcome = f.select(source, 1).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await entered;
  f.authority.withdraw();
  release();
  const result = await outcome;
  assert.ok("error" in result);
  assert.ok(hasCause(result.error, "plugin_installation_profile_unavailable"));
  const selected = await f.store
    .pluginInstallationStore()
    .loadSelection({ scope, pluginId: source.pluginId });
  assert.equal(selected?.state, "disabled");
  assert.equal(selected?.revision, 1);
  assert.equal(
    await f.store
      .pluginInstallationStore()
      .compositionStore()
      .loadCurrent({ scope }),
    null,
  );
  assert.deepEqual(f.probe.events, ["pending:setup:1", "pending:dispose:1"]);
  assert.throws(
    () =>
      f.probe.ports.pending!.register({
        create() {
          throw new Error("must-not-register");
        },
      }),
    /plugin_execution_registry_closed/u,
  );
});

test("actual close withdraws registration synchronously and joins pending setup plus queued status before releasing ownership", async (t) => {
  const f = await fixture(t, [{ id: "pending", kind: "independent" }]);
  await f.open("installation");
  const source = f.source("pending");
  await f.install(source);
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.probe.gates.pending = { setupWait: gate, setupEntered: reached };
  const selected = f.select(source, 1).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await entered;
  const queued = f.status().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const closing = f.runtime.close();
  let done = false;
  void closing.then(() => {
    done = true;
  });
  assert.throws(
    () =>
      f.probe.ports.pending!.register({
        create() {
          throw new Error("must-not-register");
        },
      }),
    /plugin_execution_registry_closed/u,
  );
  await Promise.resolve();
  assert.equal(
    done,
    false,
    "close joins owned pending setup instead of abandoning it",
  );
  release();
  const [selection, status] = await Promise.all([selected, queued]);
  assert.ok("error" in selection);
  assert.ok("error" in status);
  await closing;
  assert.deepEqual(f.probe.events, ["pending:setup:1", "pending:dispose:1"]);
  assert.equal(
    (
      await f.store
        .pluginInstallationStore()
        .loadSelection({ scope, pluginId: source.pluginId })
    )?.state,
    "disabled",
  );
  await f.close();
  await f.open("installation");
  assert.deepEqual(byPlugin(await f.status(), source.pluginId).node, {
    state: "inactive",
  });
});

test("a real Store head superseded during the final Native refresh cannot publish the desired consumer", async (t) => {
  const f = await fixture(t);
  await f.open("installation");
  await enableStandard(f);
  const provider = f.source("provider"),
    consumer = f.source("consumer");
  const compositions = f.store.pluginInstallationStore().compositionStore();
  const original = await compositions.loadCurrent({ scope });
  assert.ok(original);
  await f.select(provider, 2, "disabled");
  const db = new DatabaseSync(f.databasePath);
  let changed = false;
  const epoch = f.authority.epoch;
  t.mock.method(
    f.authority,
    "epoch",
    async function (
      this: typeof f.authority,
      ...args: Parameters<typeof epoch>
    ) {
      const current = await epoch.apply(this, args);
      if (
        !changed &&
        args[0].pluginId === consumer.pluginId &&
        f.probe.counts.consumer === 2
      ) {
        changed = true;
        db.prepare(
          "UPDATE plugin_composition_heads SET revision=?,lock_digest=? WHERE tenant_id=? AND space_id=? AND profile_id=?",
        ).run(
          original.revision,
          original.lockDigest,
          scope.tenantId,
          scope.spaceId,
          scope.profileId,
        );
      }
      return current;
    },
  );
  try {
    const result = await f.select(
      provider,
      3,
      "enabled",
      "superseded-head-selection",
    );
    assert.equal(
      changed,
      true,
      "the actual old head replaced the committed new graph during a real Native epoch call",
    );
    assert.equal(result.mutation.disposition, "committed");
    assert.equal(result.projection.outcome, "applied");
    assert.deepEqual(await compositions.loadCurrent({ scope }), original);
    const status = await f.status();
    assert.equal(
      byPlugin(status, consumer.pluginId).selection.state,
      "enabled",
    );
    assert.deepEqual(byPlugin(status, consumer.pluginId).node, {
      state: "unobserved",
    });
    assert.ok(f.probe.events.includes("consumer:dispose:2"));
    assert.throws(
      () =>
        f.probe.ports.consumer!.register({
          create() {
            throw new Error("must-not-register");
          },
        }),
      /plugin_execution_registration_closed/u,
    );
    const events = [...f.probe.events];
    assert.equal(
      (await f.select(provider, 3, "enabled", "superseded-head-selection"))
        .mutation.disposition,
      "replayed",
    );
    assert.deepEqual(f.probe.events, events);
  } finally {
    db.close();
  }
});

test("a real private Native bootstrap change during setup synchronously rejects publication and closes registrations", async (t) => {
  const f = await fixture(
    t,
    [{ id: "pending", kind: "independent" }],
    "private-file-v3",
  );
  await f.open("installation");
  const source = f.source("pending");
  await f.install(source);
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.probe.gates.pending = { setupWait: gate, setupEntered: reached };
  const selecting = f.select(source, 1).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await entered;
  writeFileSync(f.configurationPath, "{}", { mode: 0o600 });
  const runtime = f.runtime;
  assert.ok("service" in runtime);
  assert.throws(
    () => runtime.assertProfileOwnership(actor),
    /desktop_plugin_configuration_invalid/u,
  );
  release();
  const result = await selecting;
  assert.ok("error" in result);
  assert.ok(hasCause(result.error, "plugin_installation_profile_unavailable"));
  assert.equal(
    (
      await f.store
        .pluginInstallationStore()
        .loadSelection({ scope, pluginId: source.pluginId })
    )?.state,
    "disabled",
  );
  assert.deepEqual(f.probe.events, ["pending:setup:1", "pending:dispose:1"]);
  assert.throws(
    () =>
      f.probe.ports.pending!.register({
        create() {
          throw new Error("must-not-register");
        },
      }),
    /plugin_execution_registry_closed/u,
  );
});

test("foreign actor rejections cannot withdraw the real Profile owner or its accepting instances", async (t) => {
  const f = await fixture(t, standard, "private-file-v3");
  await f.open("installation");
  await enableStandard(f);
  const foreign = {
    ...actor,
    actorId: "foreign-user",
    principalId: "foreign-native-owner",
  };
  const runtime = f.runtime;
  assert.ok("service" in runtime);
  const events = [...f.probe.events];
  assert.throws(
    () => runtime.assertProfileOwnership(foreign),
    /desktop_plugin_owner_mismatch/u,
  );
  assert.throws(
    () => runtime.compositionState(foreign),
    /desktop_plugin_owner_mismatch/u,
  );
  await assert.rejects(
    runtime.compositionStatus.listStatus(foreign, {
      afterPluginId: null,
      limit: 50,
    }),
    /desktop_plugin_owner_mismatch/u,
  );
  await assert.rejects(
    runtime.service.select(foreign, {
      pluginId: f.source("provider").pluginId,
      expectedSelectionRevision: 2,
      selectedPackageDigest: f.source("provider").packageDigest,
      state: "disabled",
      idempotencyKey: "foreign-withdraw",
    }),
    /desktop_plugin_owner_mismatch/u,
  );
  assert.deepEqual(
    (await f.status()).plugins.map((entry) => entry.node),
    [{ state: "ready" }, { state: "ready" }, { state: "ready" }],
  );
  assert.deepEqual(f.probe.events, events);
  runtime.assertProfileOwnership(actor);
  assert.equal(
    (await f.select(f.source("provider"), 2, "disabled")).mutation.disposition,
    "committed",
  );
  let withdrawals = 0;
  f.authority.registerWithdrawalObserver(() => {
    withdrawals++;
  });
  writeFileSync(f.configurationPath, "{}", { mode: 0o600 });
  assert.throws(
    () => runtime.assertProfileOwnership(foreign),
    /desktop_plugin_owner_mismatch/u,
  );
  assert.throws(() => f.authority.assertActor({ ...foreign, actorId: "" }));
  assert.equal(
    withdrawals,
    0,
    "foreign and malformed actors cannot trigger a real owner's withdrawal observer",
  );
  const register = () =>
    f.probe.ports.independent!.register({
      create() {
        throw new Error("must-not-register");
      },
    });
  assert.throws(
    register,
    /plugin_execution_factory_conflict/u,
    "the accepting binding remains open until its own real Native check",
  );
  await assert.rejects(
    f.selection(f.source("independent")),
    /desktop_plugin_configuration_invalid/u,
  );
  assert.equal(withdrawals, 1);
  assert.throws(register, /plugin_execution_registry_closed/u);
});

test("idle private Native-file invalidation at each original front door synchronously withdraws live registrations", async (t) => {
  for (const entry of [
    "selection",
    "ownership",
    "metadata",
    "status",
  ] as const) {
    await t.test(entry, async (subtest) => {
      const f = await fixture(
        subtest,
        [{ id: "idle", kind: "independent" }],
        "private-file-v3",
      );
      await f.open("installation");
      const source = f.source("idle");
      await f.install(source);
      await f.select(source, 1);
      const runtime = f.runtime;
      assert.ok("service" in runtime);
      writeFileSync(f.configurationPath, "{}", { mode: 0o600 });
      let rejection: Promise<unknown> | null = null;
      if (entry === "selection")
        rejection = assert.rejects(
          f.selection(source),
          /desktop_plugin_configuration_invalid/u,
        );
      else if (entry === "status")
        rejection = assert.rejects(
          f.status(),
          /desktop_plugin_configuration_invalid/u,
        );
      else
        assert.throws(
          () =>
            entry === "ownership"
              ? runtime.assertProfileOwnership(actor)
              : runtime.compositionState(actor),
          /desktop_plugin_configuration_invalid/u,
        );
      assert.throws(
        () =>
          f.probe.ports.idle!.register({
            create() {
              throw new Error("must-not-register");
            },
          }),
        /plugin_execution_registry_closed/u,
      );
      await rejection;
      assert.equal(
        (
          await f.store
            .pluginInstallationStore()
            .loadSelection({ scope, pluginId: source.pluginId })
        )?.state,
        "enabled",
        "Native withdrawal closes execution without rewriting the committed desired selection",
      );
      await f.close();
      assert.deepEqual(f.probe.events, ["idle:setup:1", "idle:dispose:1"]);
    });
  }
});

test("explicit Native authority withdrawal closes idle registrations before any next request and never restores through reads", async (t) => {
  const f = await fixture(t, [{ id: "idle", kind: "independent" }]);
  await f.open("installation");
  const source = f.source("idle");
  await f.install(source);
  await f.select(source, 1);
  f.authority.withdraw();
  assert.throws(
    () =>
      f.probe.ports.idle!.register({
        create() {
          throw new Error("must-not-register");
        },
      }),
    /plugin_execution_registry_closed/u,
  );
  await assert.rejects(f.selection(source), /desktop_plugin_authority_closed/u);
  await assert.rejects(f.status(), /desktop_plugin_authority_closed/u);
  f.authority.withdraw();
  await f.close();
  assert.deepEqual(f.probe.events, ["idle:setup:1", "idle:dispose:1"]);
});

test("Native withdrawal while the real SQLite claim acquisition is awaiting rejects startup and releases that actual claim", async (t) => {
  const f = await fixture(t, []);
  const acquire = SqlitePluginInstallationStore.prototype.acquireProfileOwner;
  let reached!: () => void,
    release!: () => void,
    gated = false;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(
    SqlitePluginInstallationStore.prototype,
    "acquireProfileOwner",
    async function (
      this: SqlitePluginInstallationStore,
      ...args: Parameters<typeof acquire>
    ) {
      const actual = await acquire.apply(this, args);
      if (!gated) {
        gated = true;
        reached();
        await gate;
      }
      return actual;
    },
  );
  const opening = f.open("installation").then(
    () => ({ opened: true }),
    (error: unknown) => ({ error }),
  );
  await entered;
  f.authority.withdraw();
  release();
  const result = await opening;
  assert.ok("error" in result);
  assert.ok(hasCause(result.error, "desktop_plugin_authority_closed"));
  const nextStore = new SqliteRunStore(f.databasePath);
  try {
    const nextOwner = await nextStore
      .pluginInstallationStore()
      .acquireProfileOwner({ scope, onOwnershipLost: () => {} });
    nextOwner.assertOwnership();
    await nextOwner.close();
  } finally {
    await nextStore.close();
  }
  assert.deepEqual(f.probe.events, []);
});

test("the real Native authority observer set is bounded, cancellable, synchronous and not interrupted by a failing listener", async (t) => {
  const f = await fixture(t, []);
  await f.open("installation");
  let repeated = 0;
  const repeat = () => {
    repeated++;
  };
  const cancel = f.authority.registerWithdrawalObserver(repeat);
  f.authority.registerWithdrawalObserver(repeat);
  const counts = Array.from({ length: 30 }, () => 0);
  for (let i = 0; i < counts.length; i++)
    f.authority.registerWithdrawalObserver(() => {
      counts[i]++;
      if (i === 0) throw new Error("actual_observer_cleanup_failure");
    });
  assert.throws(
    () => f.authority.registerWithdrawalObserver(() => {}),
    /desktop_plugin_authority_observer_limit/u,
  );
  cancel();
  cancel();
  let replacement = 0;
  f.authority.registerWithdrawalObserver(() => {
    replacement++;
    f.authority.withdraw();
  });
  f.authority.withdraw();
  assert.equal(repeated, 0);
  assert.equal(replacement, 1);
  assert.deepEqual(
    counts,
    Array.from({ length: 30 }, () => 1),
  );
  f.authority.withdraw();
  await f.authority.close();
  assert.equal(replacement, 1);
  let closed = 0;
  f.authority.registerWithdrawalObserver(() => {
    closed++;
  })();
  assert.equal(
    closed,
    1,
    "a newly bound owner cannot miss an already withdrawn authority",
  );
});
