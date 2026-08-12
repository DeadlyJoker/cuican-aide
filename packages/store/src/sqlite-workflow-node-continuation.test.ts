import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  compileWorkflowVersion,
  dispatchToolExecutionReceipt,
  reduceRunLifecycleEvent,
  resolveToolExecutionReceipt,
  serializeCompiledWorkflowVersion,
  type RunState,
} from "@crewon/domain";

import { beginSqliteRunAttempt } from "./sqlite-execution-authority.ts";
import { insertSqliteToolExecutionReceipt } from "./sqlite-tool-execution-receipts.ts";
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
  const committed =
    await fixture.store.commitWorkflowAssistantContinuation(input);
  assert.equal(committed.revision, 1);
  assert.deepEqual(
    await fixture.store.loadWorkflowNodeContinuation(fixture.authority),
    committed,
  );
});

test("rejects stale continuation revisions without changing the checkpoint", async () => {
  const fixture = await admittedFixture();
  const input = continuationInput(fixture);
  const committed =
    await fixture.store.commitWorkflowAssistantContinuation(input);
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

test("fresh Tool continuation atomically commits all four durable authorities", async () => {
  const fixture = await toolFixture();
  const fresh = await fixture.store.commitWorkflowToolContinuation(
    fixture.input,
  );
  assert.deepEqual(fresh.receipt, fixture.input.receipt);
  assert.equal(fresh.continuation.revision, 1);
  assert.deepEqual(toolAtomicCounts(fixture.database), {
    completedAttempts: 1,
    completedReceipts: 1,
    completedEvents: 1,
    outbox: 1,
    continuations: 1,
  });
});

test("exact Tool continuation replay is deep-equal and creates no event or outbox", async () => {
  const fixture = await toolFixture();
  const fresh = await fixture.store.commitWorkflowToolContinuation(
    fixture.input,
  );
  const before = toolAtomicCounts(fixture.database);
  assert.deepEqual(
    await fixture.store.commitWorkflowToolContinuation(fixture.input),
    fresh,
  );
  assert.deepEqual(toolAtomicCounts(fixture.database), before);
});

test("exact replay fails closed when any committed Tool continuation component is tampered", async () => {
  for (const tamper of [
    "receipt",
    "attempt",
    "finishedAt",
    "event",
    "outbox",
    "continuation",
    "snapshot",
  ] as const) {
    const fixture = await toolFixture();
    await fixture.store.commitWorkflowToolContinuation(fixture.input);
    const sql = {
      receipt:
          `UPDATE tool_execution_receipts
           SET state_json=json_set(state_json,'$.result.output','forged')`,
      attempt: "UPDATE run_attempts SET lease_epoch=2 WHERE attempt_id='tool-attempt'",
      finishedAt:
          `UPDATE run_attempts
           SET updated_at='2026-08-12T00:00:03.000Z',
               terminal_at='2026-08-12T00:00:03.000Z',
               state_json=json_set(state_json,'$.updatedAt','2026-08-12T00:00:03.000Z',
                 '$.terminalAt','2026-08-12T00:00:03.000Z')
           WHERE attempt_id='tool-attempt'`,
      event:
          `UPDATE run_events SET event_json=json_set(event_json,'$.data.output','forged')
           WHERE json_extract(event_json,'$.type')='tool.completed'`,
      outbox:
          `UPDATE outbox SET message_json=json_set(message_json,'$.payload.eventType','forged')
           WHERE message_id LIKE 'wf-tool:tool-outbox:%'`,
      continuation:
          `UPDATE workflow_node_continuations
           SET checkpoint_json=json_set(checkpoint_json,'$.segmentId','forged')`,
      snapshot:
          `UPDATE run_snapshots SET last_sequence=last_sequence-1,
           state_json=json_set(state_json,'$.lastSequence',last_sequence-1)
           WHERE run_id='run-1'`,
    }[tamper];
    fixture.database.prepare(sql).run();
    await assert.rejects(
      fixture.store.commitWorkflowToolContinuation(fixture.input),
      /workflow_tool_continuation_corrupt/u,
      tamper,
    );
  }
});

test("invalid checkpoint and CAS conflict roll back every Tool continuation mutation", async () => {
  for (const failure of ["invalidCheckpoint", "cas"] as const) {
    const fixture = await toolFixture();
    const input =
      failure === "invalidCheckpoint"
        ? {
            ...fixture.input,
            next: { ...fixture.input.next, segmentId: "" },
          }
        : { ...fixture.input, expectedContinuationRevision: 7 };
    await assert.rejects(
      fixture.store.commitWorkflowToolContinuation(input),
      /workflow_node_continuation_(invalid|revision_conflict)/u,
    );
    assert.deepEqual(toolAtomicCounts(fixture.database), {
      completedAttempts: 0,
      completedReceipts: 0,
      completedEvents: 0,
      outbox: 0,
      continuations: 0,
    });
  }
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
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
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
  database
    .prepare(
      `INSERT INTO run_snapshots
     (tenant_id,space_id,run_id,revision,last_sequence,state_json,updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    )
    .run("tenant-1", "space-1", "run-1", 1, 1, JSON.stringify(run), now);
  database
    .prepare(
      `INSERT INTO work_items
     (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,
      available_at_ms,lease_owner_id,lease_id,lease_epoch,lease_expires_at_ms,
      attempt_count)
     VALUES ('scheduler','tenant-1','run-1','run.execute',?,?,'leased',0,
             'worker','scheduler-lease',1,?,1)`,
    )
    .run(
      JSON.stringify({
        workItemId: "scheduler",
        tenantId: "tenant-1",
        runId: "run-1",
        kind: "run.execute",
        payload: {},
        createdAt: now,
      }),
      now,
      nowMs + 60_000,
    );
  database
    .prepare(
      `INSERT INTO workflow_execution_values
     (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
     VALUES ('tenant-1','run-1','root','rootInput',NULL,?,?,?)`,
    )
    .run(digester.sha256("{}"), "{}", now);
  const scheduled = await store.scheduleWorkflowNodes({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: {
      workItemId: "scheduler",
      ownerId: "worker",
      leaseId: "scheduler-lease",
      leaseEpoch: 1,
    },
    binding,
    schedulerOperationId: "schedule-1",
    workflowInput: { valueId: "root", valueDigest: digester.sha256("{}") },
  });
  const work = scheduled.nodeWorkItems[0]!;
  database
    .prepare(
      `UPDATE work_items SET status='leased',lease_owner_id='worker',lease_id='node-lease',
     lease_epoch=1,lease_expires_at_ms=? WHERE work_item_id=?`,
    )
    .run(nowMs + 60_000, work.workItemId);
  const lease = {
    workItemId: work.workItemId,
    ownerId: "worker",
    leaseId: "node-lease",
    leaseEpoch: 1,
  };
  const admitted = await store.admitWorkflowNodeWork({
    tenantId: "tenant-1",
    runId: "run-1",
    lease,
    binding,
    nodeId: work.nodeId,
    claimId: work.claimId,
    claimEpoch: work.claimEpoch,
    schedulerOperationId: "schedule-1",
    admissionOperationId: "admit-1",
    attemptLeaseDurationMs: 30_000,
  });
  assert.equal(admitted.disposition, "fresh");
  const authority = {
    tenantId: "tenant-1",
    runId: "run-1",
    workItemId: work.workItemId,
    leaseEpoch: 1,
    nodeId: work.nodeId,
    nodeKind: "agent" as const,
    claimId: work.claimId,
    claimEpoch: work.claimEpoch,
    agentVersionId: "agent-v1",
    attempt: {
      stepId: admitted.admission.step.stepId,
      attemptId: admitted.admission.attempt.attemptId,
    },
  };
  return { database, store, lease, authority };
}

function continuationInput(
  fixture: Awaited<ReturnType<typeof admittedFixture>>,
) {
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
      history: [
        {
          type: "message" as const,
          role: "user" as const,
          content: "continue",
        },
      ],
    },
    committedAt: now,
    terminalResult: null,
  };
}

async function toolFixture() {
  const fixture = await admittedFixture();
  const segmentId = `segment:${fixture.authority.attempt.attemptId}`;
  fixture.database.exec("BEGIN IMMEDIATE");
  const toolAttempt = beginSqliteRunAttempt(fixture.database, {
    tenantId: "tenant-1",
    runId: "run-1",
    lease: fixture.lease,
    stepId: "tool-step",
    kind: "tool",
    attemptId: "tool-attempt",
    startedAt: now,
  });
  fixture.database.exec("COMMIT");
  const prepared = {
    schemaVersion: "crewon.tool-execution-receipt.v0" as const,
    receiptId: "tool-receipt", tenantId: "tenant-1", runId: "run-1",
    stepId: "tool-step", attemptId: "tool-attempt",
    workItemId: fixture.lease.workItemId,
    executionId: "tool-execution", idempotencyKey: "tool-idempotency",
    actionDigest: digester.sha256("action"), actionIntent: null,
    call: { segmentId, callId: "call-1", kind: "function" as const,
      name: "tool.read", inputDigest: digester.sha256("{}") },
    effect: "readOnly" as const, recovery: "replaySafe" as const,
    status: "prepared" as const, revision: 1, providerReceiptId: null,
    result: null, preparedAt: now, dispatchedAt: null, updatedAt: now,
    resolvedAt: null,
  };
  const dispatched = dispatchToolExecutionReceipt(
    prepared,
    "2026-08-12T00:00:01.000Z",
  );
  insertSqliteToolExecutionReceipt(fixture.database, dispatched);
  const currentRow = fixture.database
    .prepare("SELECT state_json FROM run_snapshots WHERE run_id='run-1'")
    .get() as { state_json: string };
  const current = JSON.parse(currentRow.state_json) as RunState;
  const requested = {
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId: "run-1" }, eventId: "tool-requested-event",
    sequence: current.lastSequence + 1,
    occurredAt: "2026-08-12T00:00:01.000Z",
    type: "tool.requested" as const,
    data: { segmentId, segmentSequence: 1, callId: "call-1",
      kind: "function" as const, name: "tool.read", input: "{}" },
  };
  const requestedRun = reduceRunLifecycleEvent(current, requested);
  fixture.database
    .prepare(
      `UPDATE run_snapshots SET revision=?,last_sequence=?,state_json=?,updated_at=?
       WHERE run_id='run-1'`,
    )
    .run(
      requestedRun.revision,
      requestedRun.lastSequence,
      JSON.stringify(requestedRun),
      requested.occurredAt,
    );
  fixture.database
    .prepare(
      `INSERT INTO run_events(tenant_id,run_id,sequence,event_id,event_json)
       VALUES ('tenant-1','run-1',?,?,?)`,
    )
    .run(requested.sequence, requested.eventId, JSON.stringify(requested));
  const result = {
    output: "tool-output", outputDigest: digester.sha256("tool-output"),
    isError: false, artifactRef: null,
  };
  const receipt = resolveToolExecutionReceipt(dispatched, {
    status: "completed",
    resolvedAt: "2026-08-12T00:00:02.000Z",
    providerReceiptId: "provider-receipt",
    result,
  });
  const input = {
    lease: fixture.lease,
    authority: fixture.authority,
    receipt,
    toolAttempt: { stepId: toolAttempt.attempt.stepId,
      attemptId: toolAttempt.attempt.attemptId },
    completedEvent: {
      schemaVersion: "crewon.agent-event.v0" as const,
      runId: "run-1", segmentId, sequence: 2,
      type: "tool.completed" as const,
      data: { callId: "call-1", kind: "function" as const, name: "tool.read",
        output: result.output, isError: result.isError,
        artifactRef: result.artifactRef, outputTruncated: false },
    },
    providerReceiptId: "provider-receipt",
    expectedContinuationRevision: null,
    next: {
      ...continuationInput(fixture).next,
      history: [
        { type: "tool_call" as const, kind: "function" as const,
          callId: "call-1", name: "tool.read", input: "{}" },
        { type: "tool_result" as const, kind: "function" as const,
          callId: "call-1", output: result.output },
      ],
    },
    committedAt: "2026-08-12T00:00:02.000Z",
  };
  return { ...fixture, input };
}

function toolAtomicCounts(database: DatabaseSync) {
  const count = (sql: string) => database.prepare(sql).get()!.count as number;
  return {
    completedAttempts: count(
      "SELECT count(*) AS count FROM run_attempts WHERE attempt_id='tool-attempt' AND status='completed'",
    ),
    completedReceipts: count(
      "SELECT count(*) AS count FROM tool_execution_receipts WHERE receipt_id='tool-receipt' AND status='completed'",
    ),
    completedEvents: count(
      "SELECT count(*) AS count FROM run_events WHERE json_extract(event_json,'$.type')='tool.completed'",
    ),
    outbox: count(
      "SELECT count(*) AS count FROM outbox WHERE message_id LIKE 'wf-tool:tool-outbox:%'",
    ),
    continuations: count(
      "SELECT count(*) AS count FROM workflow_node_continuations",
    ),
  };
}
