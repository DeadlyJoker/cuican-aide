import type { PoolClient } from "pg";
import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionState,
} from "@crewon/application";
import type { CompiledWorkflowVersion } from "@crewon/domain";
import {
  readPostgresWorkflowNodes,
  postgresWorkflowNodeAdmission,
} from "./postgres-workflow-node-authority.ts";

/** Pending nodes and non-executing gates only; no external execution is declared stopped here. */
export async function cancelPostgresWorkflowUnstartedNodes(
  client: PoolClient,
  sql: string,
  state: WorkflowExecutionState,
  workflow: CompiledWorkflowVersion,
  now: string,
) {
  const rows = await readPostgresWorkflowNodes(client, sql, state, workflow);
  const nodes = [];
  for (const node of state.nodes) {
    if (node.status !== "pending" && node.status !== "waitingHuman") {
      nodes.push(node);
      continue;
    }
    if (node.status === "waitingHuman") {
      const row = rows.get(node.nodeId)!;
      const { step } = await postgresWorkflowNodeAdmission(
        client,
        sql,
        state,
        workflow,
        row,
      );
      const next = {
        ...step,
        status: "canceled",
        revision: step.revision + 1,
        updatedAt: now,
        terminalAt: now,
      };
      const changed = await client.query(
        `UPDATE ${sql}.run_steps SET status='canceled',revision=$1,state_json=$2,updated_at=$3,terminal_at=$3
         WHERE tenant_id=$4 AND run_id=$5 AND step_id=$6 AND revision=$7 AND status='waitingApproval'`,
        [
          next.revision,
          canonicalJson(next),
          now,
          state.tenantId,
          state.runId,
          step.stepId,
          step.revision,
        ],
      );
      if (changed.rowCount !== 1)
        throw new RunStoreError("workflow_gate_cancellation_conflict");
      const settled = await client.query(
        `UPDATE ${sql}.workflow_node_admissions SET settlement_fingerprint=$1 WHERE tenant_id=$2 AND run_id=$3 AND node_id=$4 AND settlement_fingerprint IS NULL`,
        [
          canonicalJson({
            kind: "workflow.node-settle.v1",
            nodeId: node.nodeId,
            claimId: node.claimId,
            outcome: { status: "canceled" },
          }),
          state.tenantId,
          state.runId,
          node.nodeId,
        ],
      );
      if (settled.rowCount !== 1)
        throw new RunStoreError("workflow_gate_cancellation_conflict");
    }
    nodes.push({ ...node, status: "canceled" as const, leaseExpiresAt: null });
  }
  return nodes;
}
