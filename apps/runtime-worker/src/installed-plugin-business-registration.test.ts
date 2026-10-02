import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createExtensionConfiguration } from "@crewon/domain";
import {
  assertInstalledPluginBusinessRegistration,
  loadInstalledPluginBusinessRegistration,
  revalidateInstalledPluginBusinessRegistration,
  validateInstalledPluginConfiguration,
} from "./plugins/installed-plugin-business-registration.ts";
import {
  businessConfiguration,
  businessDigester,
  businessManifest,
  businessPackageFixture,
  businessSignal,
} from "./installed-plugin-business.test-support.ts";

test("actual installed business metadata registers a non-Comfy capability without executing its Node entry", async (t) => {
  const key = `business-metadata-${randomUUID()}`;
  const records = globalThis as unknown as Record<string, unknown>;
  t.after(() => delete records[key]);
  const f = await businessPackageFixture(t, {
    node: `globalThis[${JSON.stringify(key)}] = 'executed'; throw new Error('metadata_must_not_import');`,
  });
  const registration = await f.load();
  assert.equal(records[key], undefined);
  assert.equal(f.controls.reads, 1);
  assert.deepEqual(registration.manifest, businessManifest);
  assert.deepEqual(registration.identity, {
    pluginId: f.installed.descriptor.pluginId,
    publisherId: f.installed.descriptor.publisherId,
    version: f.installed.descriptor.version,
    packageDigest: f.installed.packageDigest,
  });
  assert.equal(Object.isFrozen(registration), true);
  assert.equal(Object.isFrozen(registration.manifest), true);
  assert.doesNotThrow(() =>
    assertInstalledPluginBusinessRegistration(registration),
  );
  const configured = businessConfiguration(registration);
  assert.deepEqual(
    validateInstalledPluginConfiguration(registration, configured),
    configured,
  );
  assert.deepEqual(configured.parameters, { organization: "Fixture company" });
  assert.equal("baseUrl" in configured.parameters, false);
});

test("a copied registration cannot acquire the installed-byte authority of its original", async (t) => {
  const f = await businessPackageFixture(t);
  const registration = await f.load();
  const configuration = businessConfiguration(registration);
  for (const copy of [{ ...registration }, structuredClone(registration)]) {
    assert.throws(
      () => assertInstalledPluginBusinessRegistration(copy),
      /installed_plugin_business_registration_unverified/u,
    );
    assert.throws(
      () => validateInstalledPluginConfiguration(copy, configuration),
      /installed_plugin_business_registration_unverified/u,
    );
    await assert.rejects(
      revalidateInstalledPluginBusinessRegistration(copy, businessSignal()),
      /installed_plugin_business_registration_unverified/u,
    );
  }
  assert.equal(f.controls.reads, 1);
});

test("installed business input accessors cannot execute before the verified metadata reader", async (t) => {
  const f = await businessPackageFixture(t);
  let reads = 0;
  for (const name of ["installRoot", "authorizeRead", "signal"] as const) {
    const input = { ...f.input };
    Object.defineProperty(input, name, {
      enumerable: true,
      get() {
        reads++;
        throw new Error("input_accessor_must_not_run");
      },
    });
    await assert.rejects(
      loadInstalledPluginBusinessRegistration(input),
      /installed_plugin_business_input_invalid/u,
    );
  }
  assert.equal(reads, 0);
  assert.equal(f.controls.reads, 0);
  const fakeSignal = {
    throwIfAborted() {
      reads++;
    },
  } as AbortSignal;
  await assert.rejects(
    loadInstalledPluginBusinessRegistration({
      ...f.input,
      signal: fakeSignal,
    }),
    /installed_plugin_business_input_invalid/u,
  );
  const registration = await f.load();
  await assert.rejects(
    revalidateInstalledPluginBusinessRegistration(registration, fakeSignal),
    /installed_plugin_business_input_invalid/u,
  );
  assert.equal(reads, 0);
  assert.equal(f.controls.reads, 1);
});

test("identical business declarations keep their manifest identity while different installed implementation bytes get different implementation identities", async (t) => {
  const first = await businessPackageFixture(t, {
    node: "// implementation one\n",
  });
  const second = await businessPackageFixture(t, {
    node: "// implementation two\n",
  });
  const a = await first.load();
  const b = await second.load();
  assert.deepEqual(a.manifest, b.manifest);
  assert.equal(a.manifestDigest, b.manifestDigest);
  assert.notEqual(a.identity.packageDigest, b.identity.packageDigest);
  assert.notEqual(a.implementationDigest, b.implementationDigest);
  assert.deepEqual(await first.load(), a);
});

test("metadata authorization is current on initial load and every later materialization recheck", async (t) => {
  const f = await businessPackageFixture(t);
  const registration = await f.load();
  await revalidateInstalledPluginBusinessRegistration(
    registration,
    businessSignal(),
  );
  f.controls.allowed = false;
  await assert.rejects(f.load(), /plugin_business_manifest_read_denied/u);
  await assert.rejects(
    revalidateInstalledPluginBusinessRegistration(
      registration,
      businessSignal(),
    ),
    /plugin_business_manifest_read_denied/u,
  );
  assert.equal(f.controls.reads, 4);
});

test("revalidation rejects changed installed manifest or Node bytes rather than trusting the previous registration", async (t) => {
  for (const path of ["business.json", "entry.mjs"]) {
    await t.test(path, async (child) => {
      const f = await businessPackageFixture(child);
      const registration = await f.load();
      const installedPath = join(f.installed.directory, path);
      const bytes = await readFile(installedPath);
      const changed = Buffer.from(bytes);
      changed[0] = changed[0] === 32 ? 33 : 32;
      await chmod(installedPath, 0o600);
      await writeFile(installedPath, changed);
      await assert.rejects(
        revalidateInstalledPluginBusinessRegistration(
          registration,
          businessSignal(),
        ),
        /plugin_package_file_digest_mismatch/u,
      );
    });
  }
});

test("package identity and required execution service must actually match the business declaration", async (t) => {
  const mismatched = await businessPackageFixture(t, { version: "1.0.1" });
  await assert.rejects(
    mismatched.load(),
    /installed_plugin_business_identity_mismatch/u,
  );
  for (const requires of [
    [],
    [{ service: "crewon.execution", apiVersion: "2", optional: false }],
    [
      { service: "crewon.execution", apiVersion: "1", optional: false },
      { service: "example.required", apiVersion: "1", optional: false },
    ],
  ]) {
    const f = await businessPackageFixture(t, { requires });
    await assert.rejects(
      f.load(),
      /installed_plugin_business_execution_unavailable/u,
    );
  }
});

test("configuration identity drift and unsupported credential references cannot become an executable business configuration", async (t) => {
  const f = await businessPackageFixture(t, {
    manifest: {
      ...businessManifest,
      credentialSlots: [{ id: "provider", title: "Provider credential" }],
    },
  });
  const registration = await f.load();
  const configuration = businessConfiguration(registration);
  for (const patch of [
    { pluginId: "example.foreign" },
    { pluginVersion: "1.0.1" },
    { manifestDigest: businessDigester.sha256("foreign manifest") },
    { implementationDigest: businessDigester.sha256("foreign implementation") },
  ]) {
    const altered = createExtensionConfiguration(
      { ...configuration, ...patch },
      businessDigester,
    );
    assert.throws(
      () => validateInstalledPluginConfiguration(registration, altered),
      /installed_plugin_business_configuration_mismatch/u,
    );
  }
  const credentials = createExtensionConfiguration(
    {
      ...configuration,
      credentialBindings: [
        { slotId: "provider", credentialBindingId: "host-secret-reference" },
      ],
    },
    businessDigester,
  );
  assert.throws(
    () => validateInstalledPluginConfiguration(registration, credentials),
    /installed_plugin_business_credentials_unavailable/u,
  );
  const invalid = createExtensionConfiguration(
    { ...configuration, parameters: { baseUrl: "https://fixture.invalid" } },
    businessDigester,
  );
  assert.throws(
    () => validateInstalledPluginConfiguration(registration, invalid),
    /extension_configuration_invalid/u,
  );
});

test("an already aborted read or revalidation never reaches metadata authority", async (t) => {
  const f = await businessPackageFixture(t);
  const registration = await f.load();
  const controller = new AbortController();
  const reason = new Error("fixture_business_read_cancelled");
  controller.abort(reason);
  await assert.rejects(
    loadInstalledPluginBusinessRegistration({
      ...f.input,
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
  await assert.rejects(
    revalidateInstalledPluginBusinessRegistration(
      registration,
      controller.signal,
    ),
    (error) => error === reason,
  );
  assert.equal(f.controls.reads, 1);
});
