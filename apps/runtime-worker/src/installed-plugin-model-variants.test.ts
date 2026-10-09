import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  nativePreparationFixture,
  scope,
} from "./installed-plugin-native-preparation.test-support.ts";
import { loadInstalledPluginBusinessRegistration } from "./plugins/installed-plugin-business-registration.ts";
import {
  compileNativeInstalledPluginReleaseEntry,
  compileNativeInstalledPluginModelVariants,
} from "./plugins/installed-plugin-native-preparation-source.ts";
import { loadInstalledPluginRelease } from "./plugins/installed-plugin-release-loader.ts";
import {
  parseInstalledPluginReleaseDocument,
  INSTALLED_PLUGIN_RELEASE_SCHEMA,
} from "./plugins/installed-plugin-release-document.ts";

async function fixture(t: TestContext) {
  const f = await nativePreparationFixture(t);
  const input = await f.input();
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot: input.worker.installRoot,
    expectedPluginId: f.identity.pluginId,
    expectedPublisherId: f.identity.publisherId,
    expectedVersion: f.identity.version,
    expectedPackageDigest: f.identity.packageDigest,
    authorizeRead: async () => "allow",
    signal: new AbortController().signal,
  });
  return {
    f,
    input,
    compile: {
      bootstrapVersion: input.bootstrapVersion,
      defaultAgentVersionId: input.defaultAgentVersionId,
      environment: input.environment,
      scope,
      registration,
      configuration: f.configuration,
      approvalRequirement: "none" as const,
    },
  };
}

test("one real installed package compiles independent advertised model siblings without importing Node or expanding tools", async (t) => {
  const { f, input, compile } = await fixture(t);
  const environment = {
    ...input.environment,
    CREWON_MODEL_CATALOG_JSON: JSON.stringify([
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-image-2",
    ]),
  };
  const entries = compileNativeInstalledPluginModelVariants({
    ...compile,
    environment,
  });
  assert.deepEqual(
    entries.map((entry) => entry.version.model.modelId),
    ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
  );
  assert.equal(
    new Set(entries.map((entry) => entry.version.agentVersionId)).size,
    3,
  );
  assert.equal(
    new Set(entries.map((entry) => entry.modelSource.version.agentVersionId))
      .size,
    3,
  );
  const legacy = compileNativeInstalledPluginReleaseEntry(compile);
  for (const entry of entries) {
    assert.deepEqual(entry.packageIdentity, f.identity);
    assert.deepEqual(entry.configuration, f.configuration);
    assert.deepEqual(entry.version.tools, legacy.version.tools);
    assert.deepEqual(entry.modelSource.version.tools, []);
    assert.equal(entry.version.instructions, legacy.version.instructions);
    assert.equal(
      entry.modelSource.version.model.modelId,
      entry.version.model.modelId,
    );
    assert.equal(entry.target.agentVersionId, entry.version.agentVersionId);
    assert.equal(
      entry.target.agentVersionContentDigest,
      entry.version.contentDigest,
    );
    assert.equal(
      entry.modelSource.deployment.agentVersionId,
      entry.modelSource.version.agentVersionId,
    );
    assert.equal(
      entry.modelSource.runtimeBinding.provider.kind,
      "directResponses",
    );
    assert.ok(
      !JSON.stringify(entry).includes(input.environment.CREWON_MODEL_API_KEY!),
    );
  }
  const document = parseInstalledPluginReleaseDocument({
    schemaVersion: INSTALLED_PLUGIN_RELEASE_SCHEMA,
    tenantId: scope.tenantId,
    defaultAgentVersionId: input.defaultAgentVersionId,
    entries,
  });
  const release = await loadInstalledPluginRelease({
    document,
    installRoot: input.worker.installRoot,
    environment,
    authorizeRead: async () => "allow",
  });
  t.after(() => release.close());
  assert.deepEqual(
    release.versions.map((version) => version.model.modelId),
    entries.map((entry) => entry.version.model.modelId),
  );
  await assert.rejects(lstat(f.marker), { code: "ENOENT" });
});

test("reordered catalog and changed Key do not republish a different model identity", async (t) => {
  const { compile, input } = await fixture(t);
  const variants = (catalog: string[], apiKey: string) =>
    compileNativeInstalledPluginModelVariants({
      ...compile,
      environment: {
        ...input.environment,
        CREWON_MODEL_CATALOG_JSON: JSON.stringify(catalog),
        CREWON_MODEL_API_KEY: apiKey,
      },
    });
  const defaultModel = input.bootstrapVersion.model.modelId;
  const first = variants(
    ["gpt-5.6-sol", defaultModel, "gpt-5.6-terra"],
    "named-first-key",
  );
  const reordered = variants(
    ["gpt-5.6-terra", "gpt-5.6-sol", defaultModel],
    "named-second-key",
  );
  assert.deepEqual(first, reordered);
  assert.equal(first[0]!.version.model.modelId, defaultModel);
});

test("explicit model selection cannot revive a default omitted by discovery or admit media and arbitrary models", async (t) => {
  const { compile, input } = await fixture(t);
  const environment = {
    ...input.environment,
    CREWON_MODEL_CATALOG_JSON: JSON.stringify(["gpt-5.6-sol", "gpt-image-2"]),
  };
  for (const modelId of [
    input.bootstrapVersion.model.modelId,
    "gpt-image-2",
    "caller-invented-model",
    "gpt-5.5",
  ]) {
    assert.throws(
      () =>
        compileNativeInstalledPluginReleaseEntry({
          ...compile,
          environment,
          modelId,
        }),
      /model_not_advertised/,
    );
  }
  assert.equal(
    compileNativeInstalledPluginReleaseEntry({
      ...compile,
      environment,
      modelId: "gpt-5.6-sol",
    }).version.model.modelId,
    "gpt-5.6-sol",
  );
});

test("empty, malformed, duplicate and oversized advertised catalogs fail closed; absent legacy catalog stays byte compatible", async (t) => {
  const { compile, input } = await fixture(t);
  for (const catalog of [
    "[]",
    "not-json",
    JSON.stringify(["gpt-image-2"]),
    JSON.stringify(["m", "m"]),
    JSON.stringify(new Array(101).fill("m")),
    " ".repeat(32769),
    JSON.stringify([null]),
  ]) {
    assert.throws(
      () =>
        compileNativeInstalledPluginModelVariants({
          ...compile,
          environment: {
            ...input.environment,
            CREWON_MODEL_CATALOG_JSON: catalog,
          },
        }),
      /model_catalog_(?:empty|invalid)/,
    );
  }
  assert.deepEqual(compileNativeInstalledPluginModelVariants(compile), [
    compileNativeInstalledPluginReleaseEntry(compile),
  ]);
});
