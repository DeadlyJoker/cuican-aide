import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowExecutionService } from "@crewon/application";
import {
  compileWorkflowVersion,
  type WorkflowVersionSource,
} from "@crewon/domain";

import { SqliteWorkflowExecutionStore } from "./workflow-execution-store.ts";
import { migrateSqliteWorkflowExecutions } from "./workflow-execution-schema.ts";

const schema = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const fanInSchema = {
  type: "object" as const,
  properties: { "branch-a": schema, "branch-b": schema },
  required: ["branch-a", "branch-b"],
  additionalProperties: false as const,
};
const common = (nodeId: string, dependsOn: string[]) => ({
  nodeId,
  title: nodeId,
  instruction: nodeId,
  dependsOn,
  inputSchema: schema,
  outputSchema: schema,
});
const source: WorkflowVersionSource = {
  schemaVersion: "crewon.workflow-version-source.v0",
  workflowId: "workflow-1",
  workflowVersionId: "workflow-version-1",
  name: "durable DAG",
  description: "durable DAG",
  inputSchema: schema,
  outputSchema: fanInSchema,
  entryNodeIds: ["root"],
  outputNodeIds: ["verify"],
  nodes: [
    { ...common("root", []), kind: "agent", agentVersionId: "agent-root" },
    {
      ...common("branch-b", ["root"]),
      kind: "agent",
      agentVersionId: "agent-b",
    },
    {
      ...common("branch-a", ["root"]),
      kind: "agent",
      agentVersionId: "agent-a",
    },
    {
      ...common("gate", ["branch-a", "branch-b"]),
      inputSchema: fanInSchema,
      outputSchema: fanInSchema,
      kind: "humanGate",
      approvalPolicyId: "approval-policy-1",
    },
    {
      ...common("verify", ["gate"]),
      inputSchema: fanInSchema,
      outputSchema: fanInSchema,
      kind: "verification",
      verifierAgentVersionId: "agent-verifier",
    },
  ],
};
const workflow = compileWorkflowVersion(source, {
  sha256: (value) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
});
const binding = {
  workflowId: workflow.workflowId,
  workflowVersionId: workflow.workflowVersionId,
  contentDigest: workflow.contentDigest,
};
const completedDigest = `sha256:${"1".repeat(64)}`;

test("persists stable parallel claims and frozen node identities across reopen", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-workflow-dag-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "authority.sqlite");
  let now = "2026-08-12T00:00:00.000Z";
  let sequence = 0;
  let database = new DatabaseSync(path);
  let service = executionService(
    database,
    () => now,
    () => `id-${++sequence}`,
  );
  await service.initialize({
    tenantId: "tenant-1",
    runId: "run-1",
    binding,
    workflow,
  });

  const root = await service.claimReady({
    tenantId: "tenant-1",
    runId: "run-1",
    binding,
    workflow,
    leaseDurationMs: 1_000,
    operationId: "claim-root",
  });
  assert.deepEqual(root.map(projectClaim), [
    {
      nodeId: "root",
      kind: "agent",
      agentVersionId: "agent-root",
      claimEpoch: 1,
    },
  ]);
  await settleCompleted(service, root[0]!, "settle-root");

  const branches = await service.claimReady({
    tenantId: "tenant-1",
    runId: "run-1",
    binding,
    workflow,
    leaseDurationMs: 1_000,
    operationId: "claim-branches",
  });
  assert.deepEqual(branches.map(projectClaim), [
    {
      nodeId: "branch-a",
      kind: "agent",
      agentVersionId: "agent-a",
      claimEpoch: 1,
    },
    {
      nodeId: "branch-b",
      kind: "agent",
      agentVersionId: "agent-b",
      claimEpoch: 1,
    },
  ]);

  database.close();
  database = new DatabaseSync(path);
  service = executionService(
    database,
    () => now,
    () => `restart-${++sequence}`,
  );
  const reopened = await new SqliteWorkflowExecutionStore(
    database,
  ).loadWorkflowExecution({
    tenantId: "tenant-1",
    runId: "run-1",
  });
  assert.deepEqual(
    reopened?.nodes
      .filter((node) => node.status === "running")
      .map((node) => ({
        nodeId: node.nodeId,
        agentVersionId: node.agentVersionId,
        claimId: node.claimId,
      })),
    branches.map((claim) => ({
      nodeId: claim.node.nodeId,
      agentVersionId:
        claim.node.kind === "agent" ? claim.node.agentVersionId : null,
      claimId: claim.claimId,
    })),
  );

  now = "2026-08-12T00:00:02.000Z";
  assert.deepEqual(
    await service.claimReady({
      tenantId: "tenant-1",
      runId: "run-1",
      binding,
      workflow,
      leaseDurationMs: 1_000,
      operationId: "recover-expired",
    }),
    [],
  );
  const unknown = await new SqliteWorkflowExecutionStore(
    database,
  ).loadWorkflowExecution({
    tenantId: "tenant-1",
    runId: "run-1",
  });
  assert.deepEqual(
    unknown?.nodes
      .filter((node) => node.status === "unknown")
      .map((node) => node.nodeId),
    ["branch-a", "branch-b"],
  );

  await settleCompleted(service, branches[1]!, "reconcile-b");
  await settleCompleted(service, branches[0]!, "reconcile-a");
  const gate = await service.claimReady({
    tenantId: "tenant-1",
    runId: "run-1",
    binding,
    workflow,
    leaseDurationMs: 1_000,
    operationId: "claim-gate",
  });
  assert.equal(gate[0]?.node.kind, "humanGate");
  assert.match(gate[0]?.gateRequestId ?? "", /^restart-/u);
  const waiting = await new SqliteWorkflowExecutionStore(
    database,
  ).loadWorkflowExecution({
    tenantId: "tenant-1",
    runId: "run-1",
  });
  assert.equal(waiting?.status, "waitingHuman");
  assert.equal(
    waiting?.nodes.find((node) => node.nodeId === "gate")?.leaseExpiresAt,
    null,
  );
  database.close();
});

test("settlement receipts replay exactly and conflicting reuse fails closed", async () => {
  const database = new DatabaseSync(":memory:");
  const service = executionService(
    database,
    () => "2026-08-12T00:00:00.000Z",
    ids(),
  );
  await service.initialize({
    tenantId: "tenant-1",
    runId: "run-2",
    binding,
    workflow,
  });
  const [claim] = await service.claimReady({
    tenantId: "tenant-1",
    runId: "run-2",
    binding,
    workflow,
    leaseDurationMs: 1_000,
    operationId: "claim-run-2",
  });
  const input = {
    tenantId: "tenant-1",
    runId: "run-2",
    binding,
    workflow,
    nodeId: claim!.node.nodeId,
    claimId: claim!.claimId,
    operationId: "settlement-1",
    outcome: { status: "completed" as const, resultDigest: completedDigest },
  };
  const completed = await service.settleNode(input);
  assert.deepEqual(await service.settleNode(input), completed);
  await assert.rejects(
    service.settleNode({
      ...input,
      outcome: { status: "failed", failureCode: "different" },
    }),
    /workflow_execution_idempotency_conflict|workflow_node_claim_stale/u,
  );
  database.close();
});

test("rejects a runtime-local binding that differs from the durable frozen binding", async () => {
  const database = new DatabaseSync(":memory:");
  const service = executionService(
    database,
    () => "2026-08-12T00:00:00.000Z",
    ids(),
  );
  await assert.rejects(
    service.initialize({
      tenantId: "tenant-1",
      runId: "run-3",
      binding: { ...binding, workflowId: "current-workflow" },
      workflow,
    }),
    /workflow_execution_binding_mismatch/u,
  );
  database.close();
});

test("replays a committed claim after caller crash with the stable operation id", async () => {
  const database = new DatabaseSync(":memory:");
  const service = executionService(
    database,
    () => "2026-08-12T00:00:00.000Z",
    ids(),
  );
  await service.initialize({
    tenantId: "tenant-1",
    runId: "run-claim-replay",
    binding,
    workflow,
  });
  const input = {
    tenantId: "tenant-1",
    runId: "run-claim-replay",
    binding,
    workflow,
    leaseDurationMs: 1_000,
    operationId: "scheduler-pass-1",
  };
  const committed = await service.claimReady(input);
  const replayed = await service.claimReady(input);
  assert.deepEqual(replayed, committed);
  assert.equal(replayed[0]?.claimId, committed[0]?.claimId);
  database.close();
});

test("loads unknown claims after restart and rejects nonexact terminal settlement", async () => {
  const database = new DatabaseSync(":memory:");
  let now = "2026-08-12T00:00:00.000Z";
  const service = executionService(database, () => now, ids());
  await service.initialize({
    tenantId: "tenant-1",
    runId: "run-unknown",
    binding,
    workflow,
  });
  const [claim] = await service.claimReady({
    tenantId: "tenant-1",
    runId: "run-unknown",
    binding,
    workflow,
    leaseDurationMs: 1_000,
    operationId: "claim-unknown",
  });
  now = "2026-08-12T00:00:02.000Z";
  await service.claimReady({
    tenantId: "tenant-1",
    runId: "run-unknown",
    binding,
    workflow,
    leaseDurationMs: 1_000,
    operationId: "expire-unknown",
  });
  assert.deepEqual(
    await service.listUnknownClaims({
      tenantId: "tenant-1",
      runId: "run-unknown",
      binding,
      workflow,
    }),
    [claim],
  );
  await service.settleNode({
    tenantId: "tenant-1",
    runId: "run-unknown",
    binding,
    workflow,
    nodeId: claim!.node.nodeId,
    claimId: claim!.claimId,
    operationId: "reconcile-terminal",
    outcome: { status: "completed", resultDigest: completedDigest },
  });
  await assert.rejects(
    service.settleNode({
      tenantId: "tenant-1",
      runId: "run-unknown",
      binding,
      workflow,
      nodeId: claim!.node.nodeId,
      claimId: claim!.claimId,
      operationId: "different-terminal",
      outcome: { status: "failed", failureCode: "late_failure" },
    }),
    /workflow_node_terminal_settlement_conflict/u,
  );
  database.close();
});

test("active cancellation converges to canceled after a late completion", async () => {
  const database = new DatabaseSync(":memory:");
  const service = executionService(
    database,
    () => "2026-08-12T00:00:00.000Z",
    ids(),
  );
  await service.initialize({
    tenantId: "tenant-1",
    runId: "run-cancel",
    binding,
    workflow,
  });
  const [claim] = await service.claimReady({
    tenantId: "tenant-1",
    runId: "run-cancel",
    binding,
    workflow,
    leaseDurationMs: 1_000,
    operationId: "claim-cancel",
  });
  const canceling = await service.requestCancel({
    tenantId: "tenant-1",
    runId: "run-cancel",
    binding,
    workflow,
    operationId: "cancel-1",
  });
  assert.equal(canceling.status, "running");
  const terminal = await service.settleNode({
    tenantId: "tenant-1",
    runId: "run-cancel",
    binding,
    workflow,
    nodeId: claim!.node.nodeId,
    claimId: claim!.claimId,
    operationId: "late-completion",
    outcome: { status: "completed", resultDigest: completedDigest },
  });
  assert.equal(terminal.status, "canceled");
  assert.equal(terminal.cancelRequested, true);
  database.close();
});

test("fails closed on a registered SQLite authority with corrupt physical shape", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE workflow_execution_schema (
    singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL) STRICT;
    INSERT INTO workflow_execution_schema VALUES (1,1);
    CREATE TABLE workflow_executions (tenant_id TEXT) STRICT;
    CREATE TABLE workflow_execution_receipts (tenant_id TEXT) STRICT;`);
  assert.throws(
    () => new SqliteWorkflowExecutionStore(database),
    /workflow_execution_schema_corrupt/u,
  );
  database.close();
});

for (const legacyVersion of [1, 2, 3, 4] as const) {
  test(`migrates SQLite Workflow execution v${legacyVersion} to current in one call`, () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE run_snapshots (
      tenant_id TEXT NOT NULL, run_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id,run_id)) STRICT;
      CREATE TABLE run_steps (
      tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,step_id TEXT NOT NULL,
      PRIMARY KEY(tenant_id,run_id,step_id)) STRICT;
      CREATE TABLE workflow_execution_schema (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL) STRICT;
      INSERT INTO workflow_execution_schema VALUES(1,${legacyVersion});
      CREATE TABLE workflow_executions (
      tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(tenant_id,run_id)) STRICT;
      CREATE TABLE workflow_execution_receipts (
      tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,operation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,state_json TEXT NOT NULL${legacyVersion === 1 ? "" : ",result_json TEXT"},
      PRIMARY KEY(tenant_id,run_id,operation_id)) STRICT;`);
    if (legacyVersion >= 3) database.exec(`CREATE TABLE workflow_composition_receipts (
      tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,operation_id TEXT NOT NULL,
      kind TEXT NOT NULL,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,
      PRIMARY KEY(tenant_id,run_id,operation_id)) STRICT;
      CREATE TABLE workflow_gate_requests (
      tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,node_id TEXT NOT NULL,
      gate_request_id TEXT NOT NULL UNIQUE,claim_id TEXT NOT NULL,claim_epoch INTEGER NOT NULL,
      step_id TEXT NOT NULL,approval_policy_id TEXT NOT NULL,input_digest TEXT NOT NULL,
      publication_outbox_message_id TEXT NOT NULL UNIQUE,
      approval_resume_work_item_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,
      state_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,run_id,node_id)) STRICT;`);
    if (legacyVersion === 4) database.exec(`CREATE TABLE workflow_execution_values (
      tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,value_id TEXT NOT NULL,
      role TEXT NOT NULL,node_id TEXT,value_digest TEXT NOT NULL,value_json TEXT NOT NULL,
      created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,run_id,value_id)) STRICT;`);
    migrateSqliteWorkflowExecutions(database);
    assert.equal(database.prepare(
      "SELECT version FROM workflow_execution_schema WHERE singleton=1",
    ).get()?.version, 6);
    assert.deepEqual(database.prepare(
      `SELECT name FROM sqlite_master WHERE type='index'
       AND name LIKE 'workflow_execution_values_%_role_uq' ORDER BY name`,
    ).all().map((row) => ({ ...(row as { name: string }) })), [
      { name: "workflow_execution_values_global_role_uq" },
      { name: "workflow_execution_values_node_role_uq" },
    ]);
    database.close();
  });
}

test("serializes two SQLite clients to one stable scheduler claim", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-workflow-race-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "authority.sqlite");
  const firstDatabase = new DatabaseSync(path);
  const secondDatabase = new DatabaseSync(path);
  const first = executionService(
    firstDatabase,
    () => "2026-08-12T00:00:00.000Z",
    ids(),
  );
  const second = executionService(
    secondDatabase,
    () => "2026-08-12T00:00:00.000Z",
    ids(),
  );
  await first.initialize({
    tenantId: "tenant-1",
    runId: "run-race",
    binding,
    workflow,
  });
  const base = {
    tenantId: "tenant-1",
    runId: "run-race",
    binding,
    workflow,
    leaseDurationMs: 1_000,
  };
  const [left, right] = await Promise.all([
    first.claimReady({ ...base, operationId: "scheduler-left" }),
    second.claimReady({ ...base, operationId: "scheduler-right" }),
  ]);
  assert.equal(left.length + right.length, 1);
  assert.equal((left[0] ?? right[0])?.node.nodeId, "root");
  firstDatabase.close();
  secondDatabase.close();
});

test("replays cancellation by canonical authority and rejects operation reuse", async () => {
  const database = new DatabaseSync(":memory:");
  const service = executionService(
    database,
    () => "2026-08-12T00:00:00.000Z",
    ids(),
  );
  await service.initialize({
    tenantId: "tenant-1",
    runId: "run-cancel-replay",
    binding,
    workflow,
  });
  const input = {
    tenantId: "tenant-1",
    runId: "run-cancel-replay",
    binding,
    workflow,
    operationId: "cancel-replay-1",
  };
  const committed = await service.requestCancel(input);
  assert.deepEqual(await service.requestCancel(input), committed);
  await assert.rejects(
    service.requestCancel({
      ...input,
      binding: { ...binding, contentDigest: `sha256:${"2".repeat(64)}` },
    }),
    /workflow_execution_idempotency_conflict/u,
  );
  database.close();
});

function executionService(
  database: DatabaseSync,
  now: () => string,
  nextId: () => string,
) {
  return new WorkflowExecutionService({
    store: new SqliteWorkflowExecutionStore(database),
    now,
    nextId,
    sha256: (value) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  });
}

function ids(): () => string {
  let sequence = 0;
  return () => `id-${++sequence}`;
}

function projectClaim(
  claim: Awaited<ReturnType<WorkflowExecutionService["claimReady"]>>[number],
) {
  return {
    nodeId: claim.node.nodeId,
    kind: claim.node.kind,
    agentVersionId:
      claim.node.kind === "agent"
        ? claim.node.agentVersionId
        : claim.node.kind === "verification"
          ? claim.node.verifierAgentVersionId
          : null,
    claimEpoch: claim.claimEpoch,
  };
}

async function settleCompleted(
  service: WorkflowExecutionService,
  claim: Awaited<ReturnType<WorkflowExecutionService["claimReady"]>>[number],
  operationId: string,
) {
  return service.settleNode({
    tenantId: "tenant-1",
    runId: "run-1",
    binding,
    workflow,
    nodeId: claim.node.nodeId,
    claimId: claim.claimId,
    operationId,
    outcome: { status: "completed", resultDigest: completedDigest },
  });
}
