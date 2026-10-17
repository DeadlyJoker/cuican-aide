import type { WorkflowVersionView } from "@crewon/contracts";
import type { CrewonWorkflowRecord } from "../workflow/crewonWorkflow.ts";
import { visibleWorkflowVerificationInstruction } from "@crewon/domain/workflow-verification";
export function workflowRecord(
  version: WorkflowVersionView,
  runs: CrewonWorkflowRecord["config"]["runs"],
): CrewonWorkflowRecord {
  return {
    filePath: `control:workflow-version:${version.workflowVersionId}`,
    savedAt: version.createdAt,
    config: {
      workflowId: version.workflowVersionId,
      name: version.name,
      description: version.description,
      lead:
        version.nodes.find((node) => node.kind === "agent")?.agentVersionId ??
        "Human Gate",
      status: runs?.[0]?.status ?? "ready",
      resourceSource: "crewon",
      createdAt: Date.parse(version.createdAt),
      updatedAt: runs?.[0]?.updatedAt ?? Date.parse(version.createdAt),
      nodes: version.executionOrder.map((nodeId) => {
        const node = version.nodes.find(
          (candidate) => candidate.nodeId === nodeId,
        )!;
        return node.kind === "humanGate"
          ? {
              nodeId: node.nodeId,
              type: "humanGate" as const,
              title: node.title,
              instruction: node.instruction,
            }
          : {
              nodeId: node.nodeId,
              type:
                node.kind === "verification"
                  ? ("verification" as const)
                  : ("agent" as const),
              title: node.title,
              instruction: visibleWorkflowNodeInstruction(node),
              agentId: requireAgentVersionId(node),
              agentName: requireAgentVersionId(node),
            };
      }),
      runs,
    },
  };
}

function visibleWorkflowNodeInstruction(
  node: WorkflowVersionView["nodes"][number],
): string {
  return node.kind === "verification"
    ? visibleWorkflowVerificationInstruction(node.instruction)
    : node.instruction;
}

function requireAgentVersionId(
  node: WorkflowVersionView["nodes"][number],
): string {
  const agentVersionId =
    node.kind === "verification"
      ? node.verifierAgentVersionId
      : node.agentVersionId;
  if (!agentVersionId) throw new Error("control_workflow_agent_missing");
  return agentVersionId;
}
