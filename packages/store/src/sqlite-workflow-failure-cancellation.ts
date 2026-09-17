import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  projectWorkflowExecution,
  RunStoreError,
  type WorkflowExecutionState,
} from "@crewon/application";
import type { CompiledWorkflowVersion, RunState } from "@crewon/domain";
import type { WorkflowChildRow } from "./sqlite-workflow-child-dispatch.ts";
import {
  commitSqliteWorkflowChildCancellation,
  readSqliteWorkflowChildWorkItem,
  wakeSqliteWorkflowChildCancellation,
  type WorkflowChildCancellationOperations,
} from "./sqlite-workflow-child-cancellation.ts";
import {
  readSqliteWorkflowNodes,
  sqliteWorkflowNodeAdmission,
  type WorkflowNodeRow,
} from "./sqlite-workflow-node-authority.ts";
import { cancelSqliteWorkflowUnstartedNodes } from "./sqlite-workflow-unstarted-cancellation.ts";
import { writeSqliteWorkflowExecution } from "./sqlite-workflow-execution-authority.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";

/** Caller owns the scheduler lease or an authorized human-gate rejection transaction that settled the failed node.
 * Reuse the existing child cancellation receipt; no new queue, timer or per-pass marker.
 */
export function stopSqliteWorkflowFailedSiblings(
  db: DatabaseSync,
  input: {
    parent: RunState;
    state: WorkflowExecutionState;
    workflow: CompiledWorkflowVersion;
    children: ReadonlyMap<string, WorkflowChildRow>;
    now: string;
    nextId(): string;
  },
  ops: WorkflowChildCancellationOperations,
): WorkflowExecutionState {
  const { parent, state, workflow } = input;
  if (state.status !== "failed" || state.cancelRequested) return state;
  const rows = readSqliteWorkflowNodes(db, state, workflow);
  for (const row of rows.values())
    sqliteWorkflowNodeAdmission(db, state, workflow, row);
  const source = state.nodes.find((node) => node.status === "failed");
  if (!source) corrupt();
  const failure = rows.get(source.nodeId)!;
  for (const row of input.children.values()) {
    const child = ops.loadRun({
      tenantId: parent.tenantId,
      runId: row.child_run_id,
    })!;
    if (["completed", "failed", "canceled"].includes(child.status)) continue;
    const work = readSqliteWorkflowChildWorkItem(db, parent, child, row);
    // An individual/root cancellation is already sufficient. Never reset its reconciliation backoff.
    if (child.cancelRequested) {
      hasSqliteWorkflowFailureCancellation(db, parent, child, row, state, rows);
      continue;
    }
    commitSqliteWorkflowChildCancellation(
      {
        child,
        // This follows the root creator's frozen workflow policy; it is not a new root user-cancel request.
        actorId: parent.createdByActorId,
        idempotency: {
          scope: scope(parent),
          key: row.claim_id,
          requestFingerprint: fingerprint(parent, child, row, failure),
        },
      },
      ops,
      input.nextId,
    );
    wakeSqliteWorkflowChildCancellation(db, child, work, ops);
  }
  const nodes = cancelSqliteWorkflowUnstartedNodes(
    db,
    state,
    workflow,
    input.now,
  );
  if (nodes.every((node, index) => node === state.nodes[index])) return state;
  const next = projectWorkflowExecution(state, nodes, input.now);
  writeSqliteWorkflowExecution(db, state, next);
  return next;
}

/** Preserve the distinction between a stopped sibling and an independently canceled/failed node.
 * A bounded receipt must agree with a durable failed node and the canonical child cancellation event.
 */
export function hasSqliteWorkflowFailureCancellation(
  db: DatabaseSync,
  parent: RunState,
  child: RunState,
  target: WorkflowChildRow,
  state: WorkflowExecutionState,
  nodes: ReadonlyMap<string, WorkflowNodeRow>,
): boolean {
  const row = db
    .prepare(
      `SELECT tenant_id,run_id,
    CASE WHEN length(CAST(fingerprint AS BLOB))<=128 THEN fingerprint ELSE NULL END AS fingerprint,
    CASE WHEN length(CAST(result_json AS BLOB))<=16384 THEN result_json ELSE NULL END AS json
    FROM idempotency_receipts WHERE scope=? AND idempotency_key=?`,
    )
    .get(scope(parent), target.claim_id);
  if (!row) return false;
  if (
    row.tenant_id !== child.tenantId ||
    row.run_id !== child.runId ||
    typeof row.json !== "string" ||
    !child.cancelRequested
  )
    corrupt();
  if (
    !state.nodes.some(
      (node) =>
        node.status === "failed" &&
        nodes.get(node.nodeId)?.settlement_fingerprint &&
        fingerprint(parent, child, target, nodes.get(node.nodeId)!) ===
          row.fingerprint,
    )
  )
    corrupt();
  const receipt = JSON.parse(row.json);
  const event = receipt.events?.[0];
  if (
    receipt.state?.runId !== child.runId ||
    receipt.state?.tenantId !== child.tenantId ||
    receipt.state?.threadId !== child.threadId ||
    receipt.state?.cancelRequested !== true ||
    !Array.isArray(receipt.events) ||
    !Array.isArray(receipt.workItems) ||
    receipt.events?.length !== 1 ||
    receipt.workItems?.length !== 0 ||
    event?.type !== "run.cancel.requested" ||
    event.identity?.runId !== child.runId ||
    event.data?.actorId !== parent.createdByActorId ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    event.sequence > child.lastSequence ||
    receipt.state.lastSequence !== event.sequence
  )
    corrupt();
  const canonical = db
    .prepare(
      `SELECT CASE WHEN length(CAST(event_json AS BLOB))<=16384 THEN event_json ELSE NULL END AS json
    FROM run_events WHERE tenant_id=? AND run_id=? AND sequence=?`,
    )
    .get(child.tenantId, child.runId, event.sequence);
  if (
    typeof canonical?.json !== "string" ||
    canonicalJson(JSON.parse(canonical.json)) !== canonicalJson(event)
  )
    corrupt();
  return true;
}

function scope(parent: RunState) {
  return canonicalJson({
    namespace: "workflow.failure-child-cancel.v1",
    tenantId: parent.tenantId,
    runId: parent.runId,
  });
}
function fingerprint(
  parent: RunState,
  child: RunState,
  target: WorkflowChildRow,
  source: WorkflowNodeRow,
) {
  return workflowAdmissionDigest.sha256(
    canonicalJson({
      binding: parent.workflowVersionBinding,
      sourceSettlement: source.settlement_fingerprint,
      childRunId: child.runId,
      claimId: target.claim_id,
    }),
  );
}
function corrupt(): never {
  throw new RunStoreError("workflow_failure_cancel_authority_conflict");
}
