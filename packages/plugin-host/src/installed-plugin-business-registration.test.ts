import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createExtensionConfiguration,
  extensionCanonicalJson,
  type ExtensionManifest,
} from "@crewon/domain";
import {
  assertInstalledPluginBusinessRegistration,
  installLocalPluginPackage,
  loadInstalledPluginBusinessRegistration,
  revalidateInstalledPluginBusinessRegistration,
  validateInstalledPluginConfiguration,
  type InstalledPluginBusinessRegistration,
} from "./index.ts";
import * as workerCompatibility from "../../../apps/runtime-worker/src/plugins/installed-plugin-business-registration.ts";
import {
  allowInstallation,
  packageFixture,
} from "./local-plugin-package.test-support.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const objectSchema = {
  type: "object" as const,
  properties: {
    subject: { type: "string" as const, maxLength: 160, enum: null },
  },
  required: ["subject"],
  additionalProperties: false as const,
};
const manifest: ExtensionManifest = {
  schemaVersion: "crewon.extension-manifest.v0",
  hostApi: "crewon.extensions.v0",
  pluginId: "example.fixture",
  version: "1.0.0",
  title: "Shared installed metadata fixture",
  description: "Actual installed bytes without an execution runtime.",
  task: {
    instructions: "Inspect the selected subject.",
    inputSchema: objectSchema,
  },
  configurationSchema: objectSchema,
  credentialSlots: [{ id: "provider", title: "Provider credential" }],
  tools: [
    {
      operationId: "inspect",
      adapterId: "example.fixture.api",
      description: "Inspect one subject.",
      inputSchema: objectSchema,
      outputSchema: objectSchema,
      execution: "serial",
      effect: "readOnly",
      recovery: "replaySafe",
      capability: "example.fixture.inspect",
    },
  ],
  resultViews: ["text"],
};

async function fixture(t: TestContext) {
  const f = await packageFixture(t);
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(f.source, "business.json"), bytes);
  await f.rewriteDescriptor({
    ...f.descriptor,
    businessManifestPath: "business.json",
    requires: [
      { service: "crewon.execution", apiVersion: "1", optional: false },
    ],
    files: [
      ...f.descriptor.files,
      {
        path: "business.json",
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  });
  const installed = await installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    authorization: allowInstallation,
  });
  await rm(f.source, { recursive: true });
  const controls = { allowed: true, reads: 0 };
  const input = {
    installRoot: f.installRoot,
    expectedPluginId: installed.descriptor.pluginId,
    expectedPublisherId: installed.descriptor.publisherId,
    expectedVersion: installed.descriptor.version,
    expectedPackageDigest: installed.packageDigest,
    signal: new AbortController().signal,
    authorizeRead: async () => {
      controls.reads++;
      return controls.allowed ? ("allow" as const) : ("deny" as const);
    },
  };
  return { ...f, input, installed, controls };
}

function configuration(registration: InstalledPluginBusinessRegistration) {
  return createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: "fixture-tenant",
      spaceId: "fixture-space",
      pluginId: registration.identity.pluginId,
      pluginVersion: registration.identity.version,
      revision: 1,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: { subject: "Actual installed subject" },
      credentialBindings: [],
      createdByActorId: "fixture-actor",
      createdAt: "2026-10-03T00:00:00.000Z",
    },
    digester,
  );
}

test("shared entrypoint reads the installed copy without importing ESM and preserves the original digest recipes", async (t) => {
  const f = await fixture(t);
  const registration = await loadInstalledPluginBusinessRegistration(f.input);
  assert.deepEqual(registration.manifest, manifest);
  assert.equal(
    registration.manifestDigest,
    digester.sha256(extensionCanonicalJson(manifest)),
  );
  assert.equal(
    registration.implementationDigest,
    digester.sha256(
      extensionCanonicalJson({
        schemaVersion: "crewon.installed-plugin-implementation.v1",
        packageDigest: f.installed.packageDigest,
        node: f.installed.descriptor.entrypoints.node,
      }),
    ),
  );
  assert.equal(Object.isFrozen(registration), true);
  assert.equal(Object.isFrozen(registration.identity), true);
  assert.equal(f.controls.reads, 1);
  assert.equal(existsSync(f.marker), false);
  assert.equal(existsSync(f.source), false);
  assert.deepEqual(
    validateInstalledPluginConfiguration(
      registration,
      configuration(registration),
    ),
    configuration(registration),
  );
});

test("Worker compatibility exports share the actual Host brand and reject copied metadata", async (t) => {
  const f = await fixture(t);
  assert.equal(
    workerCompatibility.loadInstalledPluginBusinessRegistration,
    loadInstalledPluginBusinessRegistration,
  );
  assert.equal(
    workerCompatibility.assertInstalledPluginBusinessRegistration,
    assertInstalledPluginBusinessRegistration,
  );
  const shared = await loadInstalledPluginBusinessRegistration(f.input);
  assert.doesNotThrow(() =>
    workerCompatibility.assertInstalledPluginBusinessRegistration(shared),
  );
  const legacyPath =
    await workerCompatibility.loadInstalledPluginBusinessRegistration(f.input);
  assert.doesNotThrow(() =>
    assertInstalledPluginBusinessRegistration(legacyPath),
  );
  await workerCompatibility.revalidateInstalledPluginBusinessRegistration(
    shared,
    f.input.signal,
  );
  assert.deepEqual(
    workerCompatibility.validateInstalledPluginConfiguration(
      shared,
      configuration(shared),
    ),
    configuration(shared),
  );
  for (const copy of [{ ...shared }, structuredClone(shared)]) {
    assert.throws(
      () => assertInstalledPluginBusinessRegistration(copy),
      /installed_plugin_business_registration_unverified/u,
    );
    assert.throws(
      () =>
        workerCompatibility.validateInstalledPluginConfiguration(
          copy,
          configuration(shared),
        ),
      /installed_plugin_business_registration_unverified/u,
    );
    await assert.rejects(
      revalidateInstalledPluginBusinessRegistration(copy, f.input.signal),
      /installed_plugin_business_registration_unverified/u,
    );
  }
  const references = createExtensionConfiguration(
    {
      ...configuration(shared),
      credentialBindings: [
        {
          slotId: "provider",
          credentialBindingId: "private-provider-reference",
        },
      ],
    },
    digester,
  );
  assert.throws(
    () => validateInstalledPluginConfiguration(shared, references),
    /installed_plugin_business_credentials_unavailable/u,
  );
  assert.equal(existsSync(f.marker), false);
});

test("shared revalidation checks current read authority and actual immutable bytes again", async (t) => {
  const f = await fixture(t);
  const registration = await loadInstalledPluginBusinessRegistration(f.input);
  f.controls.allowed = false;
  await assert.rejects(
    workerCompatibility.revalidateInstalledPluginBusinessRegistration(
      registration,
      f.input.signal,
    ),
    /plugin_business_manifest_read_denied/u,
  );
  f.controls.allowed = true;
  await revalidateInstalledPluginBusinessRegistration(
    registration,
    f.input.signal,
  );
  const path = join(
    await f.target(f.installed.packageDigest),
    "assets/input.json",
  );
  await chmod(path, 0o600);
  await writeFile(path, '{"changed":true}');
  const previous = f.controls.reads;
  await assert.rejects(
    revalidateInstalledPluginBusinessRegistration(registration, f.input.signal),
  );
  assert.equal(f.controls.reads, previous);
  assert.equal(existsSync(f.marker), false);
});
