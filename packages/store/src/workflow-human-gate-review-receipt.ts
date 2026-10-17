import {
  canonicalJson,
  RunStoreError,
  validateWorkflowHumanGateReviewComment,
  type WorkflowHumanGateAuthority,
  type WorkflowHumanGateDecision,
  type WorkflowHumanGateReview,
} from "@crewon/application";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";

export const WORKFLOW_GATE_REVIEW_SCOPE = "workflow-human-gate-review.v1";
export const WORKFLOW_GATE_REVIEW_MAX_BYTES = 65536;
const schemaVersion = "crewon.workflow-human-gate-review.v1";
export type WorkflowGateReviewReceiptRow = {
  tenant_id: string;
  run_id: string;
  fingerprint: string;
  result_json: string | null;
};
export function workflowGateReviewKey(authority: WorkflowHumanGateAuthority) {
  return workflowAdmissionDigest.sha256(
    canonicalJson({
      tenantId: authority.tenantId,
      runId: authority.runId,
      nodeId: authority.nodeId,
      gateRequestId: authority.gateRequestId,
    }),
  );
}
export function workflowGateReviewReceipt(review: WorkflowHumanGateReview) {
  validateWorkflowHumanGateReviewComment(review.comment);
  const json = canonicalJson({ schemaVersion, ...review });
  if (Buffer.byteLength(json) > WORKFLOW_GATE_REVIEW_MAX_BYTES)
    throw new RunStoreError("workflow_gate_review_limit");
  return { json, fingerprint: workflowAdmissionDigest.sha256(json) };
}
export function readWorkflowGateReviewReceipt(
  row: WorkflowGateReviewReceiptRow | undefined,
  authority: WorkflowHumanGateAuthority,
  decision: WorkflowHumanGateDecision | null,
): WorkflowHumanGateReview | null {
  if (!row) {
    if (decision)
      throw new RunStoreError("workflow_gate_review_not_recorded_conflict");
    return null;
  }
  if (
    !decision ||
    row.tenant_id !== authority.tenantId ||
    row.run_id !== authority.runId ||
    typeof row.result_json !== "string" ||
    Buffer.byteLength(row.result_json) > WORKFLOW_GATE_REVIEW_MAX_BYTES
  )
    throw new RunStoreError("workflow_gate_review_corrupt");
  try {
    const record = JSON.parse(row.result_json);
    if (
      !record ||
      Array.isArray(record) ||
      Object.keys(record).sort().join() !== "comment,decision,schemaVersion" ||
      record.schemaVersion !== schemaVersion ||
      canonicalJson(record.decision) !== canonicalJson(decision)
    )
      throw new Error("review authority mismatch");
    validateWorkflowHumanGateReviewComment(record.comment);
    if (
      workflowAdmissionDigest.sha256(canonicalJson(record)) !== row.fingerprint
    )
      throw new Error("review fingerprint mismatch");
    return { decision, comment: record.comment };
  } catch (cause) {
    throw new RunStoreError("workflow_gate_review_corrupt", { cause });
  }
}
