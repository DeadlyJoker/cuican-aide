import assert from "node:assert/strict";
import test from "node:test";
import { extensionManifestFixture } from "../../../packages/domain/src/extension-manifest.test-support.ts";
import {
  createExtensionRegistry,
  type BundledExtensionSource,
} from "./extensions/extension-registry.ts";

const implementation = `sha256:${"a".repeat(64)}`;
function source(
  sourceId: string,
  pluginId = "example.video",
): BundledExtensionSource {
  return {
    sourceId,
    manifest: extensionManifestFixture(pluginId),
    adapters: [
      {
        adapterId: "example.video-api",
        implementationDigest: implementation,
        operationIds: ["submit"],
      },
    ],
  };
}

test("empty registry does not introduce any plugin or execution behavior", () => {
  const registry = createExtensionRegistry([]);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(registry.failures(), []);
});

test("invalid declarations and missing adapters do not suppress unrelated plugins", () => {
  const registry = createExtensionRegistry([
    {
      ...source("invalid"),
      manifest: { ...extensionManifestFixture(), script: "do something" },
    },
    { ...source("missing"), adapters: [] },
    source("valid"),
  ]);
  assert.equal(registry.list().length, 1);
  assert.deepEqual(
    registry.failures().map(({ sourceId }) => sourceId),
    ["invalid", "missing"],
  );
});

test("both sides of identity or normalized tool-name conflicts fail independent of order", () => {
  for (const entries of [
    [source("a"), source("b")],
    [source("a", "example.a-b"), source("b", "example.a.b")],
  ]) {
    const forward = createExtensionRegistry([
      ...entries,
      source("unrelated", "other.video"),
    ]);
    const reversed = createExtensionRegistry(
      [...entries].reverse().concat(source("unrelated", "other.video")),
    );
    assert.deepEqual(
      forward.list().map((entry) => entry.manifest.pluginId),
      ["other.video"],
    );
    assert.deepEqual(forward.failures(), reversed.failures());
  }
});

test("retains historical versions and requires the exact adapter implementation digest", () => {
  const original = source("v1");
  const newer = {
    ...source("v2"),
    manifest: { ...extensionManifestFixture(), version: "0.2.0" },
  };
  const registry = createExtensionRegistry([newer, original]);
  const registered = registry.list()[0]!;
  assert.equal(registry.list().length, 2);
  assert.equal(
    registry.require({
      pluginId: registered.manifest.pluginId,
      version: registered.manifest.version,
      implementationDigest: registered.implementationDigest,
    }),
    registered,
  );
  const changed = createExtensionRegistry([
    {
      ...original,
      adapters: [
        {
          ...original.adapters[0]!,
          implementationDigest: `sha256:${"b".repeat(64)}`,
        },
      ],
    },
  ]).list()[0]!;
  assert.equal(changed.manifestDigest, registered.manifestDigest);
  assert.notEqual(
    changed.implementationDigest,
    registered.implementationDigest,
  );
  assert.throws(
    () =>
      registry.require({
        pluginId: changed.manifest.pluginId,
        version: changed.manifest.version,
        implementationDigest: changed.implementationDigest,
      }),
    /extension_implementation_mismatch/u,
  );
});

test("registration snapshots are isolated from caller mutation and unsupported operations fail", () => {
  const manifest = extensionManifestFixture();
  const operations = ["submit"];
  const registry = createExtensionRegistry([
    {
      ...source("valid"),
      manifest,
      adapters: [
        {
          adapterId: "example.video-api",
          implementationDigest: implementation,
          operationIds: operations,
        },
      ],
    },
  ]);
  operations.push("unexpected");
  manifest.title = "Changed";
  assert.equal(registry.list()[0]!.manifest.title, "Example external API");
  assert.deepEqual(registry.list()[0]!.adapters[0]!.operationIds, ["submit"]);
  assert.ok(Object.isFrozen(registry.list()[0]!.adapters[0]));
  const invalid = createExtensionRegistry([
    {
      ...source("missing-operation"),
      adapters: [
        {
          adapterId: "example.video-api",
          implementationDigest: implementation,
          operationIds: ["query"],
        },
      ],
    },
  ]);
  assert.equal(invalid.list().length, 0);
  assert.equal(
    invalid.failures()[0]!.code,
    "extension_adapter_operation_unavailable",
  );
});
