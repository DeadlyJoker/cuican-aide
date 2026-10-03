import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  nativeConfigurationActor as actor,
  nativeConfigurationFixture,
  nativeConfigurationManifest as manifest,
  nativeConfigurationSave as save,
} from "./desktop-plugin-configuration.test-support.ts";

const base = `/api/v1/extensions/${manifest.pluginId}`;
const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(extensionCanonicalJson(value)).digest("hex")}`;

test("Native disabled installed package exposes its actual schema and saves file-backed configuration without executing or funding", async (t) => {
  const f = await nativeConfigurationFixture(t);
  const pkg = await f.source("business-v1");
  await f.open(f.configuration([pkg]));
  const installed = await f.install(pkg);
  assert.equal(installed.selection.state, "disabled");
  assert.equal(installed.selection.selectedPackageDigest, pkg.packageDigest);
  const before = await f.request("GET", `${base}/configuration`);
  assert.equal(before.statusCode, 200, before.body);
  assert.deepEqual(before.json(), { configuration: null });
  const catalog = await f.request("GET", "/api/v1/extensions");
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.equal(catalog.json().extensions.length, 1);
  assert.deepEqual(catalog.json().extensions[0], {
    pluginId: manifest.pluginId,
    pluginVersion: manifest.version,
    title: manifest.title,
    description: manifest.description,
    inputSchema: manifest.task.inputSchema,
    configurationSchema: manifest.configurationSchema,
    credentialSlots: [],
    resultViews: ["text"],
  });
  assert.ok(!catalog.body.includes(f.root));
  assert.ok(!catalog.body.includes(manifest.task.instructions));
  assert.ok(!catalog.body.includes("implementationDigest"));
  const result = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "native-first-save",
  );
  assert.equal(result.statusCode, 200, result.body);
  const saved = result.json().configuration;
  assert.equal(result.json().disposition, "created");
  assert.equal(saved.revision, 1);
  assert.equal(saved.tenantId, actor.tenantId);
  assert.equal(saved.spaceId, actor.spaceId);
  assert.equal(saved.createdByActorId, actor.actorId);
  assert.equal(saved.pluginId, pkg.pluginId);
  assert.equal(saved.pluginVersion, pkg.version);
  assert.deepEqual(saved.parameters, save.parameters);
  assert.deepEqual(saved.credentialBindings, []);
  assert.equal(saved.manifestDigest, digest(pkg.manifest));
  assert.equal(
    saved.implementationDigest,
    digest({
      schemaVersion: "crewon.installed-plugin-implementation.v1",
      packageDigest: pkg.packageDigest,
      node: "node.mjs",
    }),
  );
  assert.equal(f.facts().counts.extension_configurations, 1);
  assert.equal(f.facts().counts.extension_mutation_receipts, 1);
  const reread = await f.request("GET", `${base}/configuration?revision=1`);
  assert.equal(reread.statusCode, 200, reread.body);
  assert.deepEqual(reread.json().configuration, saved);
  const selection = await f.request(
    "GET",
    `/api/v1/plugins/selections/${pkg.pluginId}`,
  );
  assert.equal(selection.statusCode, 200, selection.body);
  assert.equal(selection.json().selection.state, "disabled");
  assert.equal(selection.json().selection.revision, 1);
  const activation = await f.request(
    "PUT",
    `${base}/activation`,
    {
      configurationRevision: 1,
      expectedRevision: 0,
      state: "enabled",
      agentVersionId: "unpublished-execution-target",
    },
    "cannot-activate-from-config",
  );
  assert.equal(activation.statusCode, 403, activation.body);
  assert.equal(activation.json().error.code, "authorization_denied");
  const task = await f.request(
    "POST",
    `${base}/tasks`,
    {
      threadId: "no-task-created",
      expectedThreadRevision: 1,
      intent: { kind: "generate", input: save.parameters },
    },
    "configuration-is-not-task-admission",
  );
  assert.equal(task.statusCode, 404, task.body);
  assert.equal(task.json().error.code, "route_not_found");
  await f.assertMetadataOnly();
});

test("Native configuration CAS and original receipts survive real Control close and SQLite reopen", async (t) => {
  const f = await nativeConfigurationFixture(t);
  const pkg = await f.source("receipt-business");
  const configuration = f.configuration([pkg]);
  await f.open(configuration);
  await f.install(pkg);
  const first = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "unknown-first-outcome",
  );
  assert.equal(first.statusCode, 200, first.body);
  const original = first.json().configuration;
  const changedKey = await f.request(
    "PUT",
    `${base}/configuration`,
    {
      ...save,
      parameters: {
        organization: "Changed body cannot reuse the original receipt",
      },
    },
    "unknown-first-outcome",
  );
  assert.equal(changedKey.statusCode, 409, changedKey.body);
  assert.equal(changedKey.json().error.code, "extension_idempotency_conflict");
  const stale = await f.request(
    "PUT",
    `${base}/configuration`,
    {
      ...save,
      parameters: { organization: "Stale revision must not overwrite" },
    },
    "stale-first-revision",
  );
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(
    stale.json().error.code,
    "extension_configuration_revision_conflict",
  );
  assert.equal(f.facts().counts.extension_configurations, 1);
  await f.close();
  await f.open(configuration);
  const replay = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "unknown-first-outcome",
  );
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().disposition, "replayed");
  assert.deepEqual(replay.json().configuration, original);
  const next = await f.request(
    "PUT",
    `${base}/configuration`,
    {
      ...save,
      expectedRevision: 1,
      parameters: { organization: "Current second revision" },
    },
    "native-second-save",
  );
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().configuration.revision, 2);
  const historical = await f.request("GET", `${base}/configuration?revision=1`);
  assert.equal(historical.statusCode, 200, historical.body);
  assert.deepEqual(historical.json().configuration, original);
  const current = await f.request("GET", `${base}/configuration`);
  assert.equal(current.statusCode, 200, current.body);
  assert.deepEqual(current.json().configuration, next.json().configuration);
  assert.equal(f.facts().counts.extension_configurations, 2);
  assert.equal(f.facts().counts.extension_mutation_receipts, 2);
  await f.assertMetadataOnly();
});

test("Native HTTP save retains actual loopback session/Origin/CSRF identity and rejects renderer-selected scope and undeclared parameters", async (t) => {
  const f = await nativeConfigurationFixture(t);
  const pkg = await f.source("identity-business");
  const runtime = await f.open(f.configuration([pkg]));
  await f.install(pkg);
  for (const [changed, status, code] of [
    [{ authorization: "Bearer invalid" }, 401, "session_invalid"],
    [{ origin: "https://foreign.example" }, 403, "origin_not_allowed"],
    [{ "x-csrf-token": "invalid" }, 403, "csrf_invalid"],
  ] as const) {
    const response = await f.request(
      "PUT",
      `${base}/configuration`,
      save,
      "denied-first-save",
      changed,
    );
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.json().error.code, code);
  }
  const remote = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/extensions",
    headers: {
      authorization: `Bearer ${"s".repeat(32)}`,
      origin: "crewon://desktop",
    },
    remoteAddress: "192.0.2.1",
  });
  assert.equal(remote.statusCode, 403, remote.body);
  assert.equal(remote.json().error.code, "standalone_loopback_required");
  for (const body of [
    { ...save, tenantId: "foreign" },
    { ...save, spaceId: "foreign" },
    { ...save, profileId: "foreign" },
    { ...save, packageDigest: pkg.packageDigest },
    {
      ...save,
      parameters: { organization: "Company", rawApiKey: "unrecognized-secret" },
    },
  ]) {
    const response = await f.request(
      "PUT",
      `${base}/configuration`,
      body,
      "invalid-renderer-input",
    );
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(f.facts().counts.extension_configurations, 0);
  assert.equal(f.facts().counts.extension_mutation_receipts, 0);
  const saved = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "actual-owner-save",
    {
      "x-actor-id": "foreign-actor",
      "x-principal-id": "foreign-person",
      "x-tenant-id": "foreign-tenant",
      "x-profile-id": "foreign-profile",
    },
  );
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().configuration.tenantId, actor.tenantId);
  assert.equal(saved.json().configuration.spaceId, actor.spaceId);
  assert.equal(saved.json().configuration.createdByActorId, actor.actorId);
  await f.assertMetadataOnly();
});

test("Native configuration does not treat a declared credential reference as an implemented credential lease", async (t) => {
  const f = await nativeConfigurationFixture(t);
  const pkg = await f.source("credential-business", {
    manifest: {
      ...manifest,
      credentialSlots: [{ id: "provider", title: "Provider credential" }],
    },
  });
  await f.open(f.configuration([pkg]));
  await f.install(pkg);
  const catalog = await f.request("GET", "/api/v1/extensions");
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.deepEqual(
    catalog.json().extensions[0].credentialSlots,
    pkg.manifest.credentialSlots,
  );
  const unavailable = await f.request(
    "PUT",
    `${base}/configuration`,
    {
      ...save,
      credentialBindings: [
        {
          slotId: "provider",
          credentialBindingId: "not-an-implemented-credential-lease",
        },
      ],
    },
    "cannot-invent-native-credential-lease",
  );
  assert.equal(unavailable.statusCode, 500, unavailable.body);
  assert.equal(unavailable.json().error.code, "extension_service_unavailable");
  assert.equal(f.facts().counts.extension_configurations, 0);
  assert.equal(f.facts().counts.extension_mutation_receipts, 0);
  const withoutLease = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "save-empty-native-credential-bindings",
  );
  assert.equal(withoutLease.statusCode, 200, withoutLease.body);
  assert.deepEqual(withoutLease.json().configuration.credentialBindings, []);
  await f.assertMetadataOnly();
});
