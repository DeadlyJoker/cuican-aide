import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import test from "node:test";
import { createExtensionConfiguration } from "@crewon/domain";
import { installedPluginReleaseDigester } from "./plugins/installed-plugin-release-document.ts";
import { nativeAuthorityFixture } from "./installed-plugin-native-authority.test-support.ts";
import { publishNativeNetworkMetadata } from "./installed-plugin-native-authority-network.test-support.ts";
test("Native network readiness binds exact approved HTTPS URL, package, persisted configuration and complete published target while candidate is disabled", async (t) => {
  const f = await nativeAuthorityFixture(t),
    { metadata } = await publishNativeNetworkMetadata(f),
    network = f.authority.installedPluginExecution.executionIo!;
  const expected = {
    baseUrlParameter: "baseUrl",
    paths: f.document.networkGrants[0]!.paths,
  };
  assert.deepEqual(
    await network.resolveReadinessNetwork!(metadata, f.signal),
    expected,
  );
  for (const target of [
    { ...metadata.target, runtimeGeneration: "foreign-generation" },
    { ...metadata.target, policySnapshotId: "foreign-policy" },
    { ...metadata.target, materializationDigest: `sha256:${"f".repeat(64)}` },
  ])
    assert.equal(
      await network.resolveReadinessNetwork!({ ...metadata, target }, f.signal),
      null,
    );
  assert.equal(
    await network.resolveReadinessNetwork!(
      {
        ...metadata,
        identity: { ...metadata.identity, publisherId: "foreign.publisher" },
      },
      f.signal,
    ),
    null,
  );
  const changed = createExtensionConfiguration(
    {
      ...metadata.configuration,
      parameters: { baseUrl: "https://changed.example/" },
    },
    installedPluginReleaseDigester,
  );
  assert.equal(
    await network.resolveReadinessNetwork!(
      { ...metadata, configuration: changed },
      f.signal,
    ),
    null,
  );
  assert.equal(
    await f.store.loadThreadInSpace({
      tenantId: f.scope.tenantId,
      spaceId: f.scope.spaceId,
      threadId: "fabricated",
    }),
    null,
  );
});
test("Native network readiness refuses a valid-shaped release whose exact derived deployment was never activated", async (t) => {
  const f = await nativeAuthorityFixture(t),
    { metadata } = await publishNativeNetworkMetadata(f, {
      publishDerivedDeployment: false,
    });
  assert.equal(
    await f.authority.installedPluginExecution.executionIo!
      .resolveReadinessNetwork!(metadata, f.signal),
    null,
  );
});

test("Native network permission is revoked when the exact installed release file is replaced", async (t) => {
  const f = await nativeAuthorityFixture(t),
    { metadata } = await publishNativeNetworkMetadata(f),
    network = f.authority.installedPluginExecution.executionIo!;
  assert.ok(await network.resolveReadinessNetwork!(metadata, f.signal));
  const replacement = `${f.configuration.releaseDocumentPath}.replacement`;
  writeFileSync(
    replacement,
    readFileSync(f.configuration.releaseDocumentPath),
    { mode: 0o600 },
  );
  renameSync(replacement, f.configuration.releaseDocumentPath);
  assert.throws(
    () => network.resolveReadinessNetwork!(metadata, f.signal),
    /file_changed/u,
  );
});
