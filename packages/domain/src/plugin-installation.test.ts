import assert from "node:assert/strict";
import test from "node:test";
import {
  assertInstalledPluginPackageIdentity,
  assertPluginProfileScope,
  assertPluginSelectionPackage,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "./plugin-installation.ts";
import {
  PluginInstallationError,
  pluginInstallationNextRevision,
} from "./plugin-installation-validation.ts";

const scope: PluginProfileScope = {
  tenantId: "tenant-a",
  spaceId: "space-a",
  profileId: "profile-a",
};
const digest = `sha256:${"a".repeat(64)}`;
const at = "2026-10-02T03:00:00.000Z";
const installed: InstalledPluginPackage = {
  schemaVersion: "crewon.installed-plugin-package.v1",
  ...scope,
  pluginId: "example.story",
  version: "1.2.3-rc.1+build.7",
  publisherId: "example.publisher",
  packageDigest: digest,
  installedAt: at,
  installedByPrincipalId: "principal-owner",
  installedByActorId: "actor-device",
};
const selected: PluginSelection = {
  schemaVersion: "crewon.plugin-selection.v1",
  ...scope,
  pluginId: installed.pluginId,
  publisherId: installed.publisherId,
  revision: 1,
  state: "disabled",
  selectedPackageDigest: digest,
  updatedAt: at,
  updatedByPrincipalId: "principal-owner",
  updatedByActorId: "actor-device",
};

function rejects(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof PluginInstallationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("installation records detach immutable profile and independent principal/actor audit", () => {
  const source = { ...installed };
  const record = parseInstalledPluginPackage(source);
  const profile = parsePluginProfileScope(scope);
  const selection = parsePluginSelection(selected);
  assert.notEqual(record, source);
  assert.notEqual(profile, scope);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(selection));
  source.installedByPrincipalId = "changed-principal";
  source.installedByActorId = "changed-actor";
  source.profileId = "changed-profile";
  assert.equal(record.installedByPrincipalId, "principal-owner");
  assert.equal(record.installedByActorId, "actor-device");
  assert.equal(record.profileId, "profile-a");
  assert.deepEqual(record, installed);
  assert.deepEqual(selection, selected);
});

test("all three profile boundaries isolate package and selection references", () => {
  assertPluginProfileScope(scope, installed);
  assertPluginProfileScope(scope, selected);
  for (const field of ["tenantId", "spaceId", "profileId"] as const) {
    rejects(
      () => assertPluginProfileScope(scope, { ...installed, [field]: "other" }),
      "plugin_installation_scope_mismatch",
    );
    rejects(
      () =>
        assertPluginSelectionPackage({
          selection: selected,
          package: { ...installed, [field]: "other" },
        }),
      "plugin_installation_scope_mismatch",
    );
  }
});

test("same package identity may retain its original audit across fresh install requests", () => {
  const retry = {
    ...installed,
    installedAt: "2026-09-01T00:00:00.000Z",
    installedByPrincipalId: "second-principal",
    installedByActorId: "second-actor",
  };
  assertInstalledPluginPackageIdentity(installed, retry);
  assert.equal(installed.installedAt, at);
  assert.equal(installed.installedByPrincipalId, "principal-owner");
  for (const change of [
    { pluginId: "other.plugin" },
    { version: "2.0.0" },
    { publisherId: "other.publisher" },
    { packageDigest: `sha256:${"b".repeat(64)}` },
  ])
    rejects(
      () =>
        assertInstalledPluginPackageIdentity(installed, {
          ...retry,
          ...change,
        }),
      "plugin_installation_package_identity_conflict",
    );
});

test("selection requires the exact package namespace, publisher and digest", () => {
  assertPluginSelectionPackage({ selection: selected, package: installed });
  rejects(
    () => assertPluginSelectionPackage({ selection: selected, package: null }),
    "plugin_installation_selection_package_missing",
  );
  for (const change of [
    { pluginId: "other.plugin" },
    { publisherId: "other.publisher" },
    { packageDigest: `sha256:${"b".repeat(64)}` },
  ])
    rejects(
      () =>
        assertPluginSelectionPackage({
          selection: selected,
          package: { ...installed, ...change },
        }),
      "plugin_installation_selection_package_mismatch",
    );
});

test("logical uninstall has no selected digest and does not change immutable package history", () => {
  const uninstalled = parsePluginSelection({
    ...selected,
    revision: 2,
    state: "uninstalled",
    selectedPackageDigest: null,
  });
  assertPluginSelectionPackage({ selection: uninstalled, package: null });
  rejects(
    () =>
      assertPluginSelectionPackage({
        selection: uninstalled,
        package: installed,
      }),
    "plugin_installation_selection_package_mismatch",
  );
  rejects(
    () => parsePluginSelection({ ...selected, state: "uninstalled" }),
    "plugin_installation_selection_package_mismatch",
  );
  for (const state of ["enabled", "disabled"])
    rejects(
      () =>
        parsePluginSelection({
          ...selected,
          state,
          selectedPackageDigest: null,
        }),
      "plugin_installation_selection_package_missing",
    );
  assert.equal(parseInstalledPluginPackage(installed).packageDigest, digest);
});

test("known schema and exact fields reject owner, readiness and compatibility claims", () => {
  rejects(
    () =>
      parseInstalledPluginPackage({
        ...installed,
        schemaVersion: "crewon.installed-plugin-package.v2",
      }),
    "plugin_installation_package_schema_unsupported",
  );
  rejects(
    () =>
      parsePluginSelection({
        ...selected,
        schemaVersion: "crewon.plugin-selection.v0",
      }),
    "plugin_installation_selection_schema_unsupported",
  );
  for (const extra of [
    { ownerPrincipalId: "client-owner" },
    { nodeHealthy: true },
    { compatible: true },
  ])
    rejects(
      () => parsePluginSelection({ ...selected, ...extra }),
      "plugin_installation_fields_invalid",
    );
  rejects(
    () => parsePluginSelection({ ...selected, state: "pending" }),
    "plugin_installation_selection_state_invalid",
  );
});

test("record validation executes no getters or serialization hooks and rejects non-JSON structure", () => {
  let executions = 0;
  const hook = () => {
    executions++;
    throw new Error("must not execute");
  };
  const getter = { ...installed };
  Object.defineProperty(getter, "installedAt", { enumerable: true, get: hook });
  const hidden = { ...installed };
  Object.defineProperty(hidden, "publisherId", {
    value: installed.publisherId,
    enumerable: false,
  });
  const cyclic = { ...installed, extra: {} as Record<string, unknown> };
  cyclic.extra.self = cyclic;
  for (const value of [
    getter,
    hidden,
    { ...installed, toJSON: hook },
    { ...installed, [Symbol.iterator]: hook },
    cyclic,
  ])
    rejects(
      () => parseInstalledPluginPackage(value),
      "plugin_installation_fields_invalid",
    );
  for (const value of [
    null,
    [],
    new Date(at),
    Object.assign(Object.create({ custom: true }), installed),
  ])
    rejects(
      () => parseInstalledPluginPackage(value),
      "plugin_installation_object_invalid",
    );
  const argumentsGetter = {};
  Object.defineProperties(argumentsGetter, {
    selection: { enumerable: true, get: hook },
    package: { enumerable: true, value: installed },
  });
  rejects(
    () =>
      assertPluginSelectionPackage(
        argumentsGetter as Parameters<typeof assertPluginSelectionPackage>[0],
      ),
    "plugin_installation_fields_invalid",
  );
  assert.equal(executions, 0);
  assert.deepEqual(
    parseInstalledPluginPackage(Object.assign(Object.create(null), installed)),
    installed,
  );
});

test("complete bounded semver accepts prerelease/build and rejects numeric leading-zero aliases", () => {
  for (const version of [
    "0.0.0",
    "1.2.3-alpha.0+001",
    "1.2.3-01alpha+build.01",
    "999999999999999999999.0.0",
  ])
    assert.equal(
      parseInstalledPluginPackage({ ...installed, version }).version,
      version,
    );
  for (const version of [
    "01.0.0",
    "1.02.0",
    "1.0.03",
    "v1.0.0",
    "1.2",
    "1.2.3-01",
    "1.2.3-rc.01",
    "1.2.3-",
    "1.2.3+",
    `1.2.3+${"x".repeat(128)}`,
  ])
    rejects(
      () => parseInstalledPluginPackage({ ...installed, version }),
      "plugin_installation_version_invalid",
    );
});

test("identity and digest fields are bounded and reject illegal Unicode or alternate encodings", () => {
  assert.equal(
    parsePluginProfileScope({ ...scope, profileId: "创作空间😀" }).profileId,
    "创作空间😀",
  );
  for (const profileId of [
    "",
    " profile",
    "profile ",
    "a\u0085b",
    "a\u200bb",
    "a\ud800b",
    "a\udfffb",
    "a".repeat(129),
    "😀".repeat(65),
  ])
    rejects(
      () => parsePluginProfileScope({ ...scope, profileId }),
      "plugin_installation_identity_invalid",
    );
  for (const pluginId of ["Upper.case", "a:b", "中文", "a".repeat(129)])
    rejects(
      () => parseInstalledPluginPackage({ ...installed, pluginId }),
      "plugin_installation_namespace_invalid",
    );
  for (const packageDigest of [
    "a".repeat(64),
    `sha256:${"A".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
    `${digest}x`,
  ])
    rejects(
      () => parseInstalledPluginPackage({ ...installed, packageDigest }),
      "plugin_installation_digest_invalid",
    );
});

test("audit timestamps are canonical without introducing wall-clock ordering", () => {
  const earlier = "2026-09-01T00:00:00.000Z";
  assert.equal(
    parsePluginSelection({ ...selected, updatedAt: earlier }).updatedAt,
    earlier,
  );
  for (const installedAt of [
    "2026-10-02",
    "2026-10-02T03:00:00Z",
    "2026-10-02T03:00:00.000+00:00",
    "2026-02-30T00:00:00.000Z",
    "not-a-date",
  ])
    rejects(
      () => parseInstalledPluginPackage({ ...installed, installedAt }),
      "plugin_installation_timestamp_invalid",
    );
});

test("selection revisions remain exact positive integers and cannot overflow CAS", () => {
  for (const revision of [
    0,
    -0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    rejects(
      () => parsePluginSelection({ ...selected, revision }),
      "plugin_installation_revision_invalid",
    );
  assert.equal(
    parsePluginSelection({ ...selected, revision: Number.MAX_SAFE_INTEGER })
      .revision,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    pluginInstallationNextRevision(Number.MAX_SAFE_INTEGER - 1),
    Number.MAX_SAFE_INTEGER,
  );
  rejects(
    () => pluginInstallationNextRevision(Number.MAX_SAFE_INTEGER),
    "plugin_installation_revision_exhausted",
  );
});
