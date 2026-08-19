import type { AgentHistoryItem } from "@crewon/agent-kernel/runtime";
import { canonicalJson, MAX_WORKFLOW_VALUE_BYTES } from "@crewon/application";
import {
  validateWorkflowSchemaValue,
  type WorkflowNodeDefinition,
  type WorkflowSchemaValue,
} from "@crewon/domain";

const MAX_NODE_CONTEXT_ITEM_BYTES = 8 * 1024;
const MAX_NODE_CONTEXT_ITEMS = 64;
const MAX_MODEL_VISIBLE_ITEM_BYTES = 10_000;
const textEncoder = new TextEncoder();

type WorkflowNodeContextFragment = Readonly<{
  schemaVersion: "crewon.workflow-node-context-fragment.v0";
  nodeId: string;
  title: string;
  kind: "task" | "instruction" | "inputJson";
  sequence: number;
  total: number;
  content: string;
}>;

/** Projects one canonical node value into bounded, lossless model-visible fragments. */
export function workflowNodeInputHistory(input: {
  node: WorkflowNodeDefinition;
  value: WorkflowSchemaValue;
}): readonly AgentHistoryItem[] {
  const canonicalInput = canonicalJson(input.value);
  if (byteLength(canonicalInput) > MAX_WORKFLOW_VALUE_BYTES) {
    throw new Error("workflow_node_input_too_large");
  }

  const fragments: WorkflowNodeContextFragment[] = [
    {
      schemaVersion: "crewon.workflow-node-context-fragment.v0",
      nodeId: input.node.nodeId,
      title: input.node.title,
      kind: "task",
      sequence: 1,
      total: 1,
      content:
        "Concatenate each instruction and inputJson stream by sequence. Execute the instruction with the exact inputJson value and return exact JSON matching the frozen output schema.",
    },
    ...fragmentStream(input.node, "instruction", input.node.instruction),
    ...fragmentStream(input.node, "inputJson", canonicalInput),
  ];
  if (fragments.length > MAX_NODE_CONTEXT_ITEMS) {
    throw new Error("workflow_node_context_too_large");
  }
  return Object.freeze(
    fragments.map((fragment) => {
      const content = JSON.stringify(fragment);
      if (byteLength(content) > MAX_NODE_CONTEXT_ITEM_BYTES) {
        throw new Error("workflow_node_context_item_too_large");
      }
      return Object.freeze({ type: "message", role: "user", content });
    }),
  );
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

/** Produces a deterministic head/tail projection for one durable model-history value. */
export function projectWorkflowModelVisibleText(value: string): Readonly<{
  content: string;
  truncated: boolean;
}> {
  if (byteLength(value) <= MAX_NODE_CONTEXT_ITEM_BYTES) {
    return { content: value, truncated: false };
  }
  const entries = [...value].map((character) => ({
    character,
    bytes: byteLength(character),
  }));
  const contentBudget = MAX_NODE_CONTEXT_ITEM_BYTES - 64;
  const halfBudget = Math.floor(contentBudget / 2);
  const head: string[] = [];
  const tail: string[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let start = 0;
  let end = entries.length - 1;
  while (start <= end && headBytes + entries[start]!.bytes <= halfBudget) {
    head.push(entries[start]!.character);
    headBytes += entries[start]!.bytes;
    start += 1;
  }
  while (
    end >= start &&
    tailBytes + entries[end]!.bytes <= contentBudget - headBytes
  ) {
    tail.unshift(entries[end]!.character);
    tailBytes += entries[end]!.bytes;
    end -= 1;
  }
  const omittedBytes = byteLength(value) - headBytes - tailBytes;
  const content = `${head.join("")}\n…${omittedBytes} bytes omitted from model context…\n${tail.join("")}`;
  if (byteLength(content) > MAX_NODE_CONTEXT_ITEM_BYTES) {
    throw new Error("workflow_model_context_projection_failed");
  }
  return { content, truncated: true };
}

/** Enforces the hard per-item limit before Workflow history reaches a model. */
export function validateWorkflowModelHistory(
  history: readonly AgentHistoryItem[],
): readonly AgentHistoryItem[] {
  for (const item of history) {
    if (byteLength(JSON.stringify(item)) > MAX_MODEL_VISIBLE_ITEM_BYTES) {
      throw new Error("workflow_model_context_item_too_large");
    }
  }
  return history;
}

function fragmentStream(
  node: Pick<WorkflowNodeDefinition, "nodeId" | "title">,
  kind: "instruction" | "inputJson",
  value: string,
): readonly WorkflowNodeContextFragment[] {
  const emptyEnvelopeBytes = byteLength(
    JSON.stringify({
      schemaVersion: "crewon.workflow-node-context-fragment.v0",
      nodeId: node.nodeId,
      title: node.title,
      kind,
      sequence: MAX_NODE_CONTEXT_ITEMS,
      total: MAX_NODE_CONTEXT_ITEMS,
      content: "",
    } satisfies WorkflowNodeContextFragment),
  );
  const contentBudget = MAX_NODE_CONTEXT_ITEM_BYTES - emptyEnvelopeBytes;
  if (contentBudget < 1) {
    throw new Error("workflow_node_context_item_too_large");
  }

  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of value) {
    const encodedCharacter = JSON.stringify(character);
    const characterBytes = byteLength(encodedCharacter) - 2;
    if (chunkBytes + characterBytes > contentBudget && chunk.length > 0) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    if (characterBytes > contentBudget) {
      throw new Error("workflow_node_context_item_too_large");
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  chunks.push(chunk);

  return chunks.map((content, index) => ({
    schemaVersion: "crewon.workflow-node-context-fragment.v0",
    nodeId: node.nodeId,
    title: node.title,
    kind,
    sequence: index + 1,
    total: chunks.length,
    content,
  }));
}

function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}
