import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionState,
  type WorkflowHumanGateAuthority,
  type WorkflowHumanGateDecision,
  type WorkItem,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import type { decodeWorkflowCompositionContext } from "./workflow-composition-context.ts";
import { validateWorkflowSchedulerWorkItems } from "./workflow-run-admission-validation.ts";

export type GateContext = ReturnType<typeof decodeWorkflowCompositionContext>;
export type WorkflowHumanGateRow = {
  authority: WorkflowHumanGateAuthority;
  decision: WorkflowHumanGateDecision | null;
  wake: WorkItem | null;
};
export type WorkflowHumanGateStoredRow = {
  node_id: string;
  request_id: string;
  wake_work_item_id: string | null;
  authority_json: string | null;
  decided: boolean | number;
  decision_json: string | null;
  wake_json: string | null;
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
/** Pure authority validation, shared by both database implementations. */
export function validateWorkflowHumanGateRows(
  rows: readonly WorkflowHumanGateStoredRow[],
  state: WorkflowExecutionState,
  parent: RunState,
  context: GateContext,
): Map<string, WorkflowHumanGateRow> {
  const claimed = state.nodes.filter(
    (n) => n.kind === "humanGate" && n.claimId !== null,
  );
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
    result.set(node.nodeId, { authority, decision, wake });
  }
  return result;
}
function corrupt(): never {
  throw new RunStoreError("workflow_gate_authority_conflict");
}
