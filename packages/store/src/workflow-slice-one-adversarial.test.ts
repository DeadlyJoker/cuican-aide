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

  mutateDatabase(
    path,
    `CREATE TRIGGER d1_after_dispatch_transition
     BEFORE UPDATE ON run_attempts WHEN OLD.status='running'
     BEGIN SELECT RAISE(ABORT,'d1_after_dispatch_transition'); END`,
  );
  const beforeInjectedFailure = inspectD1(path, "agent", agent.workItemId);
  await assert.rejects(
    store.settleWorkflowNodeModelTerminal({
      ...settlement,
      operationId: "model-terminal-agent-injected-failure",
    }),
    /d1_after_dispatch_transition/u,
  );
  assert.deepEqual(
    inspectD1(path, "agent", agent.workItemId),
    beforeInjectedFailure,
  );
  assert.deepEqual(beforeInjectedFailure.terminalAuthorities, {
    dispatch: "responseObserved",
    attempt: "running",
    step: "running",
    dag: "running",
    workItem: "leased",
  });
  assert.equal(beforeInjectedFailure.receiptCount, 0);
  assert.equal(beforeInjectedFailure.continuationCount, 0);
  assert.equal(beforeInjectedFailure.schedulerCount, 0);
  mutateDatabase(path, "DROP TRIGGER d1_after_dispatch_transition");

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

  const tamperMatrix = [
    {
      name: "dispatch terminal revision",
      mutate: "UPDATE model_dispatch_receipts SET revision=revision+1 WHERE operation_id='dispatch-agent'",
    },
    {
      name: "Attempt terminal authority",
      mutate: "UPDATE run_attempts SET state_json=json_set(state_json,'$.status','failed') WHERE step_id='agent'",
    },
    {
      name: "Step terminal authority",
      mutate: "UPDATE run_steps SET state_json=json_set(state_json,'$.status','failed') WHERE step_id='agent'",
    },
    {
      name: "DAG claim",
      mutate: "UPDATE workflow_executions SET state_json=json_set(state_json,'$.nodes[0].claimId','forged')",
    },
    {
      name: "DAG AgentVersion",
      mutate: "UPDATE workflow_executions SET state_json=json_set(state_json,'$.nodes[0].agentVersionId','forged')",
    },
    {
      name: "completed WorkItem authority",
      mutate: `UPDATE work_items SET work_item_json=json_set(work_item_json,
        '$.payload.claimId','forged') WHERE work_item_id='${agent.workItemId}'`,
    },
    {
      name: "receipt result",
      mutate: `UPDATE workflow_composition_receipts SET result_json=json_set(
        result_json,'$.handoff.nextWorkItemId','forged')
        WHERE operation_id='model-terminal-agent'`,
    },
    {
      name: "scheduler item",
      mutate: `UPDATE work_items SET work_item_json=json_set(work_item_json,
        '$.payload.schedulerOperationId','forged')
        WHERE json_extract(work_item_json,'$.payload.trigger')='workflowScheduler'
          AND status='pending'`,
    },
  ] as const;
  for (const tamper of tamperMatrix) {
    const before = snapshotDatabase(path);
    mutateDatabase(path, tamper.mutate);
    const corrupted = snapshotDatabase(path);
    await assert.rejects(
      store.settleWorkflowNodeModelTerminal(settlement),
      /corrupt|mismatch|conflict/u,
      tamper.name,
    );
    assert.deepEqual(snapshotDatabase(path), corrupted, tamper.name);
    restoreDatabase(path, before);
  }

  const schedulerId = fresh.handoff.nextWorkItemId!;
  const schedulerLease = leasePath(path, schedulerId, "scheduler-worker", nowMs);
  const verificationSchedule = await store.scheduleWorkflowNodes(
    schedulerInput(schedulerId, schedulerId, schedulerLease),
  );
  assert.deepEqual(
    verificationSchedule.nodeWorkItems.map(({ nodeId }) => nodeId),
    ["verification"],
  );
  const verification = verificationSchedule.nodeWorkItems[0]!;
  const verificationLease = leasePath(
    path,
    verification.workItemId,
    "verification-worker",
    nowMs,
  );
  const verificationAdmission = await store.admitWorkflowNodeWork(
    admissionInput(
      verification,
      verificationLease,
      schedulerId,
      "admit-verification-model",
    ),
  );
  assert.equal(verificationAdmission.disposition, "fresh");
  const verificationAuthority = {
    tenantId: "tenant-1",
    runId: "run-1",
    workItemId: verification.workItemId,
    leaseEpoch: verification.claimEpoch,
    nodeId: verification.nodeId,
    nodeKind: "verification" as const,
    claimId: verification.claimId,
    claimEpoch: verification.claimEpoch,
    agentVersionId: "verification-v1",
    attempt: {
      stepId: verificationAdmission.admission!.step.stepId,
      attemptId: verificationAdmission.admission!.attempt.attemptId,
    },
  };
  const verificationDispatch = await observeDispatch(
    store,
    verificationLease,
    verificationAuthority.attempt,
    "verification",
    "verification-v1",
  );
  const verificationSettlement = {
    binding,
    nodeId: verification.nodeId,
    operationId: "model-terminal-verification",
    evidence: createWorkflowNodeTerminalEvidence({
      workflow,
      nodeId: verification.nodeId,
      outcome: { status: "completed" as const, value: {} },
      digester,
    }),
    lease: verificationLease,
    authority: verificationAuthority,
    dispatch: {
      operationId: verificationDispatch.operationId,
      requestSequence: verificationDispatch.requestSequence,
      expectedRevision: verificationDispatch.revision,
      status: "responseObserved" as const,
    },
    dispatchTerminalOutcome: {
      kind: "completed" as const,
      code: null,
      certainty: "responseObserved" as const,
    },
  };
  const terminal = await store.settleWorkflowNodeModelTerminal(
    verificationSettlement,
  );
  assert.equal(terminal.disposition, "settled");
  assert.equal(terminal.runDisposition, "terminalConverged");
  assert.equal(terminal.continuation, null);
  assert.deepEqual(terminal.handoff, {
    currentWorkItem: "completed",
    nextWorkItemId: null,
    kind: "none",
  });
  const terminalState = inspectD1(
    path,
    "verification",
    verification.workItemId,
  );
  const terminalRun = JSON.parse(terminalState.run as string);
  const terminalEvents = terminalState.events.map((row) =>
    JSON.parse(row.event_json as string),
  ) as RunLifecycleEvent[];
  const terminalOutbox = terminalState.outbox.map((row) =>
    JSON.parse(row.message_json as string),
  );
  assert.equal(terminalRun.status, "completed");
  assert.equal(typeof terminalRun.outputRef, "string");
  assert.deepEqual(terminalRun, replayRunLifecycle(terminalEvents));
  assert.deepEqual(terminalEvents.at(-1), {
    ...terminalEvents.at(-1),
    type: "run.completed",
    data: { outputRef: terminalRun.outputRef },
  });
  assert.deepEqual(terminalOutbox.at(-1)?.payload, {
    eventId: terminalEvents.at(-1)?.eventId,
    eventType: "run.completed",
    throughSequence: terminalRun.lastSequence,
  });
  assert.deepEqual(
    await store.settleWorkflowNodeModelTerminal(verificationSettlement),
    { ...terminal, disposition: "replay" },
  );

  const terminalTamperMatrix = [
    {
      name: "continuation resurrection",
      mutate: `INSERT INTO workflow_node_continuations
        (tenant_id,run_id,step_id,attempt_id,revision,checkpoint_json,updated_at)
        VALUES ('tenant-1','run-1','verification','${verificationAuthority.attempt.attemptId}',
        1,'{}','2026-08-12T00:00:09.000Z')`,
    },
    {
      name: "completed WorkItem status authority",
      mutate: `UPDATE work_items SET status='leased',lease_owner_id='forged',
        lease_id='forged',lease_expires_at_ms=9999999999999,completed_at_ms=NULL
        WHERE work_item_id='${verification.workItemId}'`,
    },
    {
      name: "terminal Run event",
      mutate: `UPDATE run_events SET event_json=json_set(event_json,'$.data.outputRef','forged')
        WHERE json_extract(event_json,'$.type')='run.completed'`,
    },
    {
      name: "terminal Run outbox",
      mutate: `UPDATE outbox SET message_json=json_set(message_json,
        '$.payload.eventType','run.failed')
        WHERE json_extract(message_json,'$.payload.eventType')='run.completed'`,
    },
    {
      name: "terminal Run snapshot",
      mutate: `UPDATE run_snapshots SET state_json=json_set(state_json,
        '$.outputRef','forged') WHERE run_id='run-1'`,
    },
  ] as const;
  for (const tamper of terminalTamperMatrix) {
    const before = snapshotDatabase(path);
    mutateDatabase(path, tamper.mutate);
    const corrupted = snapshotDatabase(path);
    await assert.rejects(
      store.settleWorkflowNodeModelTerminal(verificationSettlement),
      /corrupt|mismatch|conflict/u,
      tamper.name,
    );
    assert.deepEqual(snapshotDatabase(path), corrupted, tamper.name);
    restoreDatabase(path, before);
  }
});

async function observeDispatch(
  store: SqliteRunStore,
  nodeLease: ReturnType<typeof lease>,
  attempt: Readonly<{ stepId: string; attemptId: string }>,
  suffix: string,
  agentVersionId: string,
) {
  const prepared = await store.prepareModelDispatch({
    tenantId: "tenant-1", runId: "run-1", lease: nodeLease, attempt,
    operationId: `dispatch-${suffix}`, requestSequence: 1, operation: "dispatch",
    requestDigest: digester.sha256(`${suffix}-request`),
    provider: { agentVersionId, adapterName: "responses", adapterVersion: "1", modelId: "model-1" },
    preparedAt: "2026-08-12T00:00:04.000Z",
  });
  const sent = await store.markModelDispatchPossiblySent({
    tenantId: "tenant-1", runId: "run-1", lease: nodeLease, attempt,
    operationId: prepared.operationId, requestSequence: prepared.requestSequence,
    expectedRevision: prepared.revision, transitionedAt: "2026-08-12T00:00:05.000Z",
  });
  return store.observeModelDispatchResponse({
    tenantId: "tenant-1", runId: "run-1", lease: nodeLease, attempt,
    operationId: sent.operationId, requestSequence: sent.requestSequence,
    expectedRevision: sent.revision, checkpointDigest: digester.sha256(`${suffix}-checkpoint`),
    transitionedAt: "2026-08-12T00:00:06.000Z",
  });
}

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

function snapshotDatabase(path: string) {
  const database = new DatabaseSync(path);
  try {
    return Object.fromEntries(
      [
        "model_dispatch_receipts",
        "run_attempts",
        "run_steps",
        "workflow_executions",
        "work_items",
        "workflow_composition_receipts",
        "workflow_node_continuations",
        "run_events",
        "outbox",
        "run_snapshots",
      ].map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...row })),
      ]),
    );
  } finally {
    database.close();
  }
}

function mutateDatabase(path: string, statement: string) {
  const database = new DatabaseSync(path);
  try {
    database.prepare(statement).run();
  } finally {
    database.close();
  }
}

function restoreDatabase(path: string, snapshot: ReturnType<typeof snapshotDatabase>) {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    for (const [table, rows] of Object.entries(snapshot)) {
      database.prepare(`DELETE FROM ${table}`).run();
      for (const row of rows) {
        const columns = Object.keys(row);
        database
          .prepare(
            `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns
              .map(() => "?")
              .join(",")})`,
          )
          .run(...columns.map((column) => row[column]));
      }
    }
    database.exec("COMMIT; PRAGMA foreign_keys=ON");
  } catch (error) {
    database.exec("ROLLBACK; PRAGMA foreign_keys=ON");
    throw error;
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
