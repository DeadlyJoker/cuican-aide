import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionState,
} from "@crewon/application";
import type { CompiledWorkflowVersion } from "@crewon/domain";
import {
  readSqliteWorkflowNodes,
  sqliteWorkflowNodeAdmission,
} from "./sqlite-workflow-node-authority.ts";

/** Only pending nodes and non-executing human gates; never declares an external effect stopped. */
export function cancelSqliteWorkflowUnstartedNodes(
  db: DatabaseSync,
  current: WorkflowExecutionState,
  workflow: CompiledWorkflowVersion,
  now: string,
) {
  const rows = readSqliteWorkflowNodes(db, current, workflow);
  return current.nodes.map((node) => {
    if (node.status !== "pending" && node.status !== "waitingHuman")
      return node;
    if (node.status === "waitingHuman") {
      const row = rows.get(node.nodeId)!;
      const { step } = sqliteWorkflowNodeAdmission(db, current, workflow, row);
      const next = {
        ...step,
        status: "canceled",
        revision: step.revision + 1,
        updatedAt: now,
        terminalAt: now,
      };
      const changed = db
        .prepare(
          "UPDATE run_steps SET status='canceled',revision=?,state_json=?,updated_at=?,terminal_at=? WHERE tenant_id=? AND run_id=? AND step_id=? AND revision=? AND status='waitingApproval'",
        )
        .run(
          next.revision,
          canonicalJson(next),
          now,
          now,
          current.tenantId,
          current.runId,
          step.stepId,
          step.revision,
        );
      if (changed.changes !== 1)
        throw new RunStoreError("workflow_gate_cancellation_conflict");
      db.prepare(
        "UPDATE workflow_node_admissions SET settlement_fingerprint=? WHERE tenant_id=? AND run_id=? AND node_id=?",
      ).run(
        canonicalJson({
          kind: "workflow.node-settle.v1",
          nodeId: node.nodeId,
          claimId: node.claimId,
          outcome: { status: "canceled" },
        }),
        current.tenantId,
        current.runId,
        node.nodeId,
      );
    }
    return { ...node, status: "canceled" as const, leaseExpiresAt: null };
  });
}
