import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionState,
  type WorkflowHumanGateAuthority,
  type WorkflowHumanGateDecision,
  type WorkItem,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import type { readSqliteWorkflowCompositionContext } from "./sqlite-workflow-composition-context.ts";
import { assertSqliteWorkflowHumanGateSchema } from "./sqlite-workflow-human-gate-schema.ts";
import { validateWorkflowSchedulerWorkItems } from "./workflow-run-admission-validation.ts";

export type GateContext = ReturnType<
  typeof readSqliteWorkflowCompositionContext
>;
export type WorkflowHumanGateRow = {
  authority: WorkflowHumanGateAuthority;
  decision: WorkflowHumanGateDecision | null;
  wake: WorkItem | null;
};
export function workflowHumanGateAuthority(
  state: WorkflowExecutionState,
  parent: RunState,
  context: GateContext,
  nodeId: string,
): WorkflowHumanGateAuthority {
  const node = state.nodes.find((n) => n.nodeId === nodeId)!,
    definition = context.workflow.nodes.find((n) => n.nodeId === nodeId)!;
  if (
    definition.kind !== "humanGate" ||
    node.kind !== "humanGate" ||
    !node.claimId ||
    !node.gateRequestId ||
    !node.inputDigest
  )
    corrupt();
  return {
    tenantId: parent.tenantId,
    spaceId: parent.spaceId,
    runId: parent.runId,
    nodeId,
    binding: parent.workflowVersionBinding!,
    claimId: node.claimId,
    gateRequestId: node.gateRequestId,
    approvalPolicyId: definition.approvalPolicyId,
    inputDigest: node.inputDigest,
  };
}
/** Shared by scheduler, decisions, cancellation and root finalization. No lookup across lifetime history. */
export function readSqliteWorkflowHumanGates(
  db: DatabaseSync,
  state: WorkflowExecutionState,
  parent: RunState,
  context: GateContext,
  options: { requirePublishedGates: boolean },
): Map<string, WorkflowHumanGateRow> {
  const claimed = state.nodes.filter(
    (n) => n.kind === "humanGate" && n.claimId !== null,
  );
  const present = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE name IN ('workflow_human_gate_schema','workflow_human_gates') LIMIT 1",
    )
    .get();
  if (!present && !options.requirePublishedGates) return new Map();
  assertSqliteWorkflowHumanGateSchema(db);
  const rows = db
    .prepare(
      `SELECT node_id,request_id,wake_work_item_id,
    CASE WHEN length(CAST(authority_json AS BLOB))<=8192 THEN authority_json ELSE NULL END AS authority_json,
    decision_json IS NOT NULL AS decided,
    CASE WHEN length(CAST(decision_json AS BLOB))<=16384 THEN decision_json ELSE NULL END AS decision_json,
    CASE WHEN length(CAST(wake_json AS BLOB))<=65536 THEN wake_json ELSE NULL END AS wake_json
    FROM workflow_human_gates WHERE tenant_id=? AND run_id=? LIMIT 65`,
    )
    .all(state.tenantId, state.runId);
  // Unmanaged legacy direct gates remain readable only without a child-dispatch/gate composition.
  if (!options.requirePublishedGates && rows.length === 0) return new Map();
  if (rows.length !== claimed.length) corrupt();
  const result = new Map<string, WorkflowHumanGateRow>();
  for (const row of rows) {
    const node = claimed.find((n) => n.nodeId === row.node_id);
    if (!node || typeof row.authority_json !== "string") corrupt();
    const authority = workflowHumanGateAuthority(
      state,
      parent,
      context,
      node.nodeId,
    );
    if (
      row.request_id !== authority.gateRequestId ||
      canonicalJson(JSON.parse(row.authority_json)) !== canonicalJson(authority)
    )
      corrupt();
    if (!row.decided) {
      if (
        row.decision_json !== null ||
        row.wake_work_item_id !== null ||
        row.wake_json !== null ||
        !["waitingHuman", "canceled"].includes(node.status)
      )
        corrupt();
      result.set(node.nodeId, { authority, decision: null, wake: null });
      continue;
    }
    if (
      typeof row.decision_json !== "string" ||
      typeof row.wake_json !== "string"
    )
      corrupt();
    const decision = JSON.parse(row.decision_json) as WorkflowHumanGateDecision;
    if (
      Object.keys(decision).sort().join() !==
        "actor,authority,decidedAt,outcome" ||
      canonicalJson(decision.authority) !== canonicalJson(authority) ||
      !decision.actor ||
      Object.keys(decision.actor).sort().join() !==
        "actorId,principalId,spaceId,tenantId" ||
      decision.actor.tenantId !== parent.tenantId ||
      decision.actor.spaceId !== parent.spaceId ||
      typeof decision.actor.actorId !== "string" ||
      !decision.actor.actorId ||
      Buffer.byteLength(decision.actor.actorId) > 512 ||
      typeof decision.actor.principalId !== "string" ||
      !decision.actor.principalId ||
      Buffer.byteLength(decision.actor.principalId) > 512 ||
      !["approved", "rejected"].includes(decision.outcome) ||
      typeof decision.decidedAt !== "string" ||
      !Number.isFinite(Date.parse(decision.decidedAt)) ||
      new Date(decision.decidedAt).toISOString() !== decision.decidedAt ||
      node.status !==
        (decision.outcome === "approved" ? "completed" : "failed") ||
      (decision.outcome === "approved"
        ? node.resultDigest !== node.inputDigest
        : node.failureCode !== "workflow_human_gate_rejected")
    )
      corrupt();
    const wake = JSON.parse(row.wake_json) as WorkItem;
    validateWorkflowSchedulerWorkItems(
      [wake],
      parent.runId,
      parent.tenantId,
      () => false,
    );
    if (
      wake.workItemId !== row.wake_work_item_id ||
      canonicalJson(wake.payload.binding) !==
        canonicalJson(parent.workflowVersionBinding) ||
      canonicalJson(wake.payload.workflowInput) !==
        canonicalJson({
          valueId: context.rootInput.valueId,
          valueDigest: context.rootInput.valueDigest,
        })
    )
      corrupt();
    const stored = db
      .prepare(
        `SELECT tenant_id,run_id,CASE WHEN length(CAST(work_item_json AS BLOB))<=65536 THEN work_item_json ELSE NULL END AS json FROM work_items WHERE work_item_id=?`,
      )
      .get(wake.workItemId);
    if (
      stored?.tenant_id !== parent.tenantId ||
      stored.run_id !== parent.runId ||
      typeof stored.json !== "string" ||
      canonicalJson(JSON.parse(stored.json)) !== canonicalJson(wake)
    )
      corrupt();
    result.set(node.nodeId, { authority, decision, wake });
  }
  return result;
}
function corrupt(): never {
  throw new RunStoreError("workflow_gate_authority_conflict");
}
