import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  compileWorkflowVersion,
  type WorkflowVersionSource,
} from "./workflow-version.ts";
import type { WorkflowObjectSchema } from "./workflow-schema.ts";

test("compiles one canonical immutable branching Workflow DAG", () => {
  const source = workflowSource();
  const compiled = compileWorkflowVersion(source, { sha256 });
  const reordered = compileWorkflowVersion(reorderedSource(), { sha256 });

  assert.deepEqual(compiled, reordered);
  assert.deepEqual(compiled.executionOrder, [
    "collect",
    "analyze",
    "approval",
    "verify",
  ]);
  assert.deepEqual(compiled.entryNodeIds, ["collect"]);
  assert.deepEqual(compiled.outputNodeIds, ["verify"]);
  assert.ok(Object.isFrozen(compiled));
  assert.ok(Object.isFrozen(compiled.nodes));
  assert.ok(Object.isFrozen(compiled.nodes[0]?.inputSchema));
});

test("requires exact source and node authority", () => {
  const source = workflowSource();
  assert.throws(
    () =>
      compileWorkflowVersion(
        {
          ...source,
          nodes: source.nodes.map((node) =>
            node.nodeId === "collect"
              ? ({ ...node, unexpected: true } as never)
              : node,
          ),
        },
        { sha256 },
      ),
    hasCode("workflow_shape_invalid"),
  );
  assert.throws(
    () =>
      compileWorkflowVersion({ ...source, unexpected: true } as never, {
        sha256,
      }),
    hasCode("workflow_shape_invalid"),
  );
  assert.throws(
    () =>
      compileWorkflowVersion(
        { ...source, description: "invalid \ud800 text" },
        { sha256 },
      ),
    hasCode("workflow_description_invalid"),
  );
});

test("checks caller and digester content digests", () => {
  const source = workflowSource();
  const compiled = compileWorkflowVersion(source, { sha256 });

  assert.deepEqual(
    compileWorkflowVersion(source, { sha256 }, compiled.contentDigest),
    compiled,
  );
  assert.throws(
    () =>
      compileWorkflowVersion(source, { sha256 }, `sha256:${"0".repeat(64)}`),
    hasCode("workflow_digest_mismatch"),
  );
  assert.throws(
    () => compileWorkflowVersion(source, { sha256: () => "invalid" }),
    hasCode("workflow_digest_invalid"),
  );
});

test("binds declared input and output schemas to the execution boundary", () => {
  const source = workflowSource();
  assert.throws(
    () =>
      compileWorkflowVersion(
        {
          ...source,
          nodes: source.nodes.map((node) =>
            node.nodeId === "collect"
              ? { ...node, inputSchema: emptyObjectSchema() }
              : node,
          ),
        },
        { sha256 },
      ),
    hasCode("workflow_node_input_flow_schema_mismatch"),
  );
  assert.throws(
    () =>
      compileWorkflowVersion(
        {
          ...source,
          nodes: source.nodes.map((node) =>
            node.nodeId === "verify"
              ? { ...node, outputSchema: emptyObjectSchema() }
              : node,
          ),
        },
        { sha256 },
      ),
    hasCode("workflow_output_flow_schema_mismatch"),
  );
});

test("enforces node, edge and total canonical definition limits", () => {
  const source = workflowSource();
  assert.throws(
    () =>
      compileWorkflowVersion(
        {
          ...source,
          nodes: Array.from({ length: 65 }, (_, index) =>
            agentNode(`node-${index.toString().padStart(2, "0")}`, []),
          ),
          entryNodeIds: Array.from(
            { length: 65 },
            (_, index) => `node-${index.toString().padStart(2, "0")}`,
          ),
          outputNodeIds: Array.from(
            { length: 65 },
            (_, index) => `node-${index.toString().padStart(2, "0")}`,
          ),
        },
        { sha256 },
      ),
    hasCode("workflow_nodes_invalid"),
  );

  const denseNodes = Array.from({ length: 24 }, (_, index) =>
    agentNode(
      `node-${index.toString().padStart(2, "0")}`,
      Array.from(
        { length: index },
        (_, dependency) => `node-${dependency.toString().padStart(2, "0")}`,
      ),
    ),
  );
  assert.throws(
    () =>
      compileWorkflowVersion(
        {
          ...source,
          nodes: denseNodes,
          entryNodeIds: ["node-00"],
          outputNodeIds: ["node-23"],
        },
        { sha256 },
      ),
    hasCode("workflow_edges_limit_exceeded"),
  );

  const largeSchema = objectSchemaWithProperties(64);
  const largeAgentNodes = Array.from({ length: 63 }, (_, index) =>
    agentNode(
      `agent-${index.toString().padStart(2, "0")}`,
      index === 0
        ? []
        : [`agent-${(index - 1).toString().padStart(2, "0")}`],
      largeSchema,
      largeSchema,
    ),
  );
  const largeVerificationNode = {
    ...commonNode("verify", ["agent-62"], largeSchema, largeSchema),
    kind: "verification" as const,
    verifierAgentVersionId: "agent-independent-verifier",
  };
  assert.throws(
    () =>
      compileWorkflowVersion(
        {
          ...source,
          inputSchema: largeSchema,
          outputSchema: largeSchema,
          nodes: [...largeAgentNodes, largeVerificationNode],
          entryNodeIds: ["agent-00"],
          outputNodeIds: ["verify"],
        },
        { sha256 },
      ),
    hasCode("workflow_source_too_large"),
  );
});

function workflowSource(): WorkflowVersionSource {
  const result = resultSchema();
  return {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    name: "Release review",
    description:
      "Collect, approve, analyze and independently verify a release.",
    inputSchema: releaseSchema(),
    outputSchema: result,
    entryNodeIds: ["collect"],
    outputNodeIds: ["verify"],
    nodes: [
      agentNode("collect", [], releaseSchema(), result),
      {
        ...commonNode("approval", ["collect"], result, result),
        kind: "humanGate",
        approvalPolicyId: "workflow-release-approval-v1",
      },
      agentNode("analyze", ["collect"], result, result),
      {
        ...commonNode(
          "verify",
          ["approval", "analyze"],
          aggregateSchema({ analyze: result, approval: result }),
          result,
        ),
        kind: "verification",
        verifierAgentVersionId: "agent-verifier-v1",
      },
    ],
  };
}

function reorderedSource(): WorkflowVersionSource {
  const source = workflowSource();
  return {
    ...source,
    inputSchema: {
      ...source.inputSchema,
      properties: Object.fromEntries(
        Object.entries(source.inputSchema.properties).reverse(),
      ),
      required: [...source.inputSchema.required].reverse(),
    },
    nodes: [...source.nodes]
      .reverse()
      .map((node) => ({ ...node, dependsOn: [...node.dependsOn].reverse() })),
  };
}

function agentNode(
  nodeId: string,
  dependsOn: readonly string[],
  inputSchema: WorkflowObjectSchema = releaseSchema(),
  outputSchema: WorkflowObjectSchema = resultSchema(),
) {
  return {
    ...commonNode(nodeId, dependsOn, inputSchema, outputSchema),
    kind: "agent" as const,
    agentVersionId: `agent-${nodeId}-v1`,
  };
}

function commonNode(
  nodeId: string,
  dependsOn: readonly string[],
  inputSchema: WorkflowObjectSchema = releaseSchema(),
  outputSchema: WorkflowObjectSchema = resultSchema(),
) {
  return {
    nodeId,
    title: `${nodeId} step`,
    instruction: `Execute the bounded ${nodeId} step.`,
    dependsOn,
    inputSchema,
    outputSchema,
  };
}

function releaseSchema(): WorkflowObjectSchema {
  return {
    type: "object",
    properties: {
      releaseId: { type: "string", maxLength: 128, enum: null },
      targets: {
        type: "array",
        maxItems: 16,
        items: { type: "string", maxLength: 128, enum: null },
      },
    },
    required: ["releaseId", "targets"],
    additionalProperties: false,
  };
}

function resultSchema(): WorkflowObjectSchema {
  return {
    type: "object",
    properties: {
      approved: { type: "boolean" },
      summary: { type: "string", maxLength: 9_999, enum: null },
    },
    required: ["approved", "summary"],
    additionalProperties: false,
  };
}

function emptyObjectSchema(): WorkflowObjectSchema {
  return {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
}

function aggregateSchema(
  properties: WorkflowObjectSchema["properties"],
): WorkflowObjectSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties).sort(),
    additionalProperties: false,
  };
}

function objectSchemaWithProperties(count: number): WorkflowObjectSchema {
  const properties = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `property_${index.toString().padStart(2, "0")}_${"x".repeat(90)}`,
      {
        type: "string" as const,
        maxLength: 9_999,
        enum: ["y".repeat(600)],
      },
    ]),
  );
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;
}
