import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import test from "node:test";
import {
  localInstallationFixture,
  scope,
} from "./plugin-installation-local-host.test-support.ts";
import {
  installedRecoveryFixture,
  recoveryProfile,
} from "./plugin-installation-recovery.test-support.ts";
import type { PluginUiHostServiceAvailabilityPort } from "./plugin-ui-host-service-availability.ts";

const requirement = {
  service: "crewon.creative-projects",
  apiVersion: "1",
  optional: false,
} as const;
const absent = (path: string) =>
  assert.rejects(access(path), { code: "ENOENT" });

test("actual UI-only metadata installation requires an explicit exact-digest Host port and creates no Node service", async (t) => {
  const checked: Parameters<
    PluginUiHostServiceAvailabilityPort["isAvailable"]
  >[0][] = [];
  let approved: string | null = null,
    available = true;
  const f = await localInstallationFixture(t, {
    hostUiServices: {
      isAvailable(input) {
        checked.push(input);
        return available && input.candidate.packageDigest === approved;
      },
    },
  });
  const ui = await f.packageSource("1.0.0", {
    entryKind: "uiOnly",
    requires: [requirement],
  });
  await f.install(ui, null, "install-metadata");
  assert.equal((await f.current())!.state, "disabled");
  await assert.rejects(
    f.select(ui.expectedPackageDigest, 1, "enabled", "not-approved"),
    { code: "plugin_dependency_unavailable" },
  );
  assert.equal(f.policy.activationCandidates.length, 0);
  approved = ui.expectedPackageDigest;
  await rm(ui.directory, { recursive: true });
  assert.equal(
    (await f.select(approved, 1, "enabled", "enable-metadata")).projection
      .outcome,
    "applied",
  );
  assert.equal(
    (await f.select(approved, 2, "enabled", "repeat-metadata")).projection
      .outcome,
    "applied",
  );
  assert.ok(checked.length >= 4);
  for (const input of checked) {
    assert.deepEqual(input.scope, scope);
    assert.equal(input.candidate.packageDigest, approved);
    assert.equal(input.candidate.descriptor.entrypoints.node, null);
    assert.equal(input.candidate.descriptor.pluginId, "example.story");
    assert.deepEqual(input.requirement, requirement);
  }
  available = false;
  assert.equal(
    (await f.select(approved, 3, "disabled", "disable-unavailable")).projection
      .outcome,
    "applied",
  );
  assert.equal(
    f.nodeHost
      .serviceIdentities()
      .some((service) => service.service === requirement.service),
    false,
  );
  assert.deepEqual(f.nodeHost.snapshot(), []);
  await absent(ui.uiMarker);
});
test("without a Host port the actual required metadata UI-only package retains the old fail-closed behavior", async (t) => {
  const f = await localInstallationFixture(t);
  const ui = await f.packageSource("1.0.0", {
    entryKind: "uiOnly",
    requires: [requirement],
  });
  await f.install(ui, null, "install-default");
  await assert.rejects(
    f.select(ui.expectedPackageDigest, 1, "enabled", "enable-default"),
    { code: "plugin_ui_only_services_unsupported" },
  );
  assert.equal((await f.current())!.state, "disabled");
  assert.equal(f.policy.activationCandidates.length, 0);
  await absent(ui.uiMarker);
});
test("metadata availability lost during activation refuses enable before durable selection changes", async (t) => {
  let available = true;
  const f = await localInstallationFixture(t, {
    hostUiServices: { isAvailable: () => available },
  });
  const ui = await f.packageSource("1.0.0", {
    entryKind: "uiOnly",
    requires: [requirement],
  });
  await f.install(ui, null, "install-activation-close");
  f.policy.activation = async () => {
    available = false;
  };
  await assert.rejects(
    f.select(ui.expectedPackageDigest, 1, "enabled", "activation-close"),
    { code: "plugin_dependency_unavailable" },
  );
  assert.equal((await f.current())!.revision, 1);
  assert.equal((await f.current())!.state, "disabled");
  await absent(ui.uiMarker);
});
test("metadata closure inside the synchronous commit authority refuses publication after desired state is durable", async (t) => {
  let available = true;
  const f = await localInstallationFixture(t, {
    hostUiServices: { isAvailable: () => available },
  });
  const ui = await f.packageSource("1.0.0", {
    entryKind: "uiOnly",
    requires: [requirement],
  });
  await f.install(ui, null, "install-commit-close");
  f.policy.beforeFence = () => {
    available = false;
  };
  const result = await f.select(
    ui.expectedPackageDigest,
    1,
    "enabled",
    "commit-close",
  );
  assert.deepEqual(result.projection, {
    outcome: "pending",
    reasonCode: "plugin_projection_pending",
  });
  assert.equal((await f.current())!.revision, 2);
  assert.deepEqual(f.nodeHost.snapshot(), []);
  await absent(ui.uiMarker);
});
test("known optional metadata can enable without availability, while unknown optional declarations still reject", async (t) => {
  let calls = 0;
  const f = await localInstallationFixture(t, {
    hostUiServices: {
      isAvailable() {
        calls++;
        return false;
      },
    },
  });
  const optional = await f.packageSource("1.0.0", {
    entryKind: "uiOnly",
    requires: [{ ...requirement, optional: true }],
  });
  await f.install(optional, null, "install-optional");
  assert.equal(
    (
      await f.select(
        optional.expectedPackageDigest,
        1,
        "enabled",
        "enable-optional",
      )
    ).projection.outcome,
    "applied",
  );
  assert.equal(calls, 0);
  const unknown = await f.packageSource("2.0.0", {
    entryKind: "uiOnly",
    requires: [{ service: "host.recorder", apiVersion: "1", optional: true }],
  });
  await f.install(unknown, 2, "install-unknown");
  await assert.rejects(
    f.select(unknown.expectedPackageDigest, 2, "enabled", "enable-unknown"),
    { code: "plugin_ui_only_services_unsupported" },
  );
  assert.equal(
    (await f.current())!.selectedPackageDigest,
    optional.expectedPackageDigest,
  );
  await absent(unknown.uiMarker);
});
test("actual reopened SQLite recovers UI-only required metadata without sources, Node identities or ledger writes", async (t) => {
  const f = await installedRecoveryFixture(t);
  const ui = await f.packageSource({
    entryKind: "uiOnly",
    requires: [requirement],
  });
  const selection = await f.save(ui);
  await f.reopen();
  const before = f.dump();
  const input = await f.selectionInput();
  const received: Parameters<
    PluginUiHostServiceAvailabilityPort["isAvailable"]
  >[0][] = [];
  const host = f.host(recoveryProfile, {
    hostUiServices: {
      isAvailable(value) {
        received.push(value);
        return value.candidate.packageDigest === ui.installed.packageDigest;
      },
    },
  });
  assert.deepEqual(
    await host.local.recoverSelections([input], host.authority),
    [selection],
  );
  assert.deepEqual(
    await host.local.recoverSelections([input], host.authority),
    [selection],
  );
  assert.deepEqual(f.dump(), before);
  assert.deepEqual(host.node.snapshot(), []);
  assert.equal(
    host.node
      .serviceIdentities()
      .some((service) => service.service === requirement.service),
    false,
  );
  assert.ok(received.length >= 4);
  for (const value of received) assert.deepEqual(value.scope, recoveryProfile);
  await absent(ui.directory);
  await absent(ui.uiMarker);
});
test("recovery preflight refuses unavailable Host metadata before unrelated Node code executes", async (t) => {
  const f = await installedRecoveryFixture(t);
  const node = await f.packageSource({ pluginId: "example.node" });
  const ui = await f.packageSource({
    entryKind: "uiOnly",
    requires: [requirement],
  });
  await f.save(node);
  await f.save(ui);
  const host = f.host(recoveryProfile, {
    hostUiServices: { isAvailable: () => false },
  });
  const before = f.dump();
  await assert.rejects(
    host.local.recoverSelections(
      [await f.selectionInput("example.node"), await f.selectionInput()],
      host.authority,
    ),
    { code: "plugin_dependency_unavailable" },
  );
  assert.deepEqual(f.dump(), before);
  await absent(node.marker);
  await absent(ui.uiMarker);
});
test("prepared UI metadata recovery rechecks closure before and after synchronous commit authority", async (t) => {
  const f = await installedRecoveryFixture(t);
  const ui = await f.packageSource({
    entryKind: "uiOnly",
    requires: [requirement],
  });
  await f.save(ui);
  const input = await f.selectionInput();
  let available = true;
  const host = f.host(recoveryProfile, {
    hostUiServices: { isAvailable: () => available },
  });
  const before = f.dump();
  const first = await host.local.prepareRecovery(input, host.authority);
  available = false;
  assert.throws(() => first.commit({ selection: input.selection }), {
    code: "plugin_dependency_unavailable",
  });
  await first.abort();
  available = true;
  const second = await host.local.prepareRecovery(input, host.authority);
  host.policy.beforeCommit = () => {
    available = false;
  };
  assert.throws(() => second.commit({ selection: input.selection }), {
    code: "plugin_dependency_unavailable",
  });
  await second.abort();
  assert.deepEqual(f.dump(), before);
  assert.deepEqual(host.node.snapshot(), []);
  await absent(ui.uiMarker);
});
