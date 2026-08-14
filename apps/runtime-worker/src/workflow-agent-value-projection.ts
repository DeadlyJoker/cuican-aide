import type { AgentHistoryItem } from "@crewon/agent-kernel/runtime";
import { canonicalJson, MAX_WORKFLOW_VALUE_BYTES } from "@crewon/application";
import { escapeContextXmlText } from "@crewon/context";
import {
  validateWorkflowSchemaValue,
  type WorkflowNodeDefinition,
  type WorkflowSchemaValue,
} from "@crewon/domain";

const MAX_NODE_CONTEXT_BYTES = 64 * 1024;

/** Projects one canonical node value into a bounded model-visible task message. */
export function workflowNodeInputHistory(input: {
  node: WorkflowNodeDefinition;
  value: WorkflowSchemaValue;
}): readonly AgentHistoryItem[] {
  const canonicalInput = canonicalJson(input.value);
  if (
    new TextEncoder().encode(canonicalInput).length > MAX_WORKFLOW_VALUE_BYTES
  ) {
    throw new Error("workflow_node_input_too_large");
  }
  const content = [
    "<workflow_node_task>",
    `<node_id>${escapeContextXmlText(input.node.nodeId)}</node_id>`,
    `<title>${escapeContextXmlText(input.node.title)}</title>`,
    `<instruction>${escapeContextXmlText(input.node.instruction)}</instruction>`,
    `<input_json>${escapeContextXmlText(canonicalInput)}</input_json>`,
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
    new TextEncoder().encode(output).length > MAX_WORKFLOW_VALUE_BYTES
  ) {
    throw new Error("workflow_node_output_too_large");
  }
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("workflow_node_output_json_invalid");
  }
  const validated = validateWorkflowSchemaValue(value, node.outputSchema);
  if (
    new TextEncoder().encode(canonicalJson(validated)).length >
    MAX_WORKFLOW_VALUE_BYTES
  ) {
    throw new Error("workflow_node_output_too_large");
  }
  return validated;
}
