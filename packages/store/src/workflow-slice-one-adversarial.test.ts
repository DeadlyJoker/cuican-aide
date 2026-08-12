import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compileWorkflowVersion,
  createWorkflowNodeTerminalEvidence,
  replayRunLifecycle,
  serializeCompiledWorkflowVersion,
  type RunLifecycleEvent,
} from "@crewon/domain";

import { SqliteWorkflowRunCompositionStore } from "./sqlite-workflow-run-composition-store.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { SqliteWorkflowVersionStore } from "./workflow-version-store.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const emptyObjectSchema = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const workflow = compileWorkflowVersion(
  {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "slice-one-workflow",
    workflowVersionId: "slice-one-v1",
    name: "slice one",
    description: "Agent then Verification",
    inputSchema: emptyObjectSchema,
    outputSchema: emptyObjectSchema,
    entryNodeIds: ["agent"],
    outputNodeIds: ["verification"],
    nodes: [
      {
        nodeId: "agent",
        title: "agent",
        instruction: "agent",
        dependsOn: [],
        inputSchema: emptyObjectSchema,
        outputSchema: emptyObjectSchema,
        kind: "agent",
        agentVersionId: "agent-v1",
      },
      {
        nodeId: "verification",
        title: "verification",
        instruction: "verification",
        dependsOn: ["agent"],
        inputSchema: emptyObjectSchema,
        outputSchema: emptyObjectSchema,
        kind: "verification",
        verifierAgentVersionId: "verification-v1",
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

test("SQLite Slice 1 converges Agent to Verification without replay authority or stranded attempts", async () => {
  const database = new DatabaseSync(":memory:");
  const nowMs = Date.parse("2026-08-12T00:00:10.000Z");
  const store = new SqliteWorkflowRunCompositionStore(database, {
    digester,
    clock: { nowEpochMilliseconds: () => nowMs },
  });
  await seed(database, nowMs + 60_000);

  const firstScheduleInput = schedulerInput(
    "scheduler-initial",
    "scheduler-work",
  );
  const firstSchedule = await store.scheduleWorkflowNodes(firstScheduleInput);
  assert.deepEqual(
    firstSchedule.nodeWorkItems.map(({ nodeId }) => nodeId),
    ["agent"],
  );
  assert.deepEqual(firstSchedule.gatePublications, []);
  assert.deepEqual(firstSchedule.reconciliationClaims, []);
  assert.equal(count(database, "run_attempts"), 0);
  assert.deepEqual(await store.scheduleWorkflowNodes(firstScheduleInput), {
    ...firstSchedule,
    disposition: "replay",
    nodeWorkItems: [],
    gatePublications: [],
    reconciliationClaims: [],
  });

  const agent = firstSchedule.nodeWorkItems[0]!;
  const agentLease = lease(database, agent.workItemId, "agent-worker", nowMs);
  const agentAdmissionInput = admissionInput(
    agent,
    agentLease,
    "scheduler-initial",
    "admit-agent",
  );
  const admittedAgent = await store.admitWorkflowNodeWork(agentAdmissionInput);
  assert.equal(admittedAgent.disposition, "fresh");
  assert.ok(admittedAgent.admission);
  assert.deepEqual(await store.admitWorkflowNodeWork(agentAdmissionInput), {
    ...admittedAgent,
    disposition: "replay",
    admission: null,
  });

  const agentSettlement = await store.settleWorkflowNode({
    ...nodeIdentity(agent, agentLease, admittedAgent.admission!),
    operationId: "settle-agent",
    outcome: { status: "completed", value: {} },
  });
  assert.equal(agentSettlement.disposition, "settled");
  assert.equal(agentSettlement.runDisposition, "nonTerminal");
  assert.equal(agentSettlement.handoff.kind, "scheduler");
  assert.equal(
    agentSettlement.handoff.nextWorkItemId,
    agentSettlement.schedulerContinuationWorkItemId,
  );
  assert.ok(agentSettlement.schedulerContinuationWorkItemId);
  assert.deepEqual(
    database
      .prepare(
        `SELECT work_item_id FROM work_items
         WHERE json_extract(work_item_json,'$.payload.trigger')='workflowScheduler'
           AND status='pending'`,
      )
      .all()
      .map((row) => ({ work_item_id: row.work_item_id })),
    [{ work_item_id: agentSettlement.schedulerContinuationWorkItemId }],
  );

  const continuationId = agentSettlement.schedulerContinuationWorkItemId!;
  const continuationLease = lease(
    database,
    continuationId,
    "scheduler-worker",
    nowMs,
  );
  const secondScheduleInput = schedulerInput(
    continuationId,
    continuationId,
    continuationLease,
  );
  const secondSchedule = await store.scheduleWorkflowNodes(secondScheduleInput);
  assert.deepEqual(
    secondSchedule.nodeWorkItems.map(({ nodeId }) => nodeId),
    ["verification"],
  );
  assert.equal(count(database, "run_attempts"), 1);

  const verification = secondSchedule.nodeWorkItems[0]!;
  const verificationLease = lease(
    database,
    verification.workItemId,
    "verification-worker",
    nowMs,
  );
  const verificationAdmissionInput = admissionInput(
    verification,
    verificationLease,
    continuationId,
    "admit-verification",
  );
  const admittedVerification = await store.admitWorkflowNodeWork(
    verificationAdmissionInput,
  );
  assert.equal(admittedVerification.disposition, "fresh");
  assert.ok(admittedVerification.admission);
  const terminal = await store.settleWorkflowNode({
    ...nodeIdentity(
      verification,
      verificationLease,
      admittedVerification.admission!,
    ),
    operationId: "settle-verification",
    outcome: { status: "completed", value: {} },
  });
  assert.equal(terminal.runDisposition, "terminalConverged");
  assert.equal(terminal.execution.status, "completed");
  assert.equal(terminal.schedulerContinuationWorkItemId, null);

  const attempts = database
    .prepare("SELECT step_id,status FROM run_attempts ORDER BY step_id")
    .all()
    .map((row) => ({ step_id: row.step_id, status: row.status }));
  const steps = database
    .prepare("SELECT step_id,status FROM run_steps ORDER BY step_id")
    .all()
    .map((row) => ({ step_id: row.step_id, status: row.status }));
  const run = JSON.parse(
    database
      .prepare("SELECT state_json FROM run_snapshots WHERE run_id='run-1'")
      .get()!.state_json as string,
  );
  const events = database
    .prepare(
      "SELECT event_json FROM run_events WHERE run_id='run-1' ORDER BY sequence",
    )
    .all()
    .map((row) => JSON.parse(row.event_json as string)) as RunLifecycleEvent[];
  assert.deepEqual(attempts, [
    { step_id: "agent", status: "completed" },
    { step_id: "verification", status: "completed" },
  ]);
  assert.deepEqual(steps, [
    { step_id: "agent", status: "completed" },
    { step_id: "verification", status: "completed" },
  ]);
  assert.deepEqual(run, replayRunLifecycle(events));
  assert.equal(run.status, terminal.execution.status);
  assert.deepEqual(
    terminal.execution.nodes.map(({ nodeId, status }) => ({ nodeId, status })),
    [
      { nodeId: "agent", status: "completed" },
      { nodeId: "verification", status: "completed" },
    ],
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM run_attempts WHERE status='running'",
      )
      .get()!.count,
    0,
  );
  assert.equal(events.at(-1)?.type, "run.completed");
  assert.equal(
    database
      .prepare(
        `SELECT count(*) AS count FROM outbox
         WHERE topic='run.updated'
           AND json_extract(message_json,'$.payload.eventType')='run.completed'`,
      )
      .get()!.count,
    1,
  );
  assert.deepEqual(
    await store.settleWorkflowNode({
      ...nodeIdentity(
        verification,
        verificationLease,
        admittedVerification.admission!,
      ),
      operationId: "settle-verification",
      outcome: { status: "completed", value: {} },
    }),
    { ...terminal, disposition: "replay" },
  );
});

test("D1 public SQLite runtime atomically settles model terminal evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-d1-model-terminal-"));
  const path = join(directory, "runtime.sqlite");
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const nowMs = Date.parse("2026-08-12T00:00:10.000Z");
  const fixtureDatabase = new DatabaseSync(path);
  const fixtureStore = new SqliteWorkflowRunCompositionStore(fixtureDatabase, {
    digester,
    clock: { nowEpochMilliseconds: () => nowMs },
  });
  await seed(fixtureDatabase, nowMs + 60_000);
  await fixtureStore.close();
  fixtureDatabase.close();

  const store = new SqliteRunStore(path, {
    workflowDigester: digester,
    clock: { nowEpochMilliseconds: () => nowMs },
  });
  t.after(async () => store.close());
  const scheduled = await store.scheduleWorkflowNodes(
    schedulerInput("scheduler-initial", "scheduler-work"),
  );
  const agent = scheduled.nodeWorkItems[0]!;
  const agentLease = leasePath(path, agent.workItemId, "agent-worker", nowMs);
  const admitted = await store.admitWorkflowNodeWork(
    admissionInput(agent, agentLease, "scheduler-initial", "admit-agent"),
  );
  assert.equal(admitted.disposition, "fresh");
  const authority = {
    tenantId: "tenant-1",
    runId: "run-1",
    workItemId: agent.workItemId,
    leaseEpoch: agent.claimEpoch,
    nodeId: agent.nodeId,
    nodeKind: "agent" as const,
    claimId: agent.claimId,
    claimEpoch: agent.claimEpoch,
    agentVersionId: "agent-v1",
    attempt: {
      stepId: admitted.admission!.step.stepId,
      attemptId: admitted.admission!.attempt.attemptId,
    },
  };
  const prepared = await store.prepareModelDispatch({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: agentLease,
    attempt: authority.attempt,
    operationId: "dispatch-agent",
    requestSequence: 1,
    operation: "dispatch",
    requestDigest: digester.sha256("agent-request"),
    provider: {
      agentVersionId: "agent-v1",
      adapterName: "responses",
      adapterVersion: "1",
      modelId: "model-1",
    },
    preparedAt: "2026-08-12T00:00:01.000Z",
  });
  const sent = await store.markModelDispatchPossiblySent({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: agentLease,
    attempt: authority.attempt,
    operationId: prepared.operationId,
    requestSequence: prepared.requestSequence,
    expectedRevision: prepared.revision,
    transitionedAt: "2026-08-12T00:00:02.000Z",
  });
  const observed = await store.observeModelDispatchResponse({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: agentLease,
    attempt: authority.attempt,
    operationId: sent.operationId,
    requestSequence: sent.requestSequence,
    expectedRevision: sent.revision,
    checkpointDigest: digester.sha256("agent-checkpoint"),
    transitionedAt: "2026-08-12T00:00:03.000Z",
  });
  const settlement = {
    binding,
    nodeId: agent.nodeId,
    operationId: "model-terminal-agent",
    evidence: createWorkflowNodeTerminalEvidence({
      workflow,
      nodeId: agent.nodeId,
      outcome: { status: "completed" as const, value: {} },
      digester,
    }),
    lease: agentLease,
    authority,
    dispatch: {
      operationId: observed.operationId,
      requestSequence: observed.requestSequence,
      expectedRevision: observed.revision,
      status: "responseObserved" as const,
    },
    dispatchTerminalOutcome: {
      kind: "completed" as const,
      code: null,
      certainty: "responseObserved" as const,
    },
  };

  const fresh = await store.settleWorkflowNodeModelTerminal(settlement);
  assert.equal(fresh.disposition, "settled");
  assert.equal(fresh.runDisposition, "nonTerminal");
  assert.equal(fresh.continuation, null);
  assert.equal(fresh.handoff.kind, "scheduler");
  const afterFresh = inspectD1(path, "agent", agent.workItemId);
  assert.deepEqual(afterFresh.terminalAuthorities, {
    dispatch: "terminal",
    attempt: "completed",
    step: "completed",
    dag: "completed",
    workItem: "completed",
  });
  assert.equal(afterFresh.continuationCount, 0);
  assert.equal(afterFresh.schedulerCount, 1);

  assert.deepEqual(await store.settleWorkflowNodeModelTerminal(settlement), {
    ...fresh,
    disposition: "replay",
  });
  assert.deepEqual(inspectD1(path, "agent", agent.workItemId), afterFresh);
  await assert.rejects(
    store.settleWorkflowNodeModelTerminal({
      ...settlement,
      dispatchTerminalOutcome: {
        ...settlement.dispatchTerminalOutcome,
        code: "drift",
      },
    }),
    /idempotency_conflict/u,
  );

  const schedulerId = fresh.handoff.nextWorkItemId!;
  const schedulerLease = leasePath(path, schedulerId, "scheduler-worker", nowMs);
  const verificationSchedule = await store.scheduleWorkflowNodes(
    schedulerInput(schedulerId, schedulerId, schedulerLease),
  );
  assert.deepEqual(
    verificationSchedule.nodeWorkItems.map(({ nodeId }) => nodeId),
    ["verification"],
  );
});

function inspectD1(path: string, nodeId: string, workItemId: string) {
  const database = new DatabaseSync(path);
  try {
    const dispatch = database
      .prepare("SELECT status FROM model_dispatch_receipts WHERE step_id=?")
      .get(nodeId)?.status;
    const attempt = database
      .prepare("SELECT status FROM run_attempts WHERE step_id=?")
      .get(nodeId)?.status;
    const step = database
      .prepare("SELECT status FROM run_steps WHERE step_id=?")
      .get(nodeId)?.status;
    const execution = JSON.parse(
      database.prepare("SELECT state_json FROM workflow_executions").get()!
        .state_json as string,
    );
    const workItem = database
      .prepare("SELECT status FROM work_items WHERE work_item_id=?")
      .get(workItemId)?.status;
    return {
      terminalAuthorities: {
        dispatch,
        attempt,
        step,
        dag: execution.nodes.find(
          (node: { nodeId: string }) => node.nodeId === nodeId,
        )?.status,
        workItem,
      },
      continuationCount: database
        .prepare("SELECT count(*) AS count FROM workflow_node_continuations")
        .get()!.count,
      schedulerCount: database
        .prepare(
          `SELECT count(*) AS count FROM work_items
           WHERE json_extract(work_item_json,'$.payload.trigger')='workflowScheduler'
             AND status='pending'`,
        )
        .get()!.count,
      receiptCount: database
        .prepare(
          "SELECT count(*) AS count FROM workflow_composition_receipts WHERE operation_id='model-terminal-agent'",
        )
        .get()!.count,
      run: database.prepare("SELECT state_json FROM run_snapshots").get()!
        .state_json,
      events: database.prepare("SELECT event_json FROM run_events ORDER BY sequence").all(),
      outbox: database.prepare("SELECT message_json FROM outbox ORDER BY message_id").all(),
    };
  } finally {
    database.close();
  }
}

function leasePath(path: string, workItemId: string, ownerId: string, nowMs: number) {
  const database = new DatabaseSync(path);
  try {
    return lease(database, workItemId, ownerId, nowMs);
  } finally {
    database.close();
  }
}

function schedulerInput(
  schedulerOperationId: string,
  workItemId: string,
  schedulerLease = {
    workItemId,
    ownerId: "scheduler-worker",
    leaseId: `lease:${workItemId}`,
    leaseEpoch: 1,
  },
) {
  return {
    tenantId: "tenant-1",
    runId: "run-1",
    lease: schedulerLease,
    binding,
    schedulerOperationId,
    workflowInput: {
      valueId: "root-value",
      valueDigest: digester.sha256("{}"),
    },
  } as const;
}

function admissionInput(
  authority: Readonly<{
    nodeId: string;
    claimId: string;
    claimEpoch: number;
  }>,
  nodeLease: ReturnType<typeof lease>,
  schedulerOperationId: string,
  admissionOperationId: string,
) {
  return {
    tenantId: "tenant-1",
    runId: "run-1",
    lease: nodeLease,
    binding,
    ...authority,
    schedulerOperationId,
    admissionOperationId,
    attemptLeaseDurationMs: 30_000,
  } as const;
}

function nodeIdentity(
  authority: Readonly<{ nodeId: string; claimId: string; claimEpoch: number }>,
  nodeLease: ReturnType<typeof lease>,
  admission: Readonly<{
    step: Readonly<{ stepId: string }>;
    attempt: Readonly<{ attemptId: string }>;
  }>,
) {
  return {
    tenantId: "tenant-1",
    runId: "run-1",
    lease: nodeLease,
    binding,
    ...authority,
    stepId: admission.step.stepId,
    attemptId: admission.attempt.attemptId,
  } as const;
}

function lease(
  database: DatabaseSync,
  workItemId: string,
  ownerId: string,
  nowMs: number,
) {
  const nodeLease = {
    workItemId,
    ownerId,
    leaseId: `lease:${workItemId}`,
    leaseEpoch: 1,
  } as const;
  database
    .prepare(
      `UPDATE work_items SET status='leased',lease_owner_id=?,lease_id=?,
       lease_epoch=?,lease_expires_at_ms=? WHERE work_item_id=?`,
    )
    .run(
      ownerId,
      nodeLease.leaseId,
      nodeLease.leaseEpoch,
      nowMs + 60_000,
      workItemId,
    );
  return nodeLease;
}

function count(database: DatabaseSync, table: "run_attempts"): number {
  return database.prepare(`SELECT count(*) AS count FROM ${table}`).get()!
    .count as number;
}

async function seed(database: DatabaseSync, schedulerLeaseExpiresAtMs: number) {
  const versionStore = new SqliteWorkflowVersionStore(database, digester);
  await versionStore.registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0",
    tenantId: "tenant-1",
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: "2026-08-12T00:00:00.000Z",
  });
  const events: RunLifecycleEvent[] = [
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "run-created",
      sequence: 1,
      occurredAt: "2026-08-12T00:00:00.000Z",
      type: "run.created",
      data: {
        threadId: "thread-1",
        tenantId: "tenant-1",
        spaceId: "space-1",
        createdByActorId: "actor-1",
        authorityId: "authority-1",
        runtimeGeneration: "ts-v0",
        agentVersionId: "orchestrator-v1",
        policySnapshotId: "policy-1",
        workspaceBindingId: null,
        workflowVersionBinding: binding,
        collaborationMode: "default",
        goalBinding: null,
        purpose: "workflow",
        origin: null,
      },
    },
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "run-started",
      sequence: 2,
      occurredAt: "2026-08-12T00:00:01.000Z",
      type: "run.started",
      data: {},
    },
  ];
  const run = replayRunLifecycle(events);
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
      run.revision,
      run.lastSequence,
      JSON.stringify(run),
      run.updatedAt,
    );
  const insertEvent = database.prepare(
    `INSERT INTO run_events(tenant_id,run_id,sequence,event_id,event_json)
     VALUES ('tenant-1','run-1',?,?,?)`,
  );
  for (const event of events)
    insertEvent.run(event.sequence, event.eventId, JSON.stringify(event));
  database
    .prepare(
      `INSERT INTO work_items
       (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,
        available_at_ms,lease_owner_id,lease_id,lease_epoch,lease_expires_at_ms,attempt_count)
       VALUES ('scheduler-work','tenant-1','run-1','run.execute',?,?,'leased',0,
        'scheduler-worker','lease:scheduler-work',1,?,1)`,
    )
    .run(
      JSON.stringify({
        workItemId: "scheduler-work",
        tenantId: "tenant-1",
        runId: "run-1",
        kind: "run.execute",
        createdAt: run.createdAt,
        payload: {
          schemaVersion: "crewon.workflow-scheduler-work-item.v1",
          trigger: "workflowScheduler",
          binding,
          schedulerOperationId: "scheduler-initial",
          workflowInput: {
            valueId: "root-value",
            valueDigest: digester.sha256("{}"),
          },
        },
      }),
      run.createdAt,
      schedulerLeaseExpiresAtMs,
    );
  database
    .prepare(
      `INSERT INTO workflow_execution_values
       (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
       VALUES ('tenant-1','run-1','root-value','rootInput',NULL,?,?,?)`,
    )
    .run(digester.sha256("{}"), "{}", run.createdAt);
}
