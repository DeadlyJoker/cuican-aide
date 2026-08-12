import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { WorkflowObjectSchema } from "./workflow-schema.ts";
import {
  parseCompiledWorkflowVersion,
  serializeCompiledWorkflowVersion,
} from "./workflow-version-codec.ts";
import {
  compileWorkflowVersion,
  type WorkflowVersionSource,
} from "./workflow-version.ts";

test("round-trips only the canonical durable WorkflowVersion definition", () => {
  const compiled = compileWorkflowVersion(workflowSource(), { sha256 });
  const definitionJson = serializeCompiledWorkflowVersion(compiled);

  assert.deepEqual(
    parseCompiledWorkflowVersion(definitionJson, { sha256 }),
    compiled,
  );
  assert.throws(
    () => parseCompiledWorkflowVersion(` ${definitionJson}`, { sha256 }),
    hasCode("workflow_definition_invalid"),
  );
});

test("rejects content, digest, derived-plan and shape drift", () => {
  const compiled = compileWorkflowVersion(workflowSource(), { sha256 });
  const invalid = [
    {
      ...compiled,
      nodes: compiled.nodes.map((node) =>
        node.nodeId === "collect" ? { ...node, instruction: "tampered" } : node,
      ),
    },
    { ...compiled, contentDigest: `sha256:${"0".repeat(64)}` },
    { ...compiled, executionOrder: [...compiled.executionOrder].reverse() },
    { ...compiled, unexpected: true },
  ];
  for (const definition of invalid) {
    assert.throws(
      () => parseCompiledWorkflowVersion(canonicalJson(definition), { sha256 }),
      (error: unknown) =>
        hasCode("workflow_definition_invalid")(error) ||
        hasCode("workflow_digest_mismatch")(error),
    );
  }
});

test("rejects malformed and over-limit durable definitions", () => {
  for (const definitionJson of [
    "not-json",
    "null",
    `"${"x".repeat(2 * 1024 * 1024)}"`,
  ]) {
    assert.throws(
      () => parseCompiledWorkflowVersion(definitionJson, { sha256 }),
      hasCode("workflow_definition_invalid"),
    );
  }
});

function workflowSource(): WorkflowVersionSource {
  const inputSchema = objectSchema("request");
  const outputSchema = objectSchema("result");
  return {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "workflow-codec",
    workflowVersionId: "workflow-codec-v1",
    name: "Codec fixture",
    description: "Recompile one durable WorkflowVersion.",
    inputSchema,
    outputSchema,
    entryNodeIds: ["collect"],
    outputNodeIds: ["verify"],
    nodes: [
      {
        nodeId: "collect",
        kind: "agent",
        agentVersionId: "agent-collect-v1",
        title: "Collect",
        instruction: "Collect one bounded result.",
        dependsOn: [],
        inputSchema,
        outputSchema,
      },
      {
        nodeId: "verify",
        kind: "verification",
        verifierAgentVersionId: "agent-verifier-v1",
        title: "Verify",
        instruction: "Independently verify the result.",
        dependsOn: ["collect"],
        inputSchema: outputSchema,
        outputSchema,
      },
    ],
  };
}

function objectSchema(name: string): WorkflowObjectSchema {
  return {
    type: "object",
    properties: {
      [name]: { type: "string", maxLength: 128, enum: null },
    },
    required: [name],
    additionalProperties: false,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;
}
