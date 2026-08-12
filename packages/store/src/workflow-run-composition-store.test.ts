import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import {
  compileWorkflowVersion,
  createWorkflowNodeTerminalEvidence,
  serializeCompiledWorkflowVersion,
  type RunState,
  type WorkflowVersionSource,
} from "@crewon/domain";

import type { LeaseClock } from "./lease-clock.ts";
import { PostgresWorkflowRunCompositionStore } from "./postgres-workflow-run-composition-store.ts";
import { SqliteWorkflowRunCompositionStore } from "./sqlite-workflow-run-composition-store.ts";
import { SqliteWorkflowVersionStore } from "./workflow-version-store.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const objectSchema = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const common = (nodeId: string, dependsOn: string[] = []) => ({
  nodeId,
  title: nodeId,
  instruction: nodeId,
  dependsOn,
  inputSchema: objectSchema,
  outputSchema: objectSchema,
});
const fanInSchema = {
  type: "object" as const,
  properties: { agent: objectSchema, gate: objectSchema },
  required: ["agent", "gate"],
  additionalProperties: false as const,
};
const source: WorkflowVersionSource = {
  schemaVersion: "crewon.workflow-version-source.v0",
  workflowId: "workflow-1",
  workflowVersionId: "workflow-version-1",
  name: "composition",
  description: "composition",
  inputSchema: objectSchema,
  outputSchema: objectSchema,
  entryNodeIds: ["agent", "gate"],
  outputNodeIds: ["verify"],
  nodes: [
    { ...common("agent"), kind: "agent", agentVersionId: "agent-v1" },
    {
      ...common("gate"),
      kind: "humanGate",
      approvalPolicyId: "approval-1",
    },
    {
      ...common("verify", ["agent", "gate"]),
      inputSchema: fanInSchema,
      kind: "verification",
      verifierAgentVersionId: "verifier-v1",
    },
  ],
};
const workflow = compileWorkflowVersion(source, digester);
const binding = {
  workflowId: workflow.workflowId,
  workflowVersionId: workflow.workflowVersionId,
  contentDigest: workflow.contentDigest,
};
const lease = {
  workItemId: "work-1",
  ownerId: "worker-1",
  leaseId: "lease-1",
  leaseEpoch: 1,
};

test("SQLite composition prototype exposes only the current Store contract", () => {
  const prototype =
    SqliteWorkflowRunCompositionStore.prototype as unknown as Record<
      string,
      unknown
    >;
  assert.equal(prototype.admitWorkflowNodes, undefined);
  for (const method of [
    "scheduleWorkflowNodes",
    "admitWorkflowNodeWork",
    "settleWorkflowNode",
    "recordWorkflowHumanGateDecision",
    "settleWorkflowHumanGate",
    "scheduleWorkflowReconciliation",
    "reconcileWorkflowNode",
    "cancelWorkflowExecution",
  ]) {
    assert.equal(typeof prototype[method], "function", method);
  }
});

test("SQLite fanout atomically queues agent work and publishes a sibling gate", async () => {
  const database = new DatabaseSync(":memory:");
  const clock = mutableClock(Date.parse("2026-08-12T00:00:00.000Z"));
  const store = new SqliteWorkflowRunCompositionStore(database, {
    digester,
    clock,
  });
  await seed(database, clock.nowEpochMilliseconds() + 60_000);

  const scheduled = await store.scheduleWorkflowNodes({
    tenantId: "tenant-1",
    runId: "run-1",
    lease,
    binding,
    schedulerOperationId: "schedule-fanout-1",
    workflowInput: {
      valueId: "root-value-1",
      valueDigest: digester.sha256("{}"),
    },
  });
  assert.equal(scheduled.disposition, "scheduled");
  assert.equal(scheduled.nodeWorkItems.length, 1);
  assert.equal(scheduled.gatePublications.length, 1);
  assert.deepEqual(
    scheduled.execution.nodes.map((node) => [node.nodeId, node.status]),
    [
      ["agent", "queued"],
      ["gate", "waitingHuman"],
      ["verify", "pending"],
    ],
  );
  assert.match(
    scheduled.nodeWorkItems[0]!.workItemId,
    /^wf1:node:[a-f0-9]{64}$/u,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM run_attempts").get()?.count,
    0,
  );
  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM workflow_gate_requests")
      .get()?.count,
    1,
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM outbox WHERE topic='workflow.gate.requested'",
      )
      .get()?.count,
    1,
  );
  assert.equal(
    database
      .prepare("SELECT status FROM work_items WHERE work_item_id='work-1'")
      .get()?.status,
    "completed",
  );

  const replayDatabase = new DatabaseSync(":memory:");
  replayDatabase.close();
  const work = scheduled.nodeWorkItems[0]!;
  database
    .prepare(
      `UPDATE work_items SET status='leased',lease_owner_id='node-worker',lease_id='node-lease',
     lease_epoch=1,lease_expires_at_ms=? WHERE work_item_id=?`,
    )
    .run(clock.nowEpochMilliseconds() + 60_000, work.workItemId);
  const admitted = await store.admitWorkflowNodeWork({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: {
      workItemId: work.workItemId,
      ownerId: "node-worker",
      leaseId: "node-lease",
      leaseEpoch: 1,
    },
    binding,
    nodeId: work.nodeId,
    claimId: work.claimId,
    claimEpoch: work.claimEpoch,
    schedulerOperationId: "schedule-fanout-1",
    admissionOperationId: "admit-agent-1",
    attemptLeaseDurationMs: 5_000,
  });
  assert.equal(admitted.disposition, "fresh");
  assert.equal(admitted.execution.nodes[0]?.status, "running");
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM run_attempts").get()?.count,
    1,
  );
  const replay = await store.admitWorkflowNodeWork({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: {
      workItemId: work.workItemId,
      ownerId: "node-worker",
      leaseId: "node-lease",
      leaseEpoch: 1,
    },
    binding,
    nodeId: work.nodeId,
    claimId: work.claimId,
    claimEpoch: work.claimEpoch,
    schedulerOperationId: "schedule-fanout-1",
    admissionOperationId: "admit-agent-1",
    attemptLeaseDurationMs: 5_000,
  });
  assert.equal(replay.disposition, "replay");
  assert.equal(replay.admission, null);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM run_attempts").get()?.count,
    1,
  );
});

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;
if (postgresUrl === undefined) {
  test.skip("PostgreSQL workflow composition requires CREWON_TEST_POSTGRES_URL", () => {});
} else {
  test("PostgreSQL workflow composition migrates the registered physical authority", async () => {
    const schema = `workflow_composition_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl });
    const store = await PostgresWorkflowRunCompositionStore.open({
      pool,
      schema,
      digester,
    });
    try {
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='workflow_execution_receipts'
         ORDER BY ordinal_position`,
        [schema],
      );
      assert.deepEqual(
        columns.rows.map((row) => row.column_name),
        [
          "tenant_id",
          "run_id",
          "operation_id",
          "fingerprint",
          "state_json",
          "result_json",
        ],
      );
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await store.close();
    }
  });

  test("PostgreSQL composition validates replay and fans out every recovery claim", async () => {
    const schema = `workflow_replay_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl });
    const store = await PostgresWorkflowRunCompositionStore.open({
      pool,
      schema,
      digester,
    });
    try {
      await seedPostgresComposition(pool, schema);
      const scheduleInput = {
        tenantId: "tenant-1",
        runId: "run-1",
        lease,
        binding,
        schedulerOperationId: "schedule-fanout-1",
        workflowInput: {
          valueId: "root-value-1",
          valueDigest: digester.sha256("{}"),
        },
      } as const;
      const fresh = await store.scheduleWorkflowNodes(scheduleInput);
      assert.equal(fresh.disposition, "scheduled");
      assert.deepEqual(await store.scheduleWorkflowNodes(scheduleInput), {
        ...fresh,
        disposition: "replay",
      });
      await assert.rejects(
        store.scheduleWorkflowNodes({
          ...scheduleInput,
          workflowInput: { ...scheduleInput.workflowInput, valueId: "forged" },
        }),
        /idempotency_conflict/u,
      );
      const work = fresh.nodeWorkItems[0]!;
      await pool.query(
        `UPDATE ${schema}.work_items SET status='leased',
        lease_owner_id='node-worker',lease_id='node-lease',lease_epoch=1,
        lease_expires_at=clock_timestamp()+interval '1 minute' WHERE work_item_id=$1`,
        [work.workItemId],
      );
      const admitInput = {
        tenantId: "tenant-1",
        runId: "run-1",
        lease: {
          workItemId: work.workItemId,
          ownerId: "node-worker",
          leaseId: "node-lease",
          leaseEpoch: 1,
        },
        binding,
        nodeId: work.nodeId,
        claimId: work.claimId,
        claimEpoch: work.claimEpoch,
        schedulerOperationId: "schedule-fanout-1",
        admissionOperationId: "admit-1",
        attemptLeaseDurationMs: 5_000,
      } as const;
      const admitted = await store.admitWorkflowNodeWork(admitInput);
      assert.equal(admitted.disposition, "fresh");
      const second = new PostgresWorkflowRunCompositionStore({
        pool,
        schema,
        digester,
      });
      assert.equal(
        (await second.admitWorkflowNodeWork(admitInput)).disposition,
        "replay",
      );
      const authority = {
        tenantId: "tenant-1",
        runId: "run-1",
        workItemId: work.workItemId,
        leaseEpoch: work.claimEpoch,
        nodeId: work.nodeId,
        nodeKind: "agent" as const,
        claimId: work.claimId,
        claimEpoch: work.claimEpoch,
        agentVersionId: "agent-v1",
        attempt: {
          stepId: work.nodeId,
          attemptId: admitted.admission!.attempt.attemptId,
        },
      };
      const continuationInput = {
        lease: admitInput.lease,
        authority,
        expectedContinuationRevision: null,
        next: {
          schemaVersion: "crewon.workflow-node-continuation.v0" as const,
          authority,
          segmentId: "segment-1",
          modelSampleIndex: 0,
          toolRoundsConsumed: 0,
          providerCheckpoint: null,
          providerTurnState: null,
          activeDispatch: null,
          history: [
            {
              type: "message" as const,
              role: "user" as const,
              content: "continue",
            },
          ],
        },
        committedAt: "2026-08-12T00:00:00.000Z",
      };
      const continuation =
        await store.commitWorkflowAssistantContinuation(continuationInput);
      assert.deepEqual(
        await second.loadWorkflowNodeContinuation(authority),
        continuation,
      );
      await assert.rejects(
        second.commitWorkflowAssistantContinuation({
          ...continuationInput,
          next: {
            ...continuationInput.next,
            history: [
              {
                type: "message",
                role: "user",
                content: "x".repeat(40 * 1024 + 1),
              },
            ],
          },
        }),
        /workflow_node_continuation_invalid/u,
      );
      const dispatchPrepared = await store.prepareModelDispatch({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: admitInput.lease,
        attempt: {
          stepId: work.nodeId,
          attemptId: admitted.admission!.attempt.attemptId,
        },
        operationId: "model-agent-1",
        requestSequence: 1,
        operation: "dispatch",
        requestDigest: digester.sha256("model-request"),
        provider: {
          agentVersionId: "agent-v1",
          adapterName: "responses",
          adapterVersion: "1",
          modelId: "model-1",
        },
        preparedAt: "2026-08-12T00:00:01.000Z",
      });
      const dispatchSent = await store.markModelDispatchPossiblySent({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: admitInput.lease,
        attempt: dispatchPrepared,
        operationId: dispatchPrepared.operationId,
        requestSequence: 1,
        expectedRevision: dispatchPrepared.revision,
        transitionedAt: "2026-08-12T00:00:02.000Z",
      });
      const dispatchObserved = await store.observeModelDispatchResponse({
        tenantId: "tenant-1",
        runId: "run-1",
        lease: admitInput.lease,
        attempt: dispatchPrepared,
        operationId: dispatchPrepared.operationId,
        requestSequence: 1,
        expectedRevision: dispatchSent.revision,
        checkpointDigest: digester.sha256("checkpoint"),
        transitionedAt: "2026-08-12T00:00:03.000Z",
      });
      const evidence = createWorkflowNodeTerminalEvidence({
        workflow,
        nodeId: work.nodeId,
        outcome: { status: "completed", value: {} },
        digester,
      });
      const settlementInput = {
        binding,
        nodeId: work.nodeId,
        operationId: "settle-agent-1",
        evidence,
        lease: admitInput.lease,
        authority,
        dispatch: {
          operationId: dispatchObserved.operationId,
          requestSequence: dispatchObserved.requestSequence,
          expectedRevision: dispatchObserved.revision,
          status: "responseObserved" as const,
        },
        dispatchTerminalOutcome: {
          kind: "completed" as const,
          code: null,
          certainty: "responseObserved" as const,
        },
      };
      const settled =
        await store.settleWorkflowNodeModelTerminal(settlementInput);
      assert.equal(settled.disposition, "settled");
      assert.equal(
        (await second.settleWorkflowNodeModelTerminal(settlementInput))
          .disposition,
        "replay",
      );
      const completedLease = await pool.query(
        `SELECT status,lease_owner_id,lease_id,
        lease_expires_at,completed_at FROM ${schema}.work_items WHERE work_item_id=$1`,
        [work.workItemId],
      );
      assert.deepEqual(completedLease.rows[0], {
        status: "completed",
        lease_owner_id: null,
        lease_id: null,
        lease_expires_at: null,
        completed_at: completedLease.rows[0].completed_at,
      });
      await pool.query(`UPDATE ${schema}.workflow_composition_receipts
        SET result_json=jsonb_set(result_json,'{handoff,nextWorkItemId}','"forged"')
        WHERE operation_id='settle-agent-1'`);
      await assert.rejects(
        second.settleWorkflowNodeModelTerminal(settlementInput),
        /receipt_corrupt/u,
      );

      const executionRow = await pool.query<{
        state_json: Record<string, unknown>;
      }>(
        `SELECT state_json FROM ${schema}.workflow_executions WHERE run_id='run-1'`,
      );
      const execution = executionRow.rows[0]!.state_json as {
        revision: number;
        status: string;
        nodes: Array<Record<string, unknown>>;
        updatedAt: string;
      };
      execution.revision += 1;
      execution.status = "running";
      execution.updatedAt = "2026-08-12T00:01:00.000Z";
      execution.nodes = execution.nodes.map((node) =>
        node.claimId === null
          ? node
          : {
              ...node,
              status: "unknown",
              leaseExpiresAt: null,
              resultDigest: null,
              failureCode: null,
            },
      );
      await pool.query(
        `UPDATE ${schema}.workflow_executions
        SET revision=$1,state_json=$2,updated_at=$3 WHERE run_id='run-1'`,
        [execution.revision, execution, execution.updatedAt],
      );
      await seedPostgresSchedulerWork(
        pool,
        schema,
        "work-recover",
        "schedule-recover",
      );
      const recovered = await store.scheduleWorkflowNodes({
        ...scheduleInput,
        lease: { ...lease, workItemId: "work-recover" },
        schedulerOperationId: "schedule-recover",
      });
      assert.equal(recovered.disposition, "reconcileRequired");
      assert.equal(recovered.reconciliationClaims.length, 2);
      const recoveryRows = await pool.query<{
        work_item_json: {
          payload: {
            trigger: string;
            nodeId: string;
            claimId: string;
            claimEpoch: number;
            reconciliationOperationId: string;
          };
        };
      }>(
        `SELECT work_item_json FROM ${schema}.work_items
         WHERE work_item_json->'payload'->>'trigger'='workflowReconcile'`,
      );
      assert.equal(recoveryRows.rowCount, 2);
      const recoveryPayloads = recoveryRows.rows.map(
        (row) => row.work_item_json.payload,
      );
      assert.equal(
        new Set(
          recoveryPayloads.map((payload) => payload.reconciliationOperationId),
        ).size,
        2,
      );
      assert.ok(
        recoveryPayloads.every(
          (payload) =>
            payload.reconciliationOperationId !== "schedule-recover" &&
            recovered.reconciliationClaims.some(
              (claim) =>
                claim.node.nodeId === payload.nodeId &&
                claim.claimId === payload.claimId &&
                claim.claimEpoch === payload.claimEpoch,
            ),
        ),
      );

      await pool.query(`UPDATE ${schema}.workflow_composition_receipts
        SET result_json=jsonb_set(result_json,'{execution,tenantId}','"tampered"')
        WHERE operation_id='schedule-recover'`);
      await assert.rejects(
        store.scheduleWorkflowNodes({
          ...scheduleInput,
          lease: { ...lease, workItemId: "work-recover" },
          schedulerOperationId: "schedule-recover",
        }),
        /receipt_corrupt/u,
      );
      await seedPostgresSchedulerWork(
        pool,
        schema,
        "work-stale",
        "schedule-stale",
        "-1 second",
      );
      await assert.rejects(
        store.scheduleWorkflowNodes({
          ...scheduleInput,
          lease: { ...lease, workItemId: "work-stale" },
          schedulerOperationId: "schedule-stale",
        }),
        /stale_lease/u,
      );
      await pool.query(
        `UPDATE ${schema}.workflow_execution_values
        SET value_json=$1 WHERE role='rootInput'`,
        [{ oversized: "x".repeat(33_000) }],
      );
      await seedPostgresSchedulerWork(pool, schema, "work-cap", "schedule-cap");
      await assert.rejects(
        store.scheduleWorkflowNodes({
          ...scheduleInput,
          lease: { ...lease, workItemId: "work-cap" },
          schedulerOperationId: "schedule-cap",
        }),
        /workflow_execution_value_corrupt/u,
      );
      const rolledBack =
        await pool.query(`SELECT status FROM ${schema}.work_items
        WHERE work_item_id='work-cap'`);
      assert.equal(rolledBack.rows[0]?.status, "leased");
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await store.close();
    }
  });

  test("PostgreSQL gate decision and settlement are atomic and replay exact", async () => {
    const schema = `workflow_gate_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl });
    const store = await PostgresWorkflowRunCompositionStore.open({
      pool,
      schema,
      digester,
    });
    try {
      await seedPostgresComposition(pool, schema);
      const scheduled = await store.scheduleWorkflowNodes({
        tenantId: "tenant-1",
        runId: "run-1",
        lease,
        binding,
        schedulerOperationId: "schedule-fanout-1",
        workflowInput: {
          valueId: "root-value-1",
          valueDigest: digester.sha256("{}"),
        },
      });
      const gate = scheduled.gatePublications[0]!;
      const decision = {
        tenantId: "tenant-1",
        runId: "run-1",
        binding,
        nodeId: gate.nodeId,
        claimId: gate.claimId,
        claimEpoch: gate.claimEpoch,
        gateRequestId: gate.gateRequestId,
        decisionReceiptId: "decision-1",
        outcome: { status: "failed" as const, failureCode: "denied" },
      };
      const recorded = await store.recordWorkflowHumanGateDecision(decision);
      assert.equal(recorded.disposition, "recorded");
      assert.deepEqual(await store.recordWorkflowHumanGateDecision(decision), {
        ...recorded,
        disposition: "replay",
      });
      await assert.rejects(
        store.recordWorkflowHumanGateDecision({
          ...decision,
          outcome: { status: "completed" },
        }),
        /idempotency_conflict/u,
      );
      await pool.query(
        `UPDATE ${schema}.work_items SET status='leased',
        lease_owner_id='gate-worker',lease_id='gate-lease',lease_epoch=1,
        lease_expires_at=clock_timestamp()+interval '1 minute'
        WHERE work_item_id=$1`,
        [recorded.approvalResumeWorkItemId],
      );
      const settlement = {
        tenantId: "tenant-1",
        runId: "run-1",
        lease: {
          workItemId: recorded.approvalResumeWorkItemId,
          ownerId: "gate-worker",
          leaseId: "gate-lease",
          leaseEpoch: 1,
        },
        binding,
        nodeId: gate.nodeId,
        claimId: gate.claimId,
        claimEpoch: gate.claimEpoch,
        gateRequestId: gate.gateRequestId,
        decisionReceiptId: "decision-1",
        operationId: "settle-gate-1",
      };
      const settled = await store.settleWorkflowHumanGate(settlement);
      assert.equal(settled.disposition, "settled");
      assert.equal(settled.runDisposition, "terminalConverged");
      assert.equal(settled.execution.status, "failed");
      const reopened = new PostgresWorkflowRunCompositionStore({
        pool,
        schema,
        digester,
      });
      assert.equal(
        (await reopened.settleWorkflowHumanGate(settlement)).disposition,
        "replay",
      );
      const authority = await pool.query(
        `SELECT r.state_json AS run,
        w.status,w.lease_owner_id,w.lease_id,w.lease_expires_at
        FROM ${schema}.run_snapshots r JOIN ${schema}.work_items w ON w.run_id=r.run_id
        WHERE r.run_id='run-1' AND w.work_item_id=$1`,
        [recorded.approvalResumeWorkItemId],
      );
      assert.equal(authority.rows[0]?.run.status, "failed");
      assert.deepEqual(
        [
          authority.rows[0]?.status,
          authority.rows[0]?.lease_owner_id,
          authority.rows[0]?.lease_id,
          authority.rows[0]?.lease_expires_at,
        ],
        ["completed", null, null, null],
      );
      await pool.query(`UPDATE ${schema}.workflow_composition_receipts
        SET result_json=jsonb_set(result_json,'{handoff,kind}','"scheduler"')
        WHERE operation_id='settle-gate-1'`);
      await assert.rejects(
        reopened.settleWorkflowHumanGate(settlement),
        /receipt_corrupt/u,
      );

      await seedPostgresSchedulerWork(
        pool,
        schema,
        "stale-gate",
        "stale-gate",
        "-1 second",
      );
      const before = await pool.query(`SELECT count(*)::int AS count
        FROM ${schema}.workflow_composition_receipts`);
      await assert.rejects(
        store.settleWorkflowHumanGate({
          ...settlement,
          lease: { ...settlement.lease, workItemId: "stale-gate" },
          operationId: "stale-settle",
        }),
        /stale_lease|work_item_mismatch/u,
      );
      const after = await pool.query(`SELECT count(*)::int AS count
        FROM ${schema}.workflow_composition_receipts`);
      assert.equal(after.rows[0]?.count, before.rows[0]?.count);
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await store.close();
    }
  });
}

async function seedPostgresComposition(
  pool: Pool,
  schema: string,
): Promise<void> {
  const run = runState();
  await pool.query(
    `INSERT INTO ${schema}.workflow_versions
    (tenant_id,workflow_id,workflow_version_id,content_digest,definition_json,created_at)
    VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      "tenant-1",
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
    VALUES ('tenant-1','run-1','root-value-1','rootInput',NULL,$1,'{}',$2)`,
    [digester.sha256("{}"), run.createdAt],
  );
  await seedPostgresSchedulerWork(pool, schema, "work-1", "schedule-fanout-1");
}

async function seedPostgresSchedulerWork(
  pool: Pool,
  schema: string,
  workItemId: string,
  operationId: string,
  expiry = "1 minute",
): Promise<void> {
  const now = "2026-08-12T00:00:00.000Z";
  const payload = {
    schemaVersion: "crewon.workflow-scheduler-work-item.v1",
    trigger: "workflowScheduler",
    binding,
    schedulerOperationId: operationId,
    workflowInput: {
      valueId: "root-value-1",
      valueDigest: digester.sha256("{}"),
    },
  };
  const item = {
    workItemId,
    tenantId: "tenant-1",
    runId: "run-1",
    kind: "run.execute",
    payload,
    createdAt: now,
  };
  await pool.query(
    `INSERT INTO ${schema}.work_items
    (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,available_at,
     lease_owner_id,lease_id,lease_epoch,lease_expires_at,attempt_count)
    VALUES ($1,'tenant-1','run-1','run.execute',$2,$3,'leased',$3,$4,$5,1,
      clock_timestamp()+$6::interval,1)`,
    [workItemId, item, now, lease.ownerId, lease.leaseId, expiry],
  );
}

async function seed(
  databaseOrPath: DatabaseSync | string,
  leaseExpiresAtMs: number,
): Promise<void> {
  const database =
    typeof databaseOrPath === "string"
      ? new DatabaseSync(databaseOrPath)
      : databaseOrPath;
  const versions = new SqliteWorkflowVersionStore(database, digester);
  await versions.registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0",
    tenantId: "tenant-1",
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: "2026-08-12T00:00:00.000Z",
  });
  const run = runState();
  database
    .prepare(
      `INSERT INTO run_snapshots
       (tenant_id,space_id,run_id,revision,last_sequence,state_json,updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      "tenant-1",
      "space-1",
      "run-1",
      2,
      2,
      JSON.stringify(run),
      run.updatedAt,
    );
  database
    .prepare(
      `INSERT INTO work_items
       (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,
        available_at_ms,lease_owner_id,lease_id,lease_epoch,lease_expires_at_ms,attempt_count)
       VALUES (?,?,?,?,?,?,'leased',?,?,?,?,?,1)`,
    )
    .run(
      "work-1",
      "tenant-1",
      "run-1",
      "run.execute",
      JSON.stringify({
        workItemId: "work-1",
        tenantId: "tenant-1",
        runId: "run-1",
        kind: "run.execute",
        createdAt: run.createdAt,
        payload: {
          schemaVersion: "crewon.workflow-scheduler-work-item.v1",
          trigger: "workflowScheduler",
          binding,
          schedulerOperationId: "schedule-fanout-1",
          workflowInput: {
            valueId: "root-value-1",
            valueDigest: digester.sha256("{}"),
          },
        },
      }),
      run.createdAt,
      0,
      lease.ownerId,
      lease.leaseId,
      lease.leaseEpoch,
      leaseExpiresAtMs,
    );
  database
    .prepare(
      `INSERT INTO workflow_execution_values
     (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
     VALUES ('tenant-1','run-1','root-value-1','rootInput',NULL,?,?,?)`,
    )
    .run(digester.sha256("{}"), "{}", run.createdAt);
  if (typeof databaseOrPath === "string") database.close();
}

function runState(): RunState {
  return {
    runId: "run-1",
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    authorityId: "authority-1",
    runtimeGeneration: "ts-v0",
    agentVersionId: "orchestrator-v1",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
    collaborationMode: "default",
    purpose: "workflow",
    workflowVersionBinding: binding,
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
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    terminalAt: null,
  };
}

type MutableClock = LeaseClock & { set(value: number): void };

function mutableClock(initial: number): MutableClock {
  let now = initial;
  return {
    nowEpochMilliseconds: () => now,
    set(value) {
      now = value;
    },
  };
}
