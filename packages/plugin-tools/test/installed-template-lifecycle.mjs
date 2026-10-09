import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PluginInstallationApplicationService } from "@crewon/application";
import { parsePluginSelection } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import {
  LocalPluginInstallationHost,
  PluginNodeHost,
} from "@crewon/plugin-host";

/** Real Application/SQLite/immutable packages/native ESM. Policies below are explicitly test-owned. */
export async function exerciseInstalledTemplateLifecycle({
  directory,
  installRoot,
  packages,
  removeAuthoring,
}) {
  const actor = {
    tenantId: "fixture-tenant",
    spaceId: "fixture-space",
    principalId: "fixture-owner",
    actorId: "fixture-user",
  };
  const scope = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "fixture-profile",
  };
  const databasePath = join(directory, "control.sqlite");
  await mkdir(installRoot, { mode: 0o700 });
  let parent = new SqliteRunStore(databasePath);
  let ledger = parent.pluginInstallationStore();
  await ledger.migrate();
  const observer = new DatabaseSync(databasePath);
  let node, local, app;
  let allowed = true;
  const leases = new Set();
  const sources = new Map(
    packages.map((entry, index) => [`source-${index}`, entry.directory]),
  );
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const owned = (who, profile) =>
    allowed && same(who, actor) && same(profile, scope);
  const current = () => {
    const row = observer
      .prepare(
        "SELECT record_json FROM plugin_profile_selections WHERE tenant_id=? AND space_id=? AND profile_id=? AND plugin_id=?",
      )
      .get(scope.tenantId, scope.spaceId, scope.profileId, "example.minimal");
    return row
      ? parsePluginSelection(JSON.parse(String(row.record_json)))
      : null;
  };
  const dump = () =>
    [
      ["installed_plugin_packages", "record_json"],
      ["plugin_profile_selections", "record_json"],
      ["plugin_installation_receipts", "result_json"],
    ].map(([table, column]) =>
      observer
        .prepare(`SELECT ${column} FROM ${table} ORDER BY ${column}`)
        .all()
        .map((row) => row[column]),
    );
  const compatibility = async ({ descriptor }) => {
    if (descriptor === null) return;
    assert.equal(descriptor.pluginId, "example.minimal");
    assert.equal(descriptor.hostApi, "crewon.plugin-host.v1");
    assert.deepEqual(descriptor.requires, []);
    assert.deepEqual(descriptor.provides, [
      { service: "example.minimal.echo", apiVersion: "1" },
    ]);
  };
  const openHost = () => {
    node = new PluginNodeHost({ services: [] });
    local = new LocalPluginInstallationHost({
      profile: scope,
      installRoot,
      nodeHost: node,
      resolveSource: async ({ actor: who, scope: profile, sourceId }) => {
        assert.ok(owned(who, profile));
        assert.ok(sources.has(sourceId), "original source unavailable");
        return sources.get(sourceId);
      },
      authorizeInstallation: async ({
        actor: who,
        scope: profile,
        candidate,
      }) =>
        owned(who, profile) &&
        packages.some(
          (entry) =>
            entry.packageDigest === candidate.packageDigest &&
            candidate.descriptor.pluginId === "example.minimal",
        )
          ? "allow"
          : "deny",
      authorizeActivation: async ({ actor: who, scope: profile, candidate }) =>
        owned(who, profile) &&
        packages.some(
          (entry) => entry.packageDigest === candidate.packageDigest,
        )
          ? "allow"
          : "deny",
      validateCompatibility: compatibility,
      authorizeCommit: ({ actor: who, scope: profile, selection }) =>
        owned(who, profile) && same(current(), selection) ? "allow" : "deny",
    });
    app = new PluginInstallationApplicationService({
      store: ledger,
      profiles: {
        resolve: async (who) => {
          assert.ok(same(who, actor));
          return scope;
        },
      },
      authorization: {
        authorize: async ({ actor: who, resource }) =>
          allowed &&
          same(who, actor) &&
          resource.tenantId === scope.tenantId &&
          resource.spaceId === scope.spaceId &&
          resource.profileId === scope.profileId
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "fixture_permission_revoked" },
      },
      host: local,
      clock: { now: () => "2026-10-10T00:00:00.000Z" },
      digester: {
        sha256: (value) =>
          "sha256:" + createHash("sha256").update(value).digest("hex"),
      },
    });
  };
  const acquire = (digest) => {
    const lease = node.acquire({
      pluginId: "example.minimal",
      packageDigest: digest,
      purpose: "newOperation",
      authorizeBorrow: () =>
        allowed &&
        current()?.state === "enabled" &&
        current().selectedPackageDigest === digest
          ? "allow"
          : "deny",
    });
    leases.add(lease);
    return lease;
  };
  const release = (lease) => {
    lease.release();
    leases.delete(lease);
  };
  const echo = (lease, text) =>
    lease.getService("example.minimal.echo", "1").echo(text);
  const select = (digest, state, key) =>
    app.select(actor, {
      pluginId: "example.minimal",
      selectedPackageDigest: digest,
      state,
      expectedSelectionRevision: current().revision,
      idempotencyKey: key,
    });
  const recover = async () => {
    const selection = await ledger.loadSelection({
      scope,
      pluginId: "example.minimal",
    });
    const input = {
      actor,
      scope,
      selection,
      package: selection.selectedPackageDigest
        ? await ledger.loadPackage({
            scope,
            packageDigest: selection.selectedPackageDigest,
          })
        : null,
    };
    return local.recoverSelections([input], {
      authorizeCurrent: (record) =>
        owned(record.actor, record.scope) && same(current(), record.selection)
          ? "allow"
          : "deny",
      validateCompatibility: compatibility,
    });
  };
  const cold = async () => {
    assert.equal(leases.size, 0);
    await local.drain();
    await node.close();
    node = undefined;
    await parent.close();
    parent = new SqliteRunStore(databasePath);
    ledger = parent.pluginInstallationStore();
    openHost();
  };
  try {
    openHost();
    const firstCommand = {
      sourceId: "source-0",
      expectedPluginId: "example.minimal",
      expectedPackageDigest: packages[0].packageDigest,
      expectedSelectionRevision: null,
      idempotencyKey: "install-template-v1",
    };
    await app.install(actor, firstCommand);
    await select(packages[0].packageDigest, "enabled", "enable-v1");
    const original = acquire(packages[0].packageDigest);
    assert.equal(echo(original, "first"), "first");
    assert.throws(() => echo(original, "a".repeat(2049)), /echo_input_invalid/);
    await app.install(actor, {
      sourceId: "source-1",
      expectedPluginId: "example.minimal",
      expectedPackageDigest: packages[1].packageDigest,
      expectedSelectionRevision: current().revision,
      idempotencyKey: "install-template-v2",
    });
    await removeAuthoring();
    sources.clear();
    await select(packages[1].packageDigest, "enabled", "upgrade-v2");
    const upgraded = acquire(packages[1].packageDigest);
    assert.equal(echo(upgraded, "next"), "2.0.0:next");
    assert.equal(echo(original, "original"), "original");
    assert.throws(() => acquire(packages[0].packageDigest));
    await select(packages[0].packageDigest, "enabled", "rollback-v1");
    const rolledBack = acquire(packages[0].packageDigest);
    assert.equal(echo(rolledBack, "rollback"), "rollback");
    assert.equal(echo(upgraded, "held-v2"), "2.0.0:held-v2");
    for (const lease of [original, upgraded, rolledBack]) release(lease);
    await cold();
    const beforeRecovery = dump();
    allowed = false;
    await assert.rejects(recover(), { code: "plugin_recovery_current_denied" });
    assert.deepEqual(node.snapshot(), []);
    allowed = true;
    await recover();
    await recover();
    assert.deepEqual(dump(), beforeRecovery);
    const recovered = acquire(packages[0].packageDigest);
    assert.equal(echo(recovered, "cold-original"), "cold-original");
    await select(packages[0].packageDigest, "disabled", "disable-v1");
    assert.throws(() => acquire(packages[0].packageDigest));
    assert.equal(echo(recovered, "held-disabled"), "held-disabled");
    release(recovered);
    await cold();
    const beforeDisabled = dump();
    await recover();
    assert.deepEqual(node.snapshot(), []);
    assert.deepEqual(dump(), beforeDisabled);
    await select(packages[0].packageDigest, "enabled", "reenable-v1");
    const last = acquire(packages[0].packageDigest);
    await select(null, "uninstalled", "uninstall-v1");
    assert.equal(current().selectedPackageDigest, null);
    assert.throws(() => acquire(packages[0].packageDigest));
    assert.equal(echo(last, "held-uninstalled"), "held-uninstalled");
    release(last);
    await cold();
    const beforeUninstalled = dump();
    await recover();
    assert.deepEqual(node.snapshot(), []);
    assert.deepEqual(dump(), beforeUninstalled);
    const replay = await app.install(actor, firstCommand);
    assert.equal(replay.disposition, "replayed");
    assert.equal(current().state, "uninstalled");
    assert.deepEqual(dump(), beforeUninstalled);
    assert.equal(
      (
        await ledger.listPackages({
          scope,
          pluginId: "example.minimal",
          afterPackageDigest: null,
          limit: 10,
        })
      ).packages.length,
      2,
    );
  } finally {
    for (const lease of leases) lease.release();
    try {
      if (local) await local.drain();
    } finally {
      try {
        if (node) await node.close();
      } finally {
        observer.close();
        await parent.close();
      }
    }
  }
}
