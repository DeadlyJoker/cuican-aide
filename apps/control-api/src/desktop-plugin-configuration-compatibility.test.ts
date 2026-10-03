import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SqliteRunStore } from "@crewon/store";
import { LoopbackExtensionHostClient } from "./extension-worker-client.ts";
import {
  nativeConfigurationActor as actor,
  nativeConfigurationFixture,
  nativeConfigurationManifest as manifest,
  nativeConfigurationSave as save,
} from "./desktop-plugin-configuration.test-support.ts";
import { nativeLegacyWorkerFixture } from "./desktop-plugin-configuration-legacy.test-support.ts";

test("Native and existing legacy namespaces retain their actual catalogs and independent configuration paths without Native task fallback", async (t) => {
  const f = await nativeConfigurationFixture(t);
  const native = await f.source("combined-business");
  const legacy = await nativeLegacyWorkerFixture(t);
  await f.open(f.configuration([native]), legacy.peer);
  assert.deepEqual(
    legacy.requests.map(({ operation }) => operation),
    ["catalog"],
  );
  await f.install(native);
  const catalog = await f.request("GET", "/api/v1/extensions");
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.deepEqual(
    catalog
      .json()
      .extensions.map((entry: { pluginId: string }) => entry.pluginId)
      .sort(),
    [native.pluginId, legacy.manifest.pluginId].sort(),
  );
  const nativeSave = await f.request(
    "PUT",
    `/api/v1/extensions/${native.pluginId}/configuration`,
    save,
    "combined-native-first-save",
  );
  assert.equal(nativeSave.statusCode, 200, nativeSave.body);
  assert.equal(nativeSave.json().configuration.pluginId, native.pluginId);
  assert.deepEqual(
    legacy.requests.map(({ operation }) => operation),
    ["catalog"],
  );
  const legacySave = await f.request(
    "PUT",
    `/api/v1/extensions/${legacy.manifest.pluginId}/configuration`,
    save,
    "combined-legacy-first-save",
  );
  assert.equal(legacySave.statusCode, 200, legacySave.body);
  assert.equal(
    legacySave.json().configuration.implementationDigest,
    legacy.registration.implementationDigest,
  );
  assert.deepEqual(
    legacy.requests.map(({ operation }) => operation),
    ["catalog", "validateConfiguration"],
  );
  assert.deepEqual(legacy.requests[1]!.actor, actor);
  assert.equal(legacy.requests[1]!.operation, "validateConfiguration");
  if (legacy.requests[1]!.operation === "validateConfiguration")
    assert.equal(
      legacy.requests[1]!.registration.pluginId,
      legacy.manifest.pluginId,
    );
  const legacyReplay = await f.request(
    "PUT",
    `/api/v1/extensions/${legacy.manifest.pluginId}/configuration`,
    save,
    "combined-legacy-first-save",
  );
  assert.equal(legacyReplay.statusCode, 200, legacyReplay.body);
  assert.equal(legacyReplay.json().disposition, "replayed");
  assert.deepEqual(
    legacy.requests.map(({ operation }) => operation),
    ["catalog", "validateConfiguration"],
  );
  for (const [kind, intent] of [
    ["generate", { kind: "generate", input: save.parameters }],
    [
      "query",
      { kind: "query", sourceRunId: randomUUID(), operationId: randomUUID() },
    ],
  ] as const) {
    const response = await f.request(
      "POST",
      `/api/v1/extensions/${native.pluginId}/tasks`,
      {
        threadId: "does-not-exist",
        expectedThreadRevision: 1,
        intent,
      },
      `native-cannot-use-legacy-${kind}`,
    );
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, "authorization_denied");
  }
  const oldTask = await f.request(
    "POST",
    `/api/v1/extensions/${legacy.manifest.pluginId}/tasks`,
    {
      threadId: "does-not-exist",
      expectedThreadRevision: 1,
      intent: { kind: "generate", input: save.parameters },
    },
    "legacy-original-thread-check",
  );
  assert.equal(oldTask.statusCode, 404, oldTask.body);
  assert.equal(oldTask.json().error.code, "thread_not_found");
  assert.deepEqual(
    legacy.requests.map(({ operation }) => operation),
    ["catalog", "validateConfiguration"],
  );
  assert.equal(f.facts().counts.extension_configurations, 2);
  assert.equal(f.facts().counts.extension_mutation_receipts, 2);
  await f.assertMetadataOnly();
});

test("An approved Native namespace duplicated by the actual old Worker catalog is rejected at startup and releases every actual owner", async (t) => {
  const f = await nativeConfigurationFixture(t);
  const pkg = await f.source("duplicate-native-business");
  const legacy = await nativeLegacyWorkerFixture(t, manifest.pluginId);
  let closedStore: SqliteRunStore | undefined;
  const clientClose = LoopbackExtensionHostClient.prototype.close;
  let closedClients = 0;
  t.mock.method(
    LoopbackExtensionHostClient.prototype,
    "close",
    async function (this: LoopbackExtensionHostClient) {
      await clientClose.call(this);
      closedClients++;
    },
  );
  const storeClose = SqliteRunStore.prototype.close;
  t.mock.method(
    SqliteRunStore.prototype,
    "close",
    async function (this: SqliteRunStore) {
      await storeClose.call(this);
      closedStore = this;
    },
  );
  await assert.rejects(
    f.open(f.configuration([pkg]), legacy.peer),
    /desktop_plugin_extension_namespace_conflict/u,
  );
  assert.equal(closedClients, 1);
  assert.ok(closedStore);
  await assert.rejects(
    closedStore.loadThread({ tenantId: actor.tenantId, threadId: "unused" }),
    /store_closed/u,
  );
  assert.deepEqual(
    legacy.requests.map(({ operation }) => operation),
    ["catalog"],
  );
  // Actual profile lock released; no new approval or ledger was fabricated for recovery.
  await f.open(f.configuration([pkg]));
  await f.install(pkg);
  const saved = await f.request(
    "PUT",
    `/api/v1/extensions/${pkg.pluginId}/configuration`,
    save,
    "after-conflict-recovered-save",
  );
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(f.facts().counts.extension_configurations, 1);
  await f.assertMetadataOnly();
});

test("Fully withdrawn Native approval retains its durable namespace and cannot read, save, replay or execute through the old Worker", async (t) => {
  const f = await nativeConfigurationFixture(t);
  const pkg = await f.source("fully-withdrawn-business");
  await f.open(f.configuration([pkg]));
  await f.install(pkg);
  const original = await f.request(
    "PUT",
    `/api/v1/extensions/${pkg.pluginId}/configuration`,
    save,
    "before-full-approval-withdrawal",
  );
  assert.equal(original.statusCode, 200, original.body);
  await f.close();
  const legacy = await nativeLegacyWorkerFixture(t);
  await f.open(f.configuration([]), legacy.peer);
  const sources = await f.request("GET", "/api/v1/plugins/sources?limit=10");
  assert.equal(sources.statusCode, 200, sources.body);
  assert.deepEqual(sources.json().sources, []);
  const selection = await f.request(
    "GET",
    `/api/v1/plugins/selections/${pkg.pluginId}`,
  );
  assert.equal(selection.statusCode, 200, selection.body);
  assert.equal(selection.json().selection.state, "disabled");
  assert.equal(
    selection.json().selection.selectedPackageDigest,
    pkg.packageDigest,
  );
  const before = f.facts();
  const read = await f.request(
    "GET",
    `/api/v1/extensions/${pkg.pluginId}/configuration?revision=1`,
  );
  assert.equal(read.statusCode, 403, read.body);
  assert.equal(read.json().error.code, "authorization_denied");
  assert.ok(!read.body.includes(save.parameters.organization));
  const fresh = await f.request(
    "PUT",
    `/api/v1/extensions/${pkg.pluginId}/configuration`,
    {
      ...save,
      expectedRevision: 1,
      parameters: { organization: "Forbidden after full approval withdrawal" },
    },
    "fully-withdrawn-new-save",
  );
  assert.equal(fresh.statusCode, 403, fresh.body);
  assert.equal(fresh.json().error.code, "authorization_denied");
  const replay = await f.request(
    "PUT",
    `/api/v1/extensions/${pkg.pluginId}/configuration`,
    save,
    "before-full-approval-withdrawal",
  );
  assert.equal(replay.statusCode, 403, replay.body);
  assert.equal(replay.json().error.code, "authorization_denied");
  for (const [kind, intent] of [
    ["generate", { kind: "generate", input: save.parameters }],
    [
      "query",
      { kind: "query", sourceRunId: randomUUID(), operationId: randomUUID() },
    ],
  ] as const) {
    const response = await f.request(
      "POST",
      `/api/v1/extensions/${pkg.pluginId}/tasks`,
      {
        threadId: "withdrawn-native-thread-does-not-exist",
        expectedThreadRevision: 1,
        intent,
      },
      `fully-withdrawn-no-legacy-${kind}`,
    );
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, "authorization_denied");
  }
  assert.deepEqual(
    f.facts(),
    before,
    "all revoked Native requests preserve the actual SQLite rows and schemas",
  );
  assert.equal(before.counts.extension_configurations, 1);
  assert.equal(before.counts.extension_mutation_receipts, 1);
  assert.deepEqual(
    legacy.requests.map(({ operation }) => operation),
    ["catalog"],
  );
  // A different old namespace keeps its original authenticated configuration path.
  const oldSave = await f.request(
    "PUT",
    `/api/v1/extensions/${legacy.manifest.pluginId}/configuration`,
    save,
    "legacy-after-native-approval-withdrawal",
  );
  assert.equal(oldSave.statusCode, 200, oldSave.body);
  assert.equal(oldSave.json().configuration.pluginId, legacy.manifest.pluginId);
  assert.equal(
    oldSave.json().configuration.implementationDigest,
    legacy.registration.implementationDigest,
  );
  assert.deepEqual(
    legacy.requests.map(({ operation }) => operation),
    ["catalog", "validateConfiguration"],
  );
  assert.equal(f.facts().counts.extension_configurations, 2);
  assert.equal(f.facts().counts.extension_mutation_receipts, 2);
  await f.assertMetadataOnly();
});

for (const state of ["disabled", "uninstalled"] as const) {
  test(`Fully withdrawn Native ${state} history still conflicts with an actual same-name old Worker and releases startup owners`, async (t) => {
    const f = await nativeConfigurationFixture(t);
    const pkg = await f.source(`retained-${state}-business`);
    await f.open(f.configuration([pkg]));
    await f.install(pkg);
    const original = await f.request(
      "PUT",
      `/api/v1/extensions/${pkg.pluginId}/configuration`,
      save,
      `before-retained-${state}-withdrawal`,
    );
    assert.equal(original.statusCode, 200, original.body);
    if (state === "uninstalled")
      await f.select(
        pkg,
        1,
        "uninstalled",
        "retain-uninstalled-native-namespace",
      );
    await f.close();
    const legacy = await nativeLegacyWorkerFixture(t, pkg.pluginId);
    const clientClose = LoopbackExtensionHostClient.prototype.close;
    let closedClients = 0;
    t.mock.method(
      LoopbackExtensionHostClient.prototype,
      "close",
      async function (this: LoopbackExtensionHostClient) {
        await clientClose.call(this);
        closedClients++;
      },
    );
    const storeClose = SqliteRunStore.prototype.close;
    let closedStore: SqliteRunStore | undefined;
    t.mock.method(
      SqliteRunStore.prototype,
      "close",
      async function (this: SqliteRunStore) {
        await storeClose.call(this);
        closedStore = this;
      },
    );
    const before = f.facts();
    await assert.rejects(
      f.open(f.configuration([]), legacy.peer),
      /desktop_plugin_extension_namespace_conflict/u,
    );
    assert.deepEqual(
      legacy.requests.map(({ operation }) => operation),
      ["catalog"],
    );
    assert.equal(closedClients, 1);
    assert.ok(closedStore);
    await assert.rejects(
      closedStore.loadThread({ tenantId: actor.tenantId, threadId: "unused" }),
      /store_closed/u,
    );
    assert.deepEqual(f.facts(), before);
    // Actual profile ownership can be reclaimed with all approvals still absent.
    await f.open(f.configuration([]));
    const retained = await f.request(
      "GET",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
    );
    assert.equal(retained.statusCode, 200, retained.body);
    assert.equal(retained.json().selection.state, state);
    assert.equal(
      retained.json().selection.selectedPackageDigest,
      state === "uninstalled" ? null : pkg.packageDigest,
    );
    assert.equal(f.facts().counts.extension_configurations, 1);
    assert.equal(f.facts().counts.extension_mutation_receipts, 1);
    await f.assertMetadataOnly();
  });
}
