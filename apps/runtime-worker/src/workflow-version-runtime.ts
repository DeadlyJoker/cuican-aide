import type { WorkflowVersionStore } from "@crewon/application";
import {
  parseCompiledWorkflowVersion,
  type CompiledWorkflowVersion,
  type WorkflowContentDigester,
  type WorkflowNodeDefinition,
} from "@crewon/domain";

export type FrozenWorkflowRunBinding = Readonly<{
  workflowVersionId: string;
  workflowVersionDigest: string;
}>;

/** Resolves the exact tenant-scoped immutable workflow frozen by a Run. */
export async function loadFrozenWorkflowVersion(input: {
  tenantId: string;
  binding: FrozenWorkflowRunBinding;
  store: WorkflowVersionStore;
  digester: WorkflowContentDigester;
}): Promise<CompiledWorkflowVersion> {
  const asset = await input.store.loadWorkflowVersion({
    tenantId: input.tenantId,
    workflowVersionId: input.binding.workflowVersionId,
  });
  if (
    asset === null ||
    asset.contentDigest !== input.binding.workflowVersionDigest
  ) {
    throw new Error("workflow_version_binding_unresolvable");
  }
  return parseCompiledWorkflowVersion(asset.definitionJson, input.digester);
}

export type WorkflowNodeSettlement = Readonly<{
  nodeId: string;
  status: "completed" | "failed";
}>;

/** Computes runnable DAG nodes while retaining Agent, Human Gate and Verification identities. */
export function readyWorkflowNodes(
  workflow: CompiledWorkflowVersion,
  settlements: readonly WorkflowNodeSettlement[],
): readonly WorkflowNodeDefinition[] {
  const nodeById = new Map(workflow.nodes.map((node) => [node.nodeId, node]));
  const settled = new Map<string, "completed" | "failed">();
  let failed = false;
  for (const settlement of settlements) {
    if (
      typeof settlement !== "object" ||
      settlement === null ||
      Object.keys(settlement).sort().join(",") !== "nodeId,status" ||
      typeof settlement.nodeId !== "string" ||
      (settlement.status !== "completed" && settlement.status !== "failed")
    ) {
      throw new Error("workflow_node_settlement_invalid");
    }
    const node = nodeById.get(settlement.nodeId);
    if (
      node === undefined ||
      settled.has(settlement.nodeId) ||
      failed ||
      node.dependsOn.some(
        (dependency) => settled.get(dependency) !== "completed",
      )
    ) {
      throw new Error("workflow_node_settlement_invalid");
    }
    const ready = workflow.executionOrder.filter((nodeId) => {
      const candidate = nodeById.get(nodeId)!;
      return (
        !settled.has(nodeId) &&
        candidate.dependsOn.every(
          (dependency) => settled.get(dependency) === "completed",
        )
      );
    });
    if (ready[0] !== settlement.nodeId)
      throw new Error("workflow_node_settlement_invalid");
    settled.set(settlement.nodeId, settlement.status);
    failed = settlement.status === "failed";
  }
  if (failed) return [];
  return workflow.executionOrder
    .map((nodeId) => workflow.nodes.find((node) => node.nodeId === nodeId)!)
    .filter(
      (node) =>
        !settled.has(node.nodeId) &&
        node.dependsOn.every(
          (dependency) => settled.get(dependency) === "completed",
        ),
    );
}
