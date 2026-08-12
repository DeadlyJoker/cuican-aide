import type { AgentHistoryItem } from "@crewon/agent-kernel";
import {
  validateWorkflowSchemaValue,
  type WorkflowNodeDefinition,
  type WorkflowSchemaValue,
} from "@crewon/domain";

const MAX_NODE_CONTEXT_BYTES = 64 * 1024;
const MAX_NODE_OUTPUT_BYTES = 256 * 1024;

/** Projects one canonical node value into a bounded model-visible task message. */
export function workflowNodeInputHistory(input: {
  node: WorkflowNodeDefinition;
  value: WorkflowSchemaValue;
}): readonly AgentHistoryItem[] {
  const content = [
    "<workflow_node_task>",
    `node_id: ${input.node.nodeId}`,
    `title: ${input.node.title}`,
    "instruction:",
    input.node.instruction,
    "input_json:",
    JSON.stringify(input.value),
    "</workflow_node_task>",
  ].join("\n");
  if (new TextEncoder().encode(content).length > MAX_NODE_CONTEXT_BYTES) {
    throw new Error("workflow_node_context_too_large");
  }
  return Object.freeze([
    Object.freeze({ type: "message", role: "user", content }),
  ]);
}

/** Parses an exact JSON model result and validates it against the frozen node schema. */
export function parseWorkflowNodeOutput(
  output: string,
  node: WorkflowNodeDefinition,
): WorkflowSchemaValue {
  if (
    typeof output !== "string" ||
    new TextEncoder().encode(output).length > MAX_NODE_OUTPUT_BYTES
  ) {
    throw new Error("workflow_node_output_too_large");
  }
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("workflow_node_output_json_invalid");
  }
  return validateWorkflowSchemaValue(value, node.outputSchema);
}
