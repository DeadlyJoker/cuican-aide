import type { ToolApprovalView } from "@crewon/contracts/runtime";
import type { ToolApprovalState } from "@crewon/domain";

export function projectToolApproval(
  state: ToolApprovalState,
): ToolApprovalView {
  return {
    approvalId: state.approvalId,
    runId: state.runId,
    status: state.status,
    revision: state.revision,
    requiredAt: state.requiredAt,
    expiresAt: state.expiresAt,
    decision: state.decision?.outcome ?? null,
    comment: state.decision?.comment ?? null,
    decidedAt: state.decision?.decidedAt ?? null,
  };
}
