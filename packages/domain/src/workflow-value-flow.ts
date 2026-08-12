import type { WorkflowSchemaValue } from "./workflow-schema-value.ts";
import type { WorkflowObjectSchema } from "./workflow-schema.ts";
import type { WorkflowNodeDefinition } from "./workflow-version.ts";
import { WorkflowVersionError } from "./workflow-version-error.ts";

export type WorkflowValueFlowDefinition = Readonly<{
  inputSchema: WorkflowObjectSchema;
  outputSchema: WorkflowObjectSchema;
  outputNodeIds: readonly string[];
  nodes: readonly WorkflowNodeDefinition[];
}>;

/** Derives the exact immutable schema consumed by one Workflow node. */
export function workflowNodeInputSchema(
  workflow: Pick<WorkflowValueFlowDefinition, "inputSchema" | "nodes">,
  nodeId: string,
): WorkflowObjectSchema {
  const node = requireNode(workflow.nodes, nodeId);
  return derivedSchema(
    node.dependsOn,
    workflow.inputSchema,
    workflow.nodes,
  );
}

/** Derives the exact immutable schema projected by the Workflow boundary. */
export function workflowOutputSchema(
  workflow: Pick<WorkflowValueFlowDefinition, "nodes" | "outputNodeIds">,
): WorkflowObjectSchema {
  return derivedSchema(workflow.outputNodeIds, null, workflow.nodes);
}

/** Composes one node input from committed canonical dependency outputs. */
export function composeWorkflowNodeInput(input: {
  workflow: Pick<WorkflowValueFlowDefinition, "nodes">;
  nodeId: string;
  rootInput: WorkflowSchemaValue;
  dependencyOutputs: readonly WorkflowNodeOutputValue[];
}): WorkflowSchemaValue {
  const node = requireNode(input.workflow.nodes, input.nodeId);
  return composeValue(node.dependsOn, input.rootInput, input.dependencyOutputs);
}

/** Composes the canonical Workflow output from committed output-node values. */
export function composeWorkflowOutput(input: {
  workflow: Pick<WorkflowValueFlowDefinition, "outputNodeIds">;
  outputValues: readonly WorkflowNodeOutputValue[];
}): WorkflowSchemaValue {
  return composeValue(input.workflow.outputNodeIds, null, input.outputValues);
}

export type WorkflowNodeOutputValue = Readonly<{
  nodeId: string;
  value: WorkflowSchemaValue;
}>;

function derivedSchema(
  sourceNodeIds: readonly string[],
  emptySchema: WorkflowObjectSchema | null,
  nodes: readonly WorkflowNodeDefinition[],
): WorkflowObjectSchema {
  if (sourceNodeIds.length === 0) {
    if (emptySchema === null) {
      throw new WorkflowVersionError("workflow_value_flow_invalid");
    }
    return emptySchema;
  }
  if (sourceNodeIds.length === 1) {
    return requireNode(nodes, sourceNodeIds[0]!).outputSchema;
  }
  const properties = Object.freeze(
    Object.fromEntries(
      sourceNodeIds.map((nodeId) => [
        nodeId,
        requireNode(nodes, nodeId).outputSchema,
      ]),
    ),
  );
  return Object.freeze({
    type: "object" as const,
    properties,
    required: Object.freeze([...sourceNodeIds]),
    additionalProperties: false as const,
  });
}

function composeValue(
  sourceNodeIds: readonly string[],
  emptyValue: WorkflowSchemaValue | null,
  outputs: readonly WorkflowNodeOutputValue[],
): WorkflowSchemaValue {
  if (sourceNodeIds.length === 0) {
    if (emptyValue === null) {
      throw new WorkflowVersionError("workflow_value_flow_invalid");
    }
    return emptyValue;
  }
  if (
    outputs.length !== sourceNodeIds.length ||
    outputs.some((output, index) => output.nodeId !== sourceNodeIds[index])
  ) {
    throw new WorkflowVersionError("workflow_value_flow_output_mismatch");
  }
  if (outputs.length === 1) return outputs[0]!.value;
  return Object.freeze(
    Object.fromEntries(outputs.map((output) => [output.nodeId, output.value])),
  );
}

function requireNode(
  nodes: readonly WorkflowNodeDefinition[],
  nodeId: string,
): WorkflowNodeDefinition {
  const node = nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) {
    throw new WorkflowVersionError("workflow_value_flow_node_not_found");
  }
  return node;
}
