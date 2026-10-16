import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionState,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { assertSqliteWorkflowHumanGateSchema } from "./sqlite-workflow-human-gate-schema.ts";
import {
  validateWorkflowHumanGateRows,
  type GateContext,
  type WorkflowHumanGateRow,
  type WorkflowHumanGateStoredRow,
} from "./workflow-human-gate-authority.ts";
export { workflowHumanGateAuthority } from "./workflow-human-gate-authority.ts";
export type {
  GateContext,
  WorkflowHumanGateRow,
} from "./workflow-human-gate-authority.ts";

/** Shared by scheduler, decisions, cancellation and root finalization. No lookup across lifetime history. */
export function readSqliteWorkflowHumanGates(
  db: DatabaseSync,
  state: WorkflowExecutionState,
  parent: RunState,
  context: GateContext,
  options: { requirePublishedGates: boolean },
): Map<string, WorkflowHumanGateRow> {
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
    .all(state.tenantId, state.runId) as WorkflowHumanGateStoredRow[];
  // Legacy direct gates remain readable without published gate authority.
  if (!options.requirePublishedGates && rows.length === 0) return new Map();
  const result = validateWorkflowHumanGateRows(rows, state, parent, context);
  for (const { wake } of result.values()) {
    if (!wake) continue;
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
  }
  return result;
}
function corrupt(): never {
  throw new RunStoreError("workflow_gate_authority_conflict");
}
