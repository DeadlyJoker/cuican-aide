import assert from "node:assert/strict";
import test from "node:test";
import {
  ExtensionManifestError,
  parseExtensionManifest,
} from "./extension-manifest.ts";
import { extensionManifestFixture } from "./extension-manifest.test-support.ts";

function manifest(count = 32) {
  const original = extensionManifestFixture();
  return {
    ...original,
    schemaVersion: "crewon.extension-manifest.v2",
    hostApi: "crewon.extensions.v1",
    tools: Array.from({ length: count }, (_, index) => ({
      ...original.tools[0]!,
      operationId: `operation_${index}`,
    })),
  };
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof ExtensionManifestError && error.code === code;
}

test("business manifest v2 preserves all 32 tools through immutable JSON roundtrip", () => {
  const input = manifest();
  const parsed = parseExtensionManifest(input);
  assert.equal(parsed.schemaVersion, "crewon.extension-manifest.v2");
  assert.equal(parsed.hostApi, "crewon.extensions.v1");
  assert.equal(parsed.tools.length, 32);
  assert.deepEqual(
    parseExtensionManifest(JSON.parse(JSON.stringify(parsed))),
    parsed,
  );
  input.tools[31]!.description = "Caller changed after publication";
  assert.notEqual(parsed.tools[31]!.description, input.tools[31]!.description);
  assert.ok(Object.isFrozen(parsed.tools));
  assert.ok(Object.isFrozen(parsed.tools[31]!.inputSchema.properties));
});

test("v2 is explicitly bounded and does not change v0 or v1 limits", () => {
  assert.throws(
    () => parseExtensionManifest(manifest(33)),
    hasCode("extension_collection_invalid"),
  );
  assert.throws(
    () => parseExtensionManifest(manifest(0)),
    hasCode("extension_collection_invalid"),
  );
  assert.throws(
    () =>
      parseExtensionManifest({
        ...manifest(25),
        schemaVersion: "crewon.extension-manifest.v1",
      }),
    hasCode("extension_collection_invalid"),
  );
  assert.throws(
    () =>
      parseExtensionManifest({
        ...manifest(17),
        schemaVersion: "crewon.extension-manifest.v0",
        hostApi: "crewon.extensions.v0",
      }),
    hasCode("extension_collection_invalid"),
  );
  assert.equal(
    parseExtensionManifest({
      ...manifest(24),
      schemaVersion: "crewon.extension-manifest.v1",
    }).tools.length,
    24,
  );
  assert.equal(
    parseExtensionManifest({
      ...manifest(16),
      schemaVersion: "crewon.extension-manifest.v0",
      hostApi: "crewon.extensions.v0",
    }).tools.length,
    16,
  );
});

test("v2 keeps existing host, field, credential, schema and policy validation", () => {
  for (const patch of [
    { hostApi: "crewon.extensions.v0" },
    { hostApi: "crewon.extensions.v2" },
    { schemaVersion: "crewon.extension-manifest.v3" },
  ]) {
    assert.throws(
      () => parseExtensionManifest({ ...manifest(), ...patch }),
      hasCode("extension_host_incompatible"),
    );
  }
  assert.throws(
    () => parseExtensionManifest({ ...manifest(), routes: [] }),
    hasCode("extension_manifest_fields_invalid"),
  );
  const input = manifest();
  assert.throws(
    () =>
      parseExtensionManifest({
        ...input,
        task: { ...input.task, instructions: "x".repeat(4_001) },
      }),
    hasCode("extension_text_invalid"),
  );
  assert.throws(
    () =>
      parseExtensionManifest({
        ...input,
        credentialSlots: Array.from({ length: 9 }, (_, i) => ({
          id: `slot_${i}`,
          title: "Credential",
        })),
      }),
    hasCode("extension_collection_invalid"),
  );
  assert.throws(
    () =>
      parseExtensionManifest({
        ...input,
        tools: [{ ...input.tools[0], recovery: "replaySafe" }],
      }),
    hasCode("extension_tool_policy_invalid"),
  );
  assert.throws(
    () =>
      parseExtensionManifest({
        ...input,
        tools: [...input.tools.slice(0, 31), input.tools[0]],
      }),
    hasCode("extension_operation_duplicate"),
  );
  assert.throws(
    () =>
      parseExtensionManifest({
        ...input,
        task: {
          ...input.task,
          inputSchema: {
            ...input.task.inputSchema,
            $ref: "https://example.invalid/schema",
          },
        },
      }),
    hasCode("extension_schema_invalid"),
  );
});
