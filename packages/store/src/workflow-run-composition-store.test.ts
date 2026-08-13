import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { RunApplicationService, RunStoreError, ThreadApplicationService } from "@crewon/application";
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
import { SqliteRunStore } from "./sqlite-run-store.ts";
import {
  loadSqliteModelDispatchReceipt,
  markSqliteModelDispatchPossiblySent,
  observeSqliteModelDispatchResponse,
  prepareSqliteModelDispatch,
  terminateSqliteModelDispatch,
} from "./sqlite-model-dispatch-evidence.ts";
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

test("SQLite cancellation atomically closes queued, pending and waiting gate nodes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-workflow-cancel-"));
  const path = join(directory, "cancel.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = mutableClock(Date.parse("2026-08-12T00:00:00.000Z"));
  const store = new SqliteRunStore(path, { workflowDigester: digester, clock });
  t.after(() => store.close());
  await new ThreadApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    ids: { nextId: () => "thread-1" }, digester }).createThread({ tenantId: "tenant-1",
      principalId: "principal-1", spaceId: "space-1", actorId: "actor-1" }, {
      kind: "thread.create", idempotencyKey: "cancel-thread", title: "Cancel" });
  await seed(path, clock.nowEpochMilliseconds() + 60_000);
  const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
    lease, binding, schedulerOperationId: "cancel-schedule", workflowInput: {
      valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
  const nodeWork = scheduled.nodeWorkItems[0]!;
  await new RunApplicationService({ store, authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:01.000Z" },
    ids: { nextId: (kind) => `cancel-${kind}` } }).transitionRun({ tenantId: "tenant-1",
      principalId: "principal-1", spaceId: "space-1", actorId: "actor-1" }, { kind: "run.requestCancel",
      runId: "run-1", expectedRevision: 2, idempotencyKey: "request-cancel" });
  const wakeDatabase = new DatabaseSync(path);
  assert.equal(wakeDatabase.prepare(`SELECT count(*) count FROM work_items WHERE status='pending'
    AND json_extract(work_item_json,'$.payload.trigger')='workflowCancel'`).get()!.count, 1);
  wakeDatabase.close();
  clock.set(Date.parse("2026-08-12T00:00:01.000Z"));
  const claim = await store.claimNextWorkItem({ ownerId: "cancel-worker",
    leaseId: "cancel-lease", leaseDurationMs: 60_000 });
  assert.equal(claim?.workItem.workItemId, nodeWork.workItemId);
  const competing = new SqliteRunStore(path, { workflowDigester: digester, clock });
  const cancelClaim = await competing.claimNextWorkItem({ ownerId: "cancel-wake-worker",
    leaseId: "cancel-wake-lease", leaseDurationMs: 60_000 });
  const raceDatabase = new DatabaseSync(path);
  const cancelWorkItemId = raceDatabase.prepare(`SELECT work_item_id FROM work_items
    WHERE json_extract(work_item_json,'$.payload.trigger')='workflowCancel'`).get()!.work_item_id;
  raceDatabase.close();
  assert.equal(cancelClaim?.workItem.workItemId, cancelWorkItemId);
  clock.set(Date.parse("2026-08-12T00:00:02.000Z"));
  const input = { tenantId: "tenant-1", runId: "run-1", binding,
    operationId: "cancel-execution", reasonCode: "user_requested",
    lease: { workItemId: nodeWork.workItemId, ownerId: "cancel-worker",
      leaseId: "cancel-lease", leaseEpoch: claim!.lease.epoch } };
  const nodeCanceled = await store.cancelWorkflowExecution(input);
  assert.deepEqual([nodeCanceled.disposition, nodeCanceled.runDisposition],
    ["cancellationPending", "nonTerminal"]);
  const result = await competing.cancelWorkflowExecution({ tenantId: "tenant-1", runId: "run-1",
    binding, operationId: String(cancelClaim!.workItem.payload.cancellationOperationId),
    reasonCode: "user_requested", lease: { workItemId: cancelClaim!.workItem.workItemId,
      ownerId: "cancel-wake-worker", leaseId: "cancel-wake-lease",
      leaseEpoch: cancelClaim!.lease.epoch } });
  await competing.close();
  const database = new DatabaseSync(path);
  assert.equal(result.runDisposition, "terminalConverged");
  assert.equal(result.execution.status, "canceled");
  assert.deepEqual(result.execution.nodes.map((node) => node.status),
    ["canceled", "canceled", "canceled"]);
  assert.deepEqual(result.execution.nodes.map((node) => ({ nodeId: node.nodeId,
    claimId: node.claimId, claimEpoch: node.claimEpoch })), [
      { nodeId: "agent", claimId: nodeWork.claimId, claimEpoch: nodeWork.claimEpoch },
      { nodeId: "gate", claimId: scheduled.gatePublications[0]!.claimId,
        claimEpoch: scheduled.gatePublications[0]!.claimEpoch },
      { nodeId: "verify", claimId: null, claimEpoch: 0 },
    ]);
  assert.equal(database.prepare("SELECT count(*) count FROM run_steps WHERE status='canceled'")
    .get()!.count, 3);
  assert.deepEqual(database.prepare(`SELECT step_id stepId,status,current_attempt_id currentAttemptId
    FROM run_steps ORDER BY step_id`).all().map((row) => ({ ...row })), [
      { stepId: "agent", status: "canceled", currentAttemptId: null },
      { stepId: "gate", status: "canceled", currentAttemptId: null },
      { stepId: "verify", status: "canceled", currentAttemptId: null },
    ]);
  assert.equal(database.prepare("SELECT count(*) count FROM run_attempts").get()!.count, 0);
  assert.equal(database.prepare("SELECT count(*) count FROM workflow_gate_requests WHERE status='canceled'")
    .get()!.count, 1);
  assert.equal(database.prepare(`SELECT count(*) count FROM run_events
    WHERE json_extract(event_json,'$.type')='workflow.node.terminal'`).get()!.count, 3);
  assert.deepEqual(database.prepare(`SELECT json_extract(event_json,'$.data.nodeId') nodeId,
    json_extract(event_json,'$.data.claimId') claimId,
    json_extract(event_json,'$.data.claimEpoch') claimEpoch,
    json_extract(event_json,'$.data.attemptId') attemptId FROM run_events
    WHERE json_extract(event_json,'$.type')='workflow.node.terminal' ORDER BY nodeId`).all()
    .map((row) => ({ ...row })), [
      { nodeId: "agent", claimId: nodeWork.claimId, claimEpoch: nodeWork.claimEpoch, attemptId: null },
      { nodeId: "gate", claimId: scheduled.gatePublications[0]!.claimId,
        claimEpoch: scheduled.gatePublications[0]!.claimEpoch, attemptId: null },
      { nodeId: "verify", claimId: null, claimEpoch: null, attemptId: null },
    ]);
  assert.equal(database.prepare("SELECT count(*) count FROM work_items WHERE status!='completed'")
    .get()!.count, 0);
  assert.deepEqual(await store.cancelWorkflowExecution(input), {
    ...nodeCanceled, disposition: "replay",
  });
  database.prepare(`UPDATE run_events SET event_json=json_set(event_json,'$.data.nodeId','forged')
    WHERE event_id=(SELECT event_id FROM run_events
      WHERE json_extract(event_json,'$.type')='workflow.node.terminal' LIMIT 1)`).run();
  await assert.rejects(store.cancelWorkflowExecution(input),
    (error: unknown) => error instanceof RunStoreError &&
      error.code === "workflow_cancellation_replay_corrupt");
  database.close();
});

test("SQLite cancellation terminalizes a running not-dispatched node", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-workflow-cancel-prepared-"));
  const path = join(directory, "cancel.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = mutableClock(Date.parse("2026-08-12T00:00:00.000Z"));
  const store = new SqliteRunStore(path, { workflowDigester: digester, clock });
  t.after(() => store.close());
  await new ThreadApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    ids: { nextId: () => "thread-1" }, digester }).createThread({ tenantId: "tenant-1",
      principalId: "principal-1", spaceId: "space-1", actorId: "actor-1" }, {
      kind: "thread.create", idempotencyKey: "prepared-thread", title: "Prepared cancel" });
  await seed(path, clock.nowEpochMilliseconds() + 60_000);
  const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
    lease, binding, schedulerOperationId: "cancel-schedule", workflowInput: {
      valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
  const work = scheduled.nodeWorkItems[0]!;
  const claim = await store.claimNextWorkItem({ ownerId: "node-worker",
    leaseId: "node-lease", leaseDurationMs: 60_000 });
  assert.equal(claim?.workItem.workItemId, work.workItemId);
  const nodeLease = { workItemId: work.workItemId, ownerId: "node-worker",
    leaseId: "node-lease", leaseEpoch: claim!.lease.epoch };
  const admissionInput = { tenantId: "tenant-1", runId: "run-1", lease: nodeLease,
    binding, nodeId: work.nodeId, claimId: work.claimId, claimEpoch: work.claimEpoch,
    schedulerOperationId: "cancel-schedule", admissionOperationId: "admit-prepared",
    attemptLeaseDurationMs: 60_000 } as const;
  const admitted = await store.admitWorkflowNodeWork(admissionInput);
  const attempt = admitted.admission!.attempt;
  const dispatchDatabase = new DatabaseSync(path);
  const prior = prepareSqliteModelDispatch(dispatchDatabase, { tenantId: "tenant-1",
    runId: "run-1", lease: nodeLease, attempt, operationId: "completed-prior-dispatch",
    requestSequence: 1, operation: "dispatch", requestDigest: digester.sha256("prior-request"),
    provider: { agentVersionId: "agent-v1", adapterName: "responses", adapterVersion: "1",
      modelId: "model" }, preparedAt: "2026-08-12T00:00:00.000Z" });
  const priorSent = markSqliteModelDispatchPossiblySent(dispatchDatabase, {
    tenantId: "tenant-1", runId: "run-1", lease: nodeLease, attempt,
    operationId: prior.operationId, requestSequence: prior.requestSequence,
    expectedRevision: prior.revision, transitionedAt: "2026-08-12T00:00:00.000Z" });
  const priorObserved = observeSqliteModelDispatchResponse(dispatchDatabase, {
    tenantId: "tenant-1", runId: "run-1", lease: nodeLease, attempt,
    operationId: prior.operationId, requestSequence: prior.requestSequence,
    expectedRevision: priorSent.revision, checkpointDigest: digester.sha256("prior-checkpoint"),
    transitionedAt: "2026-08-12T00:00:00.000Z" });
  terminateSqliteModelDispatch(dispatchDatabase, { tenantId: "tenant-1", runId: "run-1",
    lease: nodeLease, attempt, operationId: prior.operationId,
    requestSequence: prior.requestSequence, expectedRevision: priorObserved.revision,
    transitionedAt: "2026-08-12T00:00:00.000Z",
    outcome: { kind: "completed", code: null, certainty: "responseObserved" } });
  prepareSqliteModelDispatch(dispatchDatabase, { tenantId: "tenant-1", runId: "run-1",
    lease: nodeLease, attempt, operationId: "prepared-dispatch", requestSequence: 2,
    operation: "dispatch", requestDigest: digester.sha256("request"), provider: {
      agentVersionId: "agent-v1", adapterName: "responses", adapterVersion: "1", modelId: "model" },
    preparedAt: "2026-08-12T00:00:00.000Z" });
  dispatchDatabase.close();
  await new RunApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:01.000Z" },
    ids: { nextId: (kind) => `prepared-${kind}` } }).transitionRun({ tenantId: "tenant-1",
      principalId: "principal-1", spaceId: "space-1", actorId: "actor-1" }, {
      kind: "run.requestCancel", runId: "run-1", expectedRevision: 2,
      idempotencyKey: "request-prepared-cancel" });
  clock.set(Date.parse("2026-08-12T00:00:02.000Z"));
  const cancelInput = { tenantId: "tenant-1", runId: "run-1",
    binding, operationId: "cancel-prepared", reasonCode: "user_requested", lease: nodeLease };
  const canceled = await store.cancelWorkflowExecution(cancelInput);
  assert.deepEqual([canceled.disposition, canceled.runDisposition],
    ["cancellationPending", "nonTerminal"]);
  const cancelClaim = await store.claimNextWorkItem({ ownerId: "cancel-worker",
    leaseId: "cancel-lease", leaseDurationMs: 60_000 });
  assert.equal(cancelClaim?.workItem.payload.trigger, "workflowCancel");
  const converged = await store.cancelWorkflowExecution({ tenantId: "tenant-1", runId: "run-1",
    binding, operationId: String(cancelClaim!.workItem.payload.cancellationOperationId),
    reasonCode: "user_requested", lease: { workItemId: cancelClaim!.workItem.workItemId,
      ownerId: "cancel-worker", leaseId: "cancel-lease", leaseEpoch: cancelClaim!.lease.epoch } });
  assert.equal(converged.runDisposition, "terminalConverged");
  const database = new DatabaseSync(path);
  const terminal = loadSqliteModelDispatchReceipt(database, { tenantId: "tenant-1",
    runId: "run-1", stepId: "agent", attemptId: attempt.attemptId,
    operationId: "prepared-dispatch" });
  assert.equal(terminal?.status, "terminal");
  assert.deepEqual(terminal?.terminalOutcome,
    { kind: "canceled", code: "user_requested", certainty: "notSent" });
  assert.deepEqual({ ...database.prepare(`SELECT status FROM run_attempts WHERE attempt_id=?`).get(
    attempt.attemptId) }, { status: "canceled" });
  assert.deepEqual({ ...database.prepare(`SELECT status FROM run_steps WHERE step_id='agent'`).get() },
    { status: "canceled" });
  const lifecycle = database.prepare(`SELECT json_extract(event_json,'$.type') type,
    json_extract(event_json,'$.data.nodeId') nodeId,
    json_extract(event_json,'$.data.attemptId') attemptId FROM run_events
    ORDER BY sequence`).all().map((row) => ({ ...row }));
  const agentTerminal = lifecycle.find((event) => event.type === "workflow.node.terminal" &&
    event.nodeId === "agent");
  assert.equal(agentTerminal?.attemptId, attempt.attemptId);
  assert.equal(lifecycle.at(-1)?.type, "run.canceled");
  database.close();
  assert.deepEqual(await store.cancelWorkflowExecution(cancelInput),
    { ...canceled, disposition: "replay" });
  const replay = await store.admitWorkflowNodeWork(admissionInput);
  assert.equal(replay.disposition, "replay");
  assert.equal(replay.admission, null);
  const tamper = new DatabaseSync(path);
  tamper.prepare(`UPDATE run_attempts SET state_json=json_set(state_json,'$.status','failed')
    WHERE attempt_id=?`).run(attempt.attemptId);
  tamper.close();
  await assert.rejects(store.cancelWorkflowExecution(cancelInput),
    (error: unknown) => error instanceof RunStoreError &&
      error.code === "workflow_cancellation_replay_corrupt");
});

test("SQLite cancellation fences parallel running siblings to their own leases", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-workflow-cancel-parallel-"));
  const path = join(directory, "cancel.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = mutableClock(Date.parse("2026-08-12T00:00:00.000Z"));
  const store = new SqliteRunStore(path, { workflowDigester: digester, clock });
  t.after(() => store.close());
  await new ThreadApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    ids: { nextId: () => "thread-1" }, digester }).createThread({ tenantId: "tenant-1",
      principalId: "principal-1", spaceId: "space-1", actorId: "actor-1" }, {
      kind: "thread.create", idempotencyKey: "parallel-thread", title: "Parallel cancel" });
  const parallelWorkflow = compileWorkflowVersion({ ...source,
    workflowId: "parallel-workflow", workflowVersionId: "parallel-version",
    entryNodeIds: ["left", "right"], outputNodeIds: ["join"], nodes: [
      { ...common("left"), kind: "agent", agentVersionId: "agent-v1" },
      { ...common("right"), kind: "agent", agentVersionId: "agent-v1" },
      { ...common("join", ["left", "right"]), inputSchema: { ...fanInSchema,
        properties: { left: objectSchema, right: objectSchema }, required: ["left", "right"] },
        kind: "verification", verifierAgentVersionId: "verifier-v1" },
    ] }, digester);
  const parallelBinding = { workflowId: parallelWorkflow.workflowId,
    workflowVersionId: parallelWorkflow.workflowVersionId,
    contentDigest: parallelWorkflow.contentDigest };
  await seed(path, clock.nowEpochMilliseconds() + 60_000, parallelWorkflow, parallelBinding);
  const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
    lease, binding: parallelBinding, schedulerOperationId: "schedule-fanout-1",
    workflowInput: { valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
  const admissions = [];
  for (const [index, work] of scheduled.nodeWorkItems.entries()) {
    const claim = await store.claimNextWorkItem({ ownerId: `node-worker-${index}`,
      leaseId: `node-lease-${index}`, leaseDurationMs: 60_000 });
    const nodeLease = { workItemId: work.workItemId, ownerId: `node-worker-${index}`,
      leaseId: `node-lease-${index}`, leaseEpoch: claim!.lease.epoch };
    const admitted = await store.admitWorkflowNodeWork({ tenantId: "tenant-1", runId: "run-1",
      lease: nodeLease, binding: parallelBinding, nodeId: work.nodeId, claimId: work.claimId,
      claimEpoch: work.claimEpoch, schedulerOperationId: "schedule-fanout-1",
      admissionOperationId: `admit-${work.nodeId}`, attemptLeaseDurationMs: 60_000 });
    const database = new DatabaseSync(path);
    prepareSqliteModelDispatch(database, { tenantId: "tenant-1", runId: "run-1", lease: nodeLease,
      attempt: admitted.admission!.attempt, operationId: `dispatch-${work.nodeId}`,
      requestSequence: 1, operation: "dispatch", requestDigest: digester.sha256(work.nodeId),
      provider: { agentVersionId: "agent-v1", adapterName: "responses", adapterVersion: "1",
        modelId: "model" }, preparedAt: "2026-08-12T00:00:00.000Z" });
    database.close();
    admissions.push({ work, nodeLease });
  }
  await new RunApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:01.000Z" },
    ids: { nextId: (kind) => `parallel-${kind}` } }).transitionRun({ tenantId: "tenant-1",
      principalId: "principal-1", spaceId: "space-1", actorId: "actor-1" }, {
      kind: "run.requestCancel", runId: "run-1", expectedRevision: 2,
      idempotencyKey: "request-parallel-cancel" });
  clock.set(Date.parse("2026-08-12T00:00:02.000Z"));
  const first = await store.cancelWorkflowExecution({ tenantId: "tenant-1", runId: "run-1",
    binding: parallelBinding, lease: admissions[0]!.nodeLease,
    operationId: `cancel-${admissions[0]!.work.nodeId}`, reasonCode: "user_requested" });
  assert.equal(first.disposition, "cancellationPending");
  const afterFirst = new DatabaseSync(path);
  assert.deepEqual(afterFirst.prepare(`SELECT step_id stepId,status FROM run_attempts
    ORDER BY step_id`).all().map((row) => ({ ...row })), [
      { stepId: "left", status: "canceled" }, { stepId: "right", status: "running" } ]);
  afterFirst.close();
  await store.cancelWorkflowExecution({ tenantId: "tenant-1", runId: "run-1",
    binding: parallelBinding, lease: admissions[1]!.nodeLease,
    operationId: `cancel-${admissions[1]!.work.nodeId}`, reasonCode: "user_requested" });
  const cancelClaim = await store.claimNextWorkItem({ ownerId: "cancel-worker",
    leaseId: "cancel-lease", leaseDurationMs: 60_000 });
  const final = await store.cancelWorkflowExecution({ tenantId: "tenant-1", runId: "run-1",
    binding: parallelBinding, operationId: String(cancelClaim!.workItem.payload.cancellationOperationId),
    reasonCode: "user_requested", lease: { workItemId: cancelClaim!.workItem.workItemId,
      ownerId: "cancel-worker", leaseId: "cancel-lease", leaseEpoch: cancelClaim!.lease.epoch } });
  assert.deepEqual([final.disposition, final.runDisposition, final.execution.status],
    ["canceled", "terminalConverged", "canceled"]);
  const durable = new DatabaseSync(path);
  assert.equal(durable.prepare("SELECT count(*) count FROM run_attempts WHERE status!='canceled'")
    .get()!.count, 0);
  assert.equal(durable.prepare("SELECT count(*) count FROM work_items WHERE status!='completed'")
    .get()!.count, 0);
  durable.close();
});

test("SQLite cancellation replaces completed sibling reconciles and replays after restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-workflow-cancel-restart-"));
  const path = join(directory, "cancel.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = mutableClock(Date.parse("2026-08-12T00:00:00.000Z"));
  const store = new SqliteRunStore(path, { workflowDigester: digester, clock });
  t.after(() => store.close());
  await new ThreadApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    ids: { nextId: () => "thread-1" }, digester }).createThread({ tenantId: "tenant-1",
      principalId: "principal-1", spaceId: "space-1", actorId: "actor-1" }, {
      kind: "thread.create", idempotencyKey: "restart-thread", title: "Restart cancel" });
  const parallelWorkflow = compileWorkflowVersion({ ...source,
    workflowId: "restart-workflow", workflowVersionId: "restart-version",
    entryNodeIds: ["left", "right"], outputNodeIds: ["join"], nodes: [
      { ...common("left"), kind: "agent", agentVersionId: "agent-v1" },
      { ...common("right"), kind: "agent", agentVersionId: "agent-v1" },
      { ...common("join", ["left", "right"]), inputSchema: { ...fanInSchema,
        properties: { left: objectSchema, right: objectSchema }, required: ["left", "right"] },
        kind: "verification", verifierAgentVersionId: "verifier-v1" },
    ] }, digester);
  const parallelBinding = { workflowId: parallelWorkflow.workflowId,
    workflowVersionId: parallelWorkflow.workflowVersionId,
    contentDigest: parallelWorkflow.contentDigest };
  await seed(path, clock.nowEpochMilliseconds() + 60_000, parallelWorkflow, parallelBinding);
  const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
    lease, binding: parallelBinding, schedulerOperationId: "restart-schedule",
    workflowInput: { valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
  const oldReconcileIds: string[] = [];
  for (const [index, work] of scheduled.nodeWorkItems.entries()) {
    const ownerId = `node-worker-${index}`;
    const leaseId = `node-lease-${index}`;
    const claim = await store.claimNextWorkItem({ ownerId, leaseId, leaseDurationMs: 60_000 });
    assert.equal(claim?.workItem.workItemId, work.workItemId);
    const nodeLease = { workItemId: work.workItemId, ownerId, leaseId,
      leaseEpoch: claim!.lease.epoch };
    const admitted = await store.admitWorkflowNodeWork({ tenantId: "tenant-1", runId: "run-1",
      lease: nodeLease, binding: parallelBinding, nodeId: work.nodeId,
      claimId: work.claimId, claimEpoch: work.claimEpoch,
      schedulerOperationId: "restart-schedule", admissionOperationId: `admit-${work.nodeId}`,
      attemptLeaseDurationMs: 60_000 });
    const unknown = await store.settleWorkflowNode({ tenantId: "tenant-1", runId: "run-1",
      lease: nodeLease, binding: parallelBinding, nodeId: work.nodeId,
      claimId: work.claimId, claimEpoch: work.claimEpoch,
      stepId: admitted.admission!.attempt.stepId,
      attemptId: admitted.admission!.attempt.attemptId,
      operationId: `unknown-${work.nodeId}`, outcome: { status: "unknown" } });
    oldReconcileIds.push(unknown.handoff.nextWorkItemId!);
  }
  await new RunApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:01.000Z" },
    ids: { nextId: (kind) => `restart-${kind}` } }).transitionRun({ tenantId: "tenant-1",
      principalId: "principal-1", spaceId: "space-1", actorId: "actor-1" }, {
      kind: "run.requestCancel", runId: "run-1", expectedRevision: 2,
      idempotencyKey: "request-restart-cancel" });
  clock.set(Date.parse("2026-08-12T00:00:02.000Z"));
  for (const index of [0, 1]) {
    const claim = await store.claimNextWorkItem({ ownerId: `stale-worker-${index}`,
      leaseId: `stale-lease-${index}`, leaseDurationMs: 60_000 });
    assert.equal(claim?.workItem.payload.trigger, "workflowReconcile");
    assert.ok(oldReconcileIds.includes(claim!.workItem.workItemId));
    await store.completeWorkItem({ workItemId: claim!.workItem.workItemId,
      ownerId: `stale-worker-${index}`, leaseId: `stale-lease-${index}`,
      leaseEpoch: claim!.lease.epoch });
  }
  const cancelClaim = await store.claimNextWorkItem({ ownerId: "cancel-worker",
    leaseId: "cancel-lease", leaseDurationMs: 60_000 });
  assert.equal(cancelClaim?.workItem.payload.trigger, "workflowCancel");
  const operationId = String(cancelClaim!.workItem.payload.cancellationOperationId);
  const cancelLease = { workItemId: cancelClaim!.workItem.workItemId,
    ownerId: "cancel-worker", leaseId: "cancel-lease", leaseEpoch: cancelClaim!.lease.epoch };
  const retained = await store.cancelWorkflowExecution({ tenantId: "tenant-1", runId: "run-1",
    binding: parallelBinding, operationId, reasonCode: "user_requested", lease: cancelLease });
  assert.equal(retained.disposition, "retryRequired");
  assert.equal(retained.handoff.currentWorkItem, "retained");
  assert.equal(retained.reconciliationWorkItemIds.length, 2);
  assert.deepEqual(retained.reconciliationWorkItemIds.map((workItemId) =>
    oldReconcileIds.includes(workItemId)), [false, false]);
  const partial = new DatabaseSync(path);
  assert.equal(partial.prepare(`SELECT count(*) count FROM workflow_composition_receipts
    WHERE kind='cancelExecution'`).get()!.count, 0);
  assert.equal(partial.prepare(`SELECT count(*) count FROM work_items WHERE
    json_extract(work_item_json,'$.payload.trigger')='workflowReconcile'`).get()!.count, 4);
  partial.close();
  await store.retryWorkItem({ ...cancelLease, retryAfterMs: 60_000,
    reasonCode: "workflow_cancellation_retry_required" });

  const restarted = new SqliteRunStore(path, { workflowDigester: digester, clock });
  t.after(() => restarted.close());
  const reconciledWorkItemIds: string[] = [];
  for (const index of [0, 1]) {
    const ownerId = `reconcile-worker-${index}`;
    const leaseId = `reconcile-lease-${index}`;
    const claim = await restarted.claimNextWorkItem({ ownerId, leaseId,
      leaseDurationMs: 60_000 });
    assert.ok(retained.reconciliationWorkItemIds.includes(claim!.workItem.workItemId));
    assert.ok(!reconciledWorkItemIds.includes(claim!.workItem.workItemId));
    reconciledWorkItemIds.push(claim!.workItem.workItemId);
    const workItemId: string = claim!.workItem.workItemId;
    const payload = claim!.workItem.payload as Record<string, unknown>;
    const reconcileInput: Parameters<SqliteRunStore["reconcileWorkflowNode"]>[0] = {
      tenantId: "tenant-1",
      runId: "run-1", binding: parallelBinding, lease: { workItemId, ownerId, leaseId,
        leaseEpoch: claim!.lease.epoch }, nodeId: String(payload.nodeId),
      claimId: String(payload.claimId), claimEpoch: Number(payload.claimEpoch),
      reconciliationOperationId: String(payload.reconciliationOperationId) };
    const reconciled = await restarted.reconcileWorkflowNode(reconcileInput);
    assert.deepEqual([reconciled.disposition, reconciled.evidenceStatus,
      reconciled.runDisposition], ["settled", "notDispatched", "nonTerminal"]);
    assert.equal((await restarted.reconcileWorkflowNode(reconcileInput)).disposition, "replay");
  }
  clock.set(Date.parse("2026-08-12T00:01:03.000Z"));
  const finalClaim = await restarted.claimNextWorkItem({ ownerId: "final-worker",
    leaseId: "final-lease", leaseDurationMs: 60_000 });
  assert.equal(finalClaim?.workItem.workItemId, cancelLease.workItemId);
  const finalInput = { tenantId: "tenant-1", runId: "run-1", binding: parallelBinding,
    operationId, reasonCode: "user_requested", lease: {
      workItemId: finalClaim!.workItem.workItemId, ownerId: "final-worker",
      leaseId: "final-lease", leaseEpoch: finalClaim!.lease.epoch } };
  const final = await restarted.cancelWorkflowExecution(finalInput);
  assert.deepEqual([final.disposition, final.runDisposition, final.execution.status],
    ["reconciliationScheduled", "terminalConverged", "canceled"]);
  assert.deepEqual(final.reconciliationWorkItemIds, retained.reconciliationWorkItemIds);
  assert.equal(final.handoff.nextWorkItemId, retained.reconciliationWorkItemIds[0]);

  const replayStore = new SqliteRunStore(path, { workflowDigester: digester, clock });
  t.after(() => replayStore.close());
  assert.deepEqual(await replayStore.cancelWorkflowExecution(finalInput),
    { ...final, disposition: "replay" });
});

test("SQLite cancellation retains possibly-sent node reconciliation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-workflow-cancel-unknown-"));
  const path = join(directory, "cancel.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = mutableClock(Date.parse("2026-08-12T00:00:00.000Z"));
  const store = new SqliteRunStore(path, { workflowDigester: digester, clock });
  t.after(() => store.close());
  await new ThreadApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    ids: { nextId: () => "thread-1" }, digester }).createThread({ tenantId: "tenant-1",
      principalId: "principal-1", spaceId: "space-1", actorId: "actor-1" }, {
      kind: "thread.create", idempotencyKey: "unknown-thread", title: "Unknown cancel" });
  await seed(path, clock.nowEpochMilliseconds() + 60_000);
  const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
    lease, binding, schedulerOperationId: "cancel-schedule", workflowInput: {
      valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
  const work = scheduled.nodeWorkItems[0]!;
  const claim = await store.claimNextWorkItem({ ownerId: "node-worker",
    leaseId: "node-lease", leaseDurationMs: 60_000 });
  const nodeLease = { workItemId: work.workItemId, ownerId: "node-worker",
    leaseId: "node-lease", leaseEpoch: claim!.lease.epoch };
  const admitted = await store.admitWorkflowNodeWork({ tenantId: "tenant-1", runId: "run-1",
    lease: nodeLease, binding, nodeId: work.nodeId, claimId: work.claimId,
    claimEpoch: work.claimEpoch, schedulerOperationId: "cancel-schedule",
    admissionOperationId: "admit-unknown", attemptLeaseDurationMs: 60_000 });
  const attempt = admitted.admission!.attempt;
  const dispatchDatabase = new DatabaseSync(path);
  const prepared = prepareSqliteModelDispatch(dispatchDatabase, { tenantId: "tenant-1",
    runId: "run-1", lease: nodeLease, attempt, operationId: "possibly-sent-dispatch",
    requestSequence: 1, operation: "dispatch", requestDigest: digester.sha256("request"),
    provider: { agentVersionId: "agent-v1", adapterName: "responses", adapterVersion: "1",
      modelId: "model" }, preparedAt: "2026-08-12T00:00:00.000Z" });
  markSqliteModelDispatchPossiblySent(dispatchDatabase, { tenantId: "tenant-1", runId: "run-1",
    lease: nodeLease, attempt, operationId: prepared.operationId, requestSequence: 1,
    expectedRevision: prepared.revision, transitionedAt: "2026-08-12T00:00:00.000Z" });
  dispatchDatabase.close();
  const unknown = await store.settleWorkflowNode({ tenantId: "tenant-1", runId: "run-1",
    lease: nodeLease, binding, nodeId: work.nodeId, claimId: work.claimId,
    claimEpoch: work.claimEpoch, stepId: attempt.stepId, attemptId: attempt.attemptId,
    operationId: "settle-unknown", outcome: { status: "unknown" } });
  assert.equal(unknown.disposition, "reconciliationScheduled");
  await new RunApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:01.000Z" },
    ids: { nextId: (kind) => `unknown-${kind}` } }).transitionRun({ tenantId: "tenant-1",
      principalId: "principal-1", spaceId: "space-1", actorId: "actor-1" }, {
      kind: "run.requestCancel", runId: "run-1", expectedRevision: 2,
      idempotencyKey: "request-unknown-cancel" });
  clock.set(Date.parse("2026-08-12T00:00:02.000Z"));
  const reconcileClaim = await store.claimNextWorkItem({ ownerId: "reconcile-worker",
    leaseId: "reconcile-lease", leaseDurationMs: 60_000 });
  assert.equal(reconcileClaim?.workItem.workItemId, unknown.handoff.nextWorkItemId);
  const reconcilePayload = reconcileClaim!.workItem.payload as Record<string, unknown>;
  const retained = await store.reconcileWorkflowNode({ tenantId: "tenant-1", runId: "run-1",
    binding, lease: { workItemId: reconcileClaim!.workItem.workItemId,
      ownerId: "reconcile-worker", leaseId: "reconcile-lease",
      leaseEpoch: reconcileClaim!.lease.epoch }, nodeId: work.nodeId, claimId: work.claimId,
    claimEpoch: work.claimEpoch,
    reconciliationOperationId: String(reconcilePayload.reconciliationOperationId) });
  assert.equal(retained.disposition, "retryRequired");
  await store.retryWorkItem({ workItemId: reconcileClaim!.workItem.workItemId,
    ownerId: "reconcile-worker", leaseId: "reconcile-lease", leaseEpoch: reconcileClaim!.lease.epoch,
    retryAfterMs: 60_000, reasonCode: "workflow_reconciliation_retry_required" });
  const cancelClaim = await store.claimNextWorkItem({ ownerId: "cancel-worker",
    leaseId: "cancel-lease", leaseDurationMs: 60_000 });
  assert.equal(cancelClaim?.workItem.payload.trigger, "workflowCancel");
  const cancelInput = { tenantId: "tenant-1", runId: "run-1", binding,
    operationId: String(cancelClaim!.workItem.payload.cancellationOperationId),
    reasonCode: "user_requested", lease: { workItemId: cancelClaim!.workItem.workItemId,
      ownerId: "cancel-worker", leaseId: "cancel-lease", leaseEpoch: cancelClaim!.lease.epoch } };
  const canceled = await store.cancelWorkflowExecution(cancelInput);
  assert.equal(canceled.disposition, "retryRequired");
  assert.equal(canceled.execution.nodes[0]!.status, "unknown");
  assert.equal(canceled.runDisposition, "nonTerminal");
  assert.deepEqual(canceled.reconciliationWorkItemIds,
    [reconcileClaim!.workItem.workItemId]);
  const retainedAgain = await store.cancelWorkflowExecution(cancelInput);
  assert.equal(retainedAgain.disposition, "retryRequired");
  assert.deepEqual(retainedAgain.reconciliationWorkItemIds,
    canceled.reconciliationWorkItemIds);
  const database = new DatabaseSync(path);
  assert.equal(database.prepare(`SELECT count(*) count FROM
    workflow_composition_receipts WHERE kind='cancelExecution'`).get()!.count, 0);
  assert.deepEqual({ ...database.prepare(`SELECT status FROM model_dispatch_receipts
    WHERE operation_id='possibly-sent-dispatch'`).get() }, { status: "possiblySent" });
  assert.equal(database.prepare(`SELECT count(*) count FROM work_items WHERE status='pending' AND
    json_extract(work_item_json,'$.payload.trigger')='workflowReconcile'`).get()!.count, 1);
  database.close();
});

test("SQLite cancellation wins over a late response terminal candidate", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-workflow-cancel-candidate-"));
  const path = join(directory, "cancel.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = mutableClock(Date.parse("2026-08-12T00:00:00.000Z"));
  const store = new SqliteRunStore(path, { workflowDigester: digester, clock });
  t.after(() => store.close());
  await new ThreadApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    ids: { nextId: () => "thread-1" }, digester }).createThread({ tenantId: "tenant-1",
      principalId: "principal-1", spaceId: "space-1", actorId: "actor-1" }, {
      kind: "thread.create", idempotencyKey: "candidate-thread", title: "Candidate cancel" });
  await seed(path, clock.nowEpochMilliseconds() + 60_000);
  const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
    lease, binding, schedulerOperationId: "cancel-schedule", workflowInput: {
      valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
  const work = scheduled.nodeWorkItems[0]!;
  const claim = await store.claimNextWorkItem({ ownerId: "node-worker",
    leaseId: "node-lease", leaseDurationMs: 60_000 });
  const nodeLease = { workItemId: work.workItemId, ownerId: "node-worker",
    leaseId: "node-lease", leaseEpoch: claim!.lease.epoch };
  const admitted = await store.admitWorkflowNodeWork({ tenantId: "tenant-1", runId: "run-1",
    lease: nodeLease, binding, nodeId: work.nodeId, claimId: work.claimId,
    claimEpoch: work.claimEpoch, schedulerOperationId: "cancel-schedule",
    admissionOperationId: "admit-candidate", attemptLeaseDurationMs: 60_000 });
  const attempt = admitted.admission!.attempt;
  const authority = { tenantId: "tenant-1", runId: "run-1", workItemId: work.workItemId,
    leaseEpoch: nodeLease.leaseEpoch, nodeId: work.nodeId, nodeKind: "agent" as const,
    claimId: work.claimId, claimEpoch: work.claimEpoch, agentVersionId: "agent-v1",
    attempt: { stepId: attempt.stepId, attemptId: attempt.attemptId } };
  const dispatchDatabase = new DatabaseSync(path);
  const prepared = prepareSqliteModelDispatch(dispatchDatabase, { tenantId: "tenant-1",
    runId: "run-1", lease: nodeLease, attempt, operationId: "candidate-dispatch",
    requestSequence: 1, operation: "dispatch", requestDigest: digester.sha256("request"),
    provider: { agentVersionId: "agent-v1", adapterName: "responses", adapterVersion: "1",
      modelId: "model" }, preparedAt: "2026-08-12T00:00:00.000Z" });
  const sent = markSqliteModelDispatchPossiblySent(dispatchDatabase, { tenantId: "tenant-1",
    runId: "run-1", lease: nodeLease, attempt, operationId: prepared.operationId,
    requestSequence: 1, expectedRevision: prepared.revision,
    transitionedAt: "2026-08-12T00:00:00.000Z" });
  const observed = observeSqliteModelDispatchResponse(dispatchDatabase, { tenantId: "tenant-1",
    runId: "run-1", lease: nodeLease, attempt, operationId: prepared.operationId,
    requestSequence: 1, expectedRevision: sent.revision,
    checkpointDigest: digester.sha256("checkpoint"),
    transitionedAt: "2026-08-12T00:00:00.000Z" });
  dispatchDatabase.close();
  const continuation = await store.commitWorkflowAssistantContinuation({ lease: nodeLease, authority,
    expectedContinuationRevision: null, next: {
      schemaVersion: "crewon.workflow-node-continuation.v0", authority, segmentId: "segment-1",
      modelSampleIndex: 0, toolRoundsConsumed: 0, providerCheckpoint: null,
      providerTurnState: null, activeDispatch: { operationId: observed.operationId,
        requestSequence: 1, expectedRevision: observed.revision, status: "responseObserved" },
      history: [] }, committedAt: "2026-08-12T00:00:00.000Z",
    terminalResult: { status: "completed", output: "{}" } });
  const candidateId = continuation.terminalCandidate!.candidateId;
  const unknown = await store.settleWorkflowNode({ tenantId: "tenant-1", runId: "run-1",
    lease: nodeLease, binding, nodeId: work.nodeId, claimId: work.claimId,
    claimEpoch: work.claimEpoch, stepId: attempt.stepId, attemptId: attempt.attemptId,
    operationId: "settle-candidate-unknown", outcome: { status: "unknown" } });
  await new RunApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:01.000Z" },
    ids: { nextId: (kind) => `candidate-${kind}` } }).transitionRun({ tenantId: "tenant-1",
      principalId: "principal-1", spaceId: "space-1", actorId: "actor-1" }, {
      kind: "run.requestCancel", runId: "run-1", expectedRevision: 2,
      idempotencyKey: "request-candidate-cancel" });
  clock.set(Date.parse("2026-08-12T00:00:02.000Z"));
  const reconcileClaim = await store.claimNextWorkItem({ ownerId: "reconcile-worker",
    leaseId: "reconcile-lease", leaseDurationMs: 60_000 });
  assert.equal(reconcileClaim?.workItem.workItemId, unknown.handoff.nextWorkItemId);
  const reconcilePayload = reconcileClaim!.workItem.payload as Record<string, unknown>;
  const reconcileInput = { tenantId: "tenant-1", runId: "run-1", binding,
    lease: { workItemId: reconcileClaim!.workItem.workItemId, ownerId: "reconcile-worker",
      leaseId: "reconcile-lease", leaseEpoch: reconcileClaim!.lease.epoch },
    nodeId: work.nodeId, claimId: work.claimId, claimEpoch: work.claimEpoch,
    reconciliationOperationId: String(reconcilePayload.reconciliationOperationId) };
  const reconciled = await store.reconcileWorkflowNode(reconcileInput);
  assert.equal(reconciled.disposition, "settled");
  assert.equal(reconciled.execution.nodes[0]!.status, "canceled");
  const database = new DatabaseSync(path);
  const terminal = loadSqliteModelDispatchReceipt(database, { tenantId: "tenant-1", runId: "run-1",
    stepId: "agent", attemptId: attempt.attemptId, operationId: "candidate-dispatch" });
  assert.deepEqual(terminal?.terminalOutcome,
    { kind: "completed", code: null, certainty: "responseObserved" });
  const retainedCandidate = JSON.parse(String(database.prepare(
    "SELECT checkpoint_json FROM workflow_node_continuations").get()!.checkpoint_json));
  assert.equal(retainedCandidate.terminalCandidate.candidateId, candidateId);
  assert.deepEqual({ ...database.prepare("SELECT status FROM run_attempts WHERE attempt_id=?").get(
    attempt.attemptId) }, { status: "canceled" });
  database.close();
  assert.equal((await store.reconcileWorkflowNode(reconcileInput)).disposition, "replay");
  const cancelClaim = await store.claimNextWorkItem({ ownerId: "cancel-worker",
    leaseId: "cancel-lease", leaseDurationMs: 60_000 });
  assert.equal(cancelClaim?.workItem.payload.trigger, "workflowCancel");
  const final = await store.cancelWorkflowExecution({ tenantId: "tenant-1", runId: "run-1",
    binding, operationId: String(cancelClaim!.workItem.payload.cancellationOperationId),
    reasonCode: "user_requested", lease: { workItemId: cancelClaim!.workItem.workItemId,
      ownerId: "cancel-worker", leaseId: "cancel-lease", leaseEpoch: cancelClaim!.lease.epoch } });
  assert.equal(final.runDisposition, "terminalConverged");
  const finalDatabase = new DatabaseSync(path);
  assert.equal(JSON.parse(String(finalDatabase.prepare(
    "SELECT state_json FROM run_snapshots WHERE run_id='run-1'").get()!.state_json)).status,
  "canceled");
  assert.equal(finalDatabase.prepare(`SELECT count(*) count FROM work_items WHERE status='pending'
    AND json_extract(work_item_json,'$.payload.trigger')='workflowScheduler'`).get()!.count, 0);
  finalDatabase.prepare(`UPDATE workflow_node_continuations SET checkpoint_json=json_set(
    checkpoint_json,'$.terminalCandidate.candidateId','sha256:forged')`).run();
  finalDatabase.close();
  await assert.rejects(store.reconcileWorkflowNode(reconcileInput),
    (error: unknown) => error instanceof RunStoreError &&
      error.code === "workflow_reconciliation_replay_corrupt");
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
    "settleWorkflowNodeModelTerminal",
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
  const scheduled = await store.scheduleWorkflowNodes(scheduleInput);
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
  assert.deepEqual(await store.scheduleWorkflowNodes(scheduleInput), {
    ...scheduled,
    disposition: "replay",
    nodeWorkItems: [],
    gatePublications: [],
    reconciliationClaims: [],
  });

  const replayDatabase = new DatabaseSync(":memory:");
  replayDatabase.close();
  const work = scheduled.nodeWorkItems[0]!;
  const nodeLease = {
    workItemId: work.workItemId,
    ownerId: "node-worker",
    leaseId: "node-lease",
    leaseEpoch: 1,
  };
  database
    .prepare(
      `UPDATE work_items SET status='leased',lease_owner_id='node-worker',lease_id='node-lease',
     lease_epoch=1,lease_expires_at_ms=? WHERE work_item_id=?`,
    )
    .run(clock.nowEpochMilliseconds() + 60_000, work.workItemId);
  const admitted = await store.admitWorkflowNodeWork({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: nodeLease,
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
    lease: nodeLease,
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
  const authority = {
    tenantId: "tenant-1", runId: "run-1", workItemId: work.workItemId,
    leaseEpoch: 1, nodeId: work.nodeId, nodeKind: "agent" as const,
    claimId: work.claimId, claimEpoch: work.claimEpoch,
    agentVersionId: "agent-v1",
    attempt: { stepId: work.nodeId,
      attemptId: admitted.admission!.attempt.attemptId },
  };
  const prepared = prepareSqliteModelDispatch(database, {
    tenantId: "tenant-1", runId: "run-1", lease: nodeLease,
    attempt: authority.attempt, operationId: "dispatch-agent-1",
    requestSequence: 1, operation: "dispatch",
    requestDigest: digester.sha256("request"),
    provider: { agentVersionId: "agent-v1", adapterName: "responses",
      adapterVersion: "1", modelId: "model-1" },
    preparedAt: "2026-08-12T00:00:01.000Z",
  });
  const sent = markSqliteModelDispatchPossiblySent(database, {
    tenantId: "tenant-1", runId: "run-1", lease: nodeLease,
    attempt: authority.attempt, operationId: prepared.operationId,
    requestSequence: 1, expectedRevision: prepared.revision,
    transitionedAt: "2026-08-12T00:00:02.000Z",
  });
  const observed = observeSqliteModelDispatchResponse(database, {
    tenantId: "tenant-1", runId: "run-1", lease: nodeLease,
    attempt: authority.attempt, operationId: prepared.operationId,
    requestSequence: 1, expectedRevision: sent.revision,
    checkpointDigest: digester.sha256("checkpoint"),
    transitionedAt: "2026-08-12T00:00:03.000Z",
  });
  const continuation = await store.commitWorkflowAssistantContinuation({
    lease: nodeLease, authority, expectedContinuationRevision: null,
    next: { schemaVersion: "crewon.workflow-node-continuation.v0",
      authority, segmentId: "segment-1", modelSampleIndex: 0,
      toolRoundsConsumed: 0, providerCheckpoint: null,
      providerTurnState: null, activeDispatch: {
        operationId: observed.operationId, requestSequence: 1,
        expectedRevision: observed.revision, status: "responseObserved",
      }, history: [] },
    committedAt: "2026-08-12T00:00:03.000Z",
    terminalResult: { status: "completed", output: "{}" },
  });
  clock.set(Date.parse("2026-08-12T00:00:04.000Z"));
  assert.equal(continuation.terminalCandidate?.evidence.status, "completed");
  const terminalInput = {
    binding, operationId: "settle-agent-model-1", lease: nodeLease, authority,
    candidateId: continuation.terminalCandidate!.candidateId,
  };
  const settled = await store.settlePreparedWorkflowNodeTerminal(terminalInput);
  assert.equal(settled.disposition, "settled");
  assert.equal(settled.continuation, null);
  assert.equal(await store.loadWorkflowNodeContinuation(authority), null);
  assert.deepEqual(await store.settlePreparedWorkflowNodeTerminal(terminalInput), {
    ...settled, disposition: "replay",
  });
  await assert.rejects(
    store.settlePreparedWorkflowNodeTerminal({ ...terminalInput,
      candidateId: digester.sha256("different-terminal-candidate") }),
    (error: unknown) => error instanceof RunStoreError &&
      error.code === "workflow_composition_idempotency_conflict",
  );
  database.prepare(`UPDATE run_events SET event_json=json_set(event_json,
    '$.data.claimEpoch',99) WHERE json_extract(event_json,'$.type')='workflow.node.terminal'`).run();
  await assert.rejects(
    store.settlePreparedWorkflowNodeTerminal(terminalInput),
    (error: unknown) => error instanceof RunStoreError &&
      error.code === "workflow_node_terminal_lifecycle_corrupt",
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
        nodeWorkItems: [],
        gatePublications: [],
        reconciliationClaims: [],
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
      assert.deepEqual(await second.admitWorkflowNodeWork(admitInput), {
        ...admitted,
        disposition: "replay",
        admission: null,
      });
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
        terminalResult: null,
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
      const terminalContinuation =
        await store.commitWorkflowAssistantContinuation({
          ...continuationInput,
          expectedContinuationRevision: continuation.revision,
          next: {
            ...continuationInput.next,
            activeDispatch: settlementInput.dispatch,
          },
          committedAt: "2026-08-12T00:00:04.000Z",
          terminalResult: { status: "completed", output: "{}" },
        });
      assert.deepEqual(terminalContinuation.terminalCandidate?.evidence, evidence);
      const candidateId = terminalContinuation.terminalCandidate!.candidateId;
      const preparedTerminalInput = { lease: admitInput.lease, binding,
        authority, candidateId, operationId: settlementInput.operationId };
      const settled = await store.settlePreparedWorkflowNodeTerminal(preparedTerminalInput);
      assert.equal(settled.disposition, "settled");
      assert.equal(
        (await second.settlePreparedWorkflowNodeTerminal(preparedTerminalInput)).disposition,
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
      assert.equal(settled.runDisposition, "nonTerminal");
      assert.equal(settled.execution.status, "running");
      assert.equal(
        settled.execution.nodes.find((node) => node.nodeId === gate.nodeId)
          ?.status,
        "failed",
      );
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
      assert.equal(authority.rows[0]?.run.status, "running");
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

  test("PostgreSQL cancellation atomically closes queued and waiting gate nodes", async () => {
    const schema = `workflow_cancel_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl });
    const store = await PostgresWorkflowRunCompositionStore.open({ pool, schema, digester });
    try {
      await seedPostgresComposition(pool, schema);
      const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
        lease, binding, schedulerOperationId: "schedule-fanout-1",
        workflowInput: { valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
      assert.deepEqual([scheduled.nodeWorkItems.length, scheduled.gatePublications.length], [1, 1]);
      const run = await pool.query<{ state_json: Record<string, unknown> }>(
        `SELECT state_json FROM ${schema}.run_snapshots WHERE run_id='run-1'`);
      await pool.query(`UPDATE ${schema}.run_snapshots SET state_json=$1 WHERE run_id='run-1'`,
        [{ ...run.rows[0]!.state_json, cancelRequested: true }]);
      const cancelWork = { workItemId: "cancel-work-1", tenantId: "tenant-1", runId: "run-1",
        kind: "run.execute", payload: { schemaVersion: "crewon.workflow-cancel-work-item.v0",
          trigger: "workflowCancel", binding, cancellationOperationId: "cancel-1" },
        createdAt: "2026-08-13T00:00:00.000Z" };
      await pool.query(`INSERT INTO ${schema}.work_items
        (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,available_at,
         lease_owner_id,lease_id,lease_epoch,lease_expires_at,attempt_count)
        VALUES ($1,'tenant-1','run-1','run.execute',$2,$3,'leased',$3,
          'cancel-worker','cancel-lease',1,clock_timestamp()+interval '1 minute',1)`,
        [cancelWork.workItemId, cancelWork, cancelWork.createdAt]);
      const input = { tenantId: "tenant-1", runId: "run-1", lease: {
        workItemId: cancelWork.workItemId, ownerId: "cancel-worker",
        leaseId: "cancel-lease", leaseEpoch: 1 }, binding,
        operationId: "cancel-1", reasonCode: "user_requested" } as const;
      const canceled = await store.cancelWorkflowExecution(input);
      assert.deepEqual([canceled.disposition, canceled.runDisposition, canceled.execution.status],
        ["canceled", "terminalConverged", "canceled"]);
      assert.ok(canceled.execution.nodes.every((node) => node.status === "canceled"));
      assert.deepEqual((canceled as typeof canceled & { canceledNodeIds: string[] })
        .canceledNodeIds, ["agent", "gate", "verify"]);
      assert.deepEqual((canceled as typeof canceled & {
        canceledGateRequestNodeIds: string[] }).canceledGateRequestNodeIds, ["gate"]);
      assert.equal((await store.cancelWorkflowExecution(input)).disposition, "replay");
      const durable = await pool.query(`SELECT
        (SELECT state_json->>'status' FROM ${schema}.run_snapshots WHERE run_id='run-1') run_status,
        (SELECT status FROM ${schema}.work_items WHERE work_item_id='cancel-work-1') cancel_status,
        (SELECT status FROM ${schema}.work_items WHERE work_item_json->'payload'->>'trigger'='workflowNode') node_status,
        (SELECT status FROM ${schema}.workflow_gate_requests WHERE run_id='run-1') gate_status,
        (SELECT count(*)::int FROM ${schema}.run_events
          WHERE event_json->>'type'='workflow.node.terminal') node_events,
        (SELECT count(*)::int FROM ${schema}.outbox
          WHERE message_json->'payload'->>'eventType'='workflow.node.terminal') node_outbox`);
      assert.deepEqual(durable.rows[0], { run_status: "canceled", cancel_status: "completed",
        node_status: "completed", gate_status: "canceled", node_events: 3, node_outbox: 3 });
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await store.close();
    }
  });

  test("PostgreSQL cancellation terminates a prepared running node as not sent", async () => {
    const schema = `workflow_cancel_running_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl });
    const store = await PostgresWorkflowRunCompositionStore.open({ pool, schema, digester });
    try {
      await seedPostgresComposition(pool, schema);
      const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
        lease, binding, schedulerOperationId: "schedule-fanout-1",
        workflowInput: { valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
      const work = scheduled.nodeWorkItems[0]!;
      await pool.query(`UPDATE ${schema}.work_items SET status='leased',
        lease_owner_id='node-worker',lease_id='node-lease',lease_epoch=1,
        lease_expires_at=clock_timestamp()+interval '1 minute' WHERE work_item_id=$1`,
        [work.workItemId]);
      const nodeLease = { workItemId: work.workItemId, ownerId: "node-worker",
        leaseId: "node-lease", leaseEpoch: 1 } as const;
      const admitted = await store.admitWorkflowNodeWork({ tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, binding, nodeId: work.nodeId, claimId: work.claimId, claimEpoch: work.claimEpoch,
        schedulerOperationId: "schedule-fanout-1", admissionOperationId: "admit-cancel",
        attemptLeaseDurationMs: 30_000 });
      const attempt = admitted.admission!.attempt;
      const dispatch = await store.prepareModelDispatch({ tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, attempt: { stepId: attempt.stepId, attemptId: attempt.attemptId },
        operationId: "dispatch-cancel", requestSequence: 1, operation: "dispatch",
        requestDigest: digester.sha256("request"), provider: { agentVersionId: "agent-v1",
          adapterName: "responses", adapterVersion: "1", modelId: "model-1" },
        preparedAt: "2026-08-13T00:00:00.000Z" });
      const run = await pool.query<{ state_json: Record<string, unknown> }>(
        `SELECT state_json FROM ${schema}.run_snapshots WHERE run_id='run-1'`);
      await pool.query(`UPDATE ${schema}.run_snapshots SET state_json=$1 WHERE run_id='run-1'`,
        [{ ...run.rows[0]!.state_json, cancelRequested: true }]);
      const input = { tenantId: "tenant-1", runId: "run-1", lease: nodeLease, binding,
        operationId: "cancel-running", reasonCode: "user_requested" } as const;
      const canceled = await store.cancelWorkflowExecution(input);
      assert.deepEqual([canceled.disposition, canceled.runDisposition, canceled.execution.status],
        ["cancellationPending", "nonTerminal", "waitingHuman"]);
      const durable = await pool.query(`SELECT
        (SELECT status FROM ${schema}.model_dispatch_receipts
          WHERE operation_id='dispatch-cancel') dispatch_status,
        (SELECT state_json->'terminalOutcome'->>'certainty' FROM ${schema}.model_dispatch_receipts
          WHERE operation_id='dispatch-cancel') certainty,
        (SELECT status FROM ${schema}.run_attempts WHERE attempt_id=$1) attempt_status,
        (SELECT status FROM ${schema}.work_items WHERE work_item_id=$2) work_status`,
        [attempt.attemptId, work.workItemId]);
      assert.deepEqual(durable.rows[0], { dispatch_status: "terminal", certainty: "notSent",
        attempt_status: "canceled", work_status: "completed" });
      assert.equal(dispatch.status, "prepared");
      assert.equal((await store.cancelWorkflowExecution(input)).disposition, "replay");
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await store.close();
    }
  });

  test("PostgreSQL cancellation fences two running siblings to node-owned leases", async () => {
    const schema = `workflow_cancel_parallel_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl });
    const store = await PostgresWorkflowRunCompositionStore.open({ pool, schema, digester });
    const parallelWorkflow = compileWorkflowVersion({ ...source,
      workflowId: "parallel-workflow", workflowVersionId: "parallel-version",
      entryNodeIds: ["left", "right"], outputNodeIds: ["join"], nodes: [
        { ...common("left"), kind: "agent", agentVersionId: "agent-v1" },
        { ...common("right"), kind: "agent", agentVersionId: "agent-v1" },
        { ...common("join", ["left", "right"]), inputSchema: { ...fanInSchema,
          properties: { left: objectSchema, right: objectSchema }, required: ["left", "right"] },
          kind: "verification", verifierAgentVersionId: "verifier-v1" },
      ] }, digester);
    const parallelBinding = { workflowId: parallelWorkflow.workflowId,
      workflowVersionId: parallelWorkflow.workflowVersionId,
      contentDigest: parallelWorkflow.contentDigest };
    try {
      await seedPostgresComposition(pool, schema, parallelWorkflow, parallelBinding);
      const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
        lease, binding: parallelBinding, schedulerOperationId: "schedule-fanout-1",
        workflowInput: { valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
      assert.deepEqual(scheduled.nodeWorkItems.map((work) => work.nodeId), ["left", "right"]);
      const lanes = [];
      for (const [index, work] of scheduled.nodeWorkItems.entries()) {
        const ownerId = `node-worker-${index}`;
        const leaseId = `node-lease-${index}`;
        await pool.query(`UPDATE ${schema}.work_items SET status='leased',lease_owner_id=$1,
          lease_id=$2,lease_epoch=1,lease_expires_at=clock_timestamp()+interval '1 minute'
          WHERE work_item_id=$3`, [ownerId, leaseId, work.workItemId]);
        const nodeLease = { workItemId: work.workItemId, ownerId, leaseId, leaseEpoch: 1 };
        const admitted = await store.admitWorkflowNodeWork({ tenantId: "tenant-1", runId: "run-1",
          lease: nodeLease, binding: parallelBinding, nodeId: work.nodeId, claimId: work.claimId,
          claimEpoch: work.claimEpoch, schedulerOperationId: "schedule-fanout-1",
          admissionOperationId: `admit-${work.nodeId}`, attemptLeaseDurationMs: 30_000 });
        const attempt = admitted.admission!.attempt;
        await store.prepareModelDispatch({ tenantId: "tenant-1", runId: "run-1", lease: nodeLease,
          attempt: { stepId: attempt.stepId, attemptId: attempt.attemptId },
          operationId: `dispatch-${work.nodeId}`, requestSequence: 1, operation: "dispatch",
          requestDigest: digester.sha256(work.nodeId), provider: { agentVersionId: "agent-v1",
            adapterName: "responses", adapterVersion: "1", modelId: "model-1" },
          preparedAt: "2026-08-13T00:00:00.000Z" });
        lanes.push({ work, nodeLease });
      }
      const run = await pool.query<{ state_json: Record<string, unknown> }>(
        `SELECT state_json FROM ${schema}.run_snapshots WHERE run_id='run-1'`);
      await pool.query(`UPDATE ${schema}.run_snapshots SET state_json=$1 WHERE run_id='run-1'`,
        [{ ...run.rows[0]!.state_json, cancelRequested: true }]);
      const cancelWork = { workItemId: "cancel-work-parallel", tenantId: "tenant-1", runId: "run-1",
        kind: "run.execute", payload: { schemaVersion: "crewon.workflow-cancel-work-item.v0",
          trigger: "workflowCancel", binding: parallelBinding,
          cancellationOperationId: "cancel-parallel" }, createdAt: "2026-08-13T00:00:01.000Z" };
      await pool.query(`INSERT INTO ${schema}.work_items
        (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,available_at,
         lease_owner_id,lease_id,lease_epoch,lease_expires_at,attempt_count)
        VALUES ($1,'tenant-1','run-1','run.execute',$2,$3,'leased',$3,
          'cancel-worker','cancel-lease',1,clock_timestamp()+interval '1 minute',1)`,
        [cancelWork.workItemId, cancelWork, cancelWork.createdAt]);
      const coordinatorInput = { tenantId: "tenant-1", runId: "run-1", binding: parallelBinding,
        operationId: "cancel-parallel", reasonCode: "user_requested", lease: {
          workItemId: cancelWork.workItemId, ownerId: "cancel-worker",
          leaseId: "cancel-lease", leaseEpoch: 1 } } as const;
      const attemptsBefore = await pool.query(`SELECT step_id,status,work_item_id,lease_epoch,state_json
        FROM ${schema}.run_attempts ORDER BY step_id`);
      const retained = await store.cancelWorkflowExecution(coordinatorInput);
      assert.deepEqual([retained.disposition, retained.handoff.currentWorkItem,
        retained.runDisposition], ["retryRequired", "retained", "nonTerminal"]);
      const retainedDurability = await pool.query(`SELECT
        (SELECT count(*)::int FROM ${schema}.workflow_composition_receipts
          WHERE operation_id='cancel-parallel') cancellation_receipts,
        (SELECT count(*)::int FROM ${schema}.run_events
          WHERE event_json->>'type'='run.canceled') final_events,
        (SELECT count(*)::int FROM ${schema}.outbox
          WHERE message_json->'payload'->>'eventType'='run.canceled') final_outbox`);
      assert.deepEqual(retainedDurability.rows[0],
        { cancellation_receipts: 0, final_events: 0, final_outbox: 0 });
      const foreignLeases = await pool.query(`SELECT work_item_json->'payload'->>'nodeId' node_id,
        status,lease_owner_id,lease_id,lease_epoch::int lease_epoch FROM ${schema}.work_items
        WHERE work_item_json->'payload'->>'trigger'='workflowNode' ORDER BY node_id`);
      assert.deepEqual(foreignLeases.rows, [
        { node_id: "left", status: "leased", lease_owner_id: "node-worker-0",
          lease_id: "node-lease-0", lease_epoch: 1 },
        { node_id: "right", status: "leased", lease_owner_id: "node-worker-1",
          lease_id: "node-lease-1", lease_epoch: 1 },
      ]);
      assert.deepEqual((await pool.query(`SELECT step_id,status,work_item_id,lease_epoch,state_json
        FROM ${schema}.run_attempts ORDER BY step_id`)).rows, attemptsBefore.rows);
      for (const lane of lanes) {
        const canceled = await store.cancelWorkflowExecution({ tenantId: "tenant-1", runId: "run-1",
          binding: parallelBinding, lease: lane.nodeLease,
          operationId: `cancel-${lane.work.nodeId}`, reasonCode: "user_requested" });
        assert.equal(canceled.disposition, "cancellationPending");
      }
      const final = await store.cancelWorkflowExecution(coordinatorInput);
      assert.deepEqual([final.disposition, final.runDisposition, final.execution.status,
        final.handoff.currentWorkItem], ["canceled", "terminalConverged", "canceled", "completed"]);
      const durable = await pool.query(`SELECT
        (SELECT count(*)::int FROM ${schema}.run_attempts WHERE status!='canceled') live_attempts,
        (SELECT count(*)::int FROM ${schema}.work_items WHERE status!='completed') stranded_work,
        (SELECT state_json->>'status' FROM ${schema}.run_snapshots WHERE run_id='run-1') run_status`);
      assert.deepEqual(durable.rows[0],
        { live_attempts: 0, stranded_work: 0, run_status: "canceled" });
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await store.close();
    }
  });

  test("PostgreSQL cancellation coordinates multiple uncertain siblings in execution order", async () => {
    const schema = `workflow_cancel_uncertain_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl });
    const store = await PostgresWorkflowRunCompositionStore.open({ pool, schema, digester });
    const parallelWorkflow = compileWorkflowVersion({ ...source,
      workflowId: "uncertain-workflow", workflowVersionId: "uncertain-version",
      entryNodeIds: ["left", "right"], outputNodeIds: ["join"], nodes: [
        { ...common("left"), kind: "agent", agentVersionId: "agent-v1" },
        { ...common("right"), kind: "agent", agentVersionId: "agent-v1" },
        { ...common("join", ["left", "right"]), inputSchema: { ...fanInSchema,
          properties: { left: objectSchema, right: objectSchema }, required: ["left", "right"] },
          kind: "verification", verifierAgentVersionId: "verifier-v1" },
      ] }, digester);
    const parallelBinding = { workflowId: parallelWorkflow.workflowId,
      workflowVersionId: parallelWorkflow.workflowVersionId,
      contentDigest: parallelWorkflow.contentDigest };
    try {
      await seedPostgresComposition(pool, schema, parallelWorkflow, parallelBinding);
      const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
        lease, binding: parallelBinding, schedulerOperationId: "schedule-uncertain",
        workflowInput: { valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
      const lanes = [];
      for (const [index, work] of scheduled.nodeWorkItems.entries()) {
        const ownerId = `uncertain-worker-${index}`;
        const leaseId = `uncertain-lease-${index}`;
        await pool.query(`UPDATE ${schema}.work_items SET status='leased',lease_owner_id=$1,
          lease_id=$2,lease_epoch=1,lease_expires_at=clock_timestamp()+interval '1 minute'
          WHERE work_item_id=$3`, [ownerId, leaseId, work.workItemId]);
        const nodeLease = { workItemId: work.workItemId, ownerId, leaseId, leaseEpoch: 1 };
        const admitted = await store.admitWorkflowNodeWork({ tenantId: "tenant-1", runId: "run-1",
          lease: nodeLease, binding: parallelBinding, nodeId: work.nodeId, claimId: work.claimId,
          claimEpoch: work.claimEpoch, schedulerOperationId: "schedule-uncertain",
          admissionOperationId: `admit-uncertain-${work.nodeId}`, attemptLeaseDurationMs: 30_000 });
        const attempt = admitted.admission!.attempt;
        const prepared = await store.prepareModelDispatch({ tenantId: "tenant-1", runId: "run-1",
          lease: nodeLease, attempt: { stepId: attempt.stepId, attemptId: attempt.attemptId },
          operationId: `dispatch-uncertain-${work.nodeId}`, requestSequence: 1,
          operation: "dispatch", requestDigest: digester.sha256(work.nodeId), provider: {
            agentVersionId: "agent-v1", adapterName: "responses", adapterVersion: "1",
            modelId: "model-1" }, preparedAt: "2026-08-13T00:00:00.000Z" });
        await store.markModelDispatchPossiblySent({ tenantId: "tenant-1", runId: "run-1",
          lease: nodeLease, attempt: prepared, operationId: prepared.operationId,
          requestSequence: 1, expectedRevision: prepared.revision,
          transitionedAt: "2026-08-13T00:00:01.000Z" });
        lanes.push({ work, nodeLease });
      }
      const run = await pool.query<{ state_json: Record<string, unknown> }>(
        `SELECT state_json FROM ${schema}.run_snapshots WHERE run_id='run-1'`);
      await pool.query(`UPDATE ${schema}.run_snapshots SET state_json=$1 WHERE run_id='run-1'`,
        [{ ...run.rows[0]!.state_json, cancelRequested: true }]);
      for (const lane of lanes) {
        const canceled = await store.cancelWorkflowExecution({ tenantId: "tenant-1", runId: "run-1",
          binding: parallelBinding, lease: lane.nodeLease,
          operationId: `cancel-uncertain-${lane.work.nodeId}`, reasonCode: "user_requested" });
        assert.equal(canceled.disposition, "reconciliationScheduled");
      }
      const priorReconcile = await pool.query<{ work_item_id: string }>(`SELECT work_item_id
        FROM ${schema}.work_items WHERE work_item_json->'payload'->>'trigger'='workflowReconcile'
        ORDER BY work_item_json->'payload'->>'nodeId'`);
      assert.equal(priorReconcile.rows.length, 2);
      await pool.query(`DELETE FROM ${schema}.work_items WHERE work_item_id=$1`,
        [priorReconcile.rows[1]!.work_item_id]);
      const cancelWork = { workItemId: "cancel-work-uncertain", tenantId: "tenant-1",
        runId: "run-1", kind: "run.execute", payload: {
          schemaVersion: "crewon.workflow-cancel-work-item.v0", trigger: "workflowCancel",
          binding: parallelBinding, cancellationOperationId: "cancel-uncertain" },
        createdAt: "2026-08-13T00:00:02.000Z" };
      await pool.query(`INSERT INTO ${schema}.work_items
        (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,available_at,
         lease_owner_id,lease_id,lease_epoch,lease_expires_at,attempt_count)
        VALUES ($1,'tenant-1','run-1','run.execute',$2,$3,'leased',$3,
          'cancel-worker','cancel-lease',1,clock_timestamp()+interval '1 minute',1)`,
        [cancelWork.workItemId, cancelWork, cancelWork.createdAt]);
      const cancelInput = { tenantId: "tenant-1", runId: "run-1", binding: parallelBinding,
        operationId: "cancel-uncertain", reasonCode: "user_requested", lease: {
          workItemId: cancelWork.workItemId, ownerId: "cancel-worker",
          leaseId: "cancel-lease", leaseEpoch: 1 } } as const;
      const coordinated = await store.cancelWorkflowExecution(cancelInput);
      const typed = coordinated as typeof coordinated & { canceledNodeIds: string[];
        reconciliationWorkItemIds: string[] };
      assert.deepEqual([typed.disposition, typed.runDisposition, typed.canceledNodeIds,
        typed.handoff], ["retryRequired", "nonTerminal", ["join"], {
          currentWorkItem: "retained", nextWorkItemId: null, kind: "none" }]);
      assert.deepEqual(typed.reconciliationWorkItemIds,
        [...typed.reconciliationWorkItemIds].sort());
      const reconciliations = await pool.query<{ work_item_id: string; node_id: string }>(`SELECT
        work_item_id,work_item_json->'payload'->>'nodeId' node_id FROM ${schema}.work_items
        WHERE work_item_id=ANY($1::text[]) ORDER BY node_id`,
        [typed.reconciliationWorkItemIds]);
      assert.deepEqual(reconciliations.rows.map((row) => row.node_id), ["left", "right"]);
      assert.ok(typed.reconciliationWorkItemIds.includes(priorReconcile.rows[0]!.work_item_id));
      assert.equal(reconciliations.rows.length, 2);
      assert.equal((await store.cancelWorkflowExecution(cancelInput)).disposition,
        "retryRequired");
      const receipt = await pool.query(`SELECT count(*)::int count FROM
        ${schema}.workflow_composition_receipts WHERE operation_id='cancel-uncertain'`);
      assert.equal(receipt.rows[0]?.count, 0);
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await store.close();
    }
  });

  test("PostgreSQL cancellation retains possibly-sent reconciliation authority", async () => {
    const schema = `workflow_cancel_unknown_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl });
    const store = await PostgresWorkflowRunCompositionStore.open({ pool, schema, digester });
    try {
      await seedPostgresComposition(pool, schema);
      const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
        lease, binding, schedulerOperationId: "schedule-fanout-1",
        workflowInput: { valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
      const work = scheduled.nodeWorkItems[0]!;
      await pool.query(`UPDATE ${schema}.work_items SET status='leased',lease_owner_id='node-worker',
        lease_id='node-lease',lease_epoch=1,lease_expires_at=clock_timestamp()+interval '1 minute'
        WHERE work_item_id=$1`, [work.workItemId]);
      const nodeLease = { workItemId: work.workItemId, ownerId: "node-worker",
        leaseId: "node-lease", leaseEpoch: 1 } as const;
      const admitted = await store.admitWorkflowNodeWork({ tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, binding, nodeId: work.nodeId, claimId: work.claimId,
        claimEpoch: work.claimEpoch, schedulerOperationId: "schedule-fanout-1",
        admissionOperationId: "admit-unknown", attemptLeaseDurationMs: 30_000 });
      const attempt = admitted.admission!.attempt;
      const prepared = await store.prepareModelDispatch({ tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, attempt: { stepId: attempt.stepId, attemptId: attempt.attemptId },
        operationId: "dispatch-unknown", requestSequence: 1, operation: "dispatch",
        requestDigest: digester.sha256("request"), provider: { agentVersionId: "agent-v1",
          adapterName: "responses", adapterVersion: "1", modelId: "model-1" },
        preparedAt: "2026-08-13T00:00:00.000Z" });
      await store.markModelDispatchPossiblySent({ tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, attempt: prepared, operationId: prepared.operationId,
        requestSequence: 1, expectedRevision: prepared.revision,
        transitionedAt: "2026-08-13T00:00:01.000Z" });
      const run = await pool.query<{ state_json: Record<string, unknown> }>(
        `SELECT state_json FROM ${schema}.run_snapshots WHERE run_id='run-1'`);
      await pool.query(`UPDATE ${schema}.run_snapshots SET state_json=$1 WHERE run_id='run-1'`,
        [{ ...run.rows[0]!.state_json, cancelRequested: true }]);
      const input = { tenantId: "tenant-1", runId: "run-1", lease: nodeLease, binding,
        operationId: "cancel-unknown", reasonCode: "user_requested" } as const;
      const canceled = await store.cancelWorkflowExecution(input);
      assert.deepEqual([canceled.disposition, canceled.runDisposition, canceled.execution.status],
        ["reconciliationScheduled", "nonTerminal", "running"]);
      assert.equal(canceled.execution.nodes.find((node) => node.nodeId === work.nodeId)?.status,
        "unknown");
      const reconciliation = await pool.query(`SELECT status,work_item_json->'payload' payload
        FROM ${schema}.work_items WHERE work_item_id=$1`, [canceled.handoff.nextWorkItemId]);
      assert.equal(reconciliation.rows[0]?.status, "pending");
      assert.equal(reconciliation.rows[0]?.payload.trigger, "workflowReconcile");
      assert.equal((await store.cancelWorkflowExecution(input)).disposition, "replay");
      await pool.query(`UPDATE ${schema}.work_items SET status='leased',
        lease_owner_id='reconcile-worker',lease_id='reconcile-lease',lease_epoch=1,
        lease_expires_at=clock_timestamp()+interval '1 minute' WHERE work_item_id=$1`,
        [canceled.handoff.nextWorkItemId]);
      const reconciled = await store.reconcileWorkflowNode({ tenantId: "tenant-1",
        runId: "run-1", lease: { workItemId: canceled.handoff.nextWorkItemId!,
          ownerId: "reconcile-worker", leaseId: "reconcile-lease", leaseEpoch: 1 },
        binding, nodeId: work.nodeId, claimId: work.claimId, claimEpoch: work.claimEpoch,
        reconciliationOperationId: "cancel-unknown:agent" });
      assert.deepEqual([reconciled.disposition, reconciled.evidenceStatus,
        reconciled.handoff.currentWorkItem], ["retryRequired", "possiblySent", "retained"]);
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await store.close();
    }
  });

  test("PostgreSQL canceled reconciliation rejects a late response outcome", async () => {
    const schema = `workflow_cancel_late_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl });
    const store = await PostgresWorkflowRunCompositionStore.open({ pool, schema, digester });
    try {
      await seedPostgresComposition(pool, schema);
      const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
        lease, binding, schedulerOperationId: "schedule-fanout-1",
        workflowInput: { valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
      const work = scheduled.nodeWorkItems[0]!;
      await pool.query(`UPDATE ${schema}.work_items SET status='leased',lease_owner_id='node-worker',
        lease_id='node-lease',lease_epoch=1,lease_expires_at=clock_timestamp()+interval '1 minute'
        WHERE work_item_id=$1`, [work.workItemId]);
      const nodeLease = { workItemId: work.workItemId, ownerId: "node-worker",
        leaseId: "node-lease", leaseEpoch: 1 } as const;
      const admitted = await store.admitWorkflowNodeWork({ tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, binding, nodeId: work.nodeId, claimId: work.claimId,
        claimEpoch: work.claimEpoch, schedulerOperationId: "schedule-fanout-1",
        admissionOperationId: "admit-late", attemptLeaseDurationMs: 30_000 });
      const attempt = admitted.admission!.attempt;
      const prepared = await store.prepareModelDispatch({ tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, attempt: { stepId: attempt.stepId, attemptId: attempt.attemptId },
        operationId: "dispatch-late", requestSequence: 1, operation: "dispatch",
        requestDigest: digester.sha256("request"), provider: { agentVersionId: "agent-v1",
          adapterName: "responses", adapterVersion: "1", modelId: "model-1" },
        preparedAt: "2026-08-13T00:00:00.000Z" });
      const sent = await store.markModelDispatchPossiblySent({ tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, attempt: prepared, operationId: prepared.operationId, requestSequence: 1,
        expectedRevision: prepared.revision, transitionedAt: "2026-08-13T00:00:01.000Z" });
      const observed = await store.observeModelDispatchResponse({ tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, attempt: prepared, operationId: prepared.operationId, requestSequence: 1,
        expectedRevision: sent.revision, checkpointDigest: digester.sha256("checkpoint"),
        transitionedAt: "2026-08-13T00:00:02.000Z" });
      const authority = { tenantId: "tenant-1", runId: "run-1", workItemId: work.workItemId,
        leaseEpoch: 1, nodeId: work.nodeId, nodeKind: "agent" as const,
        claimId: work.claimId, claimEpoch: work.claimEpoch, agentVersionId: "agent-v1",
        attempt: { stepId: attempt.stepId, attemptId: attempt.attemptId } };
      const evidence = createWorkflowNodeTerminalEvidence({ workflow, nodeId: work.nodeId,
        outcome: { status: "completed", value: {} }, digester });
      const candidate = { schemaVersion: "crewon.workflow-node-terminal-candidate.v0",
        candidateId: digester.sha256("late-candidate"), segmentId: "segment-late", evidence,
        dispatchTerminalOutcome: { kind: "completed", code: null,
          certainty: "responseObserved" } } as const;
      const checkpoint = { schemaVersion: "crewon.workflow-node-continuation.v0", authority,
        segmentId: "segment-late", modelSampleIndex: 1, toolRoundsConsumed: 0,
        providerCheckpoint: null, providerTurnState: null,
        activeDispatch: { operationId: observed.operationId, requestSequence: 1,
          expectedRevision: observed.revision, status: "responseObserved" },
        terminalCandidate: candidate, history: [], revision: 1,
        updatedAt: "2026-08-13T00:00:03.000Z" };
      await pool.query(`INSERT INTO ${schema}.workflow_node_continuations
        (tenant_id,run_id,node_id,attempt_id,revision,state_json,updated_at)
        VALUES ('tenant-1','run-1',$1,$2,1,$3,$4)`,
        [work.nodeId, attempt.attemptId, checkpoint, checkpoint.updatedAt]);
      const run = await pool.query<{ state_json: Record<string, unknown> }>(
        `SELECT state_json FROM ${schema}.run_snapshots WHERE run_id='run-1'`);
      await pool.query(`UPDATE ${schema}.run_snapshots SET state_json=$1 WHERE run_id='run-1'`,
        [{ ...run.rows[0]!.state_json, cancelRequested: true }]);
      const cancelInput = { tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, binding, operationId: "cancel-late",
        reasonCode: "user_requested" } as const;
      const canceled = await store.cancelWorkflowExecution(cancelInput);
      await pool.query(`UPDATE ${schema}.work_items SET status='leased',
        lease_owner_id='reconcile-worker',lease_id='reconcile-lease',lease_epoch=1,
        lease_expires_at=clock_timestamp()+interval '1 minute' WHERE work_item_id=$1`,
        [canceled.handoff.nextWorkItemId]);
      const reconciled = await store.reconcileWorkflowNode({ tenantId: "tenant-1", runId: "run-1",
        lease: { workItemId: canceled.handoff.nextWorkItemId!, ownerId: "reconcile-worker",
          leaseId: "reconcile-lease", leaseEpoch: 1 }, binding, nodeId: work.nodeId,
        claimId: work.claimId, claimEpoch: work.claimEpoch,
        reconciliationOperationId: "cancel-late:agent" });
      assert.deepEqual([reconciled.disposition, reconciled.evidenceStatus,
        reconciled.runDisposition, reconciled.execution.status],
        ["settled", "responseObserved", "nonTerminal", "waitingHuman"]);
      const durable = await pool.query(`SELECT
        (SELECT state_json->>'status' FROM ${schema}.run_snapshots WHERE run_id='run-1') run_status,
        (SELECT status FROM ${schema}.run_attempts WHERE attempt_id=$1) attempt_status,
        (SELECT status FROM ${schema}.model_dispatch_receipts WHERE operation_id='dispatch-late') dispatch_status`,
        [attempt.attemptId]);
      assert.deepEqual(durable.rows[0], { run_status: "running",
        attempt_status: "canceled", dispatch_status: "terminal" });
      const replay = await store.cancelWorkflowExecution(cancelInput);
      assert.deepEqual([replay.disposition, replay.execution.nodes[0]?.status,
        (replay as typeof replay & { reconciliationWorkItemIds: string[] })
          .reconciliationWorkItemIds],
        ["replay", "unknown", [canceled.handoff.nextWorkItemId]]);
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await store.close();
    }
  });

  test("PostgreSQL not-dispatched reconciliation creates one new node authority", async () => {
    const schema = `workflow_retry_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: postgresUrl });
    const store = await PostgresWorkflowRunCompositionStore.open({ pool, schema, digester });
    try {
      await seedPostgresComposition(pool, schema);
      const scheduled = await store.scheduleWorkflowNodes({ tenantId: "tenant-1", runId: "run-1",
        lease, binding, schedulerOperationId: "schedule-fanout-1",
        workflowInput: { valueId: "root-value-1", valueDigest: digester.sha256("{}") } });
      const work = scheduled.nodeWorkItems[0]!;
      await pool.query(`UPDATE ${schema}.work_items SET status='leased',lease_owner_id='node-worker',
        lease_id='node-lease',lease_epoch=1,lease_expires_at=clock_timestamp()+interval '1 minute'
        WHERE work_item_id=$1`, [work.workItemId]);
      const nodeLease = { workItemId: work.workItemId, ownerId: "node-worker",
        leaseId: "node-lease", leaseEpoch: 1 } as const;
      const admitted = await store.admitWorkflowNodeWork({ tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, binding, nodeId: work.nodeId, claimId: work.claimId,
        claimEpoch: work.claimEpoch, schedulerOperationId: "schedule-fanout-1",
        admissionOperationId: "admit-retry", attemptLeaseDurationMs: 30_000 });
      const attempt = admitted.admission!.attempt;
      await store.prepareModelDispatch({ tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, attempt: { stepId: attempt.stepId, attemptId: attempt.attemptId },
        operationId: "dispatch-retry", requestSequence: 1, operation: "dispatch",
        requestDigest: digester.sha256("request"), provider: { agentVersionId: "agent-v1",
          adapterName: "responses", adapterVersion: "1", modelId: "model-1" },
        preparedAt: "2026-08-13T00:00:00.000Z" });
      const unknown = await store.settleWorkflowNode({ tenantId: "tenant-1", runId: "run-1",
        lease: nodeLease, binding, nodeId: work.nodeId, claimId: work.claimId,
        claimEpoch: work.claimEpoch, stepId: attempt.stepId, attemptId: attempt.attemptId,
        operationId: "unknown-retry", outcome: { status: "unknown" } });
      await pool.query(`UPDATE ${schema}.work_items SET status='leased',
        lease_owner_id='reconcile-worker',lease_id='reconcile-lease',lease_epoch=1,
        lease_expires_at=clock_timestamp()+interval '1 minute' WHERE work_item_id=$1`,
        [unknown.handoff.nextWorkItemId]);
      const input = { tenantId: "tenant-1", runId: "run-1", lease: {
        workItemId: unknown.handoff.nextWorkItemId!, ownerId: "reconcile-worker",
        leaseId: "reconcile-lease", leaseEpoch: 1 }, binding, nodeId: work.nodeId,
        claimId: work.claimId, claimEpoch: work.claimEpoch,
        reconciliationOperationId: "unknown-retry" } as const;
      const retried = await store.reconcileWorkflowNode(input);
      assert.deepEqual([retried.disposition, retried.evidenceStatus,
        retried.handoff.kind], ["retryScheduled", "notDispatched", "node"]);
      assert.equal(retried.execution.nodes.find((node) => node.nodeId === work.nodeId)?.claimEpoch,
        work.claimEpoch + 1);
      const count = await pool.query<{ count: number }>(`SELECT count(*)::int count
        FROM ${schema}.work_items WHERE work_item_id=$1`, [retried.handoff.nextWorkItemId]);
      assert.equal(count.rows[0]?.count, 1);
      assert.equal((await store.reconcileWorkflowNode(input)).disposition, "replay");
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await store.close();
    }
  });
}

async function seedPostgresComposition(
  pool: Pool,
  schema: string,
  workflowAsset = workflow,
  bindingAsset = binding,
): Promise<void> {
  const run = runState(bindingAsset);
  await pool.query(
    `INSERT INTO ${schema}.workflow_versions
    (tenant_id,workflow_id,workflow_version_id,content_digest,definition_json,created_at)
    VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      "tenant-1",
      workflowAsset.workflowId,
      workflowAsset.workflowVersionId,
      workflowAsset.contentDigest,
      serializeCompiledWorkflowVersion(workflowAsset),
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
  await seedPostgresSchedulerWork(
    pool, schema, "work-1", "schedule-fanout-1", "1 minute", bindingAsset);
}

async function seedPostgresSchedulerWork(
  pool: Pool,
  schema: string,
  workItemId: string,
  operationId: string,
  expiry = "1 minute",
  bindingAsset = binding,
): Promise<void> {
  const now = "2026-08-12T00:00:00.000Z";
  const payload = {
    schemaVersion: "crewon.workflow-scheduler-work-item.v1",
    trigger: "workflowScheduler",
    binding: bindingAsset,
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
  workflowAsset = workflow,
  bindingAsset = binding,
): Promise<void> {
  const database =
    typeof databaseOrPath === "string"
      ? new DatabaseSync(databaseOrPath)
      : databaseOrPath;
  const versions = new SqliteWorkflowVersionStore(database, digester);
  await versions.registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0",
    tenantId: "tenant-1",
    workflowId: workflowAsset.workflowId,
    workflowVersionId: workflowAsset.workflowVersionId,
    contentDigest: workflowAsset.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflowAsset),
    createdAt: "2026-08-12T00:00:00.000Z",
  });
  const run = runState(bindingAsset);
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
  if (database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'`).get() !==
      undefined && database.prepare(`SELECT 1 FROM threads
        WHERE tenant_id='tenant-1' AND thread_id='thread-1'`).get() !== undefined)
    database.prepare(`INSERT INTO run_thread_bindings(tenant_id,run_id,thread_id)
      VALUES ('tenant-1','run-1','thread-1')`).run();
  const created = { schemaVersion: "crewon.run-event.v0", identity: { runId: "run-1" },
    eventId: "seed-run-created", sequence: 1, occurredAt: run.createdAt,
    type: "run.created", data: { threadId: run.threadId, tenantId: run.tenantId,
      spaceId: run.spaceId, createdByActorId: run.createdByActorId,
      authorityId: run.authorityId, runtimeGeneration: run.runtimeGeneration,
      agentVersionId: run.agentVersionId, policySnapshotId: run.policySnapshotId,
      workspaceBindingId: null, workflowVersionBinding: bindingAsset,
      collaborationMode: "default", goalBinding: null, purpose: "workflow", origin: null } };
  const started = { schemaVersion: "crewon.run-event.v0", identity: { runId: "run-1" },
    eventId: "seed-run-started", sequence: 2, occurredAt: run.updatedAt,
    type: "run.started", data: {} };
  const insertEvent = database.prepare(`INSERT INTO run_events
    (tenant_id,run_id,sequence,event_id,event_json) VALUES ('tenant-1','run-1',?,?,?)`);
  insertEvent.run(1, created.eventId, JSON.stringify(created));
  insertEvent.run(2, started.eventId, JSON.stringify(started));
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
          binding: bindingAsset,
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

function runState(bindingValue = binding): RunState {
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
    workflowVersionBinding: bindingValue,
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
