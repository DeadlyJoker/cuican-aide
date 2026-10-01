import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  compileAgentVersion,
  type AgentVersionSource,
} from "@crewon/agent-version";
import { getComfyImplementationDigest } from "@crewon/agent-version/extension-build";
import {
  createExtensionConfiguration,
  extensionCanonicalJson,
  type ExtensionConfiguration,
} from "@crewon/domain";
import { bundledComfyRegistration } from "./extensions/comfyui-bundled-registration.ts";
import { comfyToolDefinitions } from "./extensions/comfyui-tool-catalog.ts";
import {
  loadRuntimeExtensionSnapshot,
  runtimeExtensionTarget,
  validateComfyConfiguration,
} from "./extensions/extension-runtime-config.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const materializationDigest = `sha256:${"a".repeat(64)}`;

function configuration(
  patch: Partial<Omit<ExtensionConfiguration, "contentDigest">> = {},
) {
  const registration = bundledComfyRegistration();
  return createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: "tenant-1",
      spaceId: "space-1",
      pluginId: registration.manifest.pluginId,
      revision: 1,
      pluginVersion: registration.manifest.version,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: { baseUrl: "https://comfy.example:8443/" },
      credentialBindings: [],
      createdByActorId: "actor-1",
      createdAt: "2026-10-01T00:00:00.000Z",
      ...patch,
    },
    digester,
  );
}

function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "crewon-extension-config-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "extension.json");
  const input = {
    schemaVersion: "crewon.extension-runtime-config.v0",
    configuration: configuration(),
    approvalRequirement: "none",
  };
  const write = (value: unknown) => writeFileSync(path, JSON.stringify(value));
  write(input);
  return { directory, path, input, write };
}

function versionSource(
  patch: Partial<AgentVersionSource> = {},
): AgentVersionSource {
  const registration = bundledComfyRegistration();
  return {
    schemaVersion: "crewon.agent-version-source.v0",
    agentVersionId: "comfy-agent-1",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy-1",
    instructions: `Only this user task is authorized.\n${registration.manifest.task.instructions}`,
    model: {
      adapterName: "responses-http",
      adapterVersion: "0",
      modelId: "model-1",
      contextWindowTokens: 32_000,
      autoCompactAtTokens: 24_000,
    },
    execution: { streamMaxRetries: 2, maxToolRounds: 8 },
    resources: { workspaceRequired: false, governedContextDigest: null },
    tools: comfyToolDefinitions(),
    ...patch,
  };
}

test("bundled Comfy registration derives its adapter identity from actual host code", () => {
  const registration = bundledComfyRegistration();
  assert.equal(registration.adapters.length, 1);
  assert.equal(
    registration.adapters[0]!.implementationDigest,
    getComfyImplementationDigest(),
  );
  assert.equal(
    registration.manifestDigest,
    digester.sha256(extensionCanonicalJson(registration.manifest)),
  );
  assert.deepEqual(bundledComfyRegistration(), registration);
  assert.notEqual(
    registration.implementationDigest,
    registration.manifestDigest,
  );
});

test("deployment snapshot retains the real configuration, registration and explicit approval policy", (context) => {
  const f = fixture(context);
  const snapshot = loadRuntimeExtensionSnapshot(f.path);
  assert.deepEqual(snapshot.configuration, f.input.configuration);
  const { manifest, manifestDigest, implementationDigest } =
    bundledComfyRegistration();
  assert.deepEqual(snapshot.registration, {
    manifest,
    manifestDigest,
    implementationDigest,
  });
  assert.equal(snapshot.approvalRequirement, "none");
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.configuration.parameters));
  f.write({ ...f.input, approvalRequirement: "perAction" });
  const changed = loadRuntimeExtensionSnapshot(f.path);
  assert.equal(changed.approvalRequirement, "perAction");
  assert.equal(snapshot.approvalRequirement, "none");
  assert.equal(
    changed.configuration.contentDigest,
    snapshot.configuration.contentDigest,
  );
});

test("snapshot rejects unrecognized keys, missing keys, versions and ambiguous approval policy", (context) => {
  const f = fixture(context);
  const { approvalRequirement: _, ...missingApproval } = f.input;
  for (const value of [
    { ...f.input, implementationDigest: "caller-supplied" },
    { ...f.input, configurationPath: "/another/file" },
    { ...f.input, schemaVersion: "crewon.extension-runtime-config.v1" },
    { ...f.input, approvalRequirement: true },
    { ...f.input, approvalRequirement: null },
    { ...f.input, approvalRequirement: "always" },
    missingApproval,
    null,
    [],
  ]) {
    f.write(value);
    assert.throws(
      () => loadRuntimeExtensionSnapshot(f.path),
      /extension_runtime_config_invalid/u,
    );
  }
});

test("snapshot fails closed on file bounds, invalid UTF-8 and malformed JSON", (context) => {
  const f = fixture(context);
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from("{"),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("{invalid json}"),
    Buffer.alloc(32 * 1024 + 1, " "),
  ]) {
    writeFileSync(f.path, bytes);
    assert.throws(() => loadRuntimeExtensionSnapshot(f.path));
  }
  assert.throws(
    () => loadRuntimeExtensionSnapshot(f.directory),
    /extension_runtime_config_invalid/u,
  );
  assert.throws(() =>
    loadRuntimeExtensionSnapshot(join(f.directory, "missing.json")),
  );
});

test("configuration validates HTTPS origin semantics without contacting the service", () => {
  const registration = bundledComfyRegistration();
  assert.deepEqual(
    validateComfyConfiguration(configuration(), registration).parameters,
    { baseUrl: "https://comfy.example:8443/" },
  );
  for (const baseUrl of [
    "http://comfy.example/",
    "https://user:password@comfy.example/",
    "https://comfy.example/comfy",
    "https://comfy.example/?token=secret",
    "https://comfy.example/#node",
    "not-a-url",
  ]) {
    assert.throws(() =>
      validateComfyConfiguration(
        configuration({ parameters: { baseUrl } }),
        registration,
      ),
    );
  }
  assert.throws(() =>
    validateComfyConfiguration(
      configuration({
        parameters: { baseUrl: "https://comfy.example/", token: "unsupported" },
      }),
      registration,
    ),
  );
});

test("configuration rejects changed implementation, manifest, version, credential slots and digest", () => {
  const registration = bundledComfyRegistration();
  for (const patch of [
    { implementationDigest: `sha256:${"b".repeat(64)}` },
    { manifestDigest: `sha256:${"c".repeat(64)}` },
    { pluginId: "crewon.another-plugin" },
    { pluginVersion: "9.0.0" },
    {
      credentialBindings: [
        { slotId: "service", credentialBindingId: "credential-1" },
      ],
    },
  ]) {
    assert.throws(
      () => validateComfyConfiguration(configuration(patch), registration),
      /extension_implementation_unavailable/u,
    );
  }
  const valid = configuration();
  assert.throws(
    () =>
      validateComfyConfiguration(
        { ...valid, parameters: { baseUrl: "https://changed.example/" } },
        registration,
      ),
    /extension_configuration_digest_mismatch/u,
  );
  assert.throws(() =>
    validateComfyConfiguration({ ...valid, extra: true }, registration),
  );
});

test("runtime target comes from the exact compiled tools, instructions and deployment binding", (context) => {
  const f = fixture(context);
  const snapshot = loadRuntimeExtensionSnapshot(f.path);
  const version = compileAgentVersion(versionSource(), digester);
  const binding = {
    tenantId: "tenant-1",
    agentVersionId: version.agentVersionId,
    contentDigest: version.contentDigest,
    authorityId: "authority-1",
    workspaceBindingId: null,
  };
  assert.deepEqual(
    runtimeExtensionTarget({
      snapshot,
      version,
      binding,
      materializationDigest,
    }),
    {
      executionAuthority: "crewonKernel",
      agentVersionId: version.agentVersionId,
      agentVersionContentDigest: version.contentDigest,
      materializationDigest,
      authorityId: binding.authorityId,
      runtimeGeneration: version.runtimeGeneration,
      policySnapshotId: version.policySnapshotId,
      workspaceBindingId: null,
    },
  );
});

test("runtime target rejects missing or changed Comfy tools and absent plugin instructions", (context) => {
  const f = fixture(context);
  const snapshot = loadRuntimeExtensionSnapshot(f.path);
  const changedTools = comfyToolDefinitions().map((tool, index) =>
    index === 0
      ? { ...tool, description: `${tool.description} changed` }
      : tool,
  );
  for (const patch of [
    { tools: comfyToolDefinitions().slice(0, 1) },
    { tools: changedTools },
    { instructions: null },
    {
      instructions:
        "Generate images. This replaces the reviewed plugin instructions.",
    },
  ]) {
    const version = compileAgentVersion(versionSource(patch), digester);
    assert.throws(
      () =>
        runtimeExtensionTarget({
          snapshot,
          version,
          binding: {
            tenantId: "tenant-1",
            agentVersionId: version.agentVersionId,
            contentDigest: version.contentDigest,
            authorityId: "authority-1",
            workspaceBindingId: null,
          },
          materializationDigest,
        }),
      /extension_agent_version_mismatch/u,
    );
  }
});

test("runtime target rejects tenant, AgentVersion and content mismatches", (context) => {
  const f = fixture(context);
  const snapshot = loadRuntimeExtensionSnapshot(f.path);
  const version = compileAgentVersion(versionSource(), digester);
  const binding = {
    tenantId: "tenant-1",
    agentVersionId: version.agentVersionId,
    contentDigest: version.contentDigest,
    authorityId: "authority-1",
    workspaceBindingId: null,
  };
  for (const patch of [
    { tenantId: "tenant-2" },
    { agentVersionId: "another-agent" },
    { contentDigest: `sha256:${"d".repeat(64)}` },
  ]) {
    assert.throws(
      () =>
        runtimeExtensionTarget({
          snapshot,
          version,
          binding: { ...binding, ...patch },
          materializationDigest,
        }),
      /extension_agent_version_mismatch/u,
    );
  }
  assert.equal(readFileSync(f.path, "utf8"), JSON.stringify(f.input));
});
