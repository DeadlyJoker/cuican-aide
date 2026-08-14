import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionValue,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import {
  composeWorkflowNodeInput,
  validateWorkflowSchemaValue,
  workflowNodeInputSchema,
  MAX_WORKFLOW_VALUE_BYTES,
  type CompiledWorkflowVersion,
  type RunState,
  type WorkflowContentDigester,
  type WorkflowSchemaValue,
} from "@crewon/domain";
import type { PoolClient } from "pg";

import {
  beginPostgresRunAttempt,
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import { stableJson } from "./store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import {
  decodeWorkflowExecutionState,
  validateWorkflowExecutionState,
} from "./workflow-execution-state.ts";
import {
  assertExecutionBinding,
  assertAdmissionReplayAuthority,
  gateStep,
  initialExecution,
  parseBoundWorkflow,
  reconciliationClaims,
  scheduleReadyNodes,
  workflowAuthorityId,
} from "./workflow-run-composition-support.ts";
import { assertWorkflowGatePublicationMessage } from "./workflow-gate-publication.ts";

export type ScheduleInput = Parameters<
  WorkflowRunCompositionStore["scheduleWorkflowNodes"]
>[0];
export type AdmitInput = Parameters<
  WorkflowRunCompositionStore["admitWorkflowNodeWork"]
>[0];

export async function schedulePostgresWorkflowNodes(
  client: PoolClient,
  schema: string,
  input: ScheduleInput,
  digester: WorkflowContentDigester,
): ReturnType<WorkflowRunCompositionStore["scheduleWorkflowNodes"]> {
  const fingerprint = postgresWorkflowFingerprint(
    "scheduleNodes",
    input,
    digester,
  );
  const replay = await loadPostgresWorkflowReceipt(
    client,
    schema,
    input,
    "scheduleNodes",
    fingerprint,
  );
  if (replay !== null) {
    const durable = await validateScheduleReplay(
      client,
      schema,
      input,
      replay,
      digester,
    );
    return {
      ...durable,
      disposition: "replay",
      nodeWorkItems: [] as const,
      gatePublications: [] as const,
      reconciliationClaims: [] as const,
    };
  }
  const now = await validatePostgresWorkflowLease(client, schema, input);
  const workflow = await loadPostgresWorkflowAuthorities(
    client,
    schema,
    input,
    digester,
  );
  await assertSchedulerPayload(client, schema, input, digester);
  let execution = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  if (execution === null) {
    execution = initialExecution({ ...input, workflow, updatedAt: now });
    await client.query(
      `INSERT INTO ${schema}.workflow_executions
       (tenant_id,run_id,revision,state_json,updated_at) VALUES ($1,$2,1,$3,$4)`,
      [input.tenantId, input.runId, execution, now],
    );
  }
  assertExecutionBinding(
    execution,
    input.tenantId,
    input.runId,
    input.binding,
    workflow,
  );
  const recovery = reconciliationClaims(execution, workflow);
  const currentExecution = execution;
  const inputDigests = new Map<string, string>();
  if (recovery.length === 0) {
    for (const nodeId of workflow.executionOrder) {
      const state = currentExecution.nodes.find(
        (node) => node.nodeId === nodeId,
      )!;
      const definition = workflow.nodes.find((node) => node.nodeId === nodeId)!;
      if (
        state.status === "pending" &&
        definition.dependsOn.every(
          (dependency) =>
            currentExecution.nodes.find((node) => node.nodeId === dependency)
              ?.status === "completed",
        )
      )
        inputDigests.set(
          nodeId,
          await nodeInputDigest(
            client,
            schema,
            input,
            workflow,
            nodeId,
            digester,
          ),
        );
    }
  }
  const scheduled =
    recovery.length === 0
      ? scheduleReadyNodes({
          execution,
          workflow,
          operationId: input.schedulerOperationId,
          now,
          digester,
          inputDigest: (nodeId) => inputDigests.get(nodeId)!,
        })
      : { execution, claims: [] };
  execution = scheduled.execution;
  const nodeWorkItems = [];
  const gatePublications = [];
  for (const claim of scheduled.claims) {
    const authority = {
      ...input,
      lease: undefined,
      workflowInput: undefined,
      nodeId: claim.node.nodeId,
      claimId: claim.claimId,
      claimEpoch: claim.claimEpoch,
    };
    if (claim.node.kind === "humanGate") {
      const gateRequestId = claim.gateRequestId!;
      const publicationOutboxMessageId = workflowAuthorityId(
        "gate-outbox",
        authority,
        digester,
      );
      const approvalResumeWorkItemId = workflowAuthorityId(
        "gate-resume",
        authority,
        digester,
      );
      const gate = {
        ...authority,
        gateRequestId,
        approvalPolicyId: claim.node.approvalPolicyId,
        inputDigest: claim.inputDigest,
        publicationOutboxMessageId,
        approvalResumeWorkItemId,
        status: "publicationPending",
        createdAt: now,
        updatedAt: now,
      };
      const step = gateStep({ ...input, nodeId: claim.node.nodeId, now });
      await client.query(
        `INSERT INTO ${schema}.run_steps
         (tenant_id,run_id,step_id,kind,status,revision,current_attempt_id,attempt_count,state_json,created_at,updated_at,terminal_at)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,0,$7,$8,$8,NULL)`,
        [
          step.tenantId,
          step.runId,
          step.stepId,
          step.kind,
          step.status,
          step.revision,
          step,
          now,
        ],
      );
      await client.query(
        `INSERT INTO ${schema}.workflow_gate_requests
         (tenant_id,run_id,node_id,gate_request_id,claim_id,claim_epoch,step_id,approval_policy_id,input_digest,
          publication_outbox_message_id,approval_resume_work_item_id,status,state_json,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$3,$7,$8,$9,$10,'publicationPending',$11,$12,$12)`,
        [
          input.tenantId,
          input.runId,
          claim.node.nodeId,
          gateRequestId,
          claim.claimId,
          claim.claimEpoch,
          claim.node.approvalPolicyId,
          claim.inputDigest,
          publicationOutboxMessageId,
          approvalResumeWorkItemId,
          gate,
          now,
        ],
      );
      const message = {
        messageId: publicationOutboxMessageId,
        tenantId: input.tenantId,
        runId: input.runId,
        topic: "workflow.gate.requested",
        payload: gate,
        createdAt: now,
      };
      await client.query(
        `INSERT INTO ${schema}.outbox
         (message_id,tenant_id,run_id,topic,message_json,created_at,status,available_at,lease_epoch,attempt_count)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$6,0,0)`,
        [
          publicationOutboxMessageId,
          input.tenantId,
          input.runId,
          message.topic,
          message,
          now,
        ],
      );
      gatePublications.push({
        nodeId: claim.node.nodeId,
        claimId: claim.claimId,
        claimEpoch: claim.claimEpoch,
        gateRequestId,
        publicationOutboxMessageId,
        approvalResumeWorkItemId,
      });
    } else {
      const workItemId = workflowAuthorityId("node", authority, digester);
      await insertPostgresWorkflowWorkItem(
        client,
        schema,
        workItemId,
        input,
        {
          schemaVersion: "crewon.workflow-node-work-item.v0",
          trigger: "workflowNode",
          binding: input.binding,
          nodeId: claim.node.nodeId,
          claimId: claim.claimId,
          claimEpoch: claim.claimEpoch,
          schedulerOperationId: input.schedulerOperationId,
        },
        now,
      );
      nodeWorkItems.push({
        nodeId: claim.node.nodeId,
        claimId: claim.claimId,
        claimEpoch: claim.claimEpoch,
        workItemId,
      });
    }
  }
  await writePostgresWorkflowExecution(client, schema, execution, now);
  const reconciliationWorkItemIds = recovery.map((claim) =>
    reconciliationWorkItemId(input, claim, digester),
  );
  for (const [index, claim] of recovery.entries()) {
    const reconciliationWorkItemId = reconciliationWorkItemIds[index]!;
    await insertPostgresWorkflowWorkItem(
      client,
      schema,
      reconciliationWorkItemId,
      input,
      {
        schemaVersion: "crewon.workflow-reconcile-work-item.v0",
        trigger: "workflowReconcile",
        binding: input.binding,
        nodeId: claim.node.nodeId,
        claimId: claim.claimId,
        claimEpoch: claim.claimEpoch,
        reconciliationOperationId: reconciliationOperationId(
          input,
          claim,
          digester,
        ),
      },
      now,
    );
  }
  const firstReconciliationWorkItemId = reconciliationWorkItemIds[0] ?? null;
  const result =
    recovery.length > 0
      ? {
          disposition: "reconcileRequired" as const,
          execution,
          nodeWorkItems: [] as const,
          gatePublications: [] as const,
          reconciliationClaims: recovery,
          handoff: {
            currentWorkItem: "completed" as const,
            nextWorkItemId: firstReconciliationWorkItemId,
            kind: "reconcile" as const,
          },
          runDisposition: "nonTerminal" as const,
        }
      : {
          disposition: "scheduled" as const,
          execution,
          nodeWorkItems,
          gatePublications,
          reconciliationClaims: [] as const,
          handoff: {
            currentWorkItem: "completed" as const,
            nextWorkItemId: null,
            kind: "none" as const,
          },
          runDisposition: "nonTerminal" as const,
        };
  await insertPostgresWorkflowReceipt(
    client,
    schema,
    input,
    "scheduleNodes",
    fingerprint,
    result,
  );
  await completePostgresWorkflowLease(client, schema, input, now);
  return structuredClone(result);
}

export async function admitPostgresWorkflowNodeWork(
  client: PoolClient,
  schema: string,
  input: AdmitInput,
  digester: WorkflowContentDigester,
): ReturnType<WorkflowRunCompositionStore["admitWorkflowNodeWork"]> {
  const receiptInput = { ...input, operationId: input.admissionOperationId };
  const fingerprint = postgresWorkflowFingerprint("admitNode", input, digester);
  const replay = await loadPostgresWorkflowReceipt(
    client,
    schema,
    receiptInput,
    "admitNode",
    fingerprint,
  );
  if (replay !== null) {
    const durable = await validateAdmissionReplay(
      client,
      schema,
      input,
      replay,
      digester,
    );
    return {
      disposition: "replay",
      execution: durable.execution,
      admission: null,
      handoff: durable.handoff,
    };
  }
  const now = await validatePostgresWorkflowLease(client, schema, input);
  const workflow = await loadPostgresWorkflowAuthorities(
    client,
    schema,
    input,
    digester,
  );
  const execution = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  if (execution === null)
    throw new RunStoreError("workflow_execution_not_found");
  const node = execution.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  const definition = workflow.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  if (
    node === undefined ||
    definition === undefined ||
    definition.kind === "humanGate" ||
    node.claimId !== input.claimId ||
    node.claimEpoch !== input.claimEpoch ||
    node.claimOperationId !== input.schedulerOperationId
  )
    throw new RunStoreError("workflow_composition_claim_mismatch");
  await assertNodePayload(client, schema, input);
  if (node.status === "running") {
    const step = await loadPostgresRunStep(client, schema, {
      tenantId: input.tenantId, runId: input.runId, stepId: input.nodeId,
    }, true);
    const attempt = step?.currentAttemptId === null || step === null ? null
      : await loadPostgresRunAttempt(client, schema, {
          tenantId: input.tenantId, runId: input.runId, stepId: input.nodeId,
          attemptId: step.currentAttemptId,
        }, true);
    if (attempt?.status !== "running" ||
        attempt.workItemId !== input.lease.workItemId ||
        attempt.leaseEpoch >= input.lease.leaseEpoch)
      throw new RunStoreError("workflow_composition_claim_mismatch");
    const reconciliationClaim = { node: definition, claimId: input.claimId,
      claimEpoch: input.claimEpoch, gateRequestId: null,
      inputDigest: node.inputDigest! };
    const reconciliationOperation = reconciliationOperationId(
      input, reconciliationClaim, digester);
    const reconciliationWorkItem = reconciliationWorkItemId(
      input, reconciliationClaim, digester);
    const next = { ...execution, revision: execution.revision + 1,
      nodes: execution.nodes.map((candidate) => candidate.nodeId === input.nodeId
        ? { ...candidate, status: "unknown" as const, leaseExpiresAt: null }
        : candidate), updatedAt: now };
    await writePostgresWorkflowExecution(client, schema, next, now);
    await insertPostgresWorkflowWorkItem(client, schema, reconciliationWorkItem,
      input, { schemaVersion: "crewon.workflow-reconcile-work-item.v0",
        trigger: "workflowReconcile", binding: input.binding,
        nodeId: input.nodeId, claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        reconciliationOperationId: reconciliationOperation }, now);
    const result = { disposition: "reconcileRequired" as const,
      execution: next, admission: null, reconciliationClaim,
      handoff: { currentWorkItem: "completed" as const,
        nextWorkItemId: reconciliationWorkItem,
        kind: "reconcile" as const } };
    await insertPostgresWorkflowReceipt(client, schema, receiptInput,
      "admitNode", fingerprint, result);
    await completePostgresWorkflowLease(client, schema, input, now);
    return structuredClone(result);
  }
  if (node.status !== "queued")
    throw new RunStoreError("workflow_composition_claim_mismatch");
  const attemptId = workflowAuthorityId(
    "attempt",
    {
      tenantId: input.tenantId,
      runId: input.runId,
      nodeId: input.nodeId,
      claimId: input.claimId,
      claimEpoch: input.claimEpoch,
    },
    digester,
  );
  const started = await beginPostgresRunAttempt(client, schema, {
    ...input,
    stepId: input.nodeId,
    kind: definition.kind === "verification" ? "verification" : "agent",
    attemptId,
    startedAt: now,
  });
  if (
    !Number.isSafeInteger(input.attemptLeaseDurationMs) ||
    input.attemptLeaseDurationMs <= 0
  )
    throw new RunStoreError("workflow_composition_lease_duration_invalid");
  const expiresAt = new Date(
    Date.parse(now) + input.attemptLeaseDurationMs,
  ).toISOString();
  const next = {
    ...execution,
    revision: execution.revision + 1,
    nodes: execution.nodes.map((candidate) =>
      candidate.nodeId === input.nodeId
        ? {
            ...candidate,
            status: "running" as const,
            leaseExpiresAt: expiresAt,
          }
        : candidate,
    ),
    updatedAt: now,
  };
  await writePostgresWorkflowExecution(client, schema, next, now);
  const inputValue = await composeNodeInputValue(
    client,
    schema,
    input,
    workflow,
    node.inputDigest!,
    now,
    digester,
  );
  const result = {
    disposition: "fresh" as const,
    execution: next,
    admission: {
      claim: {
        node: definition,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        gateRequestId: null,
        inputDigest: node.inputDigest!,
      },
      step: started.step,
      attempt: started.attempt,
      inputValue,
    },
    handoff: {
      currentWorkItem: "retained" as const,
      nextWorkItemId: null,
      kind: "none" as const,
    },
  };
  await insertPostgresWorkflowReceipt(
    client,
    schema,
    receiptInput,
    "admitNode",
    fingerprint,
    result,
  );
  return structuredClone(result);
}

export async function loadPostgresWorkflowAuthorities(
  client: PoolClient,
  schema: string,
  input: {
    tenantId: string;
    runId: string;
    binding: ScheduleInput["binding"];
  },
  digester: WorkflowContentDigester,
  allowTerminalRun = false,
) {
  const runResult = await client.query<{ state_json: RunState }>(
    `SELECT state_json FROM ${schema}.run_snapshots WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
    [input.tenantId, input.runId],
  );
  const run =
    runResult.rows[0] === undefined
      ? null
      : normalizeStoredRunState(
          runResult.rows[0].state_json,
          "postgres_run_state_corrupt",
        );
  if (run === null)
    throw new RunStoreError("workflow_composition_run_not_found");
  if (
    run.purpose !== "workflow" ||
    (!allowTerminalRun && run.status !== "running") ||
    stableJson(run.workflowVersionBinding) !== stableJson(input.binding)
  )
    throw new RunStoreError("workflow_composition_run_authority_mismatch");
  const version = await client.query<{ definition_json: string }>(
    `SELECT definition_json FROM ${schema}.workflow_versions
     WHERE tenant_id=$1 AND workflow_version_id=$2`,
    [input.tenantId, input.binding.workflowVersionId],
  );
  if (version.rows[0] === undefined)
    throw new RunStoreError("workflow_composition_version_not_found");
  return parseBoundWorkflow(
    version.rows[0].definition_json,
    input.binding,
    digester,
  );
}

export async function validatePostgresWorkflowLease(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; runId: string; lease: ScheduleInput["lease"] },
): Promise<string> {
  const result = await client.query<{
    tenant_id: string;
    run_id: string;
    status: string;
    lease_owner_id: string | null;
    lease_id: string | null;
    lease_epoch: number | string;
    lease_expires_at: Date | string | null;
    now: Date | string;
  }>(
    `SELECT tenant_id,run_id,status,lease_owner_id,lease_id,lease_epoch,lease_expires_at,
            clock_timestamp() AS now FROM ${schema}.work_items WHERE work_item_id=$1 FOR UPDATE`,
    [input.lease.workItemId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new RunStoreError("queue_item_not_found");
  const now = new Date(row.now).toISOString();
  if (row.tenant_id !== input.tenantId || row.run_id !== input.runId)
    throw new RunStoreError("work_item_scope_mismatch");
  if (
    row.status !== "leased" ||
    row.lease_owner_id !== input.lease.ownerId ||
    row.lease_id !== input.lease.leaseId ||
    Number(row.lease_epoch) !== input.lease.leaseEpoch ||
    row.lease_expires_at === null ||
    Date.parse(new Date(row.lease_expires_at).toISOString()) <= Date.parse(now)
  )
    throw new RunStoreError("stale_lease");
  return now;
}

export async function completePostgresWorkflowLease(
  client: PoolClient,
  schema: string,
  input: { lease: ScheduleInput["lease"] },
  now: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE ${schema}.work_items SET status='completed',lease_owner_id=NULL,lease_id=NULL,
     lease_expires_at=NULL,completed_at=$1 WHERE work_item_id=$2 AND status='leased'
     AND lease_owner_id=$3 AND lease_id=$4 AND lease_epoch=$5 AND lease_expires_at>$1`,
    [
      now,
      input.lease.workItemId,
      input.lease.ownerId,
      input.lease.leaseId,
      input.lease.leaseEpoch,
    ],
  );
  if (result.rowCount !== 1) throw new RunStoreError("stale_lease");
}

export async function loadPostgresWorkflowExecution(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; runId: string },
  lock: boolean,
) {
  const result = await client.query<{ state_json: unknown }>(
    `SELECT state_json FROM ${schema}.workflow_executions WHERE tenant_id=$1 AND run_id=$2${lock ? " FOR UPDATE" : ""}`,
    [input.tenantId, input.runId],
  );
  return result.rows[0] === undefined
    ? null
    : decodeWorkflowExecutionState(result.rows[0].state_json);
}

export async function writePostgresWorkflowExecution(
  client: PoolClient,
  schema: string,
  execution: import("@crewon/application").WorkflowExecutionState,
  now: string,
) {
  validateWorkflowExecutionState(execution);
  const result = await client.query(
    `UPDATE ${schema}.workflow_executions SET revision=$1,state_json=$2,updated_at=$3
     WHERE tenant_id=$4 AND run_id=$5`,
    [execution.revision, execution, now, execution.tenantId, execution.runId],
  );
  if (result.rowCount !== 1)
    throw new RunStoreError("workflow_execution_not_found");
}

export function postgresWorkflowFingerprint(
  kind: string,
  input: unknown,
  digester: WorkflowContentDigester,
) {
  return digester.sha256(stableJson({ kind, input }));
}

type ScheduleResult = Awaited<
  ReturnType<WorkflowRunCompositionStore["scheduleWorkflowNodes"]>
>;
type AdmissionResult = Awaited<
  ReturnType<WorkflowRunCompositionStore["admitWorkflowNodeWork"]>
>;

async function validateScheduleReplay(
  client: PoolClient,
  schema: string,
  input: ScheduleInput,
  stored: unknown,
  digester: WorkflowContentDigester,
): Promise<ScheduleResult> {
  const result = stored as ScheduleResult;
  const workflow = await loadPostgresWorkflowAuthorities(
    client,
    schema,
    input,
    digester,
  );
  try {
    validateWorkflowExecutionState(result.execution);
    assertExecutionBinding(
      result.execution,
      input.tenantId,
      input.runId,
      input.binding,
      workflow,
    );
  } catch (error) {
    if (error instanceof RunStoreError) replayCorrupt();
    throw error;
  }
  const current = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  if (current === null) replayCorrupt();
  assertExecutionBinding(
    current,
    input.tenantId,
    input.runId,
    input.binding,
    workflow,
  );
  if (
    current.revision < result.execution.revision ||
    !Array.isArray(result.nodeWorkItems) ||
    !Array.isArray(result.gatePublications) ||
    !Array.isArray(result.reconciliationClaims) ||
    result.runDisposition !== "nonTerminal" ||
    result.handoff?.currentWorkItem !== "completed"
  )
    replayCorrupt();
  for (const authority of result.nodeWorkItems) {
    const node = result.execution.nodes.find(
      (item) => item.nodeId === authority.nodeId,
    );
    const payload = await loadPayload(client, schema, authority.workItemId);
    if (
      node === undefined ||
      node.claimId !== authority.claimId ||
      node.claimEpoch !== authority.claimEpoch ||
      stableJson(payload) !==
        stableJson({
          schemaVersion: "crewon.workflow-node-work-item.v0",
          trigger: "workflowNode",
          binding: input.binding,
          nodeId: authority.nodeId,
          claimId: authority.claimId,
          claimEpoch: authority.claimEpoch,
          schedulerOperationId: input.schedulerOperationId,
        })
    )
      replayCorrupt();
  }
  for (const authority of result.gatePublications) {
    const gate = await client.query<{ state_json: unknown }>(
      `SELECT state_json FROM ${schema}.workflow_gate_requests
       WHERE tenant_id=$1 AND run_id=$2 AND node_id=$3 AND gate_request_id=$4`,
      [input.tenantId, input.runId, authority.nodeId, authority.gateRequestId],
    );
    const step = await loadPostgresRunStep(
      client,
      schema,
      {
        tenantId: input.tenantId,
        runId: input.runId,
        stepId: authority.nodeId,
      },
      true,
    );
    const outbox = await client.query<{ message_json: unknown; status: string }>(
      `SELECT message_json,status FROM ${schema}.outbox WHERE message_id=$1`,
      [authority.publicationOutboxMessageId],
    );
    const state = gate.rows[0]?.state_json as
      | Record<string, unknown>
      | undefined;
    if (
      state === undefined ||
      step === null ||
      step.kind !== "gate" ||
      state.claimId !== authority.claimId ||
      state.claimEpoch !== authority.claimEpoch ||
      state.publicationOutboxMessageId !==
        authority.publicationOutboxMessageId ||
      state.approvalResumeWorkItemId !== authority.approvalResumeWorkItemId ||
      outbox.rows[0] === undefined ||
      !["pending", "leased", "delivered"].includes(outbox.rows[0].status)
    )
      replayCorrupt();
    try {
      assertWorkflowGatePublicationMessage(
        outbox.rows[0]!.message_json as import("@crewon/application").OutboxMessage,
        state,
      );
    } catch {
      replayCorrupt();
    }
  }
  if (result.disposition === "reconcileRequired") {
    if (result.reconciliationClaims.length === 0) replayCorrupt();
    for (const claim of result.reconciliationClaims) {
      const workItemId = reconciliationWorkItemId(input, claim, digester);
      const payload = await loadPayload(client, schema, workItemId);
      if (
        stableJson(payload) !==
        stableJson({
          schemaVersion: "crewon.workflow-reconcile-work-item.v0",
          trigger: "workflowReconcile",
          binding: input.binding,
          nodeId: claim.node.nodeId,
          claimId: claim.claimId,
          claimEpoch: claim.claimEpoch,
          reconciliationOperationId: reconciliationOperationId(
            input,
            claim,
            digester,
          ),
        })
      )
        replayCorrupt();
    }
    if (
      result.handoff.nextWorkItemId !==
        reconciliationWorkItemId(
          input,
          result.reconciliationClaims[0]!,
          digester,
        ) ||
      result.handoff.kind !== "reconcile"
    )
      replayCorrupt();
  } else if (
    result.disposition !== "scheduled" ||
    result.handoff.kind !== "none" ||
    result.handoff.nextWorkItemId !== null ||
    result.reconciliationClaims.length !== 0
  )
    replayCorrupt();
  return structuredClone(result);
}

async function validateAdmissionReplay(
  client: PoolClient,
  schema: string,
  input: AdmitInput,
  stored: unknown,
  digester: WorkflowContentDigester,
): Promise<AdmissionResult> {
  const result = stored as AdmissionResult;
  const workflow = await loadPostgresWorkflowAuthorities(
    client,
    schema,
    input,
    digester,
  );
  validateWorkflowExecutionState(result.execution);
  assertExecutionBinding(
    result.execution,
    input.tenantId,
    input.runId,
    input.binding,
    workflow,
  );
  const current = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  if (current === null) replayCorrupt();
  assertExecutionBinding(
    current,
    input.tenantId,
    input.runId,
    input.binding,
    workflow,
  );
  if (current.revision < result.execution.revision) replayCorrupt();
  if (result.disposition === "reconcileRequired") {
    const claim = result.reconciliationClaim;
    const expectedWorkItemId = reconciliationWorkItemId(input, claim, digester);
    const work = await client.query<{ status: string;
      work_item_json: { payload?: unknown } }>(
        `SELECT status,work_item_json FROM ${schema}.work_items WHERE work_item_id=$1`,
        [expectedWorkItemId]);
    if (result.admission !== null || claim.node.nodeId !== input.nodeId ||
        claim.claimId !== input.claimId || claim.claimEpoch !== input.claimEpoch ||
        result.handoff.currentWorkItem !== "completed" ||
        result.handoff.nextWorkItemId !== expectedWorkItemId ||
        result.handoff.kind !== "reconcile" || work.rows[0] === undefined ||
        !["pending", "leased", "completed"].includes(work.rows[0].status) ||
        stableJson(work.rows[0].work_item_json.payload) !== stableJson({
          schemaVersion: "crewon.workflow-reconcile-work-item.v0",
          trigger: "workflowReconcile", binding: input.binding,
          nodeId: input.nodeId, claimId: input.claimId,
          claimEpoch: input.claimEpoch,
          reconciliationOperationId: reconciliationOperationId(input, claim, digester),
        }))
      replayCorrupt();
    return structuredClone(result);
  }
  const admission = result.admission;
  if (
    result.disposition !== "fresh" ||
    admission === null ||
    admission.claim.node.nodeId !== input.nodeId ||
    admission.claim.claimId !== input.claimId ||
    admission.claim.claimEpoch !== input.claimEpoch ||
    admission.attempt.attemptId !==
      workflowAuthorityId(
        "attempt",
        {
          tenantId: input.tenantId,
          runId: input.runId,
          nodeId: input.nodeId,
          claimId: input.claimId,
          claimEpoch: input.claimEpoch,
        },
        digester,
      ) ||
    result.handoff?.currentWorkItem !== "retained" ||
    result.handoff.kind !== "none" ||
    result.handoff.nextWorkItemId !== null
  )
    replayCorrupt();
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
      stepId: input.nodeId,
      attemptId: admission.attempt.attemptId,
    },
    true,
  );
  assertAdmissionReplayAuthority(admission, step, attempt);
  const value = await loadPostgresWorkflowValue(
    client,
    schema,
    input,
    "nodeInput",
    input.nodeId,
    digester,
  );
  if (
    value === null ||
    value.valueId !== admission.inputValue.valueId ||
    value.valueDigest !== admission.inputValue.valueDigest ||
    stableJson(value.value) !== stableJson(admission.inputValue.value)
  )
    replayCorrupt();
  return structuredClone(result);
}

function reconciliationWorkItemId(
  input: ReconciliationIdentityInput,
  claim: import("@crewon/application").WorkflowNodeClaim,
  digester: WorkflowContentDigester,
): string {
  return workflowAuthorityId(
    "reconcile",
    {
      tenantId: input.tenantId,
      runId: input.runId,
      binding: input.binding,
      operationId: reconciliationOperationId(input, claim, digester),
      nodeId: claim.node.nodeId,
      claimId: claim.claimId,
      claimEpoch: claim.claimEpoch,
    },
    digester,
  );
}

function reconciliationOperationId(
  input: ReconciliationIdentityInput,
  claim: import("@crewon/application").WorkflowNodeClaim,
  digester: WorkflowContentDigester,
): string {
  return workflowAuthorityId(
    "reconcile",
    {
      tenantId: input.tenantId,
      runId: input.runId,
      binding: input.binding,
      schedulerOperationId: input.schedulerOperationId,
      nodeId: claim.node.nodeId,
      claimId: claim.claimId,
      claimEpoch: claim.claimEpoch,
    },
    digester,
  );
}

type ReconciliationIdentityInput = Readonly<{
  tenantId: string;
  runId: string;
  binding: ScheduleInput["binding"];
  schedulerOperationId: string;
}>;

function replayCorrupt(): never {
  throw new RunStoreError("workflow_composition_receipt_corrupt");
}

export async function loadPostgresWorkflowReceipt(
  client: PoolClient,
  schema: string,
  input: {
    tenantId: string;
    runId: string;
    operationId?: string;
    schedulerOperationId?: string;
  },
  kind: string,
  fingerprint: string,
): Promise<unknown | null> {
  const operationId = input.operationId ?? input.schedulerOperationId!;
  const result = await client.query<{
    kind: string;
    fingerprint: string;
    result_json: unknown;
  }>(
    `SELECT kind,fingerprint,result_json FROM ${schema}.workflow_composition_receipts
     WHERE tenant_id=$1 AND run_id=$2 AND operation_id=$3`,
    [input.tenantId, input.runId, operationId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if (row.kind !== kind || row.fingerprint !== fingerprint)
    throw new RunStoreError("workflow_composition_idempotency_conflict");
  return row.result_json;
}

export async function insertPostgresWorkflowReceipt(
  client: PoolClient,
  schema: string,
  input: {
    tenantId: string;
    runId: string;
    operationId?: string;
    schedulerOperationId?: string;
  },
  kind: string,
  fingerprint: string,
  result: unknown,
) {
  await client.query(
    `INSERT INTO ${schema}.workflow_composition_receipts
     (tenant_id,run_id,operation_id,kind,fingerprint,result_json) VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      input.tenantId,
      input.runId,
      input.operationId ?? input.schedulerOperationId!,
      kind,
      fingerprint,
      result,
    ],
  );
}

export async function insertPostgresWorkflowWorkItem(
  client: PoolClient,
  schema: string,
  workItemId: string,
  input: { tenantId: string; runId: string },
  payload: Record<string, unknown>,
  now: string,
) {
  const item = {
    workItemId,
    tenantId: input.tenantId,
    runId: input.runId,
    kind: "run.execute",
    payload,
    createdAt: now,
  };
  await client.query(
    `INSERT INTO ${schema}.work_items
     (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,available_at,lease_epoch,attempt_count)
     VALUES ($1,$2,$3,'run.execute',$4,$5,'pending',$5,0,0)`,
    [workItemId, input.tenantId, input.runId, item, now],
  );
}

export async function loadPostgresWorkflowValue(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; runId: string },
  role: string,
  nodeId: string | null,
  digester: WorkflowContentDigester,
) {
  const result = await client.query<{
    value_id: string;
    value_digest: string;
    value_json: WorkflowSchemaValue;
  }>(
    `SELECT value_id,value_digest,value_json FROM ${schema}.workflow_execution_values
     WHERE tenant_id=$1 AND run_id=$2 AND role=$3 AND node_id IS NOT DISTINCT FROM $4`,
    [input.tenantId, input.runId, role, nodeId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const valueJson = canonicalJson(row.value_json);
  if (
    new TextEncoder().encode(valueJson).byteLength > MAX_WORKFLOW_VALUE_BYTES ||
    digester.sha256(valueJson) !== row.value_digest
  )
    throw new RunStoreError("workflow_execution_value_corrupt");
  return {
    valueId: row.value_id,
    valueDigest: row.value_digest,
    value: row.value_json,
  };
}

async function nodeInputDigest(
  client: PoolClient,
  schema: string,
  input: ScheduleInput,
  workflow: CompiledWorkflowVersion,
  nodeId: string,
  digester: WorkflowContentDigester,
): Promise<string> {
  const root = await loadPostgresWorkflowValue(
    client,
    schema,
    input,
    "rootInput",
    null,
    digester,
  );
  const node = workflow.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (root === null || node === undefined)
    throw new RunStoreError("workflow_execution_value_not_found");
  const dependencyOutputs = [];
  for (const dependencyNodeId of node.dependsOn) {
    const output = await loadPostgresWorkflowValue(
      client,
      schema,
      input,
      "nodeOutput",
      dependencyNodeId,
      digester,
    );
    if (output === null)
      throw new RunStoreError("workflow_execution_value_not_found");
    dependencyOutputs.push({ nodeId: dependencyNodeId, value: output.value });
  }
  return digester.sha256(
    canonicalJson(
      composeWorkflowNodeInput({
        workflow,
        nodeId,
        rootInput: root.value,
        dependencyOutputs,
      }),
    ),
  );
}

async function composeNodeInputValue(
  client: PoolClient,
  schema: string,
  input: AdmitInput,
  workflow: CompiledWorkflowVersion,
  expectedDigest: string,
  now: string,
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
  const value = validateWorkflowSchemaValue(
    composeWorkflowNodeInput({
      workflow,
      nodeId: input.nodeId,
      rootInput: root.value,
      dependencyOutputs,
    }),
    workflowNodeInputSchema(workflow, input.nodeId),
  );
  const valueJson = canonicalJson(value);
  if (new TextEncoder().encode(valueJson).byteLength > MAX_WORKFLOW_VALUE_BYTES)
    throw new RunStoreError("workflow_execution_value_invalid");
  const valueDigest = digester.sha256(valueJson);
  if (valueDigest !== expectedDigest)
    throw new RunStoreError("workflow_execution_value_digest_mismatch");
  const valueId = workflowAuthorityId(
    "value",
    {
      tenantId: input.tenantId,
      runId: input.runId,
      nodeId: input.nodeId,
      claimId: input.claimId,
      claimEpoch: input.claimEpoch,
      valueDigest,
    },
    digester,
  );
  await client.query(
    `INSERT INTO ${schema}.workflow_execution_values
     (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
     VALUES ($1,$2,$3,'nodeInput',$4,$5,$6,$7)`,
    [
      input.tenantId,
      input.runId,
      valueId,
      input.nodeId,
      valueDigest,
      value,
      now,
    ],
  );
  return {
    schemaVersion: "crewon.workflow-execution-value.v0" as const,
    valueId,
    value: structuredClone(value) as WorkflowExecutionValue["value"],
    valueDigest,
  };
}

async function assertSchedulerPayload(
  client: PoolClient,
  schema: string,
  input: ScheduleInput,
  digester: WorkflowContentDigester,
) {
  const payload = await loadPayload(client, schema, input.lease.workItemId);
  const root = await loadPostgresWorkflowValue(
    client,
    schema,
    input,
    "rootInput",
    null,
    digester,
  );
  const expected = {
    schemaVersion: "crewon.workflow-scheduler-work-item.v1",
    trigger: "workflowScheduler",
    binding: input.binding,
    schedulerOperationId: input.schedulerOperationId,
    workflowInput: input.workflowInput,
  };
  const rootRef =
    root === null
      ? null
      : {
          valueId: root.valueId,
          valueDigest: root.valueDigest,
        };
  if (
    stableJson(payload) !== stableJson(expected) ||
    stableJson(rootRef) !== stableJson(input.workflowInput)
  )
    throw new RunStoreError("workflow_composition_work_item_mismatch");
}

async function assertNodePayload(
  client: PoolClient,
  schema: string,
  input: AdmitInput,
) {
  const payload = await loadPayload(client, schema, input.lease.workItemId);
  const expected = {
    schemaVersion: "crewon.workflow-node-work-item.v0",
    trigger: "workflowNode",
    binding: input.binding,
    nodeId: input.nodeId,
    claimId: input.claimId,
    claimEpoch: input.claimEpoch,
    schedulerOperationId: input.schedulerOperationId,
  };
  if (stableJson(payload) !== stableJson(expected))
    throw new RunStoreError("workflow_composition_work_item_mismatch");
}

async function loadPayload(
  client: PoolClient,
  schema: string,
  workItemId: string,
) {
  const result = await client.query<{ work_item_json: { payload?: unknown } }>(
    `SELECT work_item_json FROM ${schema}.work_items WHERE work_item_id=$1`,
    [workItemId],
  );
  const payload = result.rows[0]?.work_item_json.payload;
  if (payload === undefined)
    throw new RunStoreError("workflow_composition_work_item_mismatch");
  return payload;
}
