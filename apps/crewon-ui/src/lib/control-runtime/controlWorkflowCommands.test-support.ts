import type { WorkflowIntentStorage } from "./controlWorkflowIntentJournal.ts";
import type {
  WorkflowRunSnapshotResponse,
  WorkflowHumanGateReviewResponse,
} from "@crewon/contracts";

/** Shared storage survives controller/window reconstruction; no browser globals. */
export function workflowIntentMemoryStorage(): WorkflowIntentStorage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    getItem(key) {
      return entries.get(key) ?? null;
    },
    setItem(key, value) {
      entries.set(key, value);
    },
    removeItem(key) {
      entries.delete(key);
    },
  };
}

export function workflowCommandsSnapshotFixture(): WorkflowRunSnapshotResponse {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    schemaVersion: "crewon.workflow-run-snapshot.v0",
    run: {
      runId: "run-1",
      threadId: "thread-1",
      status: "queued",
      revision: 1,
      lastSequence: 1,
      cancelRequested: false,
      waitingApproval: null,
      collaborationMode: "default",
      purpose: "workflow",
      workflowVersionBinding: {
        workflowId: "workflow-1",
        workflowVersionId: "version-1",
        contentDigest: digest,
      },
      goalBinding: null,
      outputRef: null,
      failure: null,
      createdAt: "2026-10-17T00:00:00Z",
      updatedAt: "2026-10-17T00:00:00Z",
      terminalAt: null,
    },
    workflow: { name: "Review", description: "" },
    input: { topic: "input" },
    execution: {
      revision: 2,
      status: "waitingHuman",
      cancelRequested: false,
      updatedAt: "2026-10-17T00:00:00Z",
    },
    nodes: [
      {
        nodeId: "gate",
        kind: "humanGate",
        title: "Review",
        agentVersionId: null,
        status: "waitingHuman",
        inputDigest: digest,
        resultDigest: null,
        failureCode: null,
        child: null,
        gate: {
          gateRequestId: "request-1",
          approvalPolicyId: "review-policy",
          inputDigest: digest,
        },
        output: null,
      },
    ],
  };
}
export function workflowCommandsReviewFixture(
  comment: string | null = "  同意\n保持原文  ",
): WorkflowHumanGateReviewResponse {
  const snapshot = workflowCommandsSnapshotFixture();
  const authority = {
    tenantId: "tenant-1",
    spaceId: "space-1",
    runId: snapshot.run.runId,
    nodeId: "gate",
    binding: snapshot.run.workflowVersionBinding!,
    claimId: "claim-1",
    gateRequestId: "request-1",
    approvalPolicyId: "review-policy",
    inputDigest: snapshot.nodes[0]!.inputDigest!,
  };
  return {
    schemaVersion: "crewon.workflow-human-gate-review.v1",
    authority,
    title: "Review",
    instruction: "请审核",
    input: snapshot.input,
    status: "completed",
    review: {
      comment,
      decision: {
        authority,
        actor: {
          tenantId: "tenant-1",
          spaceId: "space-1",
          actorId: "reviewer",
          principalId: "principal",
        },
        outcome: "approved",
        decidedAt: "2026-10-17T00:00:00Z",
      },
    },
  };
}
