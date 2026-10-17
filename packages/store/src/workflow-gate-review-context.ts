import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  RunStoreError,
  workflowChildReviewContextText,
  type WorkflowHumanGateReview,
  type WorkflowChildReviewContext,
} from "@crewon/application";
import type { CompiledWorkflowVersion } from "@crewon/domain";
import type { WorkflowHumanGateRow } from "./workflow-human-gate-authority.ts";
import {
  WORKFLOW_GATE_REVIEW_SCOPE,
  WORKFLOW_GATE_REVIEW_MAX_BYTES,
  workflowGateReviewKey,
  workflowGateReviewReceipt,
  readWorkflowGateReviewReceipt,
  type WorkflowGateReviewReceiptRow,
} from "./workflow-human-gate-review-receipt.ts";

const contextVersion = "crewon.workflow-scheduler-work-item.v2";

export function workflowReviewContextPayload(review: WorkflowHumanGateReview) {
  return {
    schemaVersion: contextVersion,
    reviewContext: {
      nodeId: review.decision.authority.nodeId,
      gateRequestId: review.decision.authority.gateRequestId,
      receiptFingerprint: workflowGateReviewReceipt(review).fingerprint,
    },
  };
}

/** Reject an oversized approval in its own transaction, while the user can still shorten it. */
export function assertWorkflowReviewContextFits(
  workflow: CompiledWorkflowVersion,
  gates: ReadonlyMap<string, WorkflowHumanGateRow>,
  review: WorkflowHumanGateReview,
): void {
  if (review.decision.outcome !== "approved") return;
  const nodeId = review.decision.authority.nodeId,
    gate = gates.get(nodeId);
  if (!gate) corrupt();
  const next = new Map(gates);
  next.set(nodeId, {
    ...gate,
    decision: review.decision,
    contextReview: review,
  });
  for (const node of workflow.nodes)
    if (node.kind !== "humanGate")
      workflowChildReviewContextText(
        workflowNodeReviewContext(workflow, node.nodeId, next),
      );
}

export function assertWorkflowReviewContextReplay(
  gate: WorkflowHumanGateRow,
  mode: "descendants-v1" | undefined,
) {
  if (
    (gate.wake?.payload.schemaVersion === contextVersion) !==
    (mode === "descendants-v1")
  )
    throw new RunStoreError("workflow_gate_review_context_conflict");
}

function markedGates(gates: ReadonlyMap<string, WorkflowHumanGateRow>) {
  if (gates.size > 64) corrupt();
  return [...gates.values()].filter(
    (gate) => gate.wake?.payload.schemaVersion === contextVersion,
  );
}

function hydrate(
  gates: ReadonlyMap<string, WorkflowHumanGateRow>,
  receipts: readonly (WorkflowGateReviewReceiptRow & {
    idempotency_key: string;
  })[],
) {
  const byKey = new Map(receipts.map((row) => [row.idempotency_key, row]));
  if (receipts.length > 64 || byKey.size !== receipts.length) corrupt();
  for (const gate of markedGates(gates)) {
    const ref = gate.wake!.payload.reviewContext as {
      nodeId: string;
      gateRequestId: string;
      receiptFingerprint: string;
    };
    if (
      !ref ||
      ref.nodeId !== gate.authority.nodeId ||
      ref.gateRequestId !== gate.authority.gateRequestId
    )
      corrupt();
    const row = byKey.get(workflowGateReviewKey(gate.authority));
    const review = readWorkflowGateReviewReceipt(
      row,
      gate.authority,
      gate.decision,
    );
    if (
      !review ||
      ref.receiptFingerprint !== workflowGateReviewReceipt(review).fingerprint
    )
      corrupt();
    gate.contextReview = review;
  }
}

/** At most one bounded receipt query for this DAG, never one query per ancestor. */
export async function readPostgresWorkflowReviewContexts(
  client: PoolClient,
  sql: string,
  gates: ReadonlyMap<string, WorkflowHumanGateRow>,
) {
  const keys = markedGates(gates).map((gate) =>
    workflowGateReviewKey(gate.authority),
  );
  if (!keys.length) return;
  const result = await client.query<
    WorkflowGateReviewReceiptRow & { idempotency_key: string }
  >(
    `SELECT tenant_id,run_id,idempotency_key,fingerprint,CASE WHEN octet_length(result_json::text)<=$3 THEN result_json::text ELSE NULL END AS result_json FROM ${sql}.idempotency_receipts WHERE scope=$1 AND idempotency_key=ANY($2::text[]) LIMIT 65`,
    [WORKFLOW_GATE_REVIEW_SCOPE, keys, WORKFLOW_GATE_REVIEW_MAX_BYTES],
  );
  hydrate(gates, result.rows);
}

export function readSqliteWorkflowReviewContexts(
  db: DatabaseSync,
  gates: ReadonlyMap<string, WorkflowHumanGateRow>,
) {
  const keys = markedGates(gates).map((gate) =>
    workflowGateReviewKey(gate.authority),
  );
  if (!keys.length) return;
  const rows = db
    .prepare(
      `SELECT tenant_id,run_id,idempotency_key,fingerprint,CASE WHEN length(CAST(result_json AS BLOB))<=? THEN result_json ELSE NULL END AS result_json FROM idempotency_receipts WHERE scope=? AND idempotency_key IN (${keys.map(() => "?").join(",")}) LIMIT 65`,
    )
    .all(
      WORKFLOW_GATE_REVIEW_MAX_BYTES,
      WORKFLOW_GATE_REVIEW_SCOPE,
      ...keys,
    ) as (WorkflowGateReviewReceiptRow & { idempotency_key: string })[];
  hydrate(gates, rows);
}

/** Only approved DAG ancestors contribute; siblings, later gates and legacy metadata do not. */
export function workflowNodeReviewContext(
  workflow: CompiledWorkflowVersion,
  nodeId: string,
  gates: ReadonlyMap<string, WorkflowHumanGateRow>,
): WorkflowChildReviewContext {
  const nodes = new Map(workflow.nodes.map((node) => [node.nodeId, node]));
  const target = nodes.get(nodeId);
  if (!target || nodes.size > 64) corrupt();
  const ancestors = new Set<string>(),
    pending = [...target.dependsOn];
  while (pending.length) {
    const id = pending.pop()!;
    if (ancestors.has(id)) continue;
    const node = nodes.get(id);
    if (!node || id === nodeId) corrupt();
    ancestors.add(id);
    pending.push(...node.dependsOn);
  }
  return workflow.executionOrder.flatMap((id) => {
    const review = gates.get(id)?.contextReview;
    return ancestors.has(id) && review?.decision.outcome === "approved"
      ? [{ title: nodes.get(id)!.title, comment: review.comment }]
      : [];
  });
}
function corrupt(): never {
  throw new RunStoreError("workflow_gate_review_context_corrupt");
}
