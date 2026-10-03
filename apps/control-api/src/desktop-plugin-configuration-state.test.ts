import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  nativeConfigurationFixture,
  nativeConfigurationManifest as manifest,
  nativeConfigurationSave as save,
} from "./desktop-plugin-configuration.test-support.ts";

const base = `/api/v1/extensions/${manifest.pluginId}`;

test("Native metadata follows disabled selected exact version; removed delivery bytes do not invalidate an installed copy", async (t) => {
  const f = await nativeConfigurationFixture(t);
  const v1 = await f.source("selected-v1");
  const v2 = await f.source("selected-v2", { version: "2.0.0" });
  const configuration = f.configuration([v1, v2]);
  await f.open(configuration);
  await f.install(v1);
  const original = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "selected-first-save",
  );
  assert.equal(original.statusCode, 200, original.body);
  await f.install(v2, 1);
  const staleVersion = await f.request(
    "PUT",
    `${base}/configuration`,
    {
      ...save,
      pluginVersion: "2.0.0",
      expectedRevision: 1,
    },
    "installed-but-not-selected",
  );
  assert.equal(staleVersion.statusCode, 404, staleVersion.body);
  assert.equal(staleVersion.json().error.code, "extension_version_unavailable");
  await f.select(v2, 1, "disabled", "select-disabled-v2");
  const catalog = await f.request("GET", "/api/v1/extensions");
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.equal(catalog.json().extensions.length, 1);
  assert.equal(catalog.json().extensions[0].pluginVersion, "2.0.0");
  const oldVersion = await f.request(
    "PUT",
    `${base}/configuration`,
    {
      ...save,
      expectedRevision: 1,
    },
    "selected-v2-denies-new-v1",
  );
  assert.equal(oldVersion.statusCode, 404, oldVersion.body);
  assert.equal(oldVersion.json().error.code, "extension_version_unavailable");
  await f.close();
  await rm(v2.directory, { recursive: true, force: true });
  await f.open(configuration);
  const sources = await f.request("GET", "/api/v1/plugins/sources?limit=10");
  assert.equal(sources.statusCode, 200, sources.body);
  assert.ok(
    !sources
      .json()
      .sources.some(
        (source: { sourceId: string }) => source.sourceId === v2.sourceId,
      ),
  );
  const second = await f.request(
    "PUT",
    `${base}/configuration`,
    {
      ...save,
      pluginVersion: "2.0.0",
      expectedRevision: 1,
      parameters: {
        organization: "Installed independent copy after delivery withdrawal",
      },
    },
    "selected-v2-local-copy-save",
  );
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().configuration.pluginVersion, "2.0.0");
  assert.equal(second.json().configuration.revision, 2);
  assert.notEqual(
    second.json().configuration.implementationDigest,
    original.json().configuration.implementationDigest,
  );
  const oldReplay = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "selected-first-save",
  );
  assert.equal(oldReplay.statusCode, 200, oldReplay.body);
  assert.equal(oldReplay.json().disposition, "replayed");
  assert.deepEqual(
    oldReplay.json().configuration,
    original.json().configuration,
  );
  assert.equal(f.facts().counts.extension_configurations, 2);
  await f.assertMetadataOnly();
});

test("Native uninstalled selection cannot create new configuration but original same-key receipt and history remain readable", async (t) => {
  const f = await nativeConfigurationFixture(t);
  const pkg = await f.source("uninstall-business");
  const configuration = f.configuration([pkg]);
  await f.open(configuration);
  await f.install(pkg);
  const first = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "before-uninstall-save",
  );
  assert.equal(first.statusCode, 200, first.body);
  await f.select(pkg, 1, "uninstalled", "withdraw-selected-business");
  await f.close();
  await f.open(configuration);
  const catalog = await f.request("GET", "/api/v1/extensions");
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.deepEqual(catalog.json(), { extensions: [] });
  const fresh = await f.request(
    "PUT",
    `${base}/configuration`,
    {
      ...save,
      expectedRevision: 1,
    },
    "cannot-save-withdrawn-package",
  );
  assert.equal(fresh.statusCode, 404, fresh.body);
  assert.equal(fresh.json().error.code, "extension_version_unavailable");
  const replay = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "before-uninstall-save",
  );
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().disposition, "replayed");
  assert.deepEqual(replay.json().configuration, first.json().configuration);
  const history = await f.request("GET", `${base}/configuration?revision=1`);
  assert.equal(history.statusCode, 200, history.body);
  assert.deepEqual(history.json().configuration, first.json().configuration);
  assert.equal(f.facts().counts.extension_configurations, 1);
  assert.equal(f.facts().counts.extension_mutation_receipts, 1);
  await f.assertMetadataOnly();
});

test("Native selected package outside current exact approval is rejected before a new write, with no fallback to a different approved version", async (t) => {
  const f = await nativeConfigurationFixture(t);
  const v1 = await f.source("approval-v1");
  const v2 = await f.source("approval-v2", { version: "2.0.0" });
  await f.open(f.configuration([v1, v2]));
  await f.install(v1);
  const first = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "approved-first-save",
  );
  assert.equal(first.statusCode, 200, first.body);
  await f.close();
  await f.open(f.configuration([v2]));
  const denied = await f.request(
    "PUT",
    `${base}/configuration`,
    {
      ...save,
      expectedRevision: 1,
    },
    "current-native-approval-required",
  );
  assert.equal(denied.statusCode, 500, denied.body);
  assert.equal(denied.json().error.code, "extension_service_unavailable");
  const catalog = await f.request("GET", "/api/v1/extensions");
  assert.equal(catalog.statusCode, 500, catalog.body);
  assert.equal(catalog.json().error.code, "extension_service_unavailable");
  const replay = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "approved-first-save",
  );
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().disposition, "replayed");
  assert.deepEqual(replay.json().configuration, first.json().configuration);
  assert.equal(f.facts().counts.extension_configurations, 1);
  assert.equal(f.facts().counts.extension_mutation_receipts, 1);
  await f.assertMetadataOnly();
});

test("Native corrupt installed business bytes cannot be skipped or reparsed as trusted metadata; original stored receipt is independent", async (t) => {
  const f = await nativeConfigurationFixture(t);
  const pkg = await f.source("corrupt-business");
  await f.open(f.configuration([pkg]));
  await f.install(pkg);
  const first = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "before-corruption-save",
  );
  assert.equal(first.statusCode, 200, first.body);
  const path = join(
    f.installRoot,
    "packages",
    pkg.packageDigest.slice(7),
    "business.json",
  );
  const bytes = await readFile(path);
  await chmod(path, 0o600);
  await writeFile(
    path,
    Buffer.from(
      bytes
        .toString("utf8")
        .replace("Native metadata fixture", "Altered metadata label"),
    ),
  );
  await chmod(path, 0o400);
  const denied = await f.request(
    "PUT",
    `${base}/configuration`,
    {
      ...save,
      expectedRevision: 1,
    },
    "cannot-save-corrupt-bytes",
  );
  assert.equal(denied.statusCode, 500, denied.body);
  assert.equal(denied.json().error.code, "extension_service_unavailable");
  const catalog = await f.request("GET", "/api/v1/extensions");
  assert.equal(catalog.statusCode, 500, catalog.body);
  assert.equal(catalog.json().error.code, "extension_service_unavailable");
  const replay = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "before-corruption-save",
  );
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().disposition, "replayed");
  assert.deepEqual(replay.json().configuration, first.json().configuration);
  assert.equal(f.facts().counts.extension_configurations, 1);
  assert.equal(f.facts().counts.extension_mutation_receipts, 1);
  await f.assertMetadataOnly();
});
