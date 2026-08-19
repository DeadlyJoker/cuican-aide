import {
  canonicalJson,
  RunStoreError,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import {
  composeWorkflowNodeInput,
  validateWorkflowSchemaValue,
  workflowNodeInputSchema,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { PoolClient } from "pg";
import { loadPostgresRunStep } from "./postgres-execution-authority.ts";
import {
  convergePostgresWorkflowRun,
  validatePostgresTerminalWorkflowRun,
} from "./postgres-workflow-node-settlement.ts";
import { stableJson } from "./store-invariants.ts";
import {
  hasReadyWorkflowNodes,
  settleWorkflowClaim,
  workflowAuthorityId,
} from "./workflow-run-composition-support.ts";
import {
  completePostgresWorkflowLease,
  insertPostgresWorkflowReceipt,
  insertPostgresWorkflowWorkItem,
  loadPostgresWorkflowAuthorities,
  loadPostgresWorkflowExecution,
  loadPostgresWorkflowReceipt,
  loadPostgresWorkflowValue,
  postgresWorkflowFingerprint,
  validatePostgresWorkflowLease,
  writePostgresWorkflowExecution,
} from "./postgres-workflow-run-composition-transactions.ts";
import { appendPostgresCanceledWorkflowNodeEvent } from "./postgres-workflow-cancellation-lifecycle.ts";
import { insertPostgresCanceledWorkflowStep } from "./postgres-workflow-cancellation.ts";
type Decision = Parameters<
  WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
>[0];
type Settle = Parameters<
  WorkflowRunCompositionStore["settleWorkflowHumanGate"]
>[0];
export async function recordPostgresWorkflowGateDecision(
  client: PoolClient,
  schema: string,
  input: Decision,
  digester: WorkflowContentDigester,
) {
  const receiptInput = { ...input, operationId: input.decisionReceiptId };
  const fingerprint = postgresWorkflowFingerprint(
    "recordGateDecision",
    input,
    digester,
  );
  const replay = await loadPostgresWorkflowReceipt(
    client,
    schema,
    receiptInput,
    "recordGateDecision",
    fingerprint,
  );
  if (replay !== null) {
    const result = replay as {
      disposition: "recorded";
      approvalResumeWorkItemId: string;
    };
    await validateDecisionAuthority(
      client,
      schema,
      input,
      result.approvalResumeWorkItemId,
    );
    return { ...result, disposition: "replay" as const };
  }
  await loadPostgresWorkflowAuthorities(client, schema, input, digester);
  const gate = await loadGate(client, schema, input, true);
  if (
    gate.status !== "published" ||
    gate.claimId !== input.claimId ||
    gate.claimEpoch !== input.claimEpoch ||
    gate.gateRequestId !== input.gateRequestId
  )
    throw new RunStoreError("workflow_gate_decision_mismatch");
  const now = await databaseNow(client);
  const state = {
    ...gate,
    status: input.outcome.status,
    decisionReceiptId: input.decisionReceiptId,
    outcome: input.outcome,
    updatedAt: now,
  };
  const updated = await client.query(
    `UPDATE ${schema}.workflow_gate_requests
    SET status=$1,state_json=$2,updated_at=$3 WHERE tenant_id=$4 AND run_id=$5
    AND node_id=$6 AND status='published'`,
    [
      input.outcome.status,
      state,
      now,
      input.tenantId,
      input.runId,
      input.nodeId,
    ],
  );
  if (updated.rowCount !== 1)
    throw new RunStoreError("workflow_gate_decision_mismatch");
  const workItemId = gate.approvalResumeWorkItemId;
  await insertPostgresWorkflowWorkItem(
    client,
    schema,
    workItemId,
    input,
    gateResumePayload(input),
    now,
  );
  const result = {
    disposition: "recorded" as const,
    approvalResumeWorkItemId: workItemId,
  };
  await insertPostgresWorkflowReceipt(
    client,
    schema,
    receiptInput,
    "recordGateDecision",
    fingerprint,
    result,
  );
  return result;
}
export async function settlePostgresWorkflowGate(
  client: PoolClient,
  schema: string,
  input: Settle,
  digester: WorkflowContentDigester,
) {
  const fingerprint = postgresWorkflowFingerprint(
    "settleGate",
    input,
    digester,
  );
  const replay = await loadPostgresWorkflowReceipt(
    client,
    schema,
    input,
    "settleGate",
    fingerprint,
  );
  if (replay !== null)
    return validateSettleReplay(client, schema, input, replay, digester);
  const now = await validatePostgresWorkflowLease(client, schema, input);
  const workflow = await loadPostgresWorkflowAuthorities(
    client,
    schema,
    input,
    digester,
  );
  const gate = await loadGate(client, schema, input, true);
  if (
    gate.decisionReceiptId !== input.decisionReceiptId ||
    gate.status === "published" ||
    gate.claimId !== input.claimId ||
    gate.claimEpoch !== input.claimEpoch
  )
    throw new RunStoreError("workflow_gate_decision_mismatch");
  await assertResumeWork(client, schema, input, gate.approvalResumeWorkItemId);
  const execution = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  const step = await loadPostgresRunStep(
    client,
    schema,
    { ...input, stepId: input.nodeId },
    true,
  );
  const node = execution?.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  if (
    execution === null ||
    step === null ||
    step.kind !== "gate" ||
    step.status !== "waitingApproval" ||
    node?.status !== "waitingHuman" ||
    node.claimId !== input.claimId ||
    node.claimEpoch !== input.claimEpoch
  )
    throw new RunStoreError("workflow_composition_gate_mismatch");
  const outcome = gate.outcome as
    | { status: "completed" }
    | { status: "failed"; failureCode: string };
  const terminalStep = {
    ...step,
    status: outcome.status,
    revision: step.revision + 1,
    updatedAt: now,
    terminalAt: now,
  };
  const changed = await client.query(
    `UPDATE ${schema}.run_steps SET status=$1,revision=$2,
    state_json=$3,updated_at=$4,terminal_at=$4 WHERE tenant_id=$5 AND run_id=$6
    AND step_id=$7 AND revision=$8`,
    [
      terminalStep.status,
      terminalStep.revision,
      terminalStep,
      now,
      input.tenantId,
      input.runId,
      input.nodeId,
      step.revision,
    ],
  );
  if (changed.rowCount !== 1) throw new RunStoreError("revision_conflict");
  let resultDigest: string | undefined;
  if (outcome.status === "completed") {
    const value = await composeGateValue(
      client,
      schema,
      input,
      workflow,
      digester,
    );
    const valueJson = canonicalJson(value);
    resultDigest = digester.sha256(valueJson);
    await client.query(
      `INSERT INTO ${schema}.workflow_execution_values
      (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
      VALUES ($1,$2,$3,'nodeOutput',$4,$5,$6,$7)`,
      [
        input.tenantId,
        input.runId,
        workflowAuthorityId(
          "value",
          {
            tenantId: input.tenantId,
            runId: input.runId,
            nodeId: input.nodeId,
            claimId: input.claimId,
            claimEpoch: input.claimEpoch,
            resultDigest,
          },
          digester,
        ),
        input.nodeId,
        resultDigest,
        value,
        now,
      ],
    );
  }
  const next = settleWorkflowClaim({
    execution,
    ...input,
    outcome:
      outcome.status === "completed"
        ? { status: "completed", value: {} }
        : outcome,
    resultDigest,
    now,
  });
  for (const blocked of next.nodes) {
    if (
      blocked.status === "canceled" &&
      execution.nodes.find((candidate) => candidate.nodeId === blocked.nodeId)
        ?.status === "pending"
    ) {
      await insertPostgresCanceledWorkflowStep(
        client,
        schema,
        input,
        blocked.nodeId,
        blocked.kind,
        now,
      );
      await appendPostgresCanceledWorkflowNodeEvent(
        client,
        schema,
        {
          tenantId: input.tenantId,
          runId: input.runId,
          binding: input.binding,
          nodeId: blocked.nodeId,
          claimId: null,
          claimEpoch: null,
          attemptId: null,
          operationId: `${input.operationId}:${blocked.nodeId}:blocked`,
        },
        now,
        digester,
      );
    }
  }
  await writePostgresWorkflowExecution(client, schema, next, now);
  const runDisposition = await convergePostgresWorkflowRun(
    client,
    schema,
    input as unknown as Parameters<
      WorkflowRunCompositionStore["settleWorkflowNode"]
    >[0],
    workflow,
    next,
    now,
    digester,
  );
  let schedulerContinuationWorkItemId: string | null = null;
  if (
    next.status === "running" &&
    hasReadyWorkflowNodes(next, workflow)
  ) {
    schedulerContinuationWorkItemId = workflowAuthorityId(
      "scheduler",
      {
        tenantId: input.tenantId,
        runId: input.runId,
        binding: input.binding,
        gateRequestId: input.gateRequestId,
        decisionReceiptId: input.decisionReceiptId,
      },
      digester,
    );
    const root = await loadPostgresWorkflowValue(
      client,
      schema,
      input,
      "rootInput",
      null,
      digester,
    );
    if (root === null)
      throw new RunStoreError("workflow_execution_value_not_found");
    await insertPostgresWorkflowWorkItem(
      client,
      schema,
      schedulerContinuationWorkItemId,
      input,
      {
        schemaVersion: "crewon.workflow-scheduler-work-item.v1",
        trigger: "workflowScheduler",
        binding: input.binding,
        schedulerOperationId: schedulerContinuationWorkItemId,
        workflowInput: { valueId: root.valueId, valueDigest: root.valueDigest },
      },
      now,
    );
  }
  const result = {
    disposition: "settled" as const,
    execution: next,
    schedulerContinuationWorkItemId,
    handoff: {
      currentWorkItem: "completed" as const,
      nextWorkItemId: schedulerContinuationWorkItemId,
      kind:
        schedulerContinuationWorkItemId === null
          ? ("none" as const)
          : ("scheduler" as const),
    },
    runDisposition,
  };
  await insertPostgresWorkflowReceipt(
    client,
    schema,
    input,
    "settleGate",
    fingerprint,
    result,
  );
  await completePostgresWorkflowLease(client, schema, input, now);
  return structuredClone(result);
}
async function validateDecisionAuthority(
  client: PoolClient,
  schema: string,
  input: Decision,
  workItemId: string,
) {
  const gate = await loadGate(client, schema, input, true);
  if (
    gate.decisionReceiptId !== input.decisionReceiptId ||
    stableJson(gate.outcome) !== stableJson(input.outcome) ||
    gate.approvalResumeWorkItemId !== workItemId
  )
    replayCorrupt();
  await assertResumeWork(client, schema, input, workItemId);
}
async function validateSettleReplay(
  client: PoolClient,
  schema: string,
  input: Settle,
  stored: unknown,
  digester: WorkflowContentDigester,
) {
  const result = stored as Awaited<
    ReturnType<WorkflowRunCompositionStore["settleWorkflowHumanGate"]>
  >;
  await loadPostgresWorkflowAuthorities(client, schema, input, digester, true);
  const gate = await loadGate(client, schema, input, true);
  const execution = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  const step = await loadPostgresRunStep(
    client,
    schema,
    { ...input, stepId: input.nodeId },
    true,
  );
  if (
    execution === null ||
    execution.revision < result.execution.revision ||
    step === null ||
    !["completed", "failed"].includes(step.status) ||
    gate.decisionReceiptId !== input.decisionReceiptId
  )
    replayCorrupt();
  const expectedKind = result.schedulerContinuationWorkItemId === null ? "none" : "scheduler";
  if (result.handoff.currentWorkItem !== "completed" || result.handoff.kind !== expectedKind ||
      result.handoff.nextWorkItemId !== result.schedulerContinuationWorkItemId)
    replayCorrupt();
  const work = await client.query<{
    status: string;
    lease_owner_id: unknown;
    lease_id: unknown;
    lease_expires_at: unknown;
  }>(
    `SELECT status,lease_owner_id,lease_id,lease_expires_at
    FROM ${schema}.work_items WHERE work_item_id=$1`,
    [input.lease.workItemId],
  );
  if (
    work.rows[0]?.status !== "completed" ||
    work.rows[0].lease_owner_id !== null ||
    work.rows[0].lease_id !== null ||
    work.rows[0].lease_expires_at !== null
  )
    replayCorrupt();
  if (result.runDisposition === "terminalConverged")
    await validatePostgresTerminalWorkflowRun(
      client,
      schema,
      input as unknown as Parameters<
        WorkflowRunCompositionStore["settleWorkflowNode"]
      >[0],
      result as unknown as Awaited<
        ReturnType<WorkflowRunCompositionStore["settleWorkflowNode"]>
      >,
      digester,
    );
  return { ...structuredClone(result), disposition: "replay" as const };
}
async function composeGateValue(
  client: PoolClient,
  schema: string,
  input: Settle,
  workflow: import("@crewon/domain").CompiledWorkflowVersion,
  digester: WorkflowContentDigester,
) {
  const root = await loadPostgresWorkflowValue(
    client,
    schema,
    input,
    "rootInput",
    null,
    digester,
  );
  const node = workflow.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  if (root === null || node === undefined)
    throw new RunStoreError("workflow_execution_value_not_found");
  const dependencyOutputs = [];
  for (const nodeId of node.dependsOn) {
    const output = await loadPostgresWorkflowValue(
      client,
      schema,
      input,
      "nodeOutput",
      nodeId,
      digester,
    );
    if (output === null)
      throw new RunStoreError("workflow_execution_value_not_found");
    dependencyOutputs.push({ nodeId, value: output.value });
  }
  return validateWorkflowSchemaValue(
    composeWorkflowNodeInput({
      workflow,
      nodeId: input.nodeId,
      rootInput: root.value,
      dependencyOutputs,
    }),
    workflowNodeInputSchema(workflow, input.nodeId),
  );
}
async function loadGate(
  client: PoolClient,
  schema: string,
  input: {
    tenantId: string;
    runId: string;
    nodeId: string;
    gateRequestId: string;
  },
  lock: boolean,
) {
  const row = await client.query<{ state_json: Record<string, any> }>(
    `SELECT state_json
    FROM ${schema}.workflow_gate_requests WHERE tenant_id=$1 AND run_id=$2 AND node_id=$3
    AND gate_request_id=$4${lock ? " FOR UPDATE" : ""}`,
    [input.tenantId, input.runId, input.nodeId, input.gateRequestId],
  );
  if (row.rows[0] === undefined)
    throw new RunStoreError("workflow_gate_not_found");
  return row.rows[0].state_json;
}
async function assertResumeWork(
  client: PoolClient,
  schema: string,
  input: Pick<
    Settle,
    | "tenantId"
    | "runId"
    | "binding"
    | "nodeId"
    | "claimId"
    | "claimEpoch"
    | "gateRequestId"
    | "decisionReceiptId"
  >,
  workItemId: string,
) {
  const row = await client.query<{
    tenant_id: string;
    run_id: string;
    work_item_json: { payload?: unknown };
  }>(
    `SELECT tenant_id,run_id,work_item_json FROM ${schema}.work_items WHERE work_item_id=$1`,
    [workItemId],
  );
  if (
    row.rows[0]?.tenant_id !== input.tenantId ||
    row.rows[0].run_id !== input.runId ||
    stableJson(row.rows[0].work_item_json.payload) !==
      stableJson(gateResumePayload(input))
  )
    throw new RunStoreError("workflow_composition_work_item_mismatch");
}
function gateResumePayload(
  input: Pick<
    Settle,
    | "binding"
    | "nodeId"
    | "claimId"
    | "claimEpoch"
    | "gateRequestId"
    | "decisionReceiptId"
  >,
) {
  return {
    schemaVersion: "crewon.workflow-gate-resume-work-item.v0",
    trigger: "workflowGateResume",
    binding: input.binding,
    nodeId: input.nodeId,
    claimId: input.claimId,
    claimEpoch: input.claimEpoch,
    gateRequestId: input.gateRequestId,
    decisionReceiptId: input.decisionReceiptId,
  };
}
async function databaseNow(client: PoolClient) {
  const row = await client.query<{ now: Date | string }>(
    "SELECT clock_timestamp() AS now",
  );
  return new Date(row.rows[0]!.now).toISOString();
}
function replayCorrupt(): never {
  throw new RunStoreError("workflow_composition_receipt_corrupt");
}
