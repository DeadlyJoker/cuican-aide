import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import type { InstallPluginPackageCommand } from "./plugin-installation-commands.ts";
import type { PluginInstallationHostIdentity } from "./plugin-installation-host-port.ts";
import {
  actor,
  at,
  digestA,
  digestB,
  identityA,
  installCommand,
  installationFixture,
  scope,
  selectCommand,
} from "./plugin-installation.test-support.ts";

async function rejects(
  action: () => Promise<unknown>,
  category: string,
  code: string,
) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ApplicationError);
    assert.equal(error.category, category);
    assert.equal(error.code, code);
    return true;
  });
}

test("authorized install derives profile, real server receipt and audit, initially disabled", async () => {
  const f = installationFixture();
  const result = await f.service.install(actor, installCommand);
  assert.equal(result.kind, "install");
  assert.equal(result.disposition, "committed");
  assert.deepEqual(result.package, {
    schemaVersion: "crewon.installed-plugin-package.v1",
    ...scope,
    ...identityA,
    installedAt: at,
    installedByPrincipalId: actor.principalId,
    installedByActorId: actor.actorId,
  });
  assert.equal(result.selection.state, "disabled");
  assert.equal(result.selection.revision, 1);
  assert.equal(result.selection.selectedPackageDigest, digestA);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.package));
  assert.ok(Object.isFrozen(result.selection));
  assert.equal(f.state.installs.length, 1);
  assert.equal(f.state.prepares.length, 0);
  assert.equal(f.state.commits, 0);
  const payload = JSON.parse(f.state.hashes[0]!);
  assert.deepEqual(payload.actor, actor);
  assert.deepEqual(payload.scope, scope);
  assert.deepEqual(payload.command, installCommand);
  assert.equal(payload.schemaVersion, "crewon.plugin-installation-command.v1");
  assert.match(
    [...f.store.receipts.values()][0]!.digest,
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.equal(f.state.decisions[0]!.resource.profileId, scope.profileId);
});

test("commands cannot inject profile, path, actor or receipt hash and execute no getters", async () => {
  const f = installationFixture();
  for (const extra of [
    { profileId: "foreign" },
    { tenantId: "foreign" },
    { directory: "/tmp/package" },
    { actorId: "spoof" },
    { requestDigest: digestB },
  ])
    await rejects(
      () =>
        f.service.install(actor, {
          ...installCommand,
          ...extra,
        } as InstallPluginPackageCommand),
      "validation",
      "plugin_installation_command_invalid",
    );
  let getterCalls = 0;
  const getter = { ...installCommand };
  Object.defineProperty(getter, "sourceId", {
    enumerable: true,
    get() {
      getterCalls++;
      return "source-a";
    },
  });
  await rejects(
    () => f.service.install(actor, getter),
    "validation",
    "plugin_installation_command_invalid",
  );
  assert.equal(getterCalls, 0);
  assert.equal(f.state.profileCalls, 0);
  assert.deepEqual(f.store.calls, []);
  assert.equal(f.state.installs.length, 0);
});

test("mandatory current policy and profile fail closed before storage or physical install", async () => {
  const f = installationFixture();
  f.state.decision = { outcome: "deny", reasonCode: "test-denial" };
  await rejects(
    () => f.service.install(actor, installCommand),
    "authorization",
    "authorization_denied",
  );
  f.state.authorizeHook = async () => {
    throw new Error("policy unavailable");
  };
  await rejects(
    () => f.service.install(actor, installCommand),
    "authorization",
    "authorization_unavailable",
  );
  f.state.authorizeHook = null;
  f.state.profile = { ...scope, tenantId: "other-tenant" };
  await rejects(
    () => f.service.install(actor, installCommand),
    "internal",
    "plugin_installation_profile_invalid",
  );
  assert.deepEqual(f.store.calls, []);
  assert.equal(f.state.installs.length, 0);
});

test("install replay reauthorizes and returns original snapshot without resolving expired source or selecting it", async () => {
  const f = installationFixture();
  const first = await f.service.install(actor, installCommand);
  await f.service.select(actor, selectCommand);
  const before = {
    installs: f.state.installs.length,
    prepares: f.state.prepares.length,
    commits: f.state.commits,
    auth: f.state.decisions.length,
  };
  f.sources.clear();
  f.state.now = "invalid clock must not be consulted for replay";
  const replay = await f.service.install(actor, installCommand);
  assert.equal(replay.disposition, "replayed");
  assert.deepEqual(replay.selection, first.selection);
  assert.equal(
    (await f.store.loadSelection({ scope, pluginId: "example.story" }))!.state,
    "enabled",
  );
  assert.equal(f.state.installs.length, before.installs);
  assert.equal(f.state.prepares.length, before.prepares);
  assert.equal(f.state.commits, before.commits);
  assert.ok(f.state.decisions.length >= before.auth + 2);
  f.state.decision = { outcome: "deny", reasonCode: "revoked" };
  await rejects(
    () => f.service.install(actor, installCommand),
    "authorization",
    "authorization_denied",
  );
});

test("same receipt key with changed normalized source is a conflict before any new install", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  await rejects(
    () => f.service.install(actor, { ...installCommand, sourceId: "source-b" }),
    "conflict",
    "plugin_installation_idempotency_conflict",
  );
  assert.equal(f.state.installs.length, 1);
  assert.equal(f.store.receipts.size, 1);
});

test("fresh receipt by another principal preserves first package audit and live selection across versions", async () => {
  const f = installationFixture();
  const original = await f.service.install(actor, installCommand);
  const enabled = await f.service.select(actor, selectCommand);
  f.state.now = "2026-10-03T00:00:00.000Z";
  const secondActor = { ...actor, principalId: "another-principal" };
  const same = await f.service.install(secondActor, {
    ...installCommand,
    expectedSelectionRevision: 2,
  });
  assert.deepEqual(same.package, original.package);
  assert.deepEqual(same.selection, enabled.mutation.selection);
  const next = await f.service.install(actor, {
    sourceId: "source-b",
    expectedPluginId: "example.story",
    expectedPackageDigest: digestB,
    expectedSelectionRevision: 2,
    idempotencyKey: "install-next",
  });
  assert.equal(next.package.version, "2.0.0");
  assert.deepEqual(next.selection, enabled.mutation.selection);
  assert.equal(f.store.packages.size, 2);
});

test("stale CAS prevents physical install and a failed artifact install creates no receipt or desired state", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  await rejects(
    () =>
      f.service.install(actor, { ...installCommand, idempotencyKey: "stale" }),
    "conflict",
    "plugin_installation_revision_conflict",
  );
  assert.equal(f.state.installs.length, 1);
  const empty = installationFixture();
  empty.state.installFailure = new Error("artifact failed");
  await rejects(
    () => empty.service.install(actor, installCommand),
    "internal",
    "plugin_installation_host_unavailable",
  );
  assert.equal(empty.store.packages.size, 0);
  assert.equal(empty.store.receipts.size, 0);
  assert.equal(empty.state.prepares.length, 0);
});

test("artifact success followed by DB failure leaves it unselected and does not claim filesystem rollback", async () => {
  const f = installationFixture();
  f.store.commitFailure = new Error("database unavailable");
  await rejects(
    () => f.service.install(actor, installCommand),
    "internal",
    "plugin_installation_service_unavailable",
  );
  assert.equal(f.state.installs.length, 1);
  assert.equal(f.store.packages.size, 0);
  assert.equal(f.store.selections.size, 0);
  assert.equal(f.store.receipts.size, 0);
  assert.equal(f.state.commits, 0);
});

test("profile change after physical install prevents recording that artifact under stale authority", async () => {
  const f = installationFixture();
  f.state.installHook = async () => {
    f.state.profile = { ...scope, profileId: "profile-b" };
  };
  await rejects(
    () => f.service.install(actor, installCommand),
    "authorization",
    "plugin_installation_profile_changed",
  );
  assert.equal(f.state.installs.length, 1);
  assert.equal(f.store.packages.size, 0);
  assert.equal(f.store.receipts.size, 0);
});

test("wrong host identity and corrupted normal store snapshots are internal failures", async () => {
  const f = installationFixture();
  f.host.install = async () => ({ ...identityA, packageDigest: digestB });
  await rejects(
    () => f.service.install(actor, installCommand),
    "internal",
    "plugin_installation_host_result_invalid",
  );
  assert.equal(f.store.receipts.size, 0);
  const badStore = installationFixture();
  const commit = badStore.store.recordInstalledPackage.bind(badStore.store);
  badStore.store.recordInstalledPackage = async (input) => {
    const saved = await commit(input);
    return { ...saved, selection: { ...saved.selection, state: "enabled" } };
  };
  await rejects(
    () => badStore.service.install(actor, installCommand),
    "internal",
    "plugin_installation_store_result_invalid",
  );
  assert.equal(badStore.state.commits, 0);
  assert.equal(badStore.store.receipts.size, 1);
  const wrongVersion = installationFixture();
  wrongVersion.host.install = async () =>
    ({ ...identityA, version: "invalid" }) as PluginInstallationHostIdentity;
  await rejects(
    () => wrongVersion.service.install(actor, installCommand),
    "internal",
    "plugin_installation_host_result_invalid",
  );
});
