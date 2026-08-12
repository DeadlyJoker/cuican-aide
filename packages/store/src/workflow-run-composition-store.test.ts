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
  await assert.rejects(store.cancelWorkflowExecution(input),
    (error: unknown) => error instanceof RunStoreError &&
      error.code === "workflow_cancellation_wakeup_leased");
  const rolledBack = new DatabaseSync(path);
  assert.equal(rolledBack.prepare(`SELECT count(*) count FROM run_events
    WHERE json_extract(event_json,'$.type')='workflow.node.terminal'`).get()!.count, 0);
  rolledBack.close();
  await competing.retryWorkItem({ workItemId: cancelClaim!.workItem.workItemId,
    ownerId: "cancel-wake-worker", leaseId: "cancel-wake-lease",
    leaseEpoch: cancelClaim!.lease.epoch, retryAfterMs: 0, reasonCode: "cancel_authority_yield" });
  await competing.close();
  const result = await store.cancelWorkflowExecution(input);
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
    ...result, disposition: "replay",
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
  prepareSqliteModelDispatch(dispatchDatabase, { tenantId: "tenant-1", runId: "run-1",
    lease: nodeLease, attempt, operationId: "prepared-dispatch", requestSequence: 1,
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
  assert.equal(canceled.runDisposition, "terminalConverged");
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
  assert.equal(canceled.disposition, "reconciliationScheduled");
  assert.equal(canceled.execution.nodes[0]!.status, "unknown");
  assert.equal(canceled.runDisposition, "nonTerminal");
  assert.deepEqual(await store.cancelWorkflowExecution(cancelInput),
    { ...canceled, disposition: "replay" });
  const database = new DatabaseSync(path);
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
      assert.equal((await store.cancelWorkflowExecution(input)).disposition, "replay");
      const durable = await pool.query(`SELECT
        (SELECT state_json->>'status' FROM ${schema}.run_snapshots WHERE run_id='run-1') run_status,
        (SELECT status FROM ${schema}.work_items WHERE work_item_id='cancel-work-1') cancel_status,
        (SELECT status FROM ${schema}.work_items WHERE work_item_json->'payload'->>'trigger'='workflowNode') node_status,
        (SELECT status FROM ${schema}.workflow_gate_requests WHERE run_id='run-1') gate_status`);
      assert.deepEqual(durable.rows[0], { run_status: "canceled", cancel_status: "completed",
        node_status: "completed", gate_status: "canceled" });
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
        ["canceled", "terminalConverged", "canceled"]);
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
      workspaceBindingId: null, workflowVersionBinding: binding,
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
