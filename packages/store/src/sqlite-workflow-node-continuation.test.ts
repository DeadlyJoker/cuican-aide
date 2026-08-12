import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  compileWorkflowVersion,
  serializeCompiledWorkflowVersion,
  type RunState,
} from "@crewon/domain";

import { SqliteWorkflowRunCompositionStore } from "./sqlite-workflow-run-composition-store.ts";
import { SqliteWorkflowVersionStore } from "./workflow-version-store.ts";

const nowMs = Date.parse("2026-08-12T00:00:00.000Z");
const now = new Date(nowMs).toISOString();
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const schema = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const workflow = compileWorkflowVersion(
  {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    name: "continuation",
    description: "continuation",
    inputSchema: schema,
    outputSchema: schema,
    entryNodeIds: ["agent"],
    outputNodeIds: ["verify"],
    nodes: [
      {
        nodeId: "agent",
        title: "agent",
        instruction: "agent",
        dependsOn: [],
        inputSchema: schema,
        outputSchema: schema,
        kind: "agent",
        agentVersionId: "agent-v1",
      },
      {
        nodeId: "verify",
        title: "verify",
        instruction: "verify",
        dependsOn: ["agent"],
        inputSchema: schema,
        outputSchema: schema,
        kind: "verification",
        verifierAgentVersionId: "verifier-v1",
      },
    ],
  },
  digester,
);
const binding = {
  workflowId: workflow.workflowId,
  workflowVersionId: workflow.workflowVersionId,
  contentDigest: workflow.contentDigest,
};

test("commits and loads an assistant continuation under exact node authority", async () => {
  const fixture = await admittedFixture();
  const input = continuationInput(fixture);
  const committed = await fixture.store.commitWorkflowAssistantContinuation(input);
  assert.equal(committed.revision, 1);
  assert.deepEqual(
    await fixture.store.loadWorkflowNodeContinuation(fixture.authority),
    committed,
  );
});

test("rejects stale continuation revisions without changing the checkpoint", async () => {
  const fixture = await admittedFixture();
  const input = continuationInput(fixture);
  const committed = await fixture.store.commitWorkflowAssistantContinuation(input);
  await assert.rejects(
    fixture.store.commitWorkflowAssistantContinuation(input),
    /workflow_node_continuation_revision_conflict/u,
  );
  assert.deepEqual(
    await fixture.store.loadWorkflowNodeContinuation(fixture.authority),
    committed,
  );
});

test("fails closed on corrupt persisted continuation JSON", async () => {
  const fixture = await admittedFixture();
  await fixture.store.commitWorkflowAssistantContinuation(
    continuationInput(fixture),
  );
  fixture.database
    .prepare(
      `UPDATE workflow_node_continuations SET checkpoint_json='{}'
       WHERE tenant_id='tenant-1' AND run_id='run-1'`,
    )
    .run();
  await assert.rejects(
    fixture.store.loadWorkflowNodeContinuation(fixture.authority),
    /workflow_node_continuation_corrupt/u,
  );
});

test("rejects stale leases and forged node authority before writing", async () => {
  const fixture = await admittedFixture();
  const input = continuationInput(fixture);
  await assert.rejects(
    fixture.store.commitWorkflowAssistantContinuation({
      ...input,
      lease: { ...input.lease, leaseId: "forged" },
    }),
    /stale_lease/u,
  );
  await assert.rejects(
    fixture.store.commitWorkflowAssistantContinuation({
      ...input,
      authority: { ...input.authority, agentVersionId: "forged" },
      next: {
        ...input.next,
        authority: { ...input.authority, agentVersionId: "forged" },
      },
    }),
    /workflow_node_continuation_authority_mismatch/u,
  );
  assert.equal(
    fixture.database
      .prepare("SELECT count(*) AS count FROM workflow_node_continuations")
      .get()?.count,
    0,
  );
});

test("rejects a leased sibling WorkItem and forged durable continuation state", async () => {
  const fixture = await admittedFixture();
  const input = continuationInput(fixture);
  fixture.database
    .prepare(
      `INSERT INTO work_items
       (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,
        available_at_ms,lease_owner_id,lease_id,lease_epoch,lease_expires_at_ms,
        attempt_count)
       VALUES ('sibling','tenant-1','run-1','run.execute',?,?,'leased',0,
               'worker','sibling-lease',1,?,1)`,
    )
    .run(
      JSON.stringify({
        workItemId: "sibling",
        tenantId: "tenant-1",
        runId: "run-1",
        kind: "run.execute",
        payload: {},
        createdAt: now,
      }),
      now,
      nowMs + 60_000,
    );
  await assert.rejects(
    fixture.store.commitWorkflowAssistantContinuation({
      ...input,
      lease: {
        workItemId: "sibling",
        ownerId: "worker",
        leaseId: "sibling-lease",
        leaseEpoch: 1,
      },
    }),
    /workflow_node_continuation_authority_mismatch/u,
  );
  await assert.rejects(
    fixture.store.commitWorkflowAssistantContinuation({
      ...input,
      next: { ...input.next, providerTurnState: "forged" },
    }),
    /workflow_node_continuation_authority_mismatch/u,
  );
  await assert.rejects(
    fixture.store.commitWorkflowAssistantContinuation({
      ...input,
      next: {
        ...input.next,
        activeDispatch: {
          operationId: "missing",
          requestSequence: 1,
          expectedRevision: 1,
          status: "prepared",
        },
      },
    }),
    /workflow_node_continuation_authority_mismatch/u,
  );
  assert.equal(
    fixture.database
      .prepare("SELECT count(*) AS count FROM workflow_node_continuations")
      .get()?.count,
    0,
  );
});

test("fails closed when a persisted continuation outlives its running Attempt", async () => {
  const fixture = await admittedFixture();
  await fixture.store.commitWorkflowAssistantContinuation(
    continuationInput(fixture),
  );
  const state = fixture.database
    .prepare("SELECT state_json FROM run_attempts WHERE attempt_id=?")
    .get(fixture.authority.attempt.attemptId) as { state_json: string };
  fixture.database
    .prepare(
      `UPDATE run_attempts SET status='completed',state_json=?
       WHERE attempt_id=?`,
    )
    .run(
      JSON.stringify({
        ...JSON.parse(state.state_json),
        status: "completed",
        finishedAt: now,
      }),
      fixture.authority.attempt.attemptId,
    );
  await assert.rejects(
    fixture.store.loadWorkflowNodeContinuation(fixture.authority),
    /workflow_node_continuation_corrupt/u,
  );
});

async function admittedFixture() {
  const database = new DatabaseSync(":memory:");
  const clock = { nowEpochMilliseconds: () => nowMs };
  const store = new SqliteWorkflowRunCompositionStore(database, {
    digester,
    clock,
  });
  const versions = new SqliteWorkflowVersionStore(database, digester);
  await versions.registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0",
    tenantId: "tenant-1",
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: now,
  });
  const run: RunState = {
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
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 },
    status: "running",
    revision: 1,
    lastSequence: 1,
    cancelRequested: false,
    waitingApproval: null,
    suspensionReasonCode: null,
    reconciliationReceiptId: null,
    outputRef: null,
    failure: null,
    createdAt: now,
    updatedAt: now,
    terminalAt: null,
  };
  database.prepare(
    `INSERT INTO run_snapshots
     (tenant_id,space_id,run_id,revision,last_sequence,state_json,updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run("tenant-1", "space-1", "run-1", 1, 1, JSON.stringify(run), now);
  database.prepare(
    `INSERT INTO work_items
     (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,
      available_at_ms,lease_owner_id,lease_id,lease_epoch,lease_expires_at_ms,
      attempt_count)
     VALUES ('scheduler','tenant-1','run-1','run.execute',?,?,'leased',0,
             'worker','scheduler-lease',1,?,1)`,
  ).run(JSON.stringify({ workItemId: "scheduler", tenantId: "tenant-1",
    runId: "run-1", kind: "run.execute", payload: {}, createdAt: now }), now,
    nowMs + 60_000);
  database.prepare(
    `INSERT INTO workflow_execution_values
     (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
     VALUES ('tenant-1','run-1','root','rootInput',NULL,?,?,?)`,
  ).run(digester.sha256("{}"), "{}", now);
  const scheduled = await store.scheduleWorkflowNodes({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: { workItemId: "scheduler", ownerId: "worker",
      leaseId: "scheduler-lease", leaseEpoch: 1 },
    binding,
    schedulerOperationId: "schedule-1",
    workflowInput: { valueId: "root", valueDigest: digester.sha256("{}") },
  });
  const work = scheduled.nodeWorkItems[0]!;
  database.prepare(
    `UPDATE work_items SET status='leased',lease_owner_id='worker',lease_id='node-lease',
     lease_epoch=1,lease_expires_at_ms=? WHERE work_item_id=?`,
  ).run(nowMs + 60_000, work.workItemId);
  const lease = { workItemId: work.workItemId, ownerId: "worker",
    leaseId: "node-lease", leaseEpoch: 1 };
  const admitted = await store.admitWorkflowNodeWork({
    tenantId: "tenant-1", runId: "run-1", lease, binding,
    nodeId: work.nodeId, claimId: work.claimId, claimEpoch: work.claimEpoch,
    schedulerOperationId: "schedule-1", admissionOperationId: "admit-1",
    attemptLeaseDurationMs: 30_000,
  });
  assert.equal(admitted.disposition, "fresh");
  const authority = {
    tenantId: "tenant-1", runId: "run-1", workItemId: work.workItemId,
    leaseEpoch: 1, nodeId: work.nodeId, nodeKind: "agent" as const,
    claimId: work.claimId, claimEpoch: work.claimEpoch,
    agentVersionId: "agent-v1", attempt: {
      stepId: admitted.admission.step.stepId,
      attemptId: admitted.admission.attempt.attemptId,
    },
  };
  return { database, store, lease, authority };
}

function continuationInput(fixture: Awaited<ReturnType<typeof admittedFixture>>) {
  return {
    lease: fixture.lease,
    authority: fixture.authority,
    expectedContinuationRevision: null,
    next: {
      schemaVersion: "crewon.workflow-node-continuation.v0" as const,
      authority: fixture.authority,
      segmentId: `segment:${fixture.authority.attempt.attemptId}`,
      modelSampleIndex: 0,
      toolRoundsConsumed: 0,
      providerCheckpoint: null,
      providerTurnState: null,
      activeDispatch: null,
      history: [{ type: "message" as const, role: "user" as const,
        content: "continue" }],
    },
    committedAt: now,
  };
}
