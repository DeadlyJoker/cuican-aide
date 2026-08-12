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

test("SQLite atomically admits stable node authority and replays after reopen", async (context) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-workflow-composition-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "authority.sqlite");
  const clock = mutableClock(Date.parse("2026-08-12T00:00:00.000Z"));
  let store = new SqliteWorkflowRunCompositionStore(path, { digester, clock });
  await seed(path, clock.nowEpochMilliseconds() + 60_000);

  const first = await store.admitWorkflowNodes(admissionInput());
  assert.equal(first.disposition, "fresh");
  assert.deepEqual(
    first.admissions.map((item) => ({
      nodeId: item.claim.node.nodeId,
      frozenAgentVersionId: first.execution.nodes.find(
        (node) => node.nodeId === item.claim.node.nodeId,
      )?.agentVersionId,
      stepKind: item.step.kind,
      hasAttempt: item.attempt !== null,
    })),
    [
      {
        nodeId: "agent",
        frozenAgentVersionId: "agent-v1",
        stepKind: "agent",
        hasAttempt: true,
      },
      {
        nodeId: "gate",
        frozenAgentVersionId: null,
        stepKind: "gate",
        hasAttempt: false,
      },
    ],
  );
  assert.equal(
    first.execution.nodes.find((node) => node.nodeId === "verify")
      ?.agentVersionId,
    "verifier-v1",
  );
  await store.close();

  store = new SqliteWorkflowRunCompositionStore(path, { digester, clock });
  assert.deepEqual(await store.admitWorkflowNodes(admissionInput()), {
    disposition: "replay",
    execution: first.execution,
    admissions: [],
    reconciliationClaims: [],
  });
  await store.close();
});

test("SQLite dual connections converge and a reclaimed lease fences replay", async (context) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-workflow-composition-race-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "authority.sqlite");
  const clock = mutableClock(Date.parse("2026-08-12T00:00:00.000Z"));
  const first = new SqliteWorkflowRunCompositionStore(path, {
    digester,
    clock,
  });
  await seed(path, clock.nowEpochMilliseconds() + 60_000);
  const second = new SqliteWorkflowRunCompositionStore(path, {
    digester,
    clock,
  });
  const [left, right] = await Promise.all([
    first.admitWorkflowNodes(admissionInput()),
    second.admitWorkflowNodes(admissionInput()),
  ]);
  assert.deepEqual(right, {
    disposition: "replay",
    execution: left.execution,
    admissions: [],
    reconciliationClaims: [],
  });

  const database = new DatabaseSync(path);
  database
    .prepare(
      `UPDATE work_items SET lease_owner_id='worker-2',lease_id='lease-2',
       lease_epoch=2,lease_expires_at_ms=? WHERE work_item_id='work-1'`,
    )
    .run(clock.nowEpochMilliseconds() + 60_000);
  database.close();
  await assert.rejects(
    second.admitWorkflowNodes(admissionInput()),
    /stale_lease/u,
  );
  await first.close();
  await second.close();
});

test("SQLite expired running node becomes unknown without a second Attempt", async () => {
  const database = new DatabaseSync(":memory:");
  const clock = mutableClock(Date.parse("2026-08-12T00:00:00.000Z"));
  const store = new SqliteWorkflowRunCompositionStore(database, {
    digester,
    clock,
  });
  await seed(database, clock.nowEpochMilliseconds() + 60_000);
  const first = await store.admitWorkflowNodes(admissionInput());
  const original = first.execution.nodes.find(
    (node) => node.nodeId === "agent",
  )!;
  clock.set(Date.parse("2026-08-12T00:00:06.000Z"));
  const reclaimedLease = {
    workItemId: "work-1",
    ownerId: "worker-2",
    leaseId: "lease-2",
    leaseEpoch: 2,
  };
  database
    .prepare(
      `UPDATE work_items SET lease_owner_id=?,lease_id=?,lease_epoch=?,lease_expires_at_ms=?
       WHERE work_item_id=?`,
    )
    .run(
      reclaimedLease.ownerId,
      reclaimedLease.leaseId,
      reclaimedLease.leaseEpoch,
      clock.nowEpochMilliseconds() + 60_000,
      reclaimedLease.workItemId,
    );
  const recovered = await store.admitWorkflowNodes({
    ...admissionInput(),
    lease: reclaimedLease,
    schedulerOperationId: "scheduler-operation-2",
  });
  const unknown = recovered.execution.nodes.find(
    (node) => node.nodeId === "agent",
  )!;
  assert.deepEqual(recovered.admissions, []);
  assert.equal(recovered.disposition, "reconcileRequired");
  assert.deepEqual(recovered.reconciliationClaims, [
    first.admissions[0]!.claim,
  ]);
  assert.deepEqual(unknown, {
    ...original,
    status: "unknown",
    leaseExpiresAt: null,
  });
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM run_attempts").get()?.count,
    1,
  );
});

test("SQLite rejects expired lease and frozen binding drift without partial DAG state", async () => {
  const database = new DatabaseSync(":memory:");
  const clock = mutableClock(Date.parse("2026-08-12T00:00:00.000Z"));
  const store = new SqliteWorkflowRunCompositionStore(database, {
    digester,
    clock,
  });
  await seed(database, clock.nowEpochMilliseconds());
  await assert.rejects(
    store.admitWorkflowNodes(admissionInput()),
    /lease_expired/u,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM workflow_executions").get()
      ?.count,
    0,
  );
  database
    .prepare(
      "UPDATE work_items SET lease_expires_at_ms=? WHERE work_item_id='work-1'",
    )
    .run(clock.nowEpochMilliseconds() + 60_000);
  await assert.rejects(
    store.admitWorkflowNodes({
      ...admissionInput(),
      binding: { ...binding, workflowVersionId: "substituted-version" },
    }),
    /run_authority_mismatch/u,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM workflow_executions").get()
      ?.count,
    0,
  );
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
}

function admissionInput() {
  return {
    tenantId: "tenant-1",
    runId: "run-1",
    lease,
    binding,
    schedulerOperationId: "scheduler-operation-1",
    leaseDurationMs: 5_000,
  } as const;
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
      "{}",
      run.createdAt,
      0,
      lease.ownerId,
      lease.leaseId,
      lease.leaseEpoch,
      leaseExpiresAtMs,
    );
  database.prepare(
    `INSERT INTO workflow_execution_values
     (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
     VALUES ('tenant-1','run-1','root-value-1','rootInput',NULL,?,?,?)`,
  ).run(digester.sha256("{}"), "{}", run.createdAt);
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
