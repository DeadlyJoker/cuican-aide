import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionState,
  type WorkflowNodeAttemptAdmission,
} from "@crewon/application";
import type {
  CompiledWorkflowVersion,
  RunStepState,
  RunAttemptState,
} from "@crewon/domain";
import { workflowVerificationResultError } from "@crewon/domain";
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

export function validateWorkflowNodeRows(
  rows: readonly WorkflowNodeRow[],
  state: WorkflowExecutionState,
  workflow: CompiledWorkflowVersion,
): Map<string, WorkflowNodeRow> {
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
      if (
        output.digest !== row.output_digest ||
        workflowVerificationResultError(definition, output.value) !== null
      )
        corrupt();
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

export function validateWorkflowNodeAdmission(
  state: WorkflowExecutionState,
  workflow: CompiledWorkflowVersion,
  row: WorkflowNodeRow,
  step: RunStepState | null,
  attempt: RunAttemptState | null,
): WorkflowNodeAttemptAdmission {
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

function corrupt(): never {
  throw new RunStoreError("workflow_node_authority_corrupt");
}
