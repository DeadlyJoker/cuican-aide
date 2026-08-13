import type { WorkflowVersionAsset } from "@crewon/application";
import {
  parseCompiledWorkflowVersion,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type {
  WorkflowVersionSummaryView,
  WorkflowVersionView,
} from "@crewon/contracts/runtime";

export function projectWorkflowVersion(
  asset: WorkflowVersionAsset,
  digester: WorkflowContentDigester,
): WorkflowVersionView {
  const version = parseCompiledWorkflowVersion(asset.definitionJson, digester);
  return {
    workflowId: version.workflowId,
    workflowVersionId: version.workflowVersionId,
    contentDigest: version.contentDigest,
    name: version.name,
    description: version.description,
    inputSchema: version.inputSchema,
    outputSchema: version.outputSchema,
    entryNodeIds: [...version.entryNodeIds],
    outputNodeIds: [...version.outputNodeIds],
    nodes: structuredClone(
      version.nodes,
    ) as unknown as WorkflowVersionView["nodes"],
    executionOrder: [...version.executionOrder],
    createdAt: asset.createdAt,
  };
}

export function projectWorkflowVersionSummary(
  asset: WorkflowVersionAsset,
  digester: WorkflowContentDigester,
): WorkflowVersionSummaryView {
  const version = parseCompiledWorkflowVersion(asset.definitionJson, digester);
  return {
    workflowId: version.workflowId,
    workflowVersionId: version.workflowVersionId,
    contentDigest: version.contentDigest,
    name: version.name,
    description: version.description,
    createdAt: asset.createdAt,
  };
}
