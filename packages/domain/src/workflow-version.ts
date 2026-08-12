import { WorkflowVersionError } from "./workflow-version-error.ts";
import { validateWorkflowGraph } from "./workflow-version-graph.ts";
import {
  parseWorkflowObjectSchema,
  type WorkflowObjectSchema,
} from "./workflow-schema.ts";

export const MAX_WORKFLOW_NODES = 64;
export const MAX_WORKFLOW_EDGES = 256;

const MAX_ID_BYTES = 512;
const MAX_NODE_ID_BYTES = 128;
const MAX_NAME_BYTES = 256;
const MAX_DESCRIPTION_BYTES = 4 * 1024;
const MAX_INSTRUCTION_BYTES = 9_999;
export const MAX_WORKFLOW_SOURCE_BYTES = 1024 * 1024;

type WorkflowNodeBase = Readonly<{
  nodeId: string;
  title: string;
  instruction: string;
  dependsOn: readonly string[];
  inputSchema: WorkflowObjectSchema;
  outputSchema: WorkflowObjectSchema;
}>;

export type WorkflowNodeDefinition =
  | (WorkflowNodeBase & Readonly<{ kind: "agent"; agentVersionId: string }>)
  | (WorkflowNodeBase &
      Readonly<{ kind: "humanGate"; approvalPolicyId: string }>)
  | (WorkflowNodeBase &
      Readonly<{ kind: "verification"; verifierAgentVersionId: string }>);

export type WorkflowVersionSource = Readonly<{
  schemaVersion: "crewon.workflow-version-source.v0";
  workflowId: string;
  workflowVersionId: string;
  name: string;
  description: string;
  inputSchema: WorkflowObjectSchema;
  outputSchema: WorkflowObjectSchema;
  entryNodeIds: readonly string[];
  outputNodeIds: readonly string[];
  nodes: readonly WorkflowNodeDefinition[];
}>;

export type CompiledWorkflowVersion = Readonly<{
  schemaVersion: "crewon.workflow-version.v0";
  contentDigest: string;
  workflowId: string;
  workflowVersionId: string;
  name: string;
  description: string;
  inputSchema: WorkflowObjectSchema;
  outputSchema: WorkflowObjectSchema;
  entryNodeIds: readonly string[];
  outputNodeIds: readonly string[];
  nodes: readonly WorkflowNodeDefinition[];
  executionOrder: readonly string[];
}>;

/** Immutable WorkflowVersion identity frozen into a durable Run. */
export type FrozenWorkflowVersionBinding = Readonly<{
  workflowId: string;
  workflowVersionId: string;
  contentDigest: string;
}>;

export interface WorkflowContentDigester {
  sha256(content: string): string;
}

/** Compiles one bounded immutable DAG without executing or scheduling nodes. */
export function compileWorkflowVersion(
  source: WorkflowVersionSource,
  digester: WorkflowContentDigester,
  expectedDigest?: string | null,
): CompiledWorkflowVersion {
  const value = requireObject(source, "workflow_source_invalid");
  requireExactKeys(value, [
    "description",
    "entryNodeIds",
    "inputSchema",
    "name",
    "nodes",
    "outputNodeIds",
    "outputSchema",
    "schemaVersion",
    "workflowId",
    "workflowVersionId",
  ]);
  if (value.schemaVersion !== "crewon.workflow-version-source.v0") {
    throw new WorkflowVersionError("workflow_source_invalid");
  }
  const workflowId = requireId(value.workflowId, "workflow_id_invalid");
  const workflowVersionId = requireId(
    value.workflowVersionId,
    "workflow_version_id_invalid",
  );
  const name = requireText(value.name, MAX_NAME_BYTES, "workflow_name_invalid");
  const description = requireText(
    value.description,
    MAX_DESCRIPTION_BYTES,
    "workflow_description_invalid",
  );
  const inputSchema = parseWorkflowObjectSchema(
    value.inputSchema,
    "workflow_input_schema_invalid",
  );
  const outputSchema = parseWorkflowObjectSchema(
    value.outputSchema,
    "workflow_output_schema_invalid",
  );
  if (
    !Array.isArray(value.nodes) ||
    value.nodes.length === 0 ||
    value.nodes.length > MAX_WORKFLOW_NODES
  ) {
    throw new WorkflowVersionError("workflow_nodes_invalid");
  }
  const nodes = value.nodes.map(normalizeNode).sort(compareNodeIds);
  const nodeIds = new Set<string>();
  let edgeCount = 0;
  for (const node of nodes) {
    if (nodeIds.has(node.nodeId)) {
      throw new WorkflowVersionError("workflow_node_id_conflict");
    }
    nodeIds.add(node.nodeId);
    edgeCount += node.dependsOn.length;
  }
  if (edgeCount > MAX_WORKFLOW_EDGES) {
    throw new WorkflowVersionError("workflow_edges_limit_exceeded");
  }
  const entryNodeIds = normalizeNodeIdSet(
    value.entryNodeIds,
    "workflow_entry_nodes_invalid",
  );
  const outputNodeIds = normalizeNodeIdSet(
    value.outputNodeIds,
    "workflow_output_nodes_invalid",
  );
  const executionOrder = validateWorkflowGraph(
    nodes,
    entryNodeIds,
    outputNodeIds,
  );
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  if (
    entryNodeIds.some(
      (nodeId) =>
        canonicalJson(nodeById.get(nodeId)!.inputSchema) !==
        canonicalJson(inputSchema),
    )
  ) {
    throw new WorkflowVersionError("workflow_input_boundary_schema_mismatch");
  }
  if (
    outputNodeIds.some(
      (nodeId) =>
        canonicalJson(nodeById.get(nodeId)!.outputSchema) !==
        canonicalJson(outputSchema),
    )
  ) {
    throw new WorkflowVersionError("workflow_output_boundary_schema_mismatch");
  }
  const canonicalSource: WorkflowVersionSource = {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId,
    workflowVersionId,
    name,
    description,
    inputSchema,
    outputSchema,
    entryNodeIds,
    outputNodeIds,
    nodes,
  };
  const canonical = canonicalJson(canonicalSource);
  if (byteLength(canonical) > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new WorkflowVersionError("workflow_source_too_large");
  }
  const contentDigest = digester.sha256(canonical);
  requireDigest(contentDigest, "workflow_digest_invalid");
  if (expectedDigest !== undefined && expectedDigest !== null) {
    requireDigest(expectedDigest, "workflow_expected_digest_invalid");
    if (expectedDigest !== contentDigest) {
      throw new WorkflowVersionError("workflow_digest_mismatch");
    }
  }
  return deepFreeze({
    schemaVersion: "crewon.workflow-version.v0",
    contentDigest,
    workflowId,
    workflowVersionId,
    name,
    description,
    inputSchema,
    outputSchema,
    entryNodeIds,
    outputNodeIds,
    nodes,
    executionOrder,
  });
}

function normalizeNode(input: unknown): WorkflowNodeDefinition {
  const node = requireObject(input, "workflow_node_invalid");
  const commonKeys = [
    "dependsOn",
    "inputSchema",
    "instruction",
    "kind",
    "nodeId",
    "outputSchema",
    "title",
  ];
  const nodeId = requireNodeId(node.nodeId, "workflow_node_id_invalid");
  const common: WorkflowNodeBase = {
    nodeId,
    title: requireText(
      node.title,
      MAX_NAME_BYTES,
      "workflow_node_title_invalid",
    ),
    instruction: requireText(
      node.instruction,
      MAX_INSTRUCTION_BYTES,
      "workflow_node_instruction_invalid",
    ),
    dependsOn: normalizeNodeIdSet(
      node.dependsOn,
      "workflow_dependencies_invalid",
      true,
    ),
    inputSchema: parseWorkflowObjectSchema(
      node.inputSchema,
      "workflow_node_input_schema_invalid",
    ),
    outputSchema: parseWorkflowObjectSchema(
      node.outputSchema,
      "workflow_node_output_schema_invalid",
    ),
  };
  if (common.dependsOn.includes(nodeId)) {
    throw new WorkflowVersionError("workflow_self_dependency");
  }
  if (node.kind === "agent") {
    requireExactKeys(node, [...commonKeys, "agentVersionId"]);
    return {
      ...common,
      kind: "agent",
      agentVersionId: requireId(
        node.agentVersionId,
        "workflow_agent_version_id_invalid",
      ),
    };
  }
  if (node.kind === "humanGate") {
    requireExactKeys(node, [...commonKeys, "approvalPolicyId"]);
    return {
      ...common,
      kind: "humanGate",
      approvalPolicyId: requireId(
        node.approvalPolicyId,
        "workflow_approval_policy_id_invalid",
      ),
    };
  }
  if (node.kind === "verification") {
    requireExactKeys(node, [...commonKeys, "verifierAgentVersionId"]);
    return {
      ...common,
      kind: "verification",
      verifierAgentVersionId: requireId(
        node.verifierAgentVersionId,
        "workflow_verifier_agent_version_id_invalid",
      ),
    };
  }
  throw new WorkflowVersionError("workflow_node_kind_invalid");
}

function normalizeNodeIdSet(
  input: unknown,
  code: string,
  allowEmpty = false,
): readonly string[] {
  if (
    !Array.isArray(input) ||
    (!allowEmpty && input.length === 0) ||
    input.length > MAX_WORKFLOW_NODES
  ) {
    throw new WorkflowVersionError(code);
  }
  const values = input.map((value) => requireNodeId(value, code));
  if (new Set(values).size !== values.length)
    throw new WorkflowVersionError(code);
  return values.sort();
}

function requireObject(input: unknown, code: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new WorkflowVersionError(code);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new WorkflowVersionError(code);
  return input as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (!sameStrings(Object.keys(value).sort(), [...expected].sort())) {
    throw new WorkflowVersionError("workflow_shape_invalid");
  }
}

function requireId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    byteLength(value) > MAX_ID_BYTES ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new WorkflowVersionError(code);
  }
  return value;
}

/** Parses an identifier using the immutable WorkflowVersion wire grammar. */
export function parseWorkflowVersionIdentityId(
  value: unknown,
  code: string,
): string {
  return requireId(value, code);
}

function requireNodeId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    byteLength(value) > MAX_NODE_ID_BYTES ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)
  ) {
    throw new WorkflowVersionError(code);
  }
  return value;
}

function requireText(value: unknown, maxBytes: number, code: string): string {
  if (
    typeof value !== "string" ||
    !isWellFormedUnicode(value) ||
    value.trim().length === 0 ||
    byteLength(value) > maxBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new WorkflowVersionError(code);
  }
  return value;
}

function requireDigest(value: string, code: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new WorkflowVersionError(code);
}

function compareNodeIds(
  left: WorkflowNodeDefinition,
  right: WorkflowNodeDefinition,
): number {
  return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
