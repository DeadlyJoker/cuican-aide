import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  compileWorkflowVersion,
  replayRunLifecycle,
  serializeCompiledWorkflowVersion,
  type RunLifecycleEvent,
} from "@crewon/domain";

import { SqliteWorkflowRunCompositionStore } from "./sqlite-workflow-run-composition-store.ts";
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
