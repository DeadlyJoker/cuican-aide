import assert from "node:assert/strict";
import { access, chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  ApplicationError,
  CreativeProjectApplicationService,
} from "@crewon/application";
import { parsePluginSelection } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { LocalPluginPackageError } from "./local-plugin-package-types.ts";
import {
  actor,
  digester,
  localInstallationFixture,
  scope,
  timestamp,
} from "./plugin-installation-local-host.test-support.ts";

test("actual App/SQLite/immutable bytes/Node lifecycle upgrades, rolls back and retains business records on uninstall", async (t) => {
  const f = await localInstallationFixture(t);
  const first = await f.packageSource("1.0.0");
  const installed = await f.install(first, null, "install-1");
  assert.equal(installed.selection.state, "disabled");
  await assert.rejects(access(first.marker));
  assert.deepEqual(f.nodeHost.snapshot(), []);
  await rm(first.directory, { recursive: true });
  await f.parent.creativeProjectStore().migrate();
  const creative = new CreativeProjectApplicationService({
    store: f.parent.creativeProjectStore(),
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => timestamp },
    ids: { nextId: () => "fixture-project" },
    digester,
  });
  const project = await creative.createProject(actor, {
    title: "保留项目",
    briefText: "保留历史需求",
    idempotencyKey: "project-1",
  });
  const credits = f.parent.pluginCreditStore();
  await credits.migrate();
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "test-only-independent-pool",
  };
  const balance = await credits.grant({
    scope: creditScope,
    grantId: "test-only-grant",
    credits: "50",
  });
  assert.equal(
    (await f.select(first.expectedPackageDigest, 1, "enabled", "enable-1"))
      .projection.outcome,
    "applied",
  );
  const old = f.acquire(first.expectedPackageDigest);
  assert.equal(f.read(old), "1.0.0");
  const second = await f.packageSource("2.0.0");
  const later = await f.install(second, 2, "install-2");
  assert.equal(later.selection.revision, 2);
  assert.equal(
    later.selection.selectedPackageDigest,
    first.expectedPackageDigest,
  );
  assert.equal(
    (await f.select(second.expectedPackageDigest, 2, "enabled", "upgrade-2"))
      .projection.outcome,
    "applied",
  );
  const newer = f.acquire(second.expectedPackageDigest);
  assert.equal(f.read(newer), "2.0.0");
  assert.equal(f.read(old), "1.0.0");
  await assert.rejects(async () => f.acquire(first.expectedPackageDigest), {
    code: "plugin_instance_unavailable",
  });
  assert.equal(
    (await f.select(second.expectedPackageDigest, 3, "disabled", "disable-2"))
      .projection.outcome,
    "applied",
  );
  assert.throws(() => f.acquire(second.expectedPackageDigest), {
    code: "plugin_instance_unavailable",
  });
  assert.equal(
    (await f.select(first.expectedPackageDigest, 4, "enabled", "rollback-1"))
      .projection.outcome,
    "applied",
  );
  assert.equal(f.read(f.acquire(first.expectedPackageDigest)), "1.0.0");
  const removed = await f.select(null, 5, "uninstalled", "uninstall");
  assert.equal(removed.projection.outcome, "applied");
  assert.equal(removed.mutation.selection.selectedPackageDigest, null);
  assert.throws(() => f.acquire(first.expectedPackageDigest), {
    code: "plugin_instance_unavailable",
  });
  assert.equal(
    (
      await f.ledger.listPackages({
        scope,
        pluginId: null,
        afterPackageDigest: null,
        limit: 50,
      })
    ).packages.length,
    2,
  );
  assert.deepEqual(
    await creative.getProject(actor, { projectId: project.project.projectId }),
    project.project,
  );
  assert.deepEqual(await credits.getAccount(creditScope), balance);
  const reopened = new SqliteRunStore(f.databasePath);
  try {
    assert.deepEqual(
      await reopened
        .pluginInstallationStore()
        .loadSelection({ scope, pluginId: "example.story" }),
      removed.mutation.selection,
    );
  } finally {
    await reopened.close();
  }
  // Receipt replay neither reads the removed development directory nor changes latest selection.
  assert.equal(
    (await f.install(first, null, "install-1")).disposition,
    "replayed",
  );
  assert.equal((await f.current())!.state, "uninstalled");
});

test("DB failure aborts a staged Node candidate; post-COMMIT publication failure retains desired state and blocks stale admission", async (t) => {
  const f = await localInstallationFixture(t);
  const first = await f.packageSource("1.0.0");
  await f.install(first, null, "install-1");
  f.observer.exec(
    "CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON plugin_installation_receipts BEGIN SELECT RAISE(ABORT,'fixture_db_failure'); END;",
  );
  await assert.rejects(
    f.select(first.expectedPackageDigest, 1, "enabled", "enable-1"),
  );
  assert.equal((await f.current())!.revision, 1);
  assert.equal(
    f.nodeHost.snapshot().some((instance) => instance.phase === "accepting"),
    false,
  );
  f.observer.exec("DROP TRIGGER fixture_receipt_failure;");
  await f.select(first.expectedPackageDigest, 1, "enabled", "enable-1");
  const borrowed = f.acquire(first.expectedPackageDigest);
  const bad = await f.packageSource("2.0.0", { failSetup: true });
  await f.install(bad, 2, "install-2");
  await assert.rejects(
    f.select(bad.expectedPackageDigest, 2, "enabled", "bad-upgrade"),
  );
  assert.equal((await f.current())!.revision, 2);
  assert.equal(f.read(borrowed), "1.0.0");
  const next = await f.packageSource("3.0.0");
  await f.install(next, 2, "install-3");
  f.policy.incompatible = true;
  await assert.rejects(
    f.select(next.expectedPackageDigest, 2, "enabled", "upgrade-3"),
    { code: "fixture_data_schema_incompatible" },
  );
  assert.equal((await f.current())!.revision, 2);
  f.policy.incompatible = false;
  f.policy.denyCommit = true;
  const pending = await f.select(
    next.expectedPackageDigest,
    2,
    "enabled",
    "upgrade-3",
  );
  assert.deepEqual(pending.projection, {
    outcome: "pending",
    reasonCode: "plugin_projection_pending",
  });
  assert.equal(
    (await f.current())!.selectedPackageDigest,
    next.expectedPackageDigest,
  );
  assert.equal((await f.current())!.revision, 3);
  assert.throws(() => f.acquire(first.expectedPackageDigest), {
    code: "plugin_instance_unavailable",
  });
  assert.throws(() => f.acquire(next.expectedPackageDigest), {
    code: "plugin_instance_unavailable",
  });
  assert.equal(f.read(borrowed), "1.0.0");
  f.policy.denyCommit = false;
  const replayed = await f.select(
    next.expectedPackageDigest,
    2,
    "enabled",
    "upgrade-3",
  );
  assert.equal(replayed.mutation.disposition, "replayed");
  assert.equal(replayed.projection.outcome, "unchanged");
  assert.throws(() => f.acquire(next.expectedPackageDigest), {
    code: "plugin_instance_unavailable",
  });
  assert.equal(
    (await f.select(next.expectedPackageDigest, 3, "enabled", "reconcile-3"))
      .projection.outcome,
    "applied",
  );
  assert.equal(f.read(f.acquire(next.expectedPackageDigest)), "3.0.0");
});

test("withdrawal commit detects synchronous authority reentry and preserves a separately published instance", async (t) => {
  const f = await localInstallationFixture(t);
  const first = await f.packageSource("1.0.0");
  await f.install(first, null, "install-1");
  await f.select(first.expectedPackageDigest, 1, "enabled", "enable-1");
  const second = await f.packageSource("2.0.0");
  await f.install(second, 2, "install-2");
  const separate = await f.nodeHost.prepare({
    installRoot: f.installRoot,
    expectedPluginId: "example.story",
    expectedPackageDigest: second.expectedPackageDigest,
    authorizeActivation: () => "allow",
  });
  const current = (await f.current())!;
  const next = parsePluginSelection({
    ...current,
    revision: 3,
    state: "disabled",
  });
  const withdrawal = await f.local.prepareSelection({
    actor,
    scope,
    currentSelection: current,
    nextSelection: next,
    package: installedPackage(
      await f.ledger.loadPackage({
        scope,
        packageDigest: first.expectedPackageDigest,
      }),
    ),
  });
  try {
    await f.ledger.commitSelection({
      scope,
      actor,
      selection: next,
      expectedSelectionRevision: 2,
      receipt: {
        idempotencyKey: "withdrawal",
        requestDigest: digester.sha256("withdrawal-fixture"),
      },
    });
    f.policy.beforeFence = () =>
      separate.commit({ authorizeCommit: () => "allow" });
    assert.throws(() => withdrawal.commit({ selection: next }), {
      code: "plugin_projection_current_changed",
    });
    f.policy.beforeFence = null;
    const currentNode = f.nodeHost
      .snapshot()
      .find((instance) => instance.phase === "accepting");
    assert.equal(
      currentNode!.identity.packageDigest,
      second.expectedPackageDigest,
    );
    assert.throws(() => f.acquire(second.expectedPackageDigest), {
      code: "plugin_borrow_denied",
    });
  } finally {
    f.policy.beforeFence = null;
    await withdrawal.abort();
    await separate.abort();
  }
});

function installedPackage<T>(value: T | null): T {
  assert.notEqual(value, null);
  return value!;
}

test("actual UI-only installation enables, repeats, disables and uninstalls without executing UI or fabricating a Node instance", async (t) => {
  const f = await localInstallationFixture(t);
  const ui = await f.packageSource("1.0.0", { entryKind: "uiOnly" });
  await f.install(ui, null, "install-ui");
  await rm(ui.directory, { recursive: true });
  const enabled = await f.select(
    ui.expectedPackageDigest,
    1,
    "enabled",
    "enable-ui",
  );
  assert.equal(enabled.projection.outcome, "applied");
  assert.equal(
    f.policy.activationCandidates[0]?.descriptor.entrypoints.node,
    null,
  );
  assert.equal(
    f.policy.activationCandidates[0]?.packageDigest,
    ui.expectedPackageDigest,
  );
  assert.equal(
    f.policy.compatibilityDescriptors[0]?.entrypoints.ui?.path,
    "ui.mjs",
  );
  assert.deepEqual(f.nodeHost.snapshot(), []);
  assert.throws(() => f.acquire(ui.expectedPackageDigest), {
    code: "plugin_instance_unavailable",
  });
  const repeated = await f.select(
    ui.expectedPackageDigest,
    2,
    "enabled",
    "repeat-ui",
  );
  assert.equal(repeated.projection.outcome, "applied");
  assert.equal(f.policy.activationCandidates.length, 2);
  assert.equal(
    (await f.select(ui.expectedPackageDigest, 3, "disabled", "disable-ui"))
      .projection.outcome,
    "applied",
  );
  assert.equal(
    (await f.select(null, 4, "uninstalled", "remove-ui")).projection.outcome,
    "applied",
  );
  const reopened = new SqliteRunStore(f.databasePath);
  try {
    assert.deepEqual(
      await reopened
        .pluginInstallationStore()
        .loadSelection({ scope, pluginId: "example.story" }),
      await f.current(),
    );
  } finally {
    await reopened.close();
  }
  await assert.rejects(access(ui.uiMarker), { code: "ENOENT" });
  assert.deepEqual(f.events, []);
});

test("mixed-to-UI-only withdrawal preserves existing Node borrowers and a rollback really loads the Node entry again", async (t) => {
  const f = await localInstallationFixture(t);
  const mixed = await f.packageSource("1.0.0", { entryKind: "mixed" });
  await f.install(mixed, null, "install-mixed");
  await f.select(mixed.expectedPackageDigest, 1, "enabled", "enable-mixed");
  const old = f.acquire(mixed.expectedPackageDigest);
  const ui = await f.packageSource("2.0.0", { entryKind: "uiOnly" });
  await f.install(ui, 2, "install-ui");
  assert.equal(
    (await f.select(ui.expectedPackageDigest, 2, "enabled", "switch-ui"))
      .projection.outcome,
    "applied",
  );
  assert.equal(
    f.nodeHost.snapshot().filter((instance) => instance.phase === "accepting")
      .length,
    0,
  );
  assert.equal(f.read(old), "1.0.0");
  assert.throws(() => f.acquire(mixed.expectedPackageDigest), {
    code: "plugin_instance_unavailable",
  });
  assert.equal(
    f.nodeHost
      .serviceIdentities()
      .some(({ service }) => service === "example.story"),
    false,
  );
  assert.equal(
    (
      await f.select(
        mixed.expectedPackageDigest,
        3,
        "enabled",
        "rollback-mixed",
      )
    ).projection.outcome,
    "applied",
  );
  const latest = f.acquire(mixed.expectedPackageDigest);
  assert.equal(f.read(latest), "1.0.0");
  assert.equal(f.read(old), "1.0.0");
  assert.notEqual(latest.identity, old.identity);
  assert.equal(f.events.filter((event) => event === "setup:1.0.0").length, 2);
  await assert.rejects(access(mixed.uiMarker), { code: "ENOENT" });
  await assert.rejects(access(ui.uiMarker), { code: "ENOENT" });
  old.release();
  await f.local.drain();
  assert.equal(f.events.filter((event) => event === "dispose:1.0.0").length, 1);
});

test("UI-only packages still require activation, compatibility and post-COMMIT current authority", async (t) => {
  const f = await localInstallationFixture(t);
  const ui = await f.packageSource("1.0.0", { entryKind: "uiOnly" });
  await f.install(ui, null, "install-ui");
  f.policy.denyActivation = true;
  await assert.rejects(
    f.select(ui.expectedPackageDigest, 1, "enabled", "enable-ui"),
    { code: "plugin_activation_denied" },
  );
  assert.equal((await f.current())!.revision, 1);
  f.policy.denyActivation = false;
  f.policy.incompatible = true;
  await assert.rejects(
    f.select(ui.expectedPackageDigest, 1, "enabled", "enable-ui"),
    { code: "fixture_data_schema_incompatible" },
  );
  f.policy.incompatible = false;
  f.policy.denyCommit = true;
  const pending = await f.select(
    ui.expectedPackageDigest,
    1,
    "enabled",
    "enable-ui",
  );
  assert.deepEqual(pending.projection, {
    outcome: "pending",
    reasonCode: "plugin_projection_pending",
  });
  assert.equal((await f.current())!.revision, 2);
  assert.deepEqual(f.nodeHost.snapshot(), []);
  f.policy.denyCommit = false;
  assert.equal(
    (await f.select(ui.expectedPackageDigest, 1, "enabled", "enable-ui"))
      .projection.outcome,
    "unchanged",
  );
  assert.equal(
    (await f.select(ui.expectedPackageDigest, 2, "enabled", "retry-current"))
      .projection.outcome,
    "applied",
  );
  await assert.rejects(access(ui.uiMarker), { code: "ENOENT" });
});

test("UI-only service declarations and bytes changed during activation are rejected before desired state changes", async (t) => {
  const f = await localInstallationFixture(t);
  for (const [version, options] of [
    [
      "1.0.0",
      {
        requires: [
          { service: "host.recorder", apiVersion: "1", optional: true },
        ],
      },
    ],
    ["2.0.0", { provides: [{ service: "example.story", apiVersion: "1" }] }],
  ] as const) {
    const ui = await f.packageSource(version, {
      entryKind: "uiOnly",
      ...options,
    });
    await f.install(
      ui,
      (await f.current())?.revision ?? null,
      `install-${ui.sourceId}`,
    );
    await assert.rejects(
      f.select(ui.expectedPackageDigest, 1, "enabled", `enable-${ui.sourceId}`),
      { code: "plugin_ui_only_services_unsupported" },
    );
    await assert.rejects(access(ui.uiMarker), { code: "ENOENT" });
  }
  assert.equal(f.policy.activationCandidates.length, 0);
  const valid = await f.packageSource("3.0.0", { entryKind: "uiOnly" });
  await f.install(valid, 1, "install-valid");
  f.policy.activation = async () => {
    const path = join(
      f.installRoot,
      "packages",
      valid.expectedPackageDigest.slice(7),
      "ui.mjs",
    );
    await chmod(path, 0o600);
    await writeFile(path, "changed after authority await");
  };
  await assert.rejects(
    f.select(valid.expectedPackageDigest, 1, "enabled", "tampered-ui"),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationError);
      assert.equal(error.code, "plugin_installation_host_unavailable");
      assert.ok(error.cause instanceof LocalPluginPackageError);
      assert.equal(error.cause.code, "plugin_package_file_size_mismatch");
      return true;
    },
  );
  assert.equal((await f.current())!.revision, 1);
  assert.deepEqual(f.nodeHost.snapshot(), []);
});
