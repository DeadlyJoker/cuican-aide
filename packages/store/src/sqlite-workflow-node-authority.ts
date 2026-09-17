import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionState,
  type WorkflowNodeAttemptAdmission,
} from "@crewon/application";
import type { CompiledWorkflowVersion, RunStepState } from "@crewon/domain";
import {
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import { workflowNodeValue } from "./workflow-node-value.ts";

export type WorkflowNodeRow = {
  node_id: string;
  claim_id: string;
  step_id: string;
  attempt_id: string | null;
  work_item_id: string;
  lease_epoch: number;
  operation_id: string;
  input_digest: string;
  input_json: string | null;
  output_digest: string | null;
  output_json: string | null;
  settlement_fingerprint: string | null;
  queue_tenant: string | null;
  queue_run: string | null;
  queue_epoch: number | null;
  queue_status: string | null;
  queue_expires: number | null;
};

export function readSqliteWorkflowNodes(
  database: DatabaseSync,
  state: WorkflowExecutionState,
  workflow: CompiledWorkflowVersion,
): Map<string, WorkflowNodeRow> {
  const rows = database
    .prepare(
      `SELECT n.node_id,n.claim_id,n.step_id,n.attempt_id,n.work_item_id,n.lease_epoch,n.operation_id,n.input_digest,
    CASE WHEN length(CAST(n.input_json AS BLOB))<=32768 THEN n.input_json ELSE NULL END AS input_json,
    n.output_digest,CASE WHEN length(CAST(n.output_json AS BLOB))<=32768 THEN n.output_json ELSE NULL END AS output_json,
    CASE WHEN length(CAST(n.settlement_fingerprint AS BLOB))<=4096 THEN n.settlement_fingerprint ELSE NULL END AS settlement_fingerprint,
    q.tenant_id AS queue_tenant,q.run_id AS queue_run,q.lease_epoch AS queue_epoch,q.status AS queue_status,q.lease_expires_at_ms AS queue_expires
    FROM workflow_node_admissions n LEFT JOIN work_items q ON q.work_item_id=n.work_item_id
    WHERE n.tenant_id=? AND n.run_id=? ORDER BY n.node_id LIMIT 65`,
    )
    .all(state.tenantId, state.runId) as unknown as WorkflowNodeRow[];
  if (rows.length > 64) corrupt();
  const nodes = new Map(rows.map((row) => [row.node_id, row]));
  if (
    state.nodes.length !== workflow.nodes.length ||
    state.nodes.some(
      (node, index) => node.nodeId !== workflow.executionOrder[index],
    )
  )
    corrupt();
  for (const node of state.nodes) {
    const definition = workflow.nodes.find(
      (value) => value.nodeId === node.nodeId,
    )!;
    if (
      node.kind !== definition.kind ||
      node.agentVersionId !==
        (definition.kind === "agent"
          ? definition.agentVersionId
          : definition.kind === "verification"
            ? definition.verifierAgentVersionId
            : null)
    )
      corrupt();
    const row = nodes.get(node.nodeId);
    if (node.claimId === null) {
      if (row) corrupt();
      continue;
    }
    if (
      !row ||
      row.claim_id !== node.claimId ||
      row.input_digest !== node.inputDigest ||
      row.operation_id !== node.claimOperationId ||
      row.input_json === null ||
      row.queue_tenant !== state.tenantId ||
      row.queue_run !== state.runId ||
      (definition.kind === "humanGate") !== (row.attempt_id === null)
    )
      corrupt();
    const value = workflowNodeValue(
      JSON.parse(row.input_json),
      definition.inputSchema,
    );
    if (value.digest !== row.input_digest) corrupt();
    const terminal =
      node.status === "completed" ||
      node.status === "failed" ||
      node.status === "canceled";
    if (terminal !== (row.settlement_fingerprint !== null)) corrupt();
    if (node.status === "completed") {
      if (
        row.output_json === null ||
        row.output_digest !== node.resultDigest ||
        row.settlement_fingerprint === null
      )
        corrupt();
      const output = workflowNodeValue(
        JSON.parse(row.output_json),
        definition.outputSchema,
      );
      if (output.digest !== row.output_digest) corrupt();
    } else if (row.output_json !== null || row.output_digest !== null)
      corrupt();
    if (
      terminal &&
      row.settlement_fingerprint !==
        canonicalJson({
          kind: "workflow.node-settle.v1",
          nodeId: node.nodeId,
          claimId: node.claimId,
          outcome:
            node.status === "completed"
              ? { status: "completed", digest: node.resultDigest }
              : node.status === "failed"
                ? { status: "failed", failureCode: node.failureCode }
                : { status: "canceled" },
        })
    )
      corrupt();
  }
  if (
    rows.length !== state.nodes.filter((node) => node.claimId !== null).length
  )
    corrupt();
  return nodes;
}

export function sqliteWorkflowNodeAdmission(
  database: DatabaseSync,
  state: WorkflowExecutionState,
  workflow: CompiledWorkflowVersion,
  row: WorkflowNodeRow,
): WorkflowNodeAttemptAdmission {
  // Guard canonical Step/Attempt bodies before the shared decoders retrieve them.
  const bytes = database
    .prepare(
      `SELECT length(CAST(s.state_json AS BLOB)) AS step_bytes,
    CASE WHEN ? IS NULL THEN 0 ELSE length(CAST(a.state_json AS BLOB)) END AS attempt_bytes
    FROM run_steps s LEFT JOIN run_attempts a ON a.tenant_id=s.tenant_id AND a.run_id=s.run_id AND a.step_id=s.step_id AND a.attempt_id=?
    WHERE s.tenant_id=? AND s.run_id=? AND s.step_id=?`,
    )
    .get(
      row.attempt_id,
      row.attempt_id,
      state.tenantId,
      state.runId,
      row.step_id,
    ) as { step_bytes: number; attempt_bytes: number | null } | undefined;
  if (
    !bytes ||
    bytes.step_bytes > 65536 ||
    bytes.attempt_bytes === null ||
    bytes.attempt_bytes > 65536
  )
    corrupt();
  const locator = {
    tenantId: state.tenantId,
    runId: state.runId,
    stepId: row.step_id,
  };
  const step = loadSqliteRunStep(database, locator);
  const attempt =
    row.attempt_id === null
      ? null
      : loadSqliteRunAttempt(database, {
          ...locator,
          attemptId: row.attempt_id,
        });
  const node = state.nodes.find((value) => value.nodeId === row.node_id)!;
  const definition = workflow.nodes.find(
    (value) => value.nodeId === row.node_id,
  )!;
  if (
    !step ||
    step.kind !==
      (definition.kind === "humanGate"
        ? "gate"
        : definition.kind === "verification"
          ? "verification"
          : "workflowNode") ||
    step.currentAttemptId !== row.attempt_id ||
    (row.attempt_id !== null &&
      (!attempt ||
        attempt.workItemId !== row.work_item_id ||
        attempt.leaseEpoch !== row.lease_epoch))
  )
    corrupt();
  const expected =
    node.status === "waitingHuman"
      ? "waitingApproval"
      : node.status === "unknown"
        ? "running"
        : node.status;
  if (step.status !== expected || (attempt && attempt.status !== expected))
    corrupt();
  return {
    claim: {
      node: definition,
      claimId: node.claimId!,
      claimEpoch: node.claimEpoch,
      gateRequestId: node.gateRequestId,
      inputDigest: node.inputDigest!,
    },
    step,
    attempt,
  };
}

export function insertSqliteWorkflowGate(
  database: DatabaseSync,
  input: { tenantId: string; runId: string; stepId: string; now: string },
): RunStepState {
  const step: RunStepState = {
    schemaVersion: "crewon.run-step.v0",
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.stepId,
    kind: "gate",
    status: "waitingApproval",
    revision: 1,
    currentAttemptId: null,
    attemptCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
    terminalAt: null,
  };
  database
    .prepare(
      `INSERT INTO run_steps (tenant_id,run_id,step_id,kind,status,revision,current_attempt_id,attempt_count,state_json,created_at,updated_at,terminal_at)
    VALUES (?,?,?,'gate','waitingApproval',1,NULL,0,?,?,?,NULL)`,
    )
    .run(
      input.tenantId,
      input.runId,
      input.stepId,
      canonicalJson(step),
      input.now,
      input.now,
    );
  return step;
}

function corrupt(): never {
  throw new RunStoreError("workflow_node_authority_corrupt");
}
