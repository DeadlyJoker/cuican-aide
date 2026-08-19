import {
  RunStoreError,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import type { WorkflowContentDigester } from "@crewon/domain";
import type { PoolClient } from "pg";

import { stableJson } from "./store-invariants.ts";
import { settlePostgresWorkflowNodeModelTerminal } from "./postgres-workflow-model-settlement.ts";
import {
  insertPostgresWorkflowReceipt,
  loadPostgresWorkflowExecution,
  loadPostgresWorkflowReceipt,
  postgresWorkflowFingerprint,
} from "./postgres-workflow-run-composition-transactions.ts";

type Input = Parameters<
  WorkflowRunCompositionStore["settleRetrievedWorkflowNode"]
>[0];
type Result = Awaited<
  ReturnType<WorkflowRunCompositionStore["settleRetrievedWorkflowNode"]>
>;

export async function settlePostgresRetrievedWorkflowNode(
  client: PoolClient,
  schema: string,
  input: Input,
  digester: WorkflowContentDigester,
): Promise<Result> {
  const reconcileInput = {
    tenantId: input.tenantId,
    runId: input.runId,
    lease: input.lease,
    binding: input.binding,
    nodeId: input.nodeId,
    claimId: input.claimId,
    claimEpoch: input.claimEpoch,
    reconciliationOperationId: input.reconciliationOperationId,
  };
  const receiptInput = {
    ...reconcileInput,
    operationId: `reconcile:${input.reconciliationOperationId}`,
  };
  const fingerprint = postgresWorkflowFingerprint(
    "reconcileNode",
    reconcileInput,
    digester,
  );
  const replay = (await loadPostgresWorkflowReceipt(
    client,
    schema,
    receiptInput,
    "reconcileNode",
    fingerprint,
  )) as Result | null;
  if (replay !== null) {
    if (
      stableJson(replay.evidence) !== stableJson(input.evidence) ||
      stableJson(replay.dispatchTerminalOutcome) !==
        stableJson(input.dispatchTerminalOutcome)
    )
      throw new RunStoreError("workflow_reconciliation_receipt_corrupt");
    return structuredClone({ ...replay, disposition: "replay" });
  }
  const work = await client.query<{ work_item_json: { payload?: unknown } }>(
    `SELECT work_item_json FROM ${schema}.work_items
     WHERE work_item_id=$1 FOR UPDATE`,
    [input.lease.workItemId],
  );
  const expectedPayload = {
    schemaVersion: "crewon.workflow-reconcile-work-item.v0",
    trigger: "workflowReconcile",
    binding: input.binding,
    nodeId: input.nodeId,
    claimId: input.claimId,
    claimEpoch: input.claimEpoch,
    reconciliationOperationId: input.reconciliationOperationId,
  };
  if (
    stableJson(work.rows[0]?.work_item_json.payload) !==
    stableJson(expectedPayload)
  )
    throw new RunStoreError("workflow_composition_work_item_mismatch");
  const execution = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  const node = execution?.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  if (
    execution === null ||
    node === undefined ||
    (node.status !== "unknown" &&
      (node.status !== "running" ||
        input.attempt.workItemId !== input.lease.workItemId ||
        input.attempt.leaseEpoch !== input.lease.leaseEpoch)) ||
    node.claimId !== input.claimId ||
    node.claimEpoch !== input.claimEpoch ||
    node.agentVersionId !== input.agentVersionId
  )
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  const authority = {
    tenantId: input.tenantId,
    runId: input.runId,
    workItemId: input.attempt.workItemId,
    leaseEpoch: input.attempt.leaseEpoch,
    nodeId: input.nodeId,
    nodeKind:
      node.kind === "verification"
        ? ("verification" as const)
        : ("agent" as const),
    claimId: input.claimId,
    claimEpoch: input.claimEpoch,
    agentVersionId: input.agentVersionId,
    attempt: {
      stepId: input.attempt.stepId,
      attemptId: input.attempt.attemptId,
    },
  };
  const settled = await settlePostgresWorkflowNodeModelTerminal(
    client,
    schema,
    {
      binding: input.binding,
      nodeId: input.nodeId,
      operationId: `node-model-terminal:${input.claimId}`,
      evidence: input.evidence,
      lease: input.lease,
      authority,
      dispatch: input.dispatch,
      dispatchTerminalOutcome: input.dispatchTerminalOutcome,
    },
    digester,
    "reconciliation",
  );
  const next = await loadPostgresWorkflowExecution(client, schema, input, true);
  if (next === null)
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  const result = {
    disposition: "settled" as const,
    evidenceStatus: "responseObserved" as const,
    evidence: structuredClone(input.evidence),
    dispatchTerminalOutcome: structuredClone(input.dispatchTerminalOutcome),
    execution: next,
    handoff: settled.handoff,
    runDisposition: settled.runDisposition,
  };
  await insertPostgresWorkflowReceipt(
    client,
    schema,
    receiptInput,
    "reconcileNode",
    fingerprint,
    result,
  );
  return structuredClone(result);
}
