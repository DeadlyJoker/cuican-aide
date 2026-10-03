import assert from "node:assert/strict";
import { chmod, link, symlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import {
  parseInstalledPluginReleaseDocument,
  readInstalledPluginReleaseDocument,
} from "./plugins/installed-plugin-release-document.ts";
import { installedReleaseFixture } from "./installed-plugin-release-loader.test-support.ts";

test("release document captures full immutable package/profile/base/derived pins and never overrides the default", async (t) => {
  const f = await installedReleaseFixture(t, "sqlite", { versions: 2 });
  const parsed = parseInstalledPluginReleaseDocument(f.document);
  assert.deepEqual(parsed, f.document);
  assert.ok(
    Object.isFrozen(parsed.entries[0]!.modelSource.runtimeBinding.provider),
  );
  assert.ok(Object.isFrozen(parsed.entries[0]!.configuration.parameters));
  assert.notEqual(
    parsed.entries[0]!.packageIdentity.packageDigest,
    parsed.entries[1]!.packageIdentity.packageDigest,
  );
  Reflect.set(
    f.document.entries[0]!.configuration.parameters,
    "baseUrl",
    "mutated",
  );
  assert.equal(
    parsed.entries[0]!.configuration.parameters.baseUrl,
    "https://vendor.fixture.example/",
  );
});

test("release own-data bounds, exact fields and incompatible authority fail before any getter or fallback", async (t) => {
  const f = await installedReleaseFixture(t);
  let getters = 0;
  const accessor = { ...f.document };
  Object.defineProperty(accessor, "entries", {
    enumerable: true,
    get() {
      getters++;
      return f.document.entries;
    },
  });
  assert.throws(
    () => parseInstalledPluginReleaseDocument(accessor),
    /document_invalid/,
  );
  assert.equal(getters, 0);
  const wrong: ((input: any) => void)[] = [
    (input) => (input.extra = true),
    (input) =>
      (input.schemaVersion = "crewon.agent-version-runtime-bindings.v0"),
    (input) => (input.entries = []),
    (input) =>
      (input.entries = Array.from({ length: 33 }, () => input.entries[0])),
    (input) => input.entries.push(input.entries[0]),
    (input) => (input.entries[0].scope.profileId = ""),
    (input) => (input.entries[0].scope.tenantId = "other-tenant"),
    (input) => (input.entries[0].target.executionAuthority = "providerAgent"),
    (input) =>
      (input.entries[0].modelSource.executionAuthority = "providerAgent"),
    (input) =>
      (input.entries[0].modelSource.runtimeBinding.toolRuntimeMode = "shared"),
    (input) =>
      (input.entries[0].modelSource.runtimeBinding.extensionConfigPath =
        "/some-old-comfy.json"),
    (input) =>
      (input.defaultAgentVersionId = input.entries[0].version.agentVersionId),
    (input) =>
      (input.entries[0].target.workspaceBindingId = "another-workspace"),
    (input) =>
      (input.entries[0].modelSource.deployment.authorityId =
        "another-base-authority"),
    (input) =>
      (input.entries[0].configuration.parameters.baseUrl = "x".repeat(
        1024 * 1024,
      )),
  ];
  for (const mutate of wrong) {
    const copy = structuredClone(f.document);
    mutate(copy);
    assert.throws(() => parseInstalledPluginReleaseDocument(copy));
  }
});

test("operator release file is private single-link data and rejects unsafe delivery", async (t) => {
  const f = await installedReleaseFixture(t);
  const path = join(f.directory, "release.json");
  await writeFile(path, JSON.stringify(f.document), { mode: 0o600 });
  assert.deepEqual(readInstalledPluginReleaseDocument(path), f.document);
  await chmod(path, 0o644);
  assert.throws(() => readInstalledPluginReleaseDocument(path), /file_invalid/);
  await chmod(path, 0o600);
  const alias = join(f.directory, "alias.json");
  await symlink(path, alias);
  assert.throws(
    () => readInstalledPluginReleaseDocument(alias),
    /file_invalid/,
  );
  await link(path, join(f.directory, "hardlink.json"));
  assert.throws(() => readInstalledPluginReleaseDocument(path), /file_invalid/);
});

test("release reader rejects invalid UTF-8 inside an otherwise valid JSON string", async (t) => {
  const f = await installedReleaseFixture(t);
  const path = join(f.directory, "invalid-utf8.json");
  const bytes = Buffer.from(JSON.stringify(f.document));
  const position = bytes.indexOf(Buffer.from("vendor.fixture.example"));
  assert.ok(position > 0);
  bytes[position] = 0xff;
  const replaced = JSON.parse(bytes.toString("utf8"));
  assert.ok(
    replaced.entries[0].configuration.parameters.baseUrl.includes("\ufffd"),
  );
  await writeFile(path, bytes, { mode: 0o600 });
  assert.throws(
    () => readInstalledPluginReleaseDocument(path),
    /encoded data was not valid for encoding utf-8/,
  );
});

test("release reader rejects actual permissions changing during its bounded read", async (t) => {
  const f = await installedReleaseFixture(t);
  const path = join(f.directory, "mode-drift.json");
  await writeFile(path, JSON.stringify(f.document), { mode: 0o600 });
  const fs = createRequire(import.meta.url)(
    "node:fs",
  ) as typeof import("node:fs");
  const originalRead = fs.readSync;
  let changed = false;
  const interception = t.mock.method(fs, "readSync", (...args: any[]) => {
    const count = Reflect.apply(originalRead, fs, args) as number;
    if (!changed) {
      changed = true;
      fs.chmodSync(path, 0o644);
    }
    return count;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => readInstalledPluginReleaseDocument(path),
      /file_changed/,
    );
    assert.equal(changed, true);
    assert.equal(fs.statSync(path).mode & 0o777, 0o644);
  } finally {
    interception.mock.restore();
    syncBuiltinESMExports();
  }
});
