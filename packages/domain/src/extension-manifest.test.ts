import assert from "node:assert/strict";
import test from "node:test";
import {
  ExtensionManifestError,
  extensionToolName,
  parseExtensionManifest,
  validateExtensionConfiguration,
  validateExtensionTaskInput,
} from "./extension-manifest.ts";
import { extensionManifestFixture } from "./extension-manifest.test-support.ts";

test("parses an isolated immutable external API plugin declaration", () => {
  const input = extensionManifestFixture();
  const parsed = parseExtensionManifest(input);
  assert.equal(parsed.pluginId, "example.video");
  assert.equal(
    extensionToolName(parsed.pluginId, "submit"),
    "example_video__submit",
  );
  assert.ok(Object.isFrozen(parsed.tools[0]!.inputSchema.properties));
  input.tools[0]!.description = "Changed outside the registry";
  assert.notEqual(parsed.tools[0]!.description, input.tools[0]!.description);
});

test("validates task inputs and configuration using the existing bounded schema", () => {
  const manifest = parseExtensionManifest(extensionManifestFixture());
  assert.deepEqual(
    validateExtensionTaskInput(manifest, { prompt: "A short film" }),
    { prompt: "A short film" },
  );
  assert.deepEqual(
    validateExtensionConfiguration(manifest, { format: "mp4" }),
    { format: "mp4" },
  );
  for (const input of [
    {},
    { prompt: "ok", endpoint: "https://other.example" },
    { prompt: "a".repeat(2_001) },
  ]) {
    assert.throws(
      () => validateExtensionTaskInput(manifest, input),
      hasCode("extension_task_input_invalid"),
    );
  }
  for (const configuration of [
    { format: "avi" },
    { format: "mp4", apiKey: "secret" },
  ]) {
    assert.throws(
      () => validateExtensionConfiguration(manifest, configuration),
      hasCode("extension_configuration_invalid"),
    );
  }
});

test("rejects scripts, routes, dependencies, credentials and unknown fields", () => {
  for (const key of [
    "script",
    "endpoint",
    "dependencies",
    "apiKey",
    "permissions",
  ]) {
    assert.throws(
      () =>
        parseExtensionManifest({
          ...extensionManifestFixture(),
          [key]: "unexpected",
        }),
      hasCode("extension_manifest_fields_invalid"),
    );
  }
});

test("rejects unsupported versions, unscoped identities and dangerous schema fields", () => {
  for (const patch of [
    { schemaVersion: "crewon.extension-manifest.v1" },
    { hostApi: "crewon.extensions.v1" },
    { version: "^0.1.0" },
    { version: "01.0.0" },
    { pluginId: "unscoped" },
    { pluginId: "../plugin" },
    { description: "bad\ud800" },
  ])
    assert.throws(
      () => parseExtensionManifest({ ...extensionManifestFixture(), ...patch }),
      ExtensionManifestError,
    );
  const fixture = extensionManifestFixture();
  assert.throws(
    () =>
      parseExtensionManifest({
        ...fixture,
        task: {
          ...fixture.task,
          inputSchema: {
            ...fixture.task.inputSchema,
            $ref: "https://remote.example/schema",
          },
        },
      }),
    hasCode("extension_schema_invalid"),
  );
});

test("mutation tools cannot claim safe replay and operations cannot collide", () => {
  const input = extensionManifestFixture();
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
        tools: [input.tools[0], input.tools[0]],
      }),
    hasCode("extension_operation_duplicate"),
  );
  assert.throws(
    () =>
      parseExtensionManifest({
        ...input,
        credentialSlots: [...input.credentialSlots, ...input.credentialSlots],
      }),
    hasCode("extension_credential_slot_duplicate"),
  );
});

test("rejects over-budget definitions, cyclic data and oversized model tool names", () => {
  const input = extensionManifestFixture();
  assert.throws(
    () =>
      parseExtensionManifest({
        ...input,
        task: { ...input.task, instructions: "x".repeat(4_001) },
      }),
    hasCode("extension_text_invalid"),
  );
  const cyclic: Record<string, unknown> = { ...input.task.inputSchema };
  cyclic.properties = { next: cyclic };
  assert.throws(
    () =>
      parseExtensionManifest({
        ...input,
        task: { ...input.task, inputSchema: cyclic },
      }),
    ExtensionManifestError,
  );
  assert.throws(
    () =>
      extensionToolName(`example.${"x".repeat(40)}`, "operation_name_too_long"),
    ExtensionManifestError,
  );
  assert.throws(
    () =>
      parseExtensionManifest({
        ...input,
        tools: Array.from({ length: 17 }, () => input.tools[0]),
      }),
    hasCode("extension_collection_invalid"),
  );
});

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof ExtensionManifestError && error.code === code;
}

test("independent business v1 admits bounded multi-stage tools while v0 still refuses a seventeenth", () => {
  const original = extensionManifestFixture();
  const tools = Array.from({ length: 24 }, (_, i) => ({
    ...original.tools[0]!,
    operationId: `operation_${i}`,
  }));
  const versioned = {
    ...original,
    schemaVersion: "crewon.extension-manifest.v1",
    hostApi: "crewon.extensions.v1",
    tools,
  };
  const parsed = parseExtensionManifest(versioned);
  assert.equal(parsed.schemaVersion, "crewon.extension-manifest.v1");
  assert.equal(parsed.hostApi, "crewon.extensions.v1");
  assert.equal(parsed.tools.length, 24);
  assert.throws(
    () =>
      parseExtensionManifest({
        ...versioned,
        tools: [...tools, { ...tools[0], operationId: "operation_extra" }],
      }),
    hasCode("extension_collection_invalid"),
  );
  assert.throws(
    () => parseExtensionManifest({ ...original, tools: tools.slice(0, 17) }),
    hasCode("extension_collection_invalid"),
  );
  assert.throws(
    () =>
      parseExtensionManifest({ ...versioned, hostApi: "crewon.extensions.v0" }),
    hasCode("extension_host_incompatible"),
  );
  assert.throws(
    () =>
      parseExtensionManifest({ ...original, hostApi: "crewon.extensions.v1" }),
    hasCode("extension_host_incompatible"),
  );
  assert.deepEqual(parseExtensionManifest(original), original);
});
