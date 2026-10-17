import { workflowGateReadFixture } from "./workflow-run-read.test-support.ts";
import type { WorkflowHumanGateReviewResponse } from "./workflow-human-gate-review-contract.ts";
export function workflowGateReviewFixture(
  comment: string | null = "  同意\n保持原文  ",
): WorkflowHumanGateReviewResponse {
  const {
    decision: _decision,
    schemaVersion: _version,
    ...view
  } = workflowGateReadFixture();
  return {
    ...view,
    schemaVersion: "crewon.workflow-human-gate-review.v1",
    status: "completed",
    review: {
      decision: {
        authority: view.authority,
        actor: {
          tenantId: view.authority.tenantId,
          spaceId: view.authority.spaceId,
          actorId: "reviewer",
          principalId: "principal",
        },
        outcome: "approved",
        decidedAt: "2026-10-16T00:00:00Z",
      },
      comment,
    },
  };
}
