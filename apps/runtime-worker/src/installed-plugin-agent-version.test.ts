import assert from "node:assert/strict";
import test from "node:test";
import {
  compileAgentVersion,
  parseCompiledAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { ToolDefinition } from "@crewon/tool-broker";
import { compileInstalledPluginAgentVersion } from "./plugins/installed-plugin-agent-version.ts";
import { extensionToolDefinitions } from "./extensions/extension-tool-catalog.ts";
import {
  businessBaseVersion,
  businessDigester,
  businessManifest,
  businessPackageFixture,
} from "./installed-plugin-business.test-support.ts";

const hostTools: readonly ToolDefinition[] = [
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: "host_read",
    description: "Original host read capability.",
    execution: "parallel",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: "host_query",
    description: "Original host query capability.",
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

function baseVersion(
  patch: Partial<CompiledAgentVersion> = {},
): CompiledAgentVersion {
  const base = businessBaseVersion();
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: base.agentVersionId,
      runtimeGeneration: base.runtimeGeneration,
      policySnapshotId: base.policySnapshotId,
      instructions:
        patch.instructions === undefined
          ? base.instructions
          : patch.instructions,
      model: patch.model ?? base.model,
      execution: patch.execution ?? base.execution,
      resources: patch.resources ?? base.resources,
      tools: patch.tools ?? hostTools,
    },
    businessDigester,
  );
}

test("a real installed non-Comfy registration compiles a separate kernel Agent with the original model, resources, policy and host tool order intact", async (t) => {
  const f = await businessPackageFixture(t);
  const registration = await f.load();
  const base = baseVersion({
    resources: {
      workspaceRequired: true,
      governedContextDigest: businessDigester.sha256("host governed context"),
    },
  });
  const before = structuredClone(base);
  const input = {
    base: { executionAuthority: "crewonKernel" as const, version: base },
    registration,
    agentVersionId: "professional-plugin-agent",
    runtimeGeneration: "professional-generation-1",
    policySnapshotId: "professional-policy-1",
    digester: businessDigester,
  };
  const version = compileInstalledPluginAgentVersion(input);
  assert.notEqual(version.agentVersionId, base.agentVersionId);
  assert.notEqual(version.contentDigest, base.contentDigest);
  assert.equal(version.agentVersionId, input.agentVersionId);
  assert.equal(version.runtimeGeneration, input.runtimeGeneration);
  assert.equal(version.policySnapshotId, input.policySnapshotId);
  assert.equal(
    version.instructions,
    `${base.instructions}\n\n${registration.manifest.task.instructions}`,
  );
  assert.deepEqual(version.model, base.model);
  assert.deepEqual(version.execution, base.execution);
  assert.deepEqual(version.resources, base.resources);
  assert.deepEqual(version.tools.slice(0, hostTools.length), base.tools);
  assert.deepEqual(
    version.tools.slice(hostTools.length),
    extensionToolDefinitions(registration.manifest),
  );
  assert.deepEqual(base, before);
  assert.deepEqual(compileInstalledPluginAgentVersion(input), version);
  assert.deepEqual(
    parseCompiledAgentVersion(JSON.stringify(version), businessDigester),
    version,
  );
  assert.equal(Object.isFrozen(version), true);
  assert.equal(Object.isFrozen(version.tools), true);
  const tool = version.tools.at(-1)!;
  assert.equal(tool.name, "example_professional__generate");
  assert.deepEqual(Object.keys(tool).sort(), [
    "description",
    "execution",
    "inputSchema",
    "kind",
    "name",
    "schemaVersion",
  ]);
});

test("business instruction composition handles absent instructions and does not duplicate already present guidance", async (t) => {
  const f = await businessPackageFixture(t);
  const registration = await f.load();
  const task = registration.manifest.task.instructions;
  for (const instructions of [
    null,
    "",
    task,
    `Host instructions.\n\n${task}`,
  ]) {
    const version = compileInstalledPluginAgentVersion({
      base: {
        executionAuthority: "crewonKernel",
        version: baseVersion({ instructions }),
      },
      registration,
      agentVersionId: "professional-guidance-agent",
      runtimeGeneration: "professional-generation-1",
      policySnapshotId: "professional-policy-1",
      digester: businessDigester,
    });
    assert.equal(version.instructions, instructions || task);
    assert.equal(version.instructions?.split(task).length, 2);
  }
});

test("the installed Agent exposes bounded nested model schemas without Workflow null sentinels", async (t) => {
  const f = await businessPackageFixture(t, {
    manifest: {
      ...businessManifest,
      tools: [
        {
          ...businessManifest.tools[0]!,
          inputSchema: {
            type: "object",
            properties: {
              request: {
                type: "object",
                properties: {
                  labels: {
                    type: "array",
                    items: { type: "string", maxLength: 64, enum: null },
                    maxItems: 8,
                  },
                  amount: { type: "number", minimum: null, maximum: 100 },
                  count: { type: "integer", minimum: 0, maximum: null },
                  format: {
                    type: "string",
                    maxLength: 8,
                    enum: ["brief", "report"],
                  },
                },
                required: ["format"],
                additionalProperties: false,
              },
            },
            required: ["request"],
            additionalProperties: false,
          },
        },
      ],
    },
  });
  const registration = await f.load();
  const version = compileInstalledPluginAgentVersion({
    base: { executionAuthority: "crewonKernel", version: baseVersion() },
    registration,
    agentVersionId: "professional-nested-schema-agent",
    runtimeGeneration: "professional-generation-1",
    policySnapshotId: "professional-policy-1",
    digester: businessDigester,
  });
  const definition = version.tools.at(-1)!;
  assert.ok(definition.kind === "function");
  const actual = definition.inputSchema;
  assert.deepEqual(actual, {
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          labels: {
            type: "array",
            items: { type: "string", maxLength: 64 },
            maxItems: 8,
          },
          amount: { type: "number", maximum: 100 },
          count: { type: "integer", minimum: 0 },
          format: { type: "string", maxLength: 8, enum: ["brief", "report"] },
        },
        required: ["format"],
        additionalProperties: false,
      },
    },
    required: ["request"],
    additionalProperties: false,
  });
  const manifestJson = JSON.stringify(
    registration.manifest.tools[0]!.inputSchema,
  );
  assert.ok(manifestJson.includes('"enum":null'));
  assert.ok(manifestJson.includes('"minimum":null'));
  assert.ok(manifestJson.includes('"maximum":null'));
});

test("copied registrations and provider-owned bases cannot produce an installed kernel execution version", async (t) => {
  const f = await businessPackageFixture(t);
  const registration = await f.load();
  const input = {
    base: {
      executionAuthority: "crewonKernel" as const,
      version: baseVersion(),
    },
    registration,
    agentVersionId: "professional-plugin-agent",
    runtimeGeneration: "professional-generation-1",
    policySnapshotId: "professional-policy-1",
    digester: businessDigester,
  };
  for (const copy of [{ ...registration }, structuredClone(registration)])
    assert.throws(
      () =>
        compileInstalledPluginAgentVersion({ ...input, registration: copy }),
      /installed_plugin_business_registration_unverified/u,
    );
  for (const executionAuthority of ["providerAgent", undefined, "unknown"])
    assert.throws(
      () =>
        compileInstalledPluginAgentVersion({
          ...input,
          base: { ...input.base, executionAuthority },
        } as unknown as Parameters<
          typeof compileInstalledPluginAgentVersion
        >[0]),
      /installed_plugin_agent_authority_invalid/u,
    );
});

test("an installed plugin cannot overwrite an existing host tool even when its name and schema are identical", async (t) => {
  const f = await businessPackageFixture(t);
  const registration = await f.load();
  const tool = extensionToolDefinitions(registration.manifest)[0]!;
  for (const description of [
    tool.description,
    "Unrelated host implementation.",
  ])
    assert.throws(
      () =>
        compileInstalledPluginAgentVersion({
          base: {
            executionAuthority: "crewonKernel",
            version: baseVersion({ tools: [{ ...tool, description }] }),
          },
          registration,
          agentVersionId: "professional-plugin-agent",
          runtimeGeneration: "professional-generation-1",
          policySnapshotId: "professional-policy-1",
          digester: businessDigester,
        }),
      /installed_plugin_agent_tool_conflict/u,
    );
});

test("new compilation rejects reuse of the base identity and drift in the immutable base asset", async (t) => {
  const f = await businessPackageFixture(t);
  const registration = await f.load();
  const base = baseVersion();
  const input = {
    base: { executionAuthority: "crewonKernel" as const, version: base },
    registration,
    agentVersionId: "professional-plugin-agent",
    runtimeGeneration: "professional-generation-1",
    policySnapshotId: "professional-policy-1",
    digester: businessDigester,
  };
  assert.throws(
    () =>
      compileInstalledPluginAgentVersion({
        ...input,
        agentVersionId: base.agentVersionId,
      }),
    /installed_plugin_agent_id_conflict/u,
  );
  assert.throws(
    () =>
      compileInstalledPluginAgentVersion({
        ...input,
        base: {
          ...input.base,
          version: {
            ...base,
            instructions: "Unreviewed altered instructions.",
          },
        },
      }),
    /agent_version_digest_mismatch/u,
  );
  for (const patch of [
    { agentVersionId: "" },
    { runtimeGeneration: "" },
    { policySnapshotId: "" },
  ])
    assert.throws(() =>
      compileInstalledPluginAgentVersion({ ...input, ...patch }),
    );
});
