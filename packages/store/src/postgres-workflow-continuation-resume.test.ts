import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

import { canonicalActionIntent } from "@crewon/contracts/runtime";
import {
  RunStoreError,
  type WorkflowExecutionState,
  type WorkflowReconciliationResult,
} from "@crewon/application";
import {
  compileWorkflowVersion,
  createWorkflowNodeTerminalEvidence,
  prepareToolExecutionReceipt,
  reduceRunLifecycleEvent,
  serializeCompiledWorkflowVersion,
  type RunLifecycleEvent,
  type RunState,
  type WorkflowVersionSource,
} from "@crewon/domain";

import { PostgresWorkflowRunCompositionStore } from "./postgres-workflow-run-composition-store.ts";

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const empty = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const source: WorkflowVersionSource = {
  schemaVersion: "crewon.workflow-version-source.v0",
  workflowId: "continuation-workflow",
  workflowVersionId: "continuation-workflow-v1",
  name: "Continuation Workflow",
  description: "PostgreSQL durable continuation takeover",
  inputSchema: empty,
  outputSchema: empty,
  entryNodeIds: ["agent"],
  outputNodeIds: ["verify"],
  nodes: [
    {
      nodeId: "agent",
      title: "Agent",
      instruction: "Continue after a durable assistant boundary",
      kind: "agent",
      agentVersionId: "agent-v1",
      dependsOn: [],
      inputSchema: empty,
      outputSchema: empty,
    },
    {
      nodeId: "verify",
      title: "Verify",
      instruction: "Verify the Agent result",
      kind: "verification",
      verifierAgentVersionId: "verifier-v1",
      dependsOn: ["agent"],
      inputSchema: empty,
      outputSchema: empty,
    },
  ],
};
const workflow = compileWorkflowVersion(source, digester);
const binding = {
  workflowId: workflow.workflowId,
  workflowVersionId: workflow.workflowVersionId,
  contentDigest: workflow.contentDigest,
};
const rootInput = {
  valueId: "root-value-1",
  valueDigest: digester.sha256("{}"),
};
const schedulerLease = {
  workItemId: "scheduler-root",
  ownerId: "scheduler-worker",
  leaseId: "scheduler-root-lease",
  leaseEpoch: 1,
};

type ResumeResult = Extract<
  WorkflowReconciliationResult,
  { disposition: "resumeRequired" }
>;

test(
  "PostgreSQL adopts a durable continuation and rebinds it after a pre-POST crash",
  { skip: postgresUrl === undefined },
  async () => {
    assert.ok(postgresUrl);
    const schema = `workflow_resume_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl, max: 1 });
    const store = await PostgresWorkflowRunCompositionStore.open({
      pool,
      schema,
      digester,
    });
    try {
      await seed(pool, schema);
      const scheduled = await store.scheduleWorkflowNodes({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: schedulerLease,
        binding,
        schedulerOperationId: "schedule-root",
        workflowInput: rootInput,
      });
      const work = scheduled.nodeWorkItems[0]!;
      const nodeLease = await lease(
        pool,
        schema,
        work.workItemId,
        "node-worker",
      );
      const admitted = await store.admitWorkflowNodeWork({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: nodeLease,
        binding,
        nodeId: work.nodeId,
        claimId: work.claimId,
        claimEpoch: work.claimEpoch,
        schedulerOperationId: "schedule-root",
        admissionOperationId: "admit-agent",
        attemptLeaseDurationMs: 60_000,
      });
      assert.equal(admitted.disposition, "fresh");
      const attempt = admitted.admission!.attempt;
      const toolSegmentId = `segment:${attempt.attemptId}:round:1`;
      const authority = {
        tenantId: "tenant-1",
        runId: "run-1",
        workItemId: work.workItemId,
        leaseEpoch: nodeLease.leaseEpoch,
        nodeId: work.nodeId,
        nodeKind: "agent" as const,
        claimId: work.claimId,
        claimEpoch: work.claimEpoch,
        agentVersionId: "agent-v1",
        attempt: { stepId: work.nodeId, attemptId: attempt.attemptId },
      };
      const prepared = await store.prepareModelDispatch({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: nodeLease,
        attempt: authority.attempt,
        operationId: "dispatch-agent-1",
        requestSequence: 1,
        operation: "dispatch",
        requestDigest: digester.sha256("request-1"),
        provider: {
          agentVersionId: "agent-v1",
          adapterName: "responses",
          adapterVersion: "1",
          modelId: "gpt-test",
        },
        preparedAt: "2026-08-19T00:00:01.000Z",
      });
      const sent = await store.markModelDispatchPossiblySent({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: nodeLease,
        attempt: authority.attempt,
        operationId: prepared.operationId,
        requestSequence: 1,
        expectedRevision: prepared.revision,
        transitionedAt: "2026-08-19T00:00:02.000Z",
      });
      const providerCheckpoint = {
        schemaVersion: "crewon.provider-checkpoint.v0" as const,
        adapterName: "responses",
        adapterVersion: "1",
        modelId: "gpt-test",
        opaquePayload: { responseId: "response-1" },
      };
      const checkpointDigest = digester.sha256(
        JSON.stringify(providerCheckpoint),
      );
      const checkpointed = await store.checkpointRunAttempt({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: nodeLease,
        attempt: authority.attempt,
        checkpoint: providerCheckpoint,
        checkpointDigest,
        checkpointedAt: "2026-08-19T00:00:03.000Z",
        modelDispatch: {
          operationId: prepared.operationId,
          requestSequence: 1,
          expectedRevision: sent.revision,
        },
      });
      const observed = await store.loadModelDispatchReceipt({
        tenantId: "tenant-1",
        runId: "run-1",
        ...authority.attempt,
        operationId: prepared.operationId,
      });
      assert.equal(observed?.status, "responseObserved");
      await store.commitWorkflowAssistantContinuation({
        lease: nodeLease,
        authority,
        expectedContinuationRevision: null,
        next: {
          schemaVersion: "crewon.workflow-node-continuation.v0",
          authority,
          segmentId: toolSegmentId,
          modelSampleIndex: 1,
          toolRoundsConsumed: 0,
          providerCheckpoint,
          providerTurnState: null,
          activeDispatch: {
            operationId: prepared.operationId,
            requestSequence: 1,
            expectedRevision: observed!.revision,
            status: "responseObserved",
          },
          history: [
            { type: "message", role: "assistant", content: "continue" },
            {
              type: "tool_call",
              kind: "function",
              callId: "call-1",
              name: "workspace.read",
              input: '{"path":"README.md"}',
            },
          ],
        },
        committedAt: "2026-08-19T00:00:04.000Z",
        terminalResult: null,
      });
      const requested = await appendToolEvent(pool, schema, {
        type: "tool.requested",
        data: {
          segmentId: toolSegmentId,
          segmentSequence: 1,
          callId: "call-1",
          kind: "function",
          name: "workspace.read",
          input: '{"path":"README.md"}',
        },
      });
      const actionIntent = {
        schemaVersion: "crewon.action-intent.v0" as const,
        runId: "run-1",
        segmentId: toolSegmentId,
        callId: "call-1",
        tool: {
          kind: "function" as const,
          name: "workspace.read",
          inputDigest: digester.sha256('{"path":"README.md"}'),
        },
        effect: "readOnly" as const,
        recovery: "replaySafe" as const,
        policySnapshotId: "policy-1",
        workspaceBindingId: null,
        resourceBindingId: null,
        credentialBindingId: null,
        executionTarget: { kind: "control" as const, bindingId: "control-1" },
        capability: "workspace.read",
        approvalRequirement: "none" as const,
        limits: {
          timeoutMs: 30_000,
          maxOutputBytes: 32_768,
          maxArtifactBytes: 1_048_576,
        },
      };
      const actionDigest = digester.sha256(canonicalActionIntent(actionIntent));
      const toolStepId = `tool:${actionDigest.slice("sha256:".length)}`;
      const toolAttempt = await store.beginRunAttempt({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: nodeLease,
        stepId: toolStepId,
        kind: "tool",
        attemptId: "tool-attempt-1",
        startedAt: requested.occurredAt,
      });
      const pendingTool = prepareToolExecutionReceipt({
        receiptId: "tool-receipt-1",
        tenantId: "tenant-1",
        runId: "run-1",
        stepId: toolStepId,
        attemptId: toolAttempt.attempt.attemptId,
        workItemId: nodeLease.workItemId,
        executionId: "tool-execution-1",
        idempotencyKey: "run-1/tool/call-1",
        actionDigest,
        actionIntent,
        call: {
          segmentId: toolSegmentId,
          callId: "call-1",
          kind: "function",
          name: "workspace.read",
          inputDigest: actionIntent.tool.inputDigest,
        },
        effect: actionIntent.effect,
        recovery: actionIntent.recovery,
        preparedAt: requested.occurredAt,
      });
      await store.prepareToolExecution({
        lease: nodeLease,
        receipt: pendingTool,
      });
      const scheduledReconcile = await store.scheduleWorkflowReconciliation({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: nodeLease,
        binding,
        operationId: "schedule-reconcile-agent",
        reasonCode: "workflow_node_durability_uncertain",
        nodeId: work.nodeId,
        claimId: work.claimId,
        claimEpoch: work.claimEpoch,
      });
      const firstLease = await lease(
        pool,
        schema,
        scheduledReconcile.reconciliationWorkItemId,
        "reconcile-worker-1",
      );
      const reconciliationInput = {
        tenantId: "tenant-1",
        runId: "run-1",
        lease: firstLease,
        binding,
        nodeId: work.nodeId,
        claimId: work.claimId,
        claimEpoch: work.claimEpoch,
        reconciliationOperationId: "schedule-reconcile-agent",
      };
      const beforeTakeover = await loadExecution(pool, schema);
      assert.equal(
        beforeTakeover.nodes.find((node) => node.nodeId === work.nodeId)
          ?.status,
        "unknown",
      );
      for (const drift of [
        { claimId: "drifted-claim" },
        { agentVersionId: "agent-v2" },
        { inputDigest: digester.sha256("drifted-input") },
      ]) {
        const drifted = {
          ...beforeTakeover,
          nodes: beforeTakeover.nodes.map((node) =>
            node.nodeId === work.nodeId ? { ...node, ...drift } : node,
          ),
        };
        await pool.query(
          `UPDATE ${schema}.workflow_executions SET state_json=$1::jsonb
           WHERE tenant_id='tenant-1' AND run_id='run-1'`,
          [drifted],
        );
        await assert.rejects(
          store.reconcileWorkflowNode(reconciliationInput),
          (error) =>
            error instanceof RunStoreError &&
            error.code === "workflow_reconciliation_evidence_corrupt",
        );
        const authorityAfterFailure = await pool.query<{
          work_item_id: string;
          lease_epoch: number;
          continuation_revision: number;
          dispatch_status: string;
        }>(
          `SELECT attempt.work_item_id,attempt.lease_epoch::int,
             continuation.revision::int continuation_revision,
             dispatch.status dispatch_status
           FROM ${schema}.run_attempts attempt
           JOIN ${schema}.workflow_node_continuations continuation
             ON continuation.tenant_id=attempt.tenant_id
             AND continuation.run_id=attempt.run_id
             AND continuation.node_id=attempt.step_id
             AND continuation.attempt_id=attempt.attempt_id
           JOIN ${schema}.model_dispatch_receipts dispatch
             USING (tenant_id,run_id,step_id,attempt_id)
           WHERE attempt.attempt_id=$1 AND dispatch.operation_id=$2`,
          [attempt.attemptId, prepared.operationId],
        );
        assert.deepEqual(authorityAfterFailure.rows, [
          {
            work_item_id: authority.workItemId,
            lease_epoch: authority.leaseEpoch,
            continuation_revision: 1,
            dispatch_status: "responseObserved",
          },
        ]);
        await pool.query(
          `UPDATE ${schema}.workflow_executions SET state_json=$1::jsonb
           WHERE tenant_id='tenant-1' AND run_id='run-1'`,
          [beforeTakeover],
        );
      }
      const continuationRow = await pool.query<{ state_json: unknown }>(
        `SELECT state_json FROM ${schema}.workflow_node_continuations
         WHERE tenant_id='tenant-1' AND run_id='run-1' AND node_id=$1`,
        [work.nodeId],
      );
      const storedContinuation = continuationRow.rows[0]!.state_json as Record<
        string,
        unknown
      >;
      await pool.query(
        `UPDATE ${schema}.workflow_node_continuations
         SET state_json=jsonb_set(state_json,'{segmentId}',$1::jsonb)
         WHERE tenant_id='tenant-1' AND run_id='run-1' AND node_id=$2`,
        [
          JSON.stringify(
            `segment:${"x".repeat(attempt.attemptId.length)}:round:1`,
          ),
          work.nodeId,
        ],
      );
      await assert.rejects(
        store.reconcileWorkflowNode(reconciliationInput),
        (error) =>
          error instanceof RunStoreError &&
          error.code === "workflow_reconciliation_evidence_corrupt",
      );
      await pool.query(
        `UPDATE ${schema}.workflow_node_continuations SET state_json=$1::jsonb
         WHERE tenant_id='tenant-1' AND run_id='run-1' AND node_id=$2`,
        [storedContinuation, work.nodeId],
      );
      await pool.query(
        `UPDATE ${schema}.run_events
         SET event_json=jsonb_set(event_json,'{data,input}',$1::jsonb)
         WHERE tenant_id='tenant-1' AND run_id='run-1' AND event_id=$2`,
        [JSON.stringify("forged-input"), requested.eventId],
      );
      await assert.rejects(
        store.reconcileWorkflowNode(reconciliationInput),
        (error) =>
          error instanceof RunStoreError &&
          error.code === "workflow_reconciliation_evidence_corrupt",
      );
      await pool.query(
        `UPDATE ${schema}.run_events SET event_json=$1::jsonb
         WHERE tenant_id='tenant-1' AND run_id='run-1' AND event_id=$2`,
        [requested, requested.eventId],
      );
      const driftedReceipt = {
        ...pendingTool,
        workItemId: schedulerLease.workItemId,
      };
      await pool.query(
        `UPDATE ${schema}.tool_execution_receipts
         SET work_item_id=$1,state_json=$2::jsonb
         WHERE tenant_id='tenant-1' AND run_id='run-1' AND receipt_id=$3`,
        [schedulerLease.workItemId, driftedReceipt, pendingTool.receiptId],
      );
      await assert.rejects(
        store.reconcileWorkflowNode(reconciliationInput),
        (error) =>
          error instanceof RunStoreError &&
          error.code === "workflow_reconciliation_evidence_corrupt",
      );
      await pool.query(
        `UPDATE ${schema}.tool_execution_receipts
         SET work_item_id=$1,state_json=$2::jsonb
         WHERE tenant_id='tenant-1' AND run_id='run-1' AND receipt_id=$3`,
        [pendingTool.workItemId, pendingTool, pendingTool.receiptId],
      );
      const rolledBackTool = await pool.query<{
        attempt_work_item_id: string;
        attempt_lease_epoch: number;
        receipt_work_item_id: string;
        receipt_revision: number;
      }>(
        `SELECT attempt.work_item_id attempt_work_item_id,
          attempt.lease_epoch::int attempt_lease_epoch,
          receipt.work_item_id receipt_work_item_id,
          receipt.revision::int receipt_revision
         FROM ${schema}.run_attempts attempt
         JOIN ${schema}.tool_execution_receipts receipt
           ON receipt.tenant_id=attempt.tenant_id
           AND receipt.run_id=attempt.run_id
           AND receipt.step_id=attempt.step_id
           AND receipt.attempt_id=attempt.attempt_id
         WHERE receipt.receipt_id=$1`,
        [pendingTool.receiptId],
      );
      assert.deepEqual(rolledBackTool.rows, [
        {
          attempt_work_item_id: authority.workItemId,
          attempt_lease_epoch: authority.leaseEpoch,
          receipt_work_item_id: authority.workItemId,
          receipt_revision: pendingTool.revision,
        },
      ]);
      const first = (await store.reconcileWorkflowNode(
        reconciliationInput,
      )) as unknown as ResumeResult;
      assert.equal(first.disposition, "resumeRequired");
      assert.equal(first.execution.revision, beforeTakeover.revision + 1);
      assert.notEqual(first.execution.updatedAt, beforeTakeover.updatedAt);
      assert.deepEqual(await loadExecution(pool, schema), first.execution);
      const resumedNode = first.execution.nodes.find(
        (node) => node.nodeId === work.nodeId,
      );
      assert.equal(resumedNode?.status, "running");
      assert.notEqual(resumedNode?.leaseExpiresAt, null);
      assert.deepEqual(
        [
          first.resume.attempt.workItemId,
          first.resume.attempt.leaseEpoch,
          first.resume.continuation.authority.workItemId,
          first.resume.continuation.authority.leaseEpoch,
          first.resume.continuation.activeDispatch,
          first.resume.continuation.terminalCandidate,
          first.handoff.currentWorkItem,
        ],
        [
          firstLease.workItemId,
          firstLease.leaseEpoch,
          firstLease.workItemId,
          firstLease.leaseEpoch,
          null,
          null,
          "retained",
        ],
      );
      assert.deepEqual(
        first.resume.pendingTools.map(({ receipt, step, attempt }) => ({
          receiptId: receipt.receiptId,
          receiptStatus: receipt.status,
          receiptWorkItemId: receipt.workItemId,
          stepKind: step.kind,
          stepStatus: step.status,
          attemptStatus: attempt.status,
          attemptWorkItemId: attempt.workItemId,
          attemptLeaseEpoch: attempt.leaseEpoch,
        })),
        [
          {
            receiptId: pendingTool.receiptId,
            receiptStatus: "prepared",
            receiptWorkItemId: firstLease.workItemId,
            stepKind: "tool",
            stepStatus: "running",
            attemptStatus: "running",
            attemptWorkItemId: firstLease.workItemId,
            attemptLeaseEpoch: firstLease.leaseEpoch,
          },
        ],
      );
      assert.deepEqual(
        await store.reconcileWorkflowNode(reconciliationInput),
        first,
      );
      assert.deepEqual(await loadExecution(pool, schema), first.execution);
      const dispatchedTool = await store.transitionToolExecution({
        tenantId: "tenant-1",
        runId: "run-1",
        receiptId: pendingTool.receiptId,
        lease: firstLease,
        expectedRevision: first.resume.pendingTools[0]!.receipt.revision,
        transition: {
          kind: "dispatch",
          occurredAt: "2026-08-19T00:00:04.100Z",
        },
      });
      const dispatchedResume = (await store.reconcileWorkflowNode(
        reconciliationInput,
      )) as ResumeResult;
      assert.equal(
        dispatchedResume.resume.pendingTools[0]?.receipt.status,
        "dispatched",
      );
      const unknownTool = await store.transitionToolExecution({
        tenantId: "tenant-1",
        runId: "run-1",
        receiptId: pendingTool.receiptId,
        lease: firstLease,
        expectedRevision: dispatchedTool.revision,
        transition: {
          kind: "unknownOutcome",
          occurredAt: "2026-08-19T00:00:04.200Z",
          providerReceiptId: "provider-tool-unknown",
        },
      });
      const unknownResume = (await store.reconcileWorkflowNode(
        reconciliationInput,
      )) as ResumeResult;
      assert.equal(
        unknownResume.resume.pendingTools[0]?.receipt.status,
        "unknownOutcome",
      );
      await pool.query(
        `UPDATE ${schema}.tool_execution_receipts
         SET status=$1,revision=$2,state_json=$3::jsonb,updated_at=$4,resolved_at=$5
         WHERE tenant_id=$6 AND run_id=$7 AND receipt_id=$8 AND revision=$9`,
        [
          dispatchedTool.status,
          dispatchedTool.revision,
          dispatchedTool,
          dispatchedTool.updatedAt,
          dispatchedTool.resolvedAt,
          dispatchedTool.tenantId,
          dispatchedTool.runId,
          dispatchedTool.receiptId,
          unknownTool.revision,
        ],
      );
      const {
        revision: _continuationRevision,
        updatedAt: _continuationUpdatedAt,
        ...continuationBase
      } = dispatchedResume.resume.continuation;
      const completedTool = await store.commitWorkflowToolContinuation({
        lease: firstLease,
        authority: dispatchedResume.resume.continuation.authority,
        receipt: dispatchedTool,
        toolAttempt: {
          stepId: dispatchedResume.resume.pendingTools[0]!.attempt.stepId,
          attemptId: dispatchedResume.resume.pendingTools[0]!.attempt.attemptId,
        },
        completedEvent: {
          schemaVersion: "crewon.agent-event.v0",
          runId: "run-1",
          segmentId: toolSegmentId,
          sequence: 2,
          type: "tool.completed",
          data: {
            callId: "call-1",
            kind: "function",
            name: "workspace.read",
            output: "README",
            isError: false,
            artifactRef: null,
            outputTruncated: false,
          },
        },
        providerReceiptId: "provider-tool-completed",
        expectedContinuationRevision:
          dispatchedResume.resume.continuation.revision,
        next: {
          ...continuationBase,
          history: [
            ...continuationBase.history,
            {
              type: "tool_result",
              kind: "function",
              callId: "call-1",
              output: "README",
            },
          ],
        },
        committedAt: "2026-08-19T00:00:04.300Z",
      });
      assert.equal(completedTool.receipt.status, "completed");
      assert.deepEqual(
        await store.commitWorkflowToolContinuation({
          lease: firstLease,
          authority: dispatchedResume.resume.continuation.authority,
          receipt: dispatchedTool,
          toolAttempt: {
            stepId: dispatchedResume.resume.pendingTools[0]!.attempt.stepId,
            attemptId:
              dispatchedResume.resume.pendingTools[0]!.attempt.attemptId,
          },
          completedEvent: {
            schemaVersion: "crewon.agent-event.v0",
            runId: "run-1",
            segmentId: toolSegmentId,
            sequence: 2,
            type: "tool.completed",
            data: {
              callId: "call-1",
              kind: "function",
              name: "workspace.read",
              output: "README",
              isError: false,
              artifactRef: null,
              outputTruncated: false,
            },
          },
          providerReceiptId: "provider-tool-completed",
          expectedContinuationRevision:
            dispatchedResume.resume.continuation.revision,
          next: {
            ...continuationBase,
            history: [
              ...continuationBase.history,
              {
                type: "tool_result",
                kind: "function",
                callId: "call-1",
                output: "README",
              },
            ],
          },
          committedAt: "2026-08-19T00:00:04.300Z",
        }),
        completedTool,
      );
      const postCompletion = (await store.reconcileWorkflowNode(
        reconciliationInput,
      )) as ResumeResult;
      assert.deepEqual(postCompletion.resume.pendingTools, []);
      assert.deepEqual(
        postCompletion.resume.continuation,
        completedTool.continuation,
      );
      const lifecycle = await pool.query<{
        completed_events: number;
        outbox: number;
      }>(
        `SELECT
         (SELECT count(*)::int FROM ${schema}.run_events
          WHERE event_json->>'type'='tool.completed') completed_events,
         (SELECT count(*)::int FROM ${schema}.outbox
          WHERE message_id LIKE 'wf-tool:tool-outbox:%') outbox`,
      );
      assert.deepEqual(lifecycle.rows[0], {
        completed_events: 1,
        outbox: 1,
      });
      const secondLease = await reclaim(
        pool,
        schema,
        firstLease.workItemId,
        "reconcile-worker-2",
      );
      const second = (await store.reconcileWorkflowNode({
        ...reconciliationInput,
        lease: secondLease,
      })) as unknown as ResumeResult;
      assert.deepEqual(
        [
          second.resume.attempt.leaseEpoch,
          second.resume.continuation.authority.leaseEpoch,
          second.resume.continuation.revision,
        ],
        [
          secondLease.leaseEpoch,
          secondLease.leaseEpoch,
          completedTool.continuation.revision + 1,
        ],
      );
      assert.deepEqual(second.resume.pendingTools, []);
      assert.deepEqual(
        await store.reconcileWorkflowNode({
          ...reconciliationInput,
          lease: secondLease,
        }),
        second,
      );
      assert.deepEqual(await loadExecution(pool, schema), second.execution);
      const durable = await pool.query<{
        active_dispatches: number;
        terminal_dispatches: number;
        reconciliation_receipts: number;
      }>(
        `SELECT
        (SELECT count(*)::int FROM ${schema}.model_dispatch_receipts
          WHERE attempt_id=$1 AND status!='terminal') active_dispatches,
        (SELECT count(*)::int FROM ${schema}.model_dispatch_receipts
          WHERE attempt_id=$1 AND status='terminal') terminal_dispatches,
        (SELECT count(*)::int FROM ${schema}.workflow_composition_receipts
          WHERE kind='reconcileNode') reconciliation_receipts`,
        [checkpointed.attemptId],
      );
      assert.deepEqual(durable.rows[0], {
        active_dispatches: 0,
        terminal_dispatches: 1,
        reconciliation_receipts: 0,
      });
      const unsent = await store.prepareModelDispatch({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: secondLease,
        attempt: authority.attempt,
        operationId: "dispatch-agent-2",
        requestSequence: 2,
        operation: "dispatch",
        requestDigest: digester.sha256("request-2"),
        provider: prepared.provider,
        preparedAt: "2026-08-19T00:00:05.000Z",
      });
      const resumedUnsent = (await store.reconcileWorkflowNode({
        ...reconciliationInput,
        lease: secondLease,
      })) as unknown as ResumeResult;
      assert.equal(resumedUnsent.disposition, "resumeRequired");
      assert.deepEqual(
        (
          await store.loadModelDispatchReceipt({
            tenantId: "tenant-1",
            runId: "run-1",
            ...authority.attempt,
            operationId: unsent.operationId,
          })
        )?.terminalOutcome,
        {
          kind: "canceled",
          code: "workflow_resume_prepared_dispatch_superseded",
          certainty: "notSent",
        },
      );
      const nextPrepared = await store.prepareModelDispatch({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: secondLease,
        attempt: authority.attempt,
        operationId: "dispatch-agent-3",
        requestSequence: 3,
        operation: "dispatch",
        requestDigest: digester.sha256("request-3"),
        provider: prepared.provider,
        preparedAt: "2026-08-19T00:00:06.000Z",
      });
      const nextSent = await store.markModelDispatchPossiblySent({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: secondLease,
        attempt: authority.attempt,
        operationId: nextPrepared.operationId,
        requestSequence: 3,
        expectedRevision: nextPrepared.revision,
        transitionedAt: "2026-08-19T00:00:07.000Z",
      });
      const nextProviderCheckpoint = {
        ...providerCheckpoint,
        opaquePayload: { responseId: "response-2" },
      };
      await store.checkpointRunAttempt({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: secondLease,
        attempt: authority.attempt,
        checkpoint: nextProviderCheckpoint,
        checkpointDigest: digester.sha256(
          JSON.stringify(nextProviderCheckpoint),
        ),
        checkpointedAt: "2026-08-19T00:00:08.000Z",
        modelDispatch: {
          operationId: nextPrepared.operationId,
          requestSequence: 3,
          expectedRevision: nextSent.revision,
        },
      });
      const uncommittedResponse = await store.reconcileWorkflowNode({
        ...reconciliationInput,
        lease: secondLease,
      });
      assert.equal(uncommittedResponse.disposition, "retrieveRequired");
      if (uncommittedResponse.disposition !== "retrieveRequired")
        assert.fail("retrieval required");
      const evidence = createWorkflowNodeTerminalEvidence({
        workflow,
        nodeId: work.nodeId,
        outcome: { status: "completed", value: {} },
        digester,
      });
      const settled = await store.settleRetrievedWorkflowNode({
        ...reconciliationInput,
        lease: secondLease,
        agentVersionId: "agent-v1",
        attempt: {
          stepId: uncommittedResponse.recovery.attempt.stepId,
          attemptId: uncommittedResponse.recovery.attempt.attemptId,
          workItemId: uncommittedResponse.recovery.attempt.workItemId,
          leaseEpoch: uncommittedResponse.recovery.attempt.leaseEpoch,
        },
        dispatch: {
          operationId: uncommittedResponse.recovery.dispatch.operationId,
          requestSequence:
            uncommittedResponse.recovery.dispatch.requestSequence,
          expectedRevision: uncommittedResponse.recovery.dispatch.revision,
          status: "responseObserved",
        },
        evidence,
        dispatchTerminalOutcome: {
          kind: "completed",
          code: null,
          certainty: "responseObserved",
        },
      });
      assert.deepEqual(
        [
          settled.disposition,
          settled.execution.nodes.find((node) => node.nodeId === work.nodeId)
            ?.status,
          settled.handoff.currentWorkItem,
        ],
        ["settled", "completed", "completed"],
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await store.close();
    }
  },
);

async function loadExecution(
  pool: Pool,
  schema: string,
): Promise<WorkflowExecutionState> {
  const result = await pool.query<{ state_json: WorkflowExecutionState }>(
    `SELECT state_json FROM ${schema}.workflow_executions
     WHERE tenant_id='tenant-1' AND run_id='run-1'`,
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.state_json;
}

type ToolRunEventInput = Readonly<{
  type: "tool.requested";
  data: Extract<RunLifecycleEvent, { type: "tool.requested" }>["data"];
}>;

async function appendToolEvent(
  pool: Pool,
  schema: string,
  input: ToolRunEventInput,
): Promise<Extract<RunLifecycleEvent, { type: typeof input.type }>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ state_json: RunState }>(
      `SELECT state_json FROM ${schema}.run_snapshots
       WHERE tenant_id='tenant-1' AND run_id='run-1' FOR UPDATE`,
    );
    const current = row.rows[0]!.state_json;
    const event = {
      schemaVersion: "crewon.run-event.v0" as const,
      identity: { runId: "run-1" },
      eventId: `tool-event-${current.lastSequence + 1}`,
      sequence: current.lastSequence + 1,
      occurredAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
      ...input,
    } as Extract<RunLifecycleEvent, { type: typeof input.type }>;
    const next = reduceRunLifecycleEvent(current, event);
    const updated = await client.query(
      `UPDATE ${schema}.run_snapshots
       SET revision=$1,last_sequence=$2,state_json=$3::jsonb,updated_at=$4
       WHERE tenant_id='tenant-1' AND run_id='run-1' AND revision=$5`,
      [
        next.revision,
        next.lastSequence,
        next,
        next.updatedAt,
        current.revision,
      ],
    );
    assert.equal(updated.rowCount, 1);
    await client.query(
      `INSERT INTO ${schema}.run_events
       (tenant_id,run_id,sequence,event_id,event_json)
       VALUES ('tenant-1','run-1',$1,$2,$3::jsonb)`,
      [event.sequence, event.eventId, event],
    );
    await client.query("COMMIT");
    return event;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lease(
  pool: Pool,
  schema: string,
  workItemId: string,
  ownerId: string,
) {
  const leaseId = `${ownerId}-lease`;
  const leased = await pool.query<{ lease_epoch: number }>(
    `UPDATE ${schema}.work_items SET status='leased',lease_owner_id=$1,lease_id=$2,
       lease_epoch=lease_epoch+1,lease_expires_at=clock_timestamp()+interval '1 minute',
       attempt_count=attempt_count+1
     WHERE work_item_id=$3 AND status='pending' RETURNING lease_epoch::int`,
    [ownerId, leaseId, workItemId],
  );
  assert.equal(leased.rows.length, 1);
  return {
    workItemId,
    ownerId,
    leaseId,
    leaseEpoch: leased.rows[0]!.lease_epoch,
  };
}

async function reclaim(
  pool: Pool,
  schema: string,
  workItemId: string,
  ownerId: string,
) {
  const leaseId = `${ownerId}-lease`;
  const leased = await pool.query<{ lease_epoch: number }>(
    `UPDATE ${schema}.work_items SET lease_owner_id=$1,lease_id=$2,
       lease_epoch=lease_epoch+1,lease_expires_at=clock_timestamp()+interval '1 minute',
       attempt_count=attempt_count+1
     WHERE work_item_id=$3 AND status='leased' RETURNING lease_epoch::int`,
    [ownerId, leaseId, workItemId],
  );
  assert.equal(leased.rows.length, 1);
  return {
    workItemId,
    ownerId,
    leaseId,
    leaseEpoch: leased.rows[0]!.lease_epoch,
  };
}

async function seed(pool: Pool, schema: string): Promise<void> {
  const run = runState();
  await pool.query(
    `INSERT INTO ${schema}.workflow_versions
       (tenant_id,workflow_id,workflow_version_id,content_digest,definition_json,created_at)
     VALUES ('tenant-1',$1,$2,$3,$4,$5)`,
    [
      workflow.workflowId,
      workflow.workflowVersionId,
      workflow.contentDigest,
      serializeCompiledWorkflowVersion(workflow),
      run.createdAt,
    ],
  );
  await pool.query(
    `INSERT INTO ${schema}.run_snapshots
       (tenant_id,space_id,run_id,revision,last_sequence,state_json,updated_at)
     VALUES ('tenant-1','space-1','run-1',2,2,$1,$2)`,
    [run, run.updatedAt],
  );
  await pool.query(
    `INSERT INTO ${schema}.workflow_execution_values
       (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
     VALUES ('tenant-1','run-1',$1,'rootInput',NULL,$2,'{}',$3)`,
    [rootInput.valueId, rootInput.valueDigest, run.createdAt],
  );
  const payload = {
    schemaVersion: "crewon.workflow-scheduler-work-item.v1",
    trigger: "workflowScheduler",
    binding,
    schedulerOperationId: "schedule-root",
    workflowInput: rootInput,
  };
  const item = {
    workItemId: schedulerLease.workItemId,
    tenantId: "tenant-1",
    runId: "run-1",
    kind: "run.execute",
    payload,
    createdAt: run.createdAt,
  };
  await pool.query(
    `INSERT INTO ${schema}.work_items
       (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,available_at,
        lease_owner_id,lease_id,lease_epoch,lease_expires_at,attempt_count)
     VALUES ($1,'tenant-1','run-1','run.execute',$2,$3,'leased',$3,$4,$5,1,
       clock_timestamp()+interval '1 minute',1)`,
    [
      schedulerLease.workItemId,
      item,
      run.createdAt,
      schedulerLease.ownerId,
      schedulerLease.leaseId,
    ],
  );
}

function runState(): RunState {
  return {
    runId: "run-1",
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    authorityId: "authority-1",
    runtimeGeneration: "ts-v1",
    agentVersionId: "orchestrator-v1",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
    collaborationMode: "default",
    purpose: "workflow",
    workflowVersionBinding: binding,
    origin: null,
    goalBinding: null,
    goalAccounting: null,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    status: "running",
    revision: 2,
    lastSequence: 2,
    cancelRequested: false,
    waitingApproval: null,
    suspensionReasonCode: null,
    reconciliationReceiptId: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    terminalAt: null,
  };
}
