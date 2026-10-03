import assert from "node:assert/strict";
import { chmod, lstat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MAX_PLUGIN_CONTROL_RESPONSE_BYTES } from "@crewon/contracts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  assertProductionPluginSourceRegistry,
  createProductionPluginSourceRegistry,
} from "./production-plugin-source-registry.ts";

test("approved source registry verifies real bytes without executing code and never publishes a private path", async (t) => {
  const f = await productionSourceFixture(t);
  const v1 = await f.source("z-report");
  const v2 = await f.source("a-report", { version: "2.0.0" });
  const config = f.configuration([v1, v2]);
  const registry = await createProductionPluginSourceRegistry(config);
  config.sources[0];
  assertProductionPluginSourceRegistry(registry);
  assert.deepEqual(
    registry.list().map((item) => item.sourceId),
    ["a-report", "z-report"],
  );
  assert.ok(!JSON.stringify(registry.list()).includes(f.root));
  assert.equal(await registry.resolveSource(v1.sourceId), v1.directory);
  assert.equal(
    registry.authorizeCandidate({
      descriptor: v1.descriptor,
      packageDigest: v1.packageDigest,
    }),
    "allow",
  );
  assert.equal(
    registry.authorizeCandidate({
      descriptor: { ...v1.descriptor, publisherId: "other.publisher" },
      packageDigest: v1.packageDigest,
    }),
    "deny",
  );
  await assert.rejects(lstat(f.marker), { code: "ENOENT" });
  assert.throws(
    () => assertProductionPluginSourceRegistry({ ...registry }),
    /production_plugin_source_registry_required/u,
  );
  assert.throws(
    () => Reflect.construct(registry.constructor, [[], config]),
    /production_plugin_source_registry_required/u,
  );
  assert.throws(
    () =>
      assertProductionPluginSourceRegistry(registry, {
        ...config,
        sources: [],
      }),
    /production_plugin_source_registry_configuration_mismatch/u,
  );
  await assert.rejects(
    registry.resolveSource(f.root),
    /production_plugin_source_not_found/u,
  );
});
test("startup refuses wrong approved identity, mutable bytes, links and public source roots", async (t) => {
  const f = await productionSourceFixture(t);
  const source = await f.source();
  for (const changed of [
    { ...source, pluginId: "other.report" },
    { ...source, publisherId: "other.publisher" },
    { ...source, version: "2.0.0" },
    { ...source, packageDigest: `sha256:${"f".repeat(64)}` },
  ])
    await assert.rejects(
      createProductionPluginSourceRegistry(f.configuration([changed])),
      /production_plugin_source_identity_mismatch/u,
    );
  await chmod(source.directory, 0o755);
  await assert.rejects(
    createProductionPluginSourceRegistry(f.configuration([source])),
    /production_plugin_source_private_directory_required/u,
  );
  await chmod(source.directory, 0o700);
  const link = join(f.root, "linked");
  await symlink(source.directory, link);
  await assert.rejects(
    createProductionPluginSourceRegistry(
      f.configuration([{ ...source, directory: link }]),
    ),
  );
  await writeFile(join(source.directory, "node.mjs"), "tampered");
  await assert.rejects(
    createProductionPluginSourceRegistry(f.configuration([source])),
  );
});
test("an approved source is reverified for each resolve and cannot change after startup approval", async (t) => {
  const f = await productionSourceFixture(t);
  const source = await f.source();
  const registry = await createProductionPluginSourceRegistry(
    f.configuration([source]),
  );
  await writeFile(join(source.directory, "node.mjs"), "tampered");
  await assert.rejects(registry.resolveSource(source.sourceId));
  assert.equal(registry.list()[0]!.packageDigest, source.packageDigest);
  await assert.rejects(lstat(f.marker), { code: "ENOENT" });
});
test("rejects sources nested in installation root and over-budget public metadata without truncation", async (t) => {
  const f = await productionSourceFixture(t);
  const source = await f.source();
  await assert.rejects(
    createProductionPluginSourceRegistry({
      ...f.configuration([source]),
      installRoot: f.root,
    }),
    /production_plugin_source_directory_conflict/u,
  );
  const sources = [];
  for (let index = 0; index < 17; index++)
    sources.push(
      await f.source(`source-${String(index).padStart(2, "0")}`, {
        pluginId: `test.report${index}`,
        description: "d".repeat(8192),
      }),
    );
  await assert.rejects(
    createProductionPluginSourceRegistry(f.configuration(sources)),
    /plugin_control_json_bytes_exceeded/u,
  );
});

test("every source page reserves its longest encoded cursor, even when the last sourceId is shorter", async (t) => {
  const f = await productionSourceFixture(t);
  const sourceIds = [
    "a" + "界".repeat(80),
    ...Array.from(
      { length: 15 },
      (_, index) => `b${String(index).padStart(2, "0")}`,
    ),
    "z",
  ];
  const views = sourceIds.map((sourceId, index) => ({
    sourceId,
    pluginId: `test.r${index}`,
    publisherId: "test.publisher",
    version: "1.0.0",
    title: "T",
    description: "d",
    packageDigest: `sha256:${"a".repeat(64)}`,
  }));
  let remaining =
    MAX_PLUGIN_CONTROL_RESPONSE_BYTES -
    2 -
    Buffer.byteLength(JSON.stringify({ sources: views, next: "z" }));
  for (let index = 0; index < views.length - 1; index++) {
    const extra = Math.min(8191, remaining);
    views[index]!.description = "d".repeat(1 + extra);
    remaining -= extra;
  }
  assert.equal(remaining, 0);
  assert.equal(
    Buffer.byteLength(JSON.stringify({ sources: views, next: "z" })),
    MAX_PLUGIN_CONTROL_RESPONSE_BYTES - 2,
  );
  const sources = [];
  for (const view of views)
    sources.push(
      await f.source(view.sourceId, {
        pluginId: view.pluginId,
        title: view.title,
        description: view.description,
      }),
    );
  await assert.rejects(
    createProductionPluginSourceRegistry(f.configuration(sources)),
    /production_plugin_source_catalog_budget_exceeded/u,
  );
});
