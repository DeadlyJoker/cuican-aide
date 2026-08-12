import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { WorkflowObjectSchema } from "./workflow-schema.ts";
import {
  composeWorkflowNodeInput,
  composeWorkflowOutput,
  workflowNodeInputSchema,
  workflowOutputSchema,
} from "./workflow-value-flow.ts";
import { compileWorkflowVersion } from "./workflow-version.ts";

test("derives and composes root, direct and fan-in Workflow values", () => {
  const scalar = schema("value");
  const fanIn = aggregate({
    "verify-left": scalar,
    "verify-right": scalar,
  });
  const workflow = compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId: "flow",
      workflowVersionId: "flow-v1",
      name: "Flow",
      description: "Exercise canonical value flow.",
      inputSchema: scalar,
      outputSchema: fanIn,
      entryNodeIds: ["root"],
      outputNodeIds: ["verify-left", "verify-right"],
      nodes: [
        agent("root", [], scalar, scalar),
        agent("left", ["root"], scalar, scalar),
        agent("right", ["root"], scalar, scalar),
        verify("verify-left", ["left"], scalar, scalar),
        verify("verify-right", ["right"], scalar, scalar),
      ],
    },
    { sha256 },
  );
  assert.deepEqual(workflowNodeInputSchema(workflow, "root"), scalar);
  assert.deepEqual(workflowNodeInputSchema(workflow, "left"), scalar);
  assert.deepEqual(workflowOutputSchema(workflow), fanIn);
  const root = { value: "root" };
  assert.deepEqual(
    composeWorkflowNodeInput({
      workflow,
      nodeId: "root",
      rootInput: root,
      dependencyOutputs: [],
    }),
    root,
  );
  assert.deepEqual(
    composeWorkflowOutput({
      workflow,
      outputValues: [
        { nodeId: "verify-left", value: { value: "left" } },
        { nodeId: "verify-right", value: { value: "right" } },
      ],
    }),
    {
      "verify-left": { value: "left" },
      "verify-right": { value: "right" },
    },
  );
});

test("rejects node input, gate passthrough and Workflow output schema drift", () => {
  const input = schema("input");
  const output = schema("output");
  const base = {
    schemaVersion: "crewon.workflow-version-source.v0" as const,
    workflowId: "invalid-flow",
    workflowVersionId: "invalid-flow-v1",
    name: "Invalid flow",
    description: "Reject non-executable value flow.",
    inputSchema: input,
    outputSchema: output,
    entryNodeIds: ["root"],
    outputNodeIds: ["verify"],
    nodes: [
      agent("root", [], input, output),
      verify("verify", ["root"], output, output),
    ],
  };
  assert.throws(
    () =>
      compileWorkflowVersion(
        { ...base, nodes: [agent("root", [], output, output), base.nodes[1]!] },
        { sha256 },
      ),
    hasCode("workflow_node_input_flow_schema_mismatch"),
  );
  const gate = {
    nodeId: "gate",
    kind: "humanGate" as const,
    approvalPolicyId: "approval",
    title: "Gate",
    instruction: "Approve",
    dependsOn: ["root"],
    inputSchema: output,
    outputSchema: input,
  };
  assert.throws(
    () =>
      compileWorkflowVersion(
        {
          ...base,
          nodes: [base.nodes[0]!, gate, verify("verify", ["gate"], input, output)],
        },
        { sha256 },
      ),
    hasCode("workflow_gate_passthrough_schema_mismatch"),
  );
  assert.throws(
    () => compileWorkflowVersion({ ...base, outputSchema: input }, { sha256 }),
    hasCode("workflow_output_flow_schema_mismatch"),
  );
});

function agent(
  nodeId: string,
  dependsOn: readonly string[],
  inputSchema: WorkflowObjectSchema,
  outputSchema: WorkflowObjectSchema,
) {
  return {
    nodeId,
    kind: "agent" as const,
    agentVersionId: `agent-${nodeId}`,
    title: nodeId,
    instruction: nodeId,
    dependsOn,
    inputSchema,
    outputSchema,
  };
}

function verify(
  nodeId: string,
  dependsOn: readonly string[],
  inputSchema: WorkflowObjectSchema,
  outputSchema: WorkflowObjectSchema,
) {
  return {
    nodeId,
    kind: "verification" as const,
    verifierAgentVersionId: `verifier-${nodeId}`,
    title: nodeId,
    instruction: nodeId,
    dependsOn,
    inputSchema,
    outputSchema,
  };
}

function schema(property: string): WorkflowObjectSchema {
  return {
    type: "object",
    properties: { [property]: { type: "string", maxLength: 128, enum: null } },
    required: [property],
    additionalProperties: false,
  };
}

function aggregate(
  properties: WorkflowObjectSchema["properties"],
): WorkflowObjectSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties).sort(),
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
