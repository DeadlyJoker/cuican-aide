import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

import {
  compileWorkflowVersion,
  serializeCompiledWorkflowVersion,
  type RunState,
  type WorkflowVersionSource,
} from "@crewon/domain";

import { PostgresWorkflowRunCompositionStore } from "./postgres-workflow-run-composition-store.ts";

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;
const digest = {
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
  workflowId: "parallel-workflow",
  workflowVersionId: "parallel-workflow-v1",
  name: "Parallel Workflow",
  description: "Independent sibling settlement",
  inputSchema: empty,
  outputSchema: empty,
  entryNodeIds: ["left", "right"],
  outputNodeIds: ["join"],
  nodes: [
    {
      nodeId: "left",
      title: "Left",
      instruction: "Return empty JSON",
      kind: "agent",
      agentVersionId: "left-v1",
      dependsOn: [],
      inputSchema: empty,
      outputSchema: empty,
    },
    {
      nodeId: "right",
      title: "Right",
      instruction: "Return empty JSON",
      kind: "agent",
      agentVersionId: "right-v1",
      dependsOn: [],
      inputSchema: empty,
      outputSchema: empty,
    },
    {
      nodeId: "join",
      title: "Join",
      instruction: "Verify both results",
      kind: "verification",
      verifierAgentVersionId: "join-v1",
      dependsOn: ["left", "right"],
      inputSchema: {
        type: "object",
        properties: { left: empty, right: empty },
        required: ["left", "right"],
        additionalProperties: false,
      },
      outputSchema: empty,
    },
  ],
};
const workflow = compileWorkflowVersion(source, digest);
const binding = {
  workflowId: workflow.workflowId,
  workflowVersionId: workflow.workflowVersionId,
  contentDigest: workflow.contentDigest,
};

test(
  "PostgreSQL siblings settle in reverse across independent connections and converge once",
  { skip: postgresUrl === undefined },
  async () => {
    assert.ok(postgresUrl);
    const schema = `workflow_parallel_${randomUUID().replaceAll("-", "")}`;
    const firstPool = new Pool({ connectionString: postgresUrl, max: 1 });
    const secondPool = new Pool({ connectionString: postgresUrl, max: 1 });
    const first = await PostgresWorkflowRunCompositionStore.open({
      pool: firstPool,
      schema,
      digester: digest,
    });
    const second = new PostgresWorkflowRunCompositionStore({
      pool: secondPool,
      schema,
      digester: digest,
    });
    try {
      await seed(firstPool, schema);
      const scheduled = await first.scheduleWorkflowNodes({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: schedulerLease,
        binding,
        schedulerOperationId: "schedule-root",
        workflowInput: rootInput,
      });
      assert.deepEqual(
        scheduled.nodeWorkItems.map((work) => work.nodeId),
        ["left", "right"],
      );
      assert.equal(
        new Set(scheduled.nodeWorkItems.map((work) => work.workItemId)).size,
        2,
      );
      const [leftWork, rightWork] = scheduled.nodeWorkItems;
      assert.ok(leftWork && rightWork);
      const leftLease = await leaseNode(
        firstPool,
        schema,
        leftWork.workItemId,
        "left-worker",
      );
      const rightLease = await leaseNode(
        secondPool,
        schema,
        rightWork.workItemId,
        "right-worker",
      );
      const left = await prepareTerminalCandidate({
        store: first,
        work: leftWork,
        lease: leftLease,
        schedulerOperationId: "schedule-root",
        agentVersionId: "left-v1",
        nodeKind: "agent",
      });
      const right = await prepareTerminalCandidate({
        store: second,
        work: rightWork,
        lease: rightLease,
        schedulerOperationId: "schedule-root",
        agentVersionId: "right-v1",
        nodeKind: "agent",
      });

      const rightSettled = await second.settlePreparedWorkflowNodeTerminal(
        right.settlement,
      );
      const afterRight = await second.loadWorkflowExecution({
        tenantId: "tenant-1",
        runId: "run-1",
      });
      assert.deepEqual(
        [afterRight?.nodes[1]?.status, rightSettled.handoff.kind],
        ["completed", "none"],
      );
      assert.equal(await countPendingSchedulers(firstPool, schema), 0);
      const leftSettled = await first.settlePreparedWorkflowNodeTerminal(
        left.settlement,
      );
      const afterLeft = await first.loadWorkflowExecution({
        tenantId: "tenant-1",
        runId: "run-1",
      });
      assert.deepEqual(
        [afterLeft?.nodes[0]?.status, leftSettled.handoff.kind],
        ["completed", "scheduler"],
      );
      assert.equal(await countPendingSchedulers(firstPool, schema), 1);

      const continuation = await claimContinuation(firstPool, schema);
      const joined = await first.scheduleWorkflowNodes({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: continuation.lease,
        binding,
        schedulerOperationId: continuation.schedulerOperationId,
        workflowInput: rootInput,
      });
      assert.deepEqual(
        joined.nodeWorkItems.map((work) => work.nodeId),
        ["join"],
      );
      const joinWork = joined.nodeWorkItems[0]!;
      const joinLease = await leaseNode(
        firstPool,
        schema,
        joinWork.workItemId,
        "join-worker",
      );
      const join = await prepareTerminalCandidate({
        store: first,
        work: joinWork,
        lease: joinLease,
        schedulerOperationId: continuation.schedulerOperationId,
        agentVersionId: "join-v1",
        nodeKind: "verification",
      });
      assert.deepEqual(join.inputValue.value, { left: {}, right: {} });
      assert.deepEqual(Object.keys(join.inputValue.value as object), [
        "left",
        "right",
      ]);
      const terminal = await first.settlePreparedWorkflowNodeTerminal(
        join.settlement,
      );
      const terminalExecution = await first.loadWorkflowExecution({
        tenantId: "tenant-1",
        runId: "run-1",
      });
      assert.deepEqual(
        [terminalExecution?.status, terminal.runDisposition],
        ["completed", "terminalConverged"],
      );
      assert.deepEqual(
        await second.settlePreparedWorkflowNodeTerminal(right.settlement),
        { ...rightSettled, disposition: "replay" },
      );
      assert.equal(
        (await first.settlePreparedWorkflowNodeTerminal(left.settlement))
          .disposition,
        "replay",
      );
      assert.equal(
        (await second.settlePreparedWorkflowNodeTerminal(join.settlement))
          .disposition,
        "replay",
      );
      const durable = await firstPool.query<{
        attempts: number;
        dispatches: number;
        node_events: number;
        pending_work: number;
        terminal_outbox: number;
        terminal_receipts: number;
      }>(`SELECT
        (SELECT count(*)::int FROM ${schema}.run_attempts
          WHERE run_id='run-1' AND status='completed') attempts,
        (SELECT count(*)::int FROM ${schema}.model_dispatch_receipts
          WHERE run_id='run-1' AND status='terminal') dispatches,
        (SELECT count(*)::int FROM ${schema}.run_events
          WHERE run_id='run-1' AND event_json->>'type'='workflow.node.terminal') node_events,
        (SELECT count(*)::int FROM ${schema}.work_items
          WHERE run_id='run-1' AND status!='completed') pending_work,
        (SELECT count(*)::int FROM ${schema}.outbox
          WHERE run_id='run-1' AND message_json->'payload'->>'eventType'='run.completed') terminal_outbox,
        (SELECT count(*)::int FROM ${schema}.workflow_composition_receipts
          WHERE run_id='run-1' AND kind='settleNode') terminal_receipts`);
      assert.deepEqual(durable.rows[0], {
        attempts: 3,
        dispatches: 3,
        node_events: 3,
        pending_work: 0,
        terminal_outbox: 1,
        terminal_receipts: 3,
      });
    } finally {
      await firstPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await Promise.all([first.close(), second.close()]);
    }
  },
);

test(
  "PostgreSQL reconciliation scheduling replays after the handoff has completed",
  { skip: postgresUrl === undefined },
  async () => {
    assert.ok(postgresUrl);
    const schema = `workflow_reconciliation_replay_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl, max: 1 });
    const store = await PostgresWorkflowRunCompositionStore.open({
      pool,
      schema,
      digester: digest,
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
      const nodeLease = await leaseNode(
        pool,
        schema,
        work.workItemId,
        "node-worker",
      );
      const input = {
        tenantId: "tenant-1",
        runId: "run-1",
        lease: nodeLease,
        binding,
        operationId: "recover-unknown-node",
        reasonCode: "workflow_node_side_effect_uncertain",
        nodeId: work.nodeId,
        claimId: work.claimId,
        claimEpoch: work.claimEpoch,
      };
      const first = await store.scheduleWorkflowReconciliation(input);
      await pool.query(
        `UPDATE ${schema}.work_items SET status='completed',completed_at=clock_timestamp()
         WHERE work_item_id=$1`,
        [first.reconciliationWorkItemId],
      );

      const replay = await store.scheduleWorkflowReconciliation(input);

      assert.deepEqual(replay, { ...first, disposition: "replay" });
    } finally {
      await store.close();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  },
);

type WorkAuthority = Readonly<{
  workItemId: string;
  nodeId: string;
  claimId: string;
  claimEpoch: number;
}>;
type NodeLease = Readonly<{
  workItemId: string;
  ownerId: string;
  leaseId: string;
  leaseEpoch: number;
}>;

async function prepareTerminalCandidate(input: {
  store: PostgresWorkflowRunCompositionStore;
  work: WorkAuthority;
  lease: NodeLease;
  schedulerOperationId: string;
  agentVersionId: string;
  nodeKind: "agent" | "verification";
}) {
  const admitted = await input.store.admitWorkflowNodeWork({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: input.lease,
    binding,
    nodeId: input.work.nodeId,
    claimId: input.work.claimId,
    claimEpoch: input.work.claimEpoch,
    schedulerOperationId: input.schedulerOperationId,
    admissionOperationId: `admit-${input.work.nodeId}`,
    attemptLeaseDurationMs: 60_000,
  });
  assert.equal(admitted.disposition, "fresh");
  const attempt = admitted.admission!.attempt;
  const authority = {
    tenantId: "tenant-1",
    runId: "run-1",
    workItemId: input.work.workItemId,
    leaseEpoch: input.lease.leaseEpoch,
    nodeId: input.work.nodeId,
    nodeKind: input.nodeKind,
    claimId: input.work.claimId,
    claimEpoch: input.work.claimEpoch,
    agentVersionId: input.agentVersionId,
    attempt: { stepId: attempt.stepId, attemptId: attempt.attemptId },
  } as const;
  const prepared = await input.store.prepareModelDispatch({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: input.lease,
    attempt: authority.attempt,
    operationId: `dispatch-${input.work.nodeId}`,
    requestSequence: 1,
    operation: "dispatch",
    requestDigest: digest.sha256(`request:${input.work.nodeId}`),
    provider: {
      agentVersionId: input.agentVersionId,
      adapterName: "responses",
      adapterVersion: "1",
      modelId: "model-1",
    },
    preparedAt: "2026-08-13T00:00:01.000Z",
  });
  const sent = await input.store.markModelDispatchPossiblySent({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: input.lease,
    attempt: prepared,
    operationId: prepared.operationId,
    requestSequence: 1,
    expectedRevision: prepared.revision,
    transitionedAt: "2026-08-13T00:00:02.000Z",
  });
  const observed = await input.store.observeModelDispatchResponse({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: input.lease,
    attempt: prepared,
    operationId: prepared.operationId,
    requestSequence: 1,
    expectedRevision: sent.revision,
    checkpointDigest: digest.sha256(`checkpoint:${input.work.nodeId}`),
    transitionedAt: "2026-08-13T00:00:03.000Z",
  });
  const continuation = await input.store.commitWorkflowAssistantContinuation({
    lease: input.lease,
    authority,
    expectedContinuationRevision: null,
    next: {
      schemaVersion: "crewon.workflow-node-continuation.v0",
      authority,
      segmentId: `segment-${input.work.nodeId}`,
      modelSampleIndex: 0,
      toolRoundsConsumed: 0,
      providerCheckpoint: null,
      providerTurnState: null,
      activeDispatch: {
        operationId: observed.operationId,
        requestSequence: observed.requestSequence,
        expectedRevision: observed.revision,
        status: "responseObserved",
      },
      history: [],
    },
    committedAt: "2026-08-13T00:00:04.000Z",
    terminalResult: { status: "completed", output: "{}" },
  });
  assert.ok(continuation.terminalCandidate);
  return {
    inputValue: admitted.admission!.inputValue,
    settlement: {
      lease: input.lease,
      binding,
      authority,
      candidateId: continuation.terminalCandidate.candidateId,
      operationId: `settle-${input.work.nodeId}`,
    },
  };
}

async function leaseNode(
  pool: Pool,
  schema: string,
  workItemId: string,
  ownerId: string,
): Promise<NodeLease> {
  const leaseId = `${ownerId}-lease`;
  const leased = await pool.query<{ lease_epoch: number }>(
    `UPDATE ${schema}.work_items
    SET status='leased',lease_owner_id=$1,lease_id=$2,lease_epoch=lease_epoch+1,
      lease_expires_at=clock_timestamp()+interval '1 minute',attempt_count=attempt_count+1
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

async function countPendingSchedulers(
  pool: Pool,
  schema: string,
): Promise<number> {
  const result = await pool.query<{ count: number }>(`SELECT count(*)::int count
    FROM ${schema}.work_items WHERE status='pending'
    AND work_item_json->'payload'->>'trigger'='workflowScheduler'`);
  return result.rows[0]!.count;
}

async function claimContinuation(pool: Pool, schema: string) {
  const result = await pool.query<{
    work_item_id: string;
    scheduler_operation_id: string;
    lease_epoch: number;
  }>(`UPDATE ${schema}.work_items SET status='leased',lease_owner_id='scheduler-worker',
    lease_id='scheduler-lease',lease_epoch=lease_epoch+1,
    lease_expires_at=clock_timestamp()+interval '1 minute',attempt_count=attempt_count+1
    WHERE work_item_id=(SELECT work_item_id FROM ${schema}.work_items WHERE status='pending'
      AND work_item_json->'payload'->>'trigger'='workflowScheduler' LIMIT 1)
    RETURNING work_item_id,work_item_json->'payload'->>'schedulerOperationId'
      scheduler_operation_id,lease_epoch::int`);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  return {
    schedulerOperationId: row.scheduler_operation_id,
    lease: {
      workItemId: row.work_item_id,
      ownerId: "scheduler-worker",
      leaseId: "scheduler-lease",
      leaseEpoch: row.lease_epoch,
    },
  } as const;
}

const rootInput = {
  valueId: "root-value-1",
  valueDigest: digest.sha256("{}"),
};
const schedulerLease = {
  workItemId: "scheduler-root",
  ownerId: "scheduler-worker",
  leaseId: "scheduler-root-lease",
  leaseEpoch: 1,
};

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
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    terminalAt: null,
  };
}
