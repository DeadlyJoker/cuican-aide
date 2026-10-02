import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type {
  PluginInstalledSelectionRecoveryInput,
  PluginInstalledSelectionRecoveryPolicy,
} from "./plugin-installation-recovery.ts";
import {
  installedRecoveryFixture,
  recoveryProfile,
} from "./plugin-installation-recovery.test-support.ts";

const recorder = { service: "host.recorder", apiVersion: "1", optional: false };
const absent = async (path: string) =>
  assert.rejects(access(path), { code: "ENOENT" });
function barrier() {
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    entered,
    finish,
    wait: () => {
      enter();
      return done;
    },
  };
}

test("reopened SQLite restores installed ESM without a source, revision change, new receipt or stale-lock deletion", async (t) => {
  const f = await installedRecoveryFixture(t);
  const pkg = await f.packageSource();
  const selection = await f.save(pkg);
  const before = f.dump();
  const lock = join(
    f.installRoot,
    ".locks",
    pkg.installed.packageDigest.slice(7),
  );
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner-evidence"), "preserve-unknown-owner");
  await absent(pkg.directory);
  const prior = f.host();
  const oldInput = await f.selectionInput();
  await prior.local.recoverSelections([oldInput], prior.authority);
  await prior.node.close();
  await f.reopen();
  const reopened = f.host();
  const input = await f.selectionInput();
  const restored = await reopened.local.recoverSelections(
    [input],
    reopened.authority,
  );
  assert.deepEqual(restored, [selection]);
  const lease = reopened.acquire(input);
  assert.equal(
    lease.getService<{ read(): string }>("example.story", "1").read(),
    "example.story:1.0.0",
  );
  lease.release();
  assert.deepEqual(f.dump(), before);
  assert.equal(
    await readFile(join(lock, "owner-evidence"), "utf8"),
    "preserve-unknown-owner",
  );
  assert.equal(
    f.events.filter((event) => event.includes("setup:example.story:1.0.0"))
      .length,
    2,
  );
  assert.equal(reopened.policy.selectionCompatibilityCalls, 0);
  const currentActor = {
    ...input,
    actor: {
      ...input.actor,
      principalId: "new-current-owner",
      actorId: "fresh-host",
    },
  };
  const again = await reopened.local.prepareRecovery(
    currentActor,
    reopened.authority,
  );
  again.commit({ selection: input.selection });
  assert.equal(reopened.policy.checkedActors.at(-1), "new-current-owner");
  assert.equal(
    f.events.filter((event) => event.includes("setup:example.story:1.0.0"))
      .length,
    2,
  );
  assert.deepEqual(f.dump(), before);
});

test("separate profile coordinators recover their own selected version and reject cross-profile restoration", async (t) => {
  const f = await installedRecoveryFixture(t);
  const otherProfile = { ...recoveryProfile, profileId: "profile-b" };
  const a = await f.packageSource();
  const b = await f.packageSource({ version: "2.0.0" });
  await f.save(a);
  await f.save(b, otherProfile);
  await f.reopen();
  const one = f.host();
  const two = f.host(otherProfile);
  const inputOne = await f.selectionInput();
  const inputTwo = await f.selectionInput("example.story", otherProfile);
  await assert.rejects(one.local.prepareRecovery(inputTwo, one.authority), {
    code: "plugin_installation_scope_mismatch",
  });
  await absent(a.marker);
  await absent(b.marker);
  await one.local.recoverSelections([inputOne], one.authority);
  await two.local.recoverSelections([inputTwo], two.authority);
  for (const [host, input, value] of [
    [one, inputOne, "1.0.0"],
    [two, inputTwo, "2.0.0"],
  ] as const) {
    const lease = host.acquire(input);
    assert.equal(
      lease.getService<{ read(): string }>("example.story", "1").read(),
      `example.story:${value}`,
    );
    lease.release();
  }
  assert.equal(
    one.node.snapshot()[0]?.identity.packageDigest,
    a.installed.packageDigest,
  );
  assert.equal(
    two.node.snapshot()[0]?.identity.packageDigest,
    b.installed.packageDigest,
  );
});

test("batch recovery orders actual service providers before consumers and publishes immutable dependency identities", async (t) => {
  const f = await installedRecoveryFixture(t);
  const provider = await f.packageSource({ pluginId: "example.provider" });
  const consumer = await f.packageSource({
    pluginId: "example.consumer",
    requires: [
      recorder,
      { service: "example.provider", apiVersion: "1", optional: false },
    ],
  });
  await f.save(provider);
  await f.save(consumer);
  const host = f.host();
  const consumerInput = await f.selectionInput("example.consumer");
  const providerInput = await f.selectionInput("example.provider");
  const before = f.dump();
  await host.local.recoverSelections(
    [consumerInput, providerInput],
    host.authority,
  );
  assert.deepEqual(f.events, [
    "profile-a:setup:example.provider:1.0.0",
    "profile-a:setup:example.consumer:1.0.0",
  ]);
  const identities = host.node.serviceIdentities();
  assert.equal(
    identities.find(({ service }) => service === "host.recorder")?.provider,
    null,
  );
  assert.equal(
    identities.find(({ service }) => service === "example.provider")?.provider
      ?.packageDigest,
    provider.installed.packageDigest,
  );
  assert.ok(Object.isFrozen(identities));
  assert.deepEqual(f.dump(), before);
  const lease = host.acquire(consumerInput);
  assert.equal(
    lease.getService<{ read(): string }>("example.consumer", "1").read(),
    "example.consumer:1.0.0",
  );
  lease.release();
});

test("missing and cyclic required dependencies reject an entire startup batch before any entry executes", async (t) => {
  const f = await installedRecoveryFixture(t);
  const unrelated = await f.packageSource({ pluginId: "example.unrelated" });
  const missing = await f.packageSource({
    pluginId: "example.missing",
    requires: [
      recorder,
      { service: "host.missing", apiVersion: "1", optional: false },
    ],
  });
  const a = await f.packageSource({
    pluginId: "example.a",
    requires: [
      recorder,
      { service: "example.b", apiVersion: "1", optional: false },
    ],
  });
  const b = await f.packageSource({
    pluginId: "example.b",
    requires: [
      recorder,
      { service: "example.a", apiVersion: "1", optional: false },
    ],
  });
  for (const pkg of [unrelated, missing, a, b]) await f.save(pkg);
  const host = f.host();
  await assert.rejects(
    host.local.recoverSelections(
      [
        await f.selectionInput("example.unrelated"),
        await f.selectionInput("example.missing"),
      ],
      host.authority,
    ),
    { code: "plugin_dependency_unavailable" },
  );
  await assert.rejects(
    host.local.recoverSelections(
      [
        await f.selectionInput("example.a"),
        await f.selectionInput("example.b"),
      ],
      host.authority,
    ),
    { code: "plugin_dependency_cycle" },
  );
  for (const pkg of [unrelated, missing, a, b]) await absent(pkg.marker);
  assert.deepEqual(host.node.snapshot(), []);
  assert.deepEqual(f.events, []);
});

test("failed consumer setup withdraws only this batch's new registrations, cleans provider leases and preserves other instances", async (t) => {
  const f = await installedRecoveryFixture(t);
  const old = await f.packageSource({ pluginId: "example.other" });
  const provider = await f.packageSource({ pluginId: "example.provider" });
  const failing = await f.packageSource({
    pluginId: "example.consumer",
    failSetup: true,
    requires: [
      recorder,
      { service: "example.provider", apiVersion: "1", optional: false },
    ],
  });
  for (const pkg of [old, provider, failing]) await f.save(pkg);
  const host = f.host();
  const otherInput = await f.selectionInput("example.other");
  await host.local.recoverSelections([otherInput], host.authority);
  const other = host.acquire(otherInput);
  const before = f.dump();
  await assert.rejects(
    host.local.recoverSelections(
      [
        await f.selectionInput("example.consumer"),
        await f.selectionInput("example.provider"),
      ],
      host.authority,
    ),
    /fixture_setup_failed/,
  );
  assert.deepEqual(
    host.node.snapshot().map(({ identity }) => identity.pluginId),
    ["example.other"],
  );
  assert.deepEqual(
    host.node
      .serviceIdentities()
      .map(({ service }) => service)
      .sort(),
    ["example.other", "host.recorder"],
  );
  assert.ok(f.events.includes("profile-a:dispose:example.consumer:1.0.0"));
  assert.ok(f.events.includes("profile-a:dispose:example.provider:1.0.0"));
  assert.equal(
    other.getService<{ read(): string }>("example.other", "1").read(),
    "example.other:1.0.0",
  );
  other.release();
  assert.deepEqual(f.dump(), before);
});

test("current authorization and compatibility are required before importing installed code", async (t) => {
  const f = await installedRecoveryFixture(t);
  const pkg = await f.packageSource();
  await f.save(pkg);
  const host = f.host();
  const input = await f.selectionInput();
  host.policy.denyCurrent = true;
  await assert.rejects(host.local.prepareRecovery(input, host.authority), {
    code: "plugin_recovery_current_denied",
  });
  host.policy.denyCurrent = false;
  host.policy.incompatible = true;
  await assert.rejects(host.local.prepareRecovery(input, host.authority), {
    code: "fixture_incompatible",
  });
  await assert.rejects(
    host.local.prepareRecovery(
      input,
      {} as PluginInstalledSelectionRecoveryPolicy,
    ),
    { code: "plugin_recovery_input_invalid" },
  );
  let getters = 0;
  const bad = { ...input };
  Object.defineProperty(bad, "selection", {
    enumerable: true,
    get() {
      getters++;
      return input.selection;
    },
  });
  await assert.rejects(host.local.prepareRecovery(bad, host.authority), {
    code: "plugin_recovery_input_invalid",
  });
  assert.equal(getters, 0);
  await absent(pkg.marker);
  assert.deepEqual(host.node.snapshot(), []);
});

test("revocation during either compatibility or activation authorization is observed before entry import", async (t) => {
  const f = await installedRecoveryFixture(t);
  const pkg = await f.packageSource();
  await f.save(pkg);
  const input = await f.selectionInput();
  for (const stage of ["compatibility", "activation"] as const) {
    const host = f.host();
    const gate = barrier();
    host.policy[stage] = gate.wait;
    const preparing = host.local.prepareRecovery(input, host.authority);
    await gate.entered;
    host.policy.denyCurrent = true;
    gate.finish();
    await assert.rejects(preparing, { code: "plugin_recovery_current_denied" });
    await absent(pkg.marker);
    assert.deepEqual(host.node.snapshot(), []);
  }
});

test("a newer durable selection during asynchronous setup aborts the candidate and preserves its original revision receipt", async (t) => {
  const f = await installedRecoveryFixture(t);
  const pkg = await f.packageSource({ pauseSetup: true });
  await f.save(pkg);
  const host = f.host();
  const input = await f.selectionInput();
  const gate = barrier();
  host.policy.pause = gate.wait;
  const preparing = host.local.prepareRecovery(input, host.authority);
  await gate.entered;
  await f.transition("example.story", "disabled");
  const afterWrite = f.dump();
  gate.finish();
  await assert.rejects(preparing, { code: "plugin_recovery_current_denied" });
  assert.deepEqual(host.node.snapshot(), []);
  assert.deepEqual(f.dump(), afterWrite);
  assert.deepEqual(f.events, [
    "profile-a:setup:example.story:1.0.0",
    "profile-a:dispose:example.story:1.0.0",
  ]);
});

test("prepared recovery rechecks exact current permission and durable revision at synchronous publication", async (t) => {
  const f = await installedRecoveryFixture(t);
  const pkg = await f.packageSource();
  await f.save(pkg);
  const host = f.host();
  const input = await f.selectionInput();
  const candidate = await host.local.prepareRecovery(input, host.authority);
  await f.transition("example.story", "disabled");
  const afterWrite = f.dump();
  assert.throws(() => candidate.commit({ selection: input.selection }), {
    code: "plugin_recovery_current_denied",
  });
  await candidate.abort();
  await host.local.drain();
  assert.deepEqual(host.node.snapshot(), []);
  assert.deepEqual(f.dump(), afterWrite);
  const next = await f.selectionInput();
  const withdrawal = await host.local.prepareRecovery(next, host.authority);
  withdrawal.commit({ selection: next.selection });
  assert.deepEqual(f.dump(), afterWrite);
});

test("disable and uninstall recover withdrawal immediately, while already borrowed services retain their original version", async (t) => {
  const f = await installedRecoveryFixture(t);
  const pkg = await f.packageSource();
  await f.save(pkg);
  const host = f.host();
  const input = await f.selectionInput();
  await host.local.recoverSelections([input], host.authority);
  const old = host.acquire(input);
  await f.transition("example.story", "disabled");
  const disabled = await f.selectionInput();
  const beforeDisabled = f.dump();
  const candidate = await host.local.prepareRecovery(disabled, host.authority);
  candidate.commit({ selection: disabled.selection });
  assert.throws(() => host.acquire(input), {
    code: "plugin_instance_unavailable",
  });
  assert.equal(
    old.getService<{ read(): string }>("example.story", "1").read(),
    "example.story:1.0.0",
  );
  assert.deepEqual(f.dump(), beforeDisabled);
  await f.transition("example.story", "uninstalled", null);
  const uninstalled = await f.selectionInput();
  const beforeUninstalled = f.dump();
  await host.local.recoverSelections([uninstalled], host.authority);
  assert.deepEqual(f.dump(), beforeUninstalled);
  assert.equal(f.events.filter((event) => event.includes("setup:")).length, 1);
  old.release();
  await host.local.drain();
  assert.deepEqual(host.node.snapshot(), []);
});

test("recovery shares the selection queue and snapshots input so later caller mutations cannot change publication", async (t) => {
  const f = await installedRecoveryFixture(t);
  const pkg = await f.packageSource();
  await f.save(pkg);
  const host = f.host();
  const input = await f.selectionInput();
  const before = f.dump();
  const mutable = {
    ...input,
    actor: { ...input.actor },
    selection: { ...input.selection },
  };
  const first = await host.local.prepareRecovery(mutable, host.authority);
  mutable.actor.principalId = "forged-later";
  mutable.selection.revision += 100;
  let secondReady = false;
  const secondPromise = host.local
    .prepareRecovery(input, host.authority)
    .then((candidate) => {
      secondReady = true;
      return candidate;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondReady, false);
  first.commit({ selection: input.selection });
  const second = await secondPromise;
  second.commit({ selection: input.selection });
  assert.equal(f.events.filter((event) => event.includes("setup:")).length, 1);
  assert.ok(!host.policy.checkedActors.includes("forged-later"));
  assert.deepEqual(f.dump(), before);
});

test("recovery rejects altered installed bytes and a changed audit snapshot without admitting either candidate", async (t) => {
  const f = await installedRecoveryFixture(t);
  const pkg = await f.packageSource();
  await f.save(pkg);
  const host = f.host();
  const input = await f.selectionInput();
  const candidate = await host.local.prepareRecovery(input, host.authority);
  assert.throws(
    () =>
      candidate.commit({
        selection: {
          ...input.selection,
          updatedAt: "2026-10-03T02:00:00.000Z",
        },
      }),
    { code: "plugin_selection_commit_mismatch" },
  );
  await candidate.abort();
  await host.local.drain();
  const filename = join(
    f.installRoot,
    "packages",
    pkg.installed.packageDigest.slice(7),
    "entry.mjs",
  );
  await chmod(filename, 0o600);
  await writeFile(filename, "export default {};");
  await assert.rejects(host.local.prepareRecovery(input, host.authority), {
    code: "plugin_package_file_size_mismatch",
  });
  assert.deepEqual(host.node.snapshot(), []);
});

test("ordinary selection publication waits for recovery on the same profile coordinator", async (t) => {
  const f = await installedRecoveryFixture(t);
  const pkg = await f.packageSource();
  await f.save(pkg);
  const host = f.host();
  const input = await f.selectionInput();
  const recovering = await host.local.prepareRecovery(input, host.authority);
  const nextSelection = {
    ...input.selection,
    state: "disabled" as const,
    revision: input.selection.revision + 1,
  };
  let selectionReady = false;
  const selecting = host.local
    .prepareSelection({
      actor: input.actor,
      scope: input.scope,
      currentSelection: input.selection,
      nextSelection,
      package: input.package,
    })
    .then((candidate) => {
      selectionReady = true;
      return candidate;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selectionReady, false);
  assert.equal(host.policy.selectionCompatibilityCalls, 0);
  recovering.commit({ selection: input.selection });
  const candidate = await selecting;
  assert.equal(host.policy.selectionCompatibilityCalls, 1);
  const durable = await f.transition("example.story", "disabled");
  candidate.commit({ selection: durable });
  await host.local.drain();
  assert.deepEqual(host.node.snapshot(), []);
});

test("permission revoked inside the synchronous publication fence cannot activate a staged recovery", async (t) => {
  const f = await installedRecoveryFixture(t);
  const pkg = await f.packageSource();
  await f.save(pkg);
  const host = f.host();
  const input = await f.selectionInput();
  const before = f.dump();
  const candidate = await host.local.prepareRecovery(input, host.authority);
  host.policy.beforeCommit = () => {
    host.policy.denyCurrent = true;
  };
  assert.throws(() => candidate.commit({ selection: input.selection }), {
    code: "plugin_recovery_current_denied",
  });
  await candidate.abort();
  await host.local.drain();
  assert.deepEqual(host.node.snapshot(), []);
  assert.deepEqual(f.dump(), before);
});
