import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import test from "node:test";
import { CreativeProjectApplicationService } from "@crewon/application";
import { parsePluginSelection } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
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
