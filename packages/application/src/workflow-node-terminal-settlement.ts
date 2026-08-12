import type {
  FrozenWorkflowVersionBinding,
  WorkflowNodeTerminalEvidence,
} from "@crewon/domain";

/** Domain-derived terminal value authority accepted by composition settlement. */
export type WorkflowNodeTerminalSettlement = Readonly<{
  binding: FrozenWorkflowVersionBinding;
  nodeId: string;
  operationId: string;
  evidence: WorkflowNodeTerminalEvidence;
}>;
