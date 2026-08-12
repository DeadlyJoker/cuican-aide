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
  const settled = new Map(
    settlements.map((item) => [item.nodeId, item.status]),
  );
  if (
    settlements.some(
      (item) => !workflow.nodes.some((node) => node.nodeId === item.nodeId),
    )
  ) {
    throw new Error("workflow_node_settlement_invalid");
  }
  if (settlements.some((item) => item.status === "failed")) return [];
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
