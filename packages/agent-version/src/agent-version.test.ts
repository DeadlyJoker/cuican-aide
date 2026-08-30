import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { ToolDefinition } from "@crewon/tool-broker";

import {
  AgentVersionError,
  compileAgentVersion,
  createAgentVersionAsset,
  InMemoryAgentVersionRegistry,
  parseAgentVersionAsset,
  parseCompiledAgentVersion,
  type AgentVersionSource,
} from "./agent-version.ts";

test("compiles a deeply immutable AgentVersion and keeps ordered Tool content stable", () => {
  const source = agentVersionSource();
  const version = compileAgentVersion(source, { sha256 });
  const again = compileAgentVersion(structuredClone(source), { sha256 });

  assert.deepEqual(version, again);
  assert.ok(Object.isFrozen(version));
  assert.ok(Object.isFrozen(version.model));
  assert.ok(Object.isFrozen(version.tools));
  assert.ok(Object.isFrozen(version.tools[0]));

  const reordered = compileAgentVersion(
    { ...source, tools: [...source.tools].reverse() },
    { sha256 },
  );
  assert.notEqual(reordered.contentDigest, version.contentDigest);
});

test("registers one digest per stable AgentVersion ID and never replaces it", () => {
  const registry = new InMemoryAgentVersionRegistry();
  const first = compileAgentVersion(agentVersionSource(), { sha256 });
  assert.deepEqual(registry.register(first), { disposition: "registered" });
  assert.deepEqual(registry.register(first), { disposition: "existing" });
  assert.deepEqual(registry.require(first.agentVersionId), first);

  const conflict = compileAgentVersion(
    { ...agentVersionSource(), instructions: "changed instructions" },
    { sha256 },
  );
  assert.throws(
    () => registry.register(conflict),
    hasCode("agent_version_id_conflict"),
  );
  assert.equal(registry.list().length, 1);
  assert.equal(
    registry.require(first.agentVersionId).contentDigest,
    first.contentDigest,
  );
});

test("fails startup on digest drift and unsafe model policy", () => {
  assert.throws(
    () =>
      compileAgentVersion(
        agentVersionSource(),
        { sha256 },
        `sha256:${"0".repeat(64)}`,
      ),
    hasCode("agent_version_digest_mismatch"),
  );
  assert.throws(
    () =>
      compileAgentVersion(
        {
          ...agentVersionSource(),
          model: {
            ...agentVersionSource().model,
            autoCompactAtTokens: 300_000,
          },
        },
        { sha256 },
      ),
    hasCode("agent_version_model_window_invalid"),
  );
});

test("round-trips a durable AgentVersion asset by recompiling its source", () => {
  const version = compileAgentVersion(agentVersionSource(), { sha256 });
  const asset = createAgentVersionAsset({
    tenantId: "tenant-1",
    version,
    createdAt: "2026-08-09T00:00:00Z",
  });

  assert.deepEqual(parseAgentVersionAsset(asset, { sha256 }), version);
  assert.deepEqual(
    parseCompiledAgentVersion(asset.definitionJson, { sha256 }),
    version,
  );
  assert.ok(Object.isFrozen(asset));
});

test("rejects durable definitions with content or identity drift", () => {
  const version = compileAgentVersion(agentVersionSource(), { sha256 });
  const asset = createAgentVersionAsset({
    tenantId: "tenant-1",
    version,
    createdAt: "2026-08-09T00:00:00Z",
  });
  const changedDefinition = JSON.stringify({
    ...JSON.parse(asset.definitionJson),
    instructions: "tampered",
  });

  assert.throws(
    () =>
      parseAgentVersionAsset(
        { ...asset, definitionJson: changedDefinition },
        { sha256 },
      ),
    hasCode("agent_version_digest_mismatch"),
  );
  assert.throws(
    () =>
      parseAgentVersionAsset(
        { ...asset, agentVersionId: "another-version" },
        { sha256 },
      ),
    hasCode("agent_version_asset_mismatch"),
  );
});

function agentVersionSource(): AgentVersionSource {
  const tools: readonly ToolDefinition[] = [
    {
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: "read_file",
      description: "Read one bounded file.",
      execution: "parallel",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      schemaVersion: "crewon.tool-definition.v0",
      kind: "custom",
      name: "apply_patch",
      description: "Apply a bounded patch.",
      execution: "serial",
      inputFormat: "text",
    },
  ];
  return {
    schemaVersion: "crewon.agent-version-source.v0",
    agentVersionId: "agent-version-1",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy-1",
    instructions: "stable instructions",
    model: {
      adapterName: "responses-http",
      adapterVersion: "0",
      modelId: "provider-model",
      contextWindowTokens: 273_000,
      autoCompactAtTokens: 200_000,
    },
    execution: { streamMaxRetries: 2, maxToolRounds: 16 },
    resources: {
      workspaceRequired: false,
      governedContextDigest: null,
    },
    tools,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AgentVersionError && error.code === code;
}
