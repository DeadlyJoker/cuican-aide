import {
  RunStoreError,
  type SettleWorkflowNodeModelTerminalInput,
  type WorkflowNodeContinuationStore,
} from "@crewon/application";
import {
  validateWorkflowDispatchTerminalCorrelation,
  validateWorkflowNodeTerminalEvidence,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { PoolClient } from "pg";

import {
  loadPostgresModelDispatchReceipt,
  terminatePostgresModelDispatchForAttempt,
  transitionPostgresModelDispatch,
} from "./postgres-model-dispatch-evidence.ts";
import { settlePostgresWorkflowNode } from "./postgres-workflow-node-settlement.ts";
import {
  loadPostgresWorkflowAuthorities,
  loadPostgresWorkflowReceipt,
  postgresWorkflowFingerprint,
} from "./postgres-workflow-run-composition-transactions.ts";

type Result = Awaited<
  ReturnType<WorkflowNodeContinuationStore["settleWorkflowNodeModelTerminal"]>
>;

export async function settlePostgresWorkflowNodeModelTerminal(
  client: PoolClient,
  schema: string,
  input: SettleWorkflowNodeModelTerminalInput,
  digester: WorkflowContentDigester,
  source: "liveNode" | "reconciliation" = "liveNode",
): Promise<Result> {
  const { authority } = input;
  if (
    input.nodeId !== authority.nodeId ||
    (source === "liveNode" &&
      (input.lease.workItemId !== authority.workItemId ||
        input.lease.leaseEpoch !== authority.leaseEpoch))
  )
    throw new RunStoreError("workflow_composition_attempt_mismatch");
  const scope = {
    tenantId: authority.tenantId,
    runId: authority.runId,
    binding: input.binding,
    operationId: input.operationId,
  };
  const workflow = await loadPostgresWorkflowAuthorities(
    client,
    schema,
    scope,
    digester,
  );
  const evidence = validateWorkflowNodeTerminalEvidence({
    workflow,
    nodeId: input.nodeId,
    evidence: input.evidence,
    digester,
  });
  validateWorkflowDispatchTerminalCorrelation({
    dispatch: input.dispatchTerminalOutcome,
    evidence,
  });
  const replay = source === "liveNode"
    ? await loadPostgresWorkflowReceipt(
        client, schema, scope, "settleNode",
        postgresWorkflowFingerprint("settleNode", input, digester))
    : null;
  const locator = {
    tenantId: authority.tenantId,
    runId: authority.runId,
    ...authority.attempt,
    operationId: input.dispatch.operationId,
  };
  let dispatch = await loadPostgresModelDispatchReceipt(
    client,
    schema,
    locator,
    true,
  );
  if (
    dispatch === null ||
    dispatch.requestSequence !== input.dispatch.requestSequence ||
    dispatch.workItemId !== authority.workItemId ||
    dispatch.leaseEpoch !== authority.leaseEpoch
  )
    mismatch();
  if (replay === null) {
    if (
      dispatch.revision !== input.dispatch.expectedRevision ||
      dispatch.status !== input.dispatch.status
    )
      mismatch();
    const clock = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const terminalInput = {
      tenantId: authority.tenantId,
      runId: authority.runId,
      lease: input.lease,
      attempt: authority.attempt,
      operationId: input.dispatch.operationId,
      requestSequence: input.dispatch.requestSequence,
      expectedRevision: input.dispatch.expectedRevision,
      transitionedAt: clock.rows[0]!.now.toISOString(),
      outcome: input.dispatchTerminalOutcome,
    };
    dispatch = source === "liveNode"
      ? await transitionPostgresModelDispatch(
          client, schema, terminalInput, "terminal")
      : await terminatePostgresModelDispatchForAttempt(client, schema, {
          ...terminalInput,
          attemptWorkItemId: authority.workItemId,
          attemptLeaseEpoch: authority.leaseEpoch,
        });
  } else if (
    dispatch.revision !== input.dispatch.expectedRevision + 1 ||
    dispatch.status !== "terminal" ||
    dispatch.terminalOutcome?.kind !== input.dispatchTerminalOutcome.kind ||
    dispatch.terminalOutcome.code !== input.dispatchTerminalOutcome.code ||
    dispatch.terminalOutcome.certainty !==
      input.dispatchTerminalOutcome.certainty
  )
    mismatch();
  if (dispatch.terminalOutcome === null) mismatch();
  validateWorkflowDispatchTerminalCorrelation({
    dispatch: dispatch.terminalOutcome,
    evidence,
  });
  const settled = await settlePostgresWorkflowNode(
    client,
    schema,
    {
      tenantId: authority.tenantId,
      runId: authority.runId,
      lease: input.lease,
      binding: input.binding,
      nodeId: authority.nodeId,
      claimId: authority.claimId,
      claimEpoch: authority.claimEpoch,
      stepId: authority.attempt.stepId,
      attemptId: authority.attempt.attemptId,
      operationId: input.operationId,
      outcome:
        evidence.status === "completed"
          ? { status: "completed", value: evidence.value }
          : evidence.status === "failed"
            ? { status: "failed", failureCode: evidence.failureCode }
            : { status: "canceled" },
    },
    digester,
    {
      fingerprintAuthority: input,
      agentVersionId: authority.agentVersionId,
      attemptCheckpointDigest: dispatch.responseCheckpointDigest,
      ...(source === "liveNode"
        ? {}
        : { reconciliationAttempt: {
            workItemId: authority.workItemId,
            leaseEpoch: authority.leaseEpoch,
          } }),
    },
  );
  return {
    disposition: settled.disposition,
    continuation: null,
    handoff: settled.handoff,
    runDisposition: settled.runDisposition,
    evidence: structuredClone(evidence),
  };
}

function mismatch(): never {
  throw new RunStoreError("workflow_model_dispatch_mismatch");
}
