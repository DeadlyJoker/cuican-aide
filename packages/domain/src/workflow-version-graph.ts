import { WorkflowVersionError } from "./workflow-version-error.ts";

export type WorkflowGraphNode =
  | Readonly<{
      nodeId: string;
      dependsOn: readonly string[];
      kind: "agent";
      agentVersionId: string;
    }>
  | Readonly<{
      nodeId: string;
      dependsOn: readonly string[];
      kind: "humanGate";
    }>
  | Readonly<{
      nodeId: string;
      dependsOn: readonly string[];
      kind: "verification";
      verifierAgentVersionId: string;
    }>;

export function validateWorkflowGraph(
  nodes: readonly WorkflowGraphNode[],
  entryNodeIds: readonly string[],
  outputNodeIds: readonly string[],
): readonly string[] {
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  if (nodeById.size !== nodes.length) {
    throw new WorkflowVersionError("workflow_node_id_conflict");
  }
  if (
    entryNodeIds.some((nodeId) => !nodeById.has(nodeId)) ||
    outputNodeIds.some((nodeId) => !nodeById.has(nodeId))
  ) {
    throw new WorkflowVersionError("workflow_boundary_node_not_found");
  }
  for (const node of nodes) {
    if (new Set(node.dependsOn).size !== node.dependsOn.length) {
      throw new WorkflowVersionError("workflow_dependencies_invalid");
    }
    if (node.dependsOn.some((dependency) => !nodeById.has(dependency))) {
      throw new WorkflowVersionError("workflow_dependency_not_found");
    }
    if (node.kind === "verification" && node.dependsOn.length === 0) {
      throw new WorkflowVersionError(
        "workflow_verification_dependency_invalid",
      );
    }
  }
  const dependents = new Map<string, string[]>(
    nodes.map((node) => [node.nodeId, []]),
  );
  const indegree = new Map(
    nodes.map((node) => [node.nodeId, node.dependsOn.length]),
  );
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      dependents.get(dependency)!.push(node.nodeId);
    }
  }
  for (const values of dependents.values()) values.sort();
  const roots = nodes
    .filter((node) => node.dependsOn.length === 0)
    .map((node) => node.nodeId)
    .sort();
  const terminals = nodes
    .filter((node) => dependents.get(node.nodeId)!.length === 0)
    .map((node) => node.nodeId)
    .sort();
  const ready = [...roots];
  const order: string[] = [];
  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    order.push(nodeId);
    for (const dependent of dependents.get(nodeId)!) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) insertSorted(ready, dependent);
    }
  }
  if (order.length !== nodes.length) {
    throw new WorkflowVersionError("workflow_graph_cycle");
  }
  validateIndependentVerifiers(order, nodeById);
  if (!sameStrings(roots, entryNodeIds)) {
    throw new WorkflowVersionError("workflow_entry_nodes_invalid");
  }
  if (!sameStrings(terminals, outputNodeIds)) {
    throw new WorkflowVersionError("workflow_output_nodes_invalid");
  }
  if (
    outputNodeIds.some(
      (nodeId) => nodeById.get(nodeId)?.kind !== "verification",
    )
  ) {
    throw new WorkflowVersionError("workflow_output_verification_required");
  }
  return order;
}

function validateIndependentVerifiers(
  order: readonly string[],
  nodeById: ReadonlyMap<string, WorkflowGraphNode>,
): void {
  const ancestorAgents = new Map<string, Set<string>>();
  for (const nodeId of order) {
    const node = nodeById.get(nodeId)!;
    const agents = new Set<string>();
    for (const dependency of node.dependsOn) {
      for (const agentVersionId of ancestorAgents.get(dependency)!) {
        agents.add(agentVersionId);
      }
    }
    if (
      node.kind === "verification" &&
      agents.has(node.verifierAgentVersionId)
    ) {
      throw new WorkflowVersionError("workflow_verifier_not_independent");
    }
    if (node.kind === "agent") agents.add(node.agentVersionId);
    if (node.kind === "verification") {
      agents.add(node.verifierAgentVersionId);
    }
    ancestorAgents.set(nodeId, agents);
  }
}

function insertSorted(values: string[], value: string): void {
  const index = values.findIndex((candidate) => candidate > value);
  values.splice(index === -1 ? values.length : index, 0, value);
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
