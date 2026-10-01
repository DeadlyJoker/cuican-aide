import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  compileAgentVersion,
  parseCompiledAgentVersion,
  type AgentVersionSource,
} from "@crewon/agent-version";
import {
  compileComfyAgentVersion,
  type ComfyAgentVersionInput,
} from "./extensions/comfyui-agent-version.ts";
import { comfyManifest } from "./extensions/comfyui-manifest.ts";
import {
  COMFY_OBSERVE_TOOL,
  COMFY_SUBMIT_TOOL,
  comfyToolDefinitions,
} from "./extensions/comfyui-tool-catalog.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
function source(patch: Partial<AgentVersionSource> = {}): AgentVersionSource {
  return {
    schemaVersion: "crewon.agent-version-source.v0",
    agentVersionId: "default-agent-version",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "base-policy",
    instructions: "Preserve these base instructions.",
    model: {
      adapterName: "responses-http",
      adapterVersion: "0+responses-lite",
      modelId: "explicit-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 1_000,
      autoCompactAtTokens: 24_000,
    },
    execution: { streamMaxRetries: 2, maxToolRounds: 16 },
    resources: {
      workspaceRequired: true,
      governedContextDigest: `sha256:${"a".repeat(64)}`,
    },
    tools: [
      {
        schemaVersion: "crewon.tool-definition.v0",
        kind: "function",
        name: "base_read",
        description: "Keep the original host tool.",
        execution: "parallel",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
    ...patch,
  };
}
function input(
  patch: Partial<AgentVersionSource> = {},
): ComfyAgentVersionInput {
  return {
    base: {
      executionAuthority: "crewonKernel",
      version: compileAgentVersion(source(patch), digester),
    },
    agentVersionId: "comfy-plugin-agent-version",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "comfy-plugin-policy",
    digester,
  };
}

test("compiles an explicit Comfy AgentVersion while preserving immutable base behavior", () => {
  const request = input();
  const before = structuredClone(request.base.version);
  const version = compileComfyAgentVersion(request);
  assert.equal(version.agentVersionId, request.agentVersionId);
  assert.equal(version.runtimeGeneration, request.runtimeGeneration);
  assert.equal(version.policySnapshotId, request.policySnapshotId);
  assert.notEqual(version.contentDigest, request.base.version.contentDigest);
  assert.equal(
    version.instructions,
    `${request.base.version.instructions}\n\n${comfyManifest().task.instructions}`,
  );
  assert.deepEqual(version.model, request.base.version.model);
  assert.deepEqual(version.execution, request.base.version.execution);
  assert.deepEqual(version.resources, request.base.version.resources);
  assert.deepEqual(version.tools.slice(0, 1), request.base.version.tools);
  assert.deepEqual(request.base.version, before);
  assert.ok(Object.isFrozen(version));
  assert.ok(Object.isFrozen(version.tools));
  assert.ok(Object.isFrozen(version.tools.at(-1)));
  assert.deepEqual(
    parseCompiledAgentVersion(JSON.stringify(version), digester),
    version,
  );
  assert.deepEqual(compileComfyAgentVersion(request), version);
});

test("includes the exact two namespaced host tool definitions and no execution policy fields", () => {
  const version = compileComfyAgentVersion(input());
  const appended = version.tools.slice(1);
  assert.deepEqual(appended, comfyToolDefinitions());
  assert.deepEqual(
    appended.map((tool) => tool.name),
    [COMFY_SUBMIT_TOOL, COMFY_OBSERVE_TOOL],
  );
  for (const tool of appended) {
    assert.equal(tool.kind, "function");
    assert.equal(tool.execution, "serial");
    assert.deepEqual(Object.keys(tool).sort(), [
      "description",
      "execution",
      "inputSchema",
      "kind",
      "name",
      "schemaVersion",
    ]);
  }
});

test("adds exact task instructions once for absent or already augmented base instructions", () => {
  const task = comfyManifest().task.instructions;
  for (const instructions of [
    null,
    "",
    task,
    `Base instructions.\n\n${task}`,
  ]) {
    const version = compileComfyAgentVersion(input({ instructions }));
    assert.equal(version.instructions?.split(task).length, 2);
    assert.equal(version.instructions, instructions || task);
  }
});

test("rejects both identical and conflicting existing Comfy tool names", () => {
  const definitions = comfyToolDefinitions();
  for (const tool of definitions) {
    for (const description of [
      tool.description,
      "Conflicting tool behavior.",
    ]) {
      assert.throws(
        () =>
          compileComfyAgentVersion(
            input({ tools: [{ ...tool, description }] }),
          ),
        /comfy_agent_version_tool_conflict/u,
      );
    }
  }
});

test("rejects provider-owned or missing execution authority before adding local capabilities", () => {
  const request = input();
  for (const executionAuthority of ["providerAgent", undefined, "unknown"]) {
    assert.throws(
      () =>
        compileComfyAgentVersion({
          ...request,
          base: { ...request.base, executionAuthority },
        } as unknown as ComfyAgentVersionInput),
      /comfy_agent_version_authority_invalid/u,
    );
  }
});

test("rejects old AgentVersion identity, invalid explicit identities and base digest drift", () => {
  const request = input();
  assert.throws(
    () =>
      compileComfyAgentVersion({
        ...request,
        agentVersionId: request.base.version.agentVersionId,
      }),
    /comfy_agent_version_id_conflict/u,
  );
  for (const patch of [
    { agentVersionId: "" },
    { runtimeGeneration: "" },
    { policySnapshotId: "" },
  ]) {
    assert.throws(() => compileComfyAgentVersion({ ...request, ...patch }));
  }
  assert.throws(
    () =>
      compileComfyAgentVersion({
        ...request,
        base: {
          ...request.base,
          version: { ...request.base.version, instructions: "tampered" },
        },
      }),
    /agent_version_digest_mismatch/u,
  );
});
