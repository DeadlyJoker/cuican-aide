import assert from "node:assert/strict";
import test from "node:test";
import type { InstalledPluginPackage, PluginSelection } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import {
  actor,
  deferred,
  digestA,
  digestB,
  identityA,
  installCommand,
  installationFixture,
  scope,
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

test("bounded package and selection pages validate cursor, filter, scope and immutable outputs", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  await f.service.install(actor, {
    sourceId: "source-b",
    expectedPluginId: "example.story",
    expectedPackageDigest: digestB,
    expectedSelectionRevision: 1,
    idempotencyKey: "install-next",
  });
  const first = await f.service.listPackages(actor, {
    pluginId: "example.story",
    afterPackageDigest: null,
    limit: 1,
  });
  assert.equal(first.packages[0]!.packageDigest, digestA);
  assert.equal(first.next, digestA);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.packages));
  const second = await f.service.listPackages(actor, {
    pluginId: "example.story",
    afterPackageDigest: first.next,
    limit: 1,
  });
  assert.equal(second.packages[0]!.packageDigest, digestB);
  assert.equal(second.next, null);
  f.sources.set("source-extra", {
    ...identityA,
    pluginId: "example.extra",
    packageDigest: `sha256:${"c".repeat(64)}`,
  });
  await f.service.install(actor, {
    sourceId: "source-extra",
    expectedPluginId: "example.extra",
    expectedPackageDigest: `sha256:${"c".repeat(64)}`,
    expectedSelectionRevision: null,
    idempotencyKey: "install-extra",
  });
  const selections = await f.service.listSelections(actor, {
    afterPluginId: null,
    limit: 1,
  });
  assert.equal(selections.selections[0]!.pluginId, "example.extra");
  assert.equal(selections.next, "example.extra");
  assert.equal(
    (await f.service.getPackage(actor, { packageDigest: digestA }))!.profileId,
    scope.profileId,
  );
  assert.equal(
    (await f.service.getSelection(actor, { pluginId: "example.story" }))!.state,
    "disabled",
  );
});

test("invalid read limits reject before profile lookup; duplicated, unordered or oversized store pages fail closed", async () => {
  const f = installationFixture();
  for (const limit of [0, 51, 1.5, NaN])
    await rejects(
      () => f.service.listSelections(actor, { afterPluginId: null, limit }),
      "validation",
      "plugin_installation_limit_invalid",
    );
  assert.equal(f.state.profileCalls, 0);
  const a = (await f.service.install(actor, installCommand)).package;
  const b = (
    await f.service.install(actor, {
      sourceId: "source-b",
      expectedPluginId: "example.story",
      expectedPackageDigest: digestB,
      expectedSelectionRevision: 1,
      idempotencyKey: "install-next",
    })
  ).package;
  for (const packages of [
    [a, a],
    [b, a],
    [a, b, a],
  ]) {
    f.store.listPackages = async () => ({ packages, next: null });
    await rejects(
      () =>
        f.service.listPackages(actor, {
          pluginId: null,
          afterPackageDigest: null,
          limit: 2,
        }),
      "internal",
      "plugin_installation_store_result_invalid",
    );
  }
  f.store.listPackages = async () => ({ packages: [a], next: digestB });
  await rejects(
    () =>
      f.service.listPackages(actor, {
        pluginId: null,
        afterPackageDigest: null,
        limit: 1,
      }),
    "internal",
    "plugin_installation_store_result_invalid",
  );
});

test("unknown schema, getter outputs and cross-profile reads never become returned installation records", async () => {
  const f = installationFixture();
  const installed = await f.service.install(actor, installCommand);
  for (const changes of [
    { profileId: "foreign" },
    { schemaVersion: "crewon.installed-plugin-package.v2" },
    { pluginId: "another.plugin", packageDigest: digestB },
  ]) {
    f.store.loadPackage = async () =>
      ({ ...installed.package, ...changes }) as InstalledPluginPackage;
    await rejects(
      () => f.service.getPackage(actor, { packageDigest: digestA }),
      "internal",
      "plugin_installation_store_result_invalid",
    );
  }
  f.store.loadSelection = async () =>
    ({ ...installed.selection, profileId: "foreign" }) as PluginSelection;
  await rejects(
    () => f.service.getSelection(actor, { pluginId: "example.story" }),
    "internal",
    "plugin_installation_store_result_invalid",
  );
  let executed = 0;
  const hostile = { ...installed.package };
  Object.defineProperty(hostile, "version", {
    enumerable: true,
    get() {
      executed++;
      return "1.0.0";
    },
  });
  f.store.loadPackage = async () => hostile;
  await rejects(
    () => f.service.getPackage(actor, { packageDigest: digestA }),
    "internal",
    "plugin_installation_store_result_invalid",
  );
  assert.equal(executed, 0);
});

test("asynchronous read rechecks current authorization before returning retrieved metadata", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  const load = f.store.loadPackage.bind(f.store);
  f.store.loadPackage = async (input) => {
    const pkg = await load(input);
    f.state.decision = { outcome: "deny", reasonCode: "revoked during read" };
    return pkg;
  };
  await rejects(
    () => f.service.getPackage(actor, { packageDigest: digestA }),
    "authorization",
    "authorization_denied",
  );
});

test("asynchronous read rejects a profile switch even when generic policy would allow both profiles", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  const load = f.store.loadPackage.bind(f.store);
  f.store.loadPackage = async (input) => {
    const pkg = await load(input);
    f.state.profile = { ...scope, profileId: "profile-b" };
    return pkg;
  };
  await rejects(
    () => f.service.getPackage(actor, { packageDigest: digestA }),
    "authorization",
    "plugin_installation_profile_changed",
  );
});

test("read query is detached while awaiting current profile and null reads are also reauthorized", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  const gate = deferred<void>();
  const entered = deferred<void>();
  let first = true;
  f.state.profileHook = async () => {
    if (first) {
      first = false;
      entered.resolve();
      await gate.promise;
    }
    return scope;
  };
  const query = { packageDigest: digestA };
  const work = f.service.getPackage(actor, query);
  await entered.promise;
  query.packageDigest = digestB;
  gate.resolve();
  assert.equal((await work)!.packageDigest, digestA);
  const authBefore = f.state.decisions.length;
  assert.equal(
    await f.service.getPackage(actor, { packageDigest: digestB }),
    null,
  );
  assert.equal(f.state.decisions.length, authBefore + 2);
});
