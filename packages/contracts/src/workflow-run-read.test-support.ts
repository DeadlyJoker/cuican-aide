import type {
  WorkflowRunSnapshotResponse,
  WorkflowHumanGateResponse,
} from "./workflow-run-read-contract.ts";
import { transcriptSnapshotFixture } from "./thread-transcript-snapshot.test-support.ts";
export const workflowReadDigest = `sha256:${"a".repeat(64)}`;
export const workflowReadLocator = {
  runId: "run-1",
  nodeId: "gate",
  gateRequestId: "request-1",
};
export function workflowRunReadFixture(): WorkflowRunSnapshotResponse {
  return {
    schemaVersion: "crewon.workflow-run-snapshot.v0",
    run: {
      ...transcriptSnapshotFixture().runs[0]!,
      status: "queued",
      collaborationMode: "default",
      purpose: "workflow",
      workflowVersionBinding: {
        workflowId: "workflow-1",
        workflowVersionId: "version-1",
        contentDigest: workflowReadDigest,
      },
    },
    workflow: { name: "Review", description: "" },
    input: { prompt: "输入" },
    execution: {
      revision: 2,
      status: "waitingHuman",
      cancelRequested: false,
      updatedAt: "2026-10-16T00:00:00Z",
    },
    nodes: [
      {
        nodeId: "gate",
        kind: "humanGate",
        title: "Review",
        agentVersionId: null,
        status: "waitingHuman",
        inputDigest: workflowReadDigest,
        resultDigest: null,
        failureCode: null,
        child: null,
        gate: {
          gateRequestId: "request-1",
          approvalPolicyId: "review-policy",
          inputDigest: workflowReadDigest,
        },
        output: null,
      },
    ],
  };
}
export function workflowGateReadFixture(): WorkflowHumanGateResponse {
  return {
    schemaVersion: "crewon.workflow-human-gate.v0",
    authority: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      ...workflowReadLocator,
      binding: workflowRunReadFixture().run.workflowVersionBinding!,
      claimId: "claim-1",
      approvalPolicyId: "review-policy",
      inputDigest: workflowReadDigest,
    },
    title: "Review",
    instruction: "请审核",
    input: { prompt: "输入" },
    status: "waitingHuman",
    decision: null,
  };
}
