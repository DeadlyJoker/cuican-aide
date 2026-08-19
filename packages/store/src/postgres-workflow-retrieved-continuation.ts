import {
  canonicalJson,
  RunStoreError,
  validateWorkflowNodeContinuationCheckpoint,
  validateWorkflowRetrievedContinuationPayload,
  type WorkflowAgentAttemptAuthority,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import type { WorkflowContentDigester } from "@crewon/domain";
import type { PoolClient } from "pg";

import {
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import {
  loadPostgresModelDispatchReceipt,
  terminatePostgresModelDispatchForAttempt,
} from "./postgres-model-dispatch-evidence.ts";
import { adoptPostgresWorkflowPendingTools } from "./postgres-workflow-pending-tool-resume.ts";
import {
  resumePostgresWorkflowExecution,
  resumeRequiredResult,
} from "./postgres-workflow-reconcile-node.ts";
import { loadPostgresWorkflowContinuationForReconciliation } from "./postgres-workflow-continuation-resume.ts";
import { persistPostgresRetrievedWorkflowEvents } from "./postgres-workflow-retrieved-events.ts";
import { stableJson } from "./store-invariants.ts";
import {
  loadPostgresWorkflowAuthorities,
  loadPostgresWorkflowExecution,
  loadPostgresWorkflowValue,
  validatePostgresWorkflowLease,
} from "./postgres-workflow-run-composition-transactions.ts";

type Input = Parameters<
  WorkflowRunCompositionStore["commitRetrievedWorkflowNodeContinuation"]
>[0];
type Result = Awaited<
  ReturnType<
    WorkflowRunCompositionStore["commitRetrievedWorkflowNodeContinuation"]
  >
>;

export async function commitPostgresRetrievedWorkflowNodeContinuation(
  client: PoolClient,
  schema: string,
  input: Input,
  digester: WorkflowContentDigester,
): Promise<Result> {
  const payload = validateWorkflowRetrievedContinuationPayload(input.payload);
  const now = await validatePostgresWorkflowLease(client, schema, input);
  const workflow = await loadPostgresWorkflowAuthorities(
    client,
    schema,
    input,
    digester,
  );
  const work = await loadReconciliationWork(client, schema, input);
  const execution = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  const definition = workflow.nodes.find((node) => node.nodeId === input.nodeId);
  const node = execution?.nodes.find((item) => item.nodeId === input.nodeId);
  const step = await loadPostgresRunStep(
    client,
    schema,
    { tenantId: input.tenantId, runId: input.runId, stepId: input.nodeId },
    true,
  );
  const attempt = await loadPostgresRunAttempt(
    client,
    schema,
    {
      tenantId: input.tenantId,
      runId: input.runId,
      stepId: input.attempt.stepId,
      attemptId: input.attempt.attemptId,
    },
    true,
  );
  if (
    execution === null ||
    definition === undefined ||
    definition.kind === "humanGate" ||
    node === undefined ||
    (node.status !== "unknown" &&
      (node.status !== "running" ||
        attempt?.workItemId !== input.lease.workItemId ||
        attempt.leaseEpoch !== input.lease.leaseEpoch)) ||
    node.claimId !== input.claimId ||
    node.claimEpoch !== input.claimEpoch ||
    node.agentVersionId !== input.agentVersionId ||
    input.attempt.stepId !== input.nodeId ||
    step?.status !== "running" ||
    step.currentAttemptId !== input.attempt.attemptId ||
    attempt?.status !== "running" ||
    attempt.workItemId !== input.attempt.workItemId ||
    attempt.leaseEpoch !== input.attempt.leaseEpoch ||
    !segmentMatchesAttempt(input.attempt.attemptId, payload.next.segmentId)
  )
    corrupt();
  const inputValue = await loadPostgresWorkflowValue(
    client,
    schema,
    input,
    "nodeInput",
    input.nodeId,
    digester,
  );
  if (
    node.inputDigest === null ||
    inputValue?.valueDigest !== node.inputDigest ||
    stableJson(payload.next.providerCheckpoint) !==
      stableJson(attempt.providerCheckpoint) ||
    payload.next.providerTurnState !== attempt.providerTurnState ||
    payload.events.some((event) => event.runId !== input.runId)
  )
    corrupt();
  const sourceAuthority = authority(input, definition.kind);
  const prior = await loadPostgresWorkflowContinuationForReconciliation(
    client,
    schema,
    sourceAuthority,
  );
  if (stableJson(prior) !== stableJson(input.priorContinuation)) corrupt();
  validateProgression(input.attempt.attemptId, prior, payload.next);
  const dispatch = await loadPostgresModelDispatchReceipt(
    client,
    schema,
    {
      tenantId: input.tenantId,
      runId: input.runId,
      stepId: input.attempt.stepId,
      attemptId: input.attempt.attemptId,
      operationId: input.dispatch.operationId,
    },
    true,
  );
  const checkpointDigest = attempt.checkpointDigest;
  if (
    dispatch?.status !== "responseObserved" ||
    dispatch.operation !== "dispatch" ||
    dispatch.requestSequence !== input.dispatch.requestSequence ||
    dispatch.revision !== input.dispatch.expectedRevision ||
    dispatch.workItemId !== attempt.workItemId ||
    dispatch.leaseEpoch !== attempt.leaseEpoch ||
    dispatch.provider.agentVersionId !== input.agentVersionId ||
    dispatch.provider.adapterName !== attempt.providerCheckpoint?.adapterName ||
    dispatch.provider.adapterVersion !== attempt.providerCheckpoint?.adapterVersion ||
    dispatch.provider.modelId !== attempt.providerCheckpoint?.modelId ||
    checkpointDigest === null ||
    dispatch.responseCheckpointDigest !== checkpointDigest ||
    digester.sha256(canonicalJson(attempt.providerCheckpoint)) !== checkpointDigest
  )
    corrupt();

  await persistPostgresRetrievedWorkflowEvents(
    client,
    schema,
    input,
    payload.events,
    now,
    digester,
  );
  await terminatePostgresModelDispatchForAttempt(client, schema, {
    tenantId: input.tenantId,
    runId: input.runId,
    lease: input.lease,
    attempt: {
      stepId: input.attempt.stepId,
      attemptId: input.attempt.attemptId,
    },
    attemptWorkItemId: attempt.workItemId,
    attemptLeaseEpoch: attempt.leaseEpoch,
    operationId: dispatch.operationId,
    requestSequence: dispatch.requestSequence,
    expectedRevision: dispatch.revision,
    transitionedAt: now,
    outcome: { kind: "completed", code: null, certainty: "responseObserved" },
  });
  const resumedAttempt = await adoptAttempt(client, schema, attempt, input, now);
  const resumedExecution = await resumePostgresWorkflowExecution(
    client,
    schema,
    execution,
    input.nodeId,
    work.leaseExpiresAt,
    now,
  );
  const resumedAuthority = {
    ...sourceAuthority,
    workItemId: input.lease.workItemId,
    leaseEpoch: input.lease.leaseEpoch,
  };
  const continuation = await replaceContinuation(
    client,
    schema,
    resumedAuthority,
    prior,
    {
      ...payload.next,
      authority: resumedAuthority,
      activeDispatch: null,
      terminalCandidate: null,
    },
    now,
  );
  const pendingTools = await adoptPostgresWorkflowPendingTools(
    client,
    schema,
    {
      sourceAuthority,
      reconciliationLease: input.lease,
      continuation,
      adoptedAt: now,
      digester,
    },
  );
  return resumeRequiredResult(
    input,
    resumedExecution,
    definition,
    node.inputDigest,
    step,
    { attempt: resumedAttempt, continuation },
    pendingTools,
  );
}

async function loadReconciliationWork(
  client: PoolClient,
  schema: string,
  input: Input,
): Promise<Readonly<{ leaseExpiresAt: string }>> {
  const result = await client.query<{
    work_item_json: { payload?: unknown };
    lease_expires_at: Date | string | null;
  }>(
    `SELECT work_item_json,lease_expires_at FROM ${schema}.work_items
     WHERE work_item_id=$1 FOR UPDATE`,
    [input.lease.workItemId],
  );
  const row = result.rows[0];
  if (
    row?.lease_expires_at === null ||
    row?.lease_expires_at === undefined ||
    stableJson(row.work_item_json.payload) !==
      stableJson({
        schemaVersion: "crewon.workflow-reconcile-work-item.v0",
        trigger: "workflowReconcile",
        binding: input.binding,
        nodeId: input.nodeId,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        reconciliationOperationId: input.reconciliationOperationId,
      })
  )
    throw new RunStoreError("workflow_composition_work_item_mismatch");
  return { leaseExpiresAt: new Date(row.lease_expires_at).toISOString() };
}

function authority(
  input: Input,
  nodeKind: "agent" | "verification",
): WorkflowAgentAttemptAuthority {
  return {
    tenantId: input.tenantId,
    runId: input.runId,
    workItemId: input.attempt.workItemId,
    leaseEpoch: input.attempt.leaseEpoch,
    nodeId: input.nodeId,
    nodeKind,
    claimId: input.claimId,
    claimEpoch: input.claimEpoch,
    agentVersionId: input.agentVersionId,
    attempt: {
      stepId: input.attempt.stepId,
      attemptId: input.attempt.attemptId,
    },
  };
}

async function adoptAttempt(
  client: PoolClient,
  schema: string,
  attempt: NonNullable<Awaited<ReturnType<typeof loadPostgresRunAttempt>>>,
  input: Input,
  now: string,
) {
  if (
    attempt.workItemId === input.lease.workItemId &&
    attempt.leaseEpoch === input.lease.leaseEpoch
  )
    return attempt as typeof attempt & Readonly<{ status: "running" }>;
  const resumed = {
    ...attempt,
    workItemId: input.lease.workItemId,
    leaseEpoch: input.lease.leaseEpoch,
    updatedAt: now,
    status: "running" as const,
  };
  const updated = await client.query(
    `UPDATE ${schema}.run_attempts
     SET work_item_id=$1,lease_epoch=$2,state_json=$3::jsonb,updated_at=$4
     WHERE tenant_id=$5 AND run_id=$6 AND step_id=$7 AND attempt_id=$8
       AND status='running' AND work_item_id=$9 AND lease_epoch=$10`,
    [
      resumed.workItemId,
      resumed.leaseEpoch,
      stableJson(resumed),
      resumed.updatedAt,
      resumed.tenantId,
      resumed.runId,
      resumed.stepId,
      resumed.attemptId,
      attempt.workItemId,
      attempt.leaseEpoch,
    ],
  );
  if (updated.rowCount !== 1) corrupt();
  return resumed;
}

async function replaceContinuation(
  client: PoolClient,
  schema: string,
  authority: WorkflowAgentAttemptAuthority,
  prior: Input["priorContinuation"],
  next: Omit<
    import("@crewon/application").WorkflowNodeContinuationCheckpoint,
    "revision" | "updatedAt"
  >,
  updatedAt: string,
) {
  const continuation = validateWorkflowNodeContinuationCheckpoint({
    ...next,
    revision: (prior?.revision ?? 0) + 1,
    updatedAt,
  });
  if (stableJson(continuation.authority) !== stableJson(authority)) corrupt();
  const result = await client.query(
    `INSERT INTO ${schema}.workflow_node_continuations
       (tenant_id,run_id,node_id,attempt_id,revision,state_json,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (tenant_id,run_id,node_id) DO UPDATE SET
       attempt_id=excluded.attempt_id,revision=excluded.revision,
       state_json=excluded.state_json,updated_at=excluded.updated_at
     WHERE ${schema}.workflow_node_continuations.revision=$8`,
    [
      authority.tenantId,
      authority.runId,
      authority.nodeId,
      authority.attempt.attemptId,
      continuation.revision,
      stableJson(continuation),
      continuation.updatedAt,
      prior?.revision ?? null,
    ],
  );
  if (result.rowCount !== 1) corrupt();
  return continuation;
}

function segmentMatchesAttempt(attemptId: string, segmentId: string): boolean {
  const prefix = `segment:${attemptId}`;
  if (segmentId === prefix) return true;
  const roundPrefix = `${prefix}:round:`;
  return (
    segmentId.startsWith(roundPrefix) &&
    /^[1-9][0-9]{0,3}$/u.test(segmentId.slice(roundPrefix.length))
  );
}

function validateProgression(
  attemptId: string,
  prior: Input["priorContinuation"],
  next: Input["payload"]["next"],
): void {
  const expectedSampleIndex = (prior?.modelSampleIndex ?? -1) + 1;
  const expectedSegmentId =
    expectedSampleIndex === 0
      ? `segment:${attemptId}`
      : `segment:${attemptId}:round:${expectedSampleIndex + 1}`;
  const prefix = prior?.history ?? [];
  if (
    next.modelSampleIndex !== expectedSampleIndex ||
    next.toolRoundsConsumed !== (prior?.toolRoundsConsumed ?? 0) ||
    next.segmentId !== expectedSegmentId ||
    next.history.length < prefix.length ||
    stableJson(next.history.slice(0, prefix.length)) !== stableJson(prefix)
  )
    corrupt();
}

function corrupt(): never {
  throw new RunStoreError("workflow_retrieved_continuation_corrupt");
}
