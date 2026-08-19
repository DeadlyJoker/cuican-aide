import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  canonicalJson,
  RunStoreError,
  type WorkflowAgentAttemptAuthority,
  type WorkflowExecutionState,
  type WorkflowNodeContinuationCheckpoint,
  type WorkflowPendingToolResume,
} from "@crewon/application";
import { canonicalActionIntent } from "@crewon/contracts/runtime";
import {
  compileWorkflowVersion,
  createWorkflowNodeTerminalEvidence,
  dispatchToolExecutionReceipt,
  markToolExecutionUnknownOutcome,
  prepareToolExecutionReceipt,
  reduceRunLifecycleEvent,
  resolveToolExecutionReceipt,
  serializeCompiledWorkflowVersion,
  type RunState,
  type ToolExecutionReceiptState,
  type WorkflowVersionSource,
} from "@crewon/domain";

import {
  beginSqliteRunAttempt,
  checkpointSqliteRunAttempt,
  loadSqliteRunAttempt,
} from "./sqlite-execution-authority.ts";
import type { LeaseClock } from "./lease-clock.ts";
import {
  loadSqliteModelDispatchReceipt,
  markSqliteModelDispatchPossiblySent,
  observeSqliteModelDispatchResponse,
  prepareSqliteModelDispatch,
} from "./sqlite-model-dispatch-evidence.ts";
import {
  insertSqliteToolExecutionReceipt,
  loadSqliteToolExecutionReceipt,
} from "./sqlite-tool-execution-receipts.ts";
import { appendSqliteWorkflowRetrievedEventSuffix } from "./sqlite-workflow-retrieved-events.ts";
import { SqliteWorkflowRunCompositionStore } from "./sqlite-workflow-run-composition-store.ts";
import { SqliteWorkflowVersionStore } from "./workflow-version-store.ts";

const now = "2026-08-19T00:00:00.000Z";
const nowMs = Date.parse(now);
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
const source: WorkflowVersionSource = {
  schemaVersion: "crewon.workflow-version-source.v0",
  workflowId: "workflow-1",
  workflowVersionId: "workflow-version-1",
  name: "continuation takeover",
  description: "continuation takeover",
  inputSchema: objectSchema,
  outputSchema: objectSchema,
  entryNodeIds: ["agent"],
  outputNodeIds: ["verify"],
  nodes: [
    {
      nodeId: "agent",
      title: "agent",
      instruction: "continue",
      dependsOn: [],
      inputSchema: objectSchema,
      outputSchema: objectSchema,
      kind: "agent",
      agentVersionId: "agent-v1",
    },
    {
      nodeId: "verify",
      title: "verify",
      instruction: "verify",
      dependsOn: ["agent"],
      inputSchema: objectSchema,
      outputSchema: objectSchema,
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

test("SQLite reconciliation atomically adopts a durable nonterminal continuation", async () => {
  const fixture = await continuationFixture();
  const beforeEventCount = count(fixture.database, "run_events");
  const beforeExecution = storedExecution(fixture.database);
  const result = await fixture.store.reconcileWorkflowNode(
    fixture.reconcileInput,
  );
  const resumed = requireResume(result);

  assert.deepEqual(resumed.resume.claim, {
    node: workflow.nodes[0],
    claimId: fixture.work.claimId,
    claimEpoch: fixture.work.claimEpoch,
    gateRequestId: null,
    inputDigest: fixture.inputDigest,
  });
  assert.deepEqual(
    resumed.resume.reconciliationLease,
    fixture.reconcileInput.lease,
  );
  assert.equal(
    resumed.resume.attempt.workItemId,
    fixture.reconcileInput.lease.workItemId,
  );
  assert.equal(
    resumed.resume.attempt.leaseEpoch,
    fixture.reconcileInput.lease.leaseEpoch,
  );
  assert.equal(resumed.resume.attempt.status, "running");
  assert.deepEqual(resumed.resume.continuation.history, fixture.history);
  assert.deepEqual(resumed.resume.continuation.authority, {
    ...fixture.authority,
    workItemId: fixture.reconcileInput.lease.workItemId,
    leaseEpoch: fixture.reconcileInput.lease.leaseEpoch,
  });
  assert.equal(resumed.resume.continuation.activeDispatch, null);
  assert.equal(resumed.resume.continuation.terminalCandidate, null);
  assert.equal(resumed.resume.continuation.revision, 2);
  assert.deepEqual(resumed.resume.pendingTools, []);
  assert.equal(resumed.execution.revision, beforeExecution.revision + 1);
  assert.deepEqual(resumed.execution.nodes[0], {
    ...beforeExecution.nodes[0],
    status: "running",
    leaseExpiresAt: new Date(nowMs + 60_000).toISOString(),
  });
  assert.deepEqual(storedExecution(fixture.database), resumed.execution);
  assert.equal(count(fixture.database, "run_events"), beforeEventCount);
  assert.deepEqual(dispatchState(fixture), {
    status: "terminal",
    revision: fixture.observed.revision + 1,
    terminalOutcome: {
      kind: "completed",
      code: null,
      certainty: "responseObserved",
    },
  });
  assert.deepEqual(workItemLease(fixture), {
    status: "leased",
    leaseOwnerId: "reconcile-worker",
    leaseId: "reconcile-lease",
    leaseEpoch: 1,
  });

  const replay = await fixture.store.reconcileWorkflowNode(
    fixture.reconcileInput,
  );
  assert.equal(replay.disposition, "resumeRequired");
  assert.equal(
    requireResume(replay).execution.revision,
    resumed.execution.revision,
  );
  assert.equal(storedContinuation(fixture.database).revision, 2);
  assert.deepEqual(dispatchState(fixture), {
    status: "terminal",
    revision: fixture.observed.revision + 1,
    terminalOutcome: {
      kind: "completed",
      code: null,
      certainty: "responseObserved",
    },
  });
  const { revision, updatedAt, terminalCandidate, ...next } =
    resumed.resume.continuation;
  const committed = await fixture.store.commitWorkflowAssistantContinuation({
    lease: fixture.reconcileInput.lease,
    authority: resumed.resume.continuation.authority,
    expectedContinuationRevision: revision,
    next,
    committedAt: updatedAt,
    terminalResult: null,
  });
  assert.equal(terminalCandidate, null);
  assert.equal(committed.revision, revision + 1);
  fixture.database.close();
});

for (const status of ["prepared", "dispatched", "unknownOutcome"] as const) {
  test(`SQLite reconciliation adopts one ${status} pending Tool without changing its dispatch state`, async () => {
    const fixture = await continuationFixture({
      pendingToolStatuses: [status],
    });
    const before = fixture.pendingTools[0]!.receipt;
    const resumed = requireResume(
      await fixture.store.reconcileWorkflowNode(fixture.reconcileInput),
    );
    const pending = resumed.resume.pendingTools[0]!;

    assert.equal(resumed.resume.pendingTools.length, 1);
    assert.equal(pending.receipt.status, status);
    assert.equal(pending.receipt.revision, before.revision + 1);
    assert.equal(
      pending.receipt.workItemId,
      fixture.reconcileInput.lease.workItemId,
    );
    assert.deepEqual(
      {
        stepId: pending.step.stepId,
        stepKind: pending.step.kind,
        stepStatus: pending.step.status,
        attemptId: pending.attempt.attemptId,
        attemptStatus: pending.attempt.status,
        workItemId: pending.attempt.workItemId,
        leaseEpoch: pending.attempt.leaseEpoch,
      },
      {
        stepId: before.stepId,
        stepKind: "tool",
        stepStatus: "running",
        attemptId: before.attemptId,
        attemptStatus: "running",
        workItemId: fixture.reconcileInput.lease.workItemId,
        leaseEpoch: fixture.reconcileInput.lease.leaseEpoch,
      },
    );
    assert.deepEqual(storedPendingTool(fixture), pending);

    const retry = requireResume(
      await fixture.store.reconcileWorkflowNode(fixture.reconcileInput),
    );
    assert.deepEqual(retry.resume.pendingTools, resumed.resume.pendingTools);
    assert.deepEqual(storedPendingTool(fixture), pending);
    fixture.database.close();
  });
}

test("SQLite pending Tool adoption rolls parent and Tool authorities back together", async () => {
  const fixture = await continuationFixture({
    pendingToolStatuses: ["prepared"],
  });
  const beforeReceipt = fixture.pendingTools[0]!.receipt;
  const beforeExecution = storedExecution(fixture.database);
  fixture.database.exec(`CREATE TRIGGER fail_pending_tool_takeover
    BEFORE UPDATE ON tool_execution_receipts
    BEGIN SELECT RAISE(ABORT, 'pending-tool-crash'); END`);

  await assert.rejects(
    fixture.store.reconcileWorkflowNode(fixture.reconcileInput),
    (error) =>
      error instanceof RunStoreError &&
      error.code === "workflow_composition_store_failed" &&
      error.cause instanceof Error &&
      error.cause.message === "pending-tool-crash",
  );
  assert.deepEqual(dispatchState(fixture), {
    status: "responseObserved",
    revision: fixture.observed.revision,
    terminalOutcome: null,
  });
  assert.deepEqual(attemptAuthority(fixture), {
    workItemId: fixture.authority.workItemId,
    leaseEpoch: fixture.authority.leaseEpoch,
  });
  assert.deepEqual(storedExecution(fixture.database), beforeExecution);
  assert.equal(storedContinuation(fixture.database).revision, 1);
  assert.deepEqual(
    loadSqliteToolExecutionReceipt(fixture.database, beforeReceipt),
    beforeReceipt,
  );
  assert.deepEqual(toolAttemptAuthority(fixture), {
    workItemId: fixture.authority.workItemId,
    leaseEpoch: fixture.authority.leaseEpoch,
  });
  fixture.database.close();
});

test("SQLite pending Tool adoption fails closed across its durable authority matrix", async (context) => {
  const cases = [
    {
      name: "segment",
      mutate(receipt: ToolExecutionReceiptState) {
        return {
          ...receipt,
          call: { ...receipt.call, segmentId: "segment:forged" },
          actionIntent: {
            ...receipt.actionIntent!,
            segmentId: "segment:forged",
          },
        };
      },
    },
    {
      name: "call",
      mutate(receipt: ToolExecutionReceiptState) {
        return {
          ...receipt,
          call: { ...receipt.call, callId: "forged-call" },
          actionIntent: { ...receipt.actionIntent!, callId: "forged-call" },
        };
      },
    },
    {
      name: "action",
      mutate(receipt: ToolExecutionReceiptState) {
        return { ...receipt, actionDigest: digester.sha256("forged-action") };
      },
    },
    {
      name: "input",
      mutate(receipt: ToolExecutionReceiptState) {
        const actionIntent = {
          ...receipt.actionIntent!,
          tool: {
            ...receipt.actionIntent!.tool,
            inputDigest: digester.sha256("forged-input"),
          },
        };
        return {
          ...receipt,
          call: {
            ...receipt.call,
            inputDigest: actionIntent.tool.inputDigest,
          },
          actionIntent,
          actionDigest: digester.sha256(canonicalActionIntent(actionIntent)),
        };
      },
    },
    {
      name: "result",
      mutate(receipt: ToolExecutionReceiptState) {
        return {
          ...receipt,
          result: {
            output: "forged",
            outputDigest: digester.sha256("forged"),
            isError: false,
            artifactRef: null,
          },
        };
      },
    },
    {
      name: "receipt work item",
      mutate(receipt: ToolExecutionReceiptState) {
        return { ...receipt, workItemId: "scheduler-work" };
      },
    },
  ] as const;
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const fixture = await continuationFixture({
        pendingToolStatuses: ["prepared"],
      });
      rewritePendingReceipt(
        fixture,
        entry.mutate(fixture.pendingTools[0]!.receipt),
      );
      await assert.rejects(
        fixture.store.reconcileWorkflowNode(fixture.reconcileInput),
        (error) => error instanceof RunStoreError,
      );
      assert.deepEqual(attemptAuthority(fixture), {
        workItemId: fixture.authority.workItemId,
        leaseEpoch: fixture.authority.leaseEpoch,
      });
      assert.deepEqual(toolAttemptAuthority(fixture), {
        workItemId: fixture.authority.workItemId,
        leaseEpoch: fixture.authority.leaseEpoch,
      });
      fixture.database.close();
    });
  }
});

test("SQLite rejects terminal Tool receipts and more than sixteen pending Tool authorities", async (context) => {
  for (const status of ["completed", "canceled"] as const) {
    await context.test(status, async () => {
      const fixture = await continuationFixture({
        pendingToolStatuses: ["prepared"],
      });
      const current = fixture.pendingTools[0]!.receipt;
      const terminal =
        status === "completed"
          ? resolveToolExecutionReceipt(
              dispatchToolExecutionReceipt(current, now),
              {
                status,
                resolvedAt: now,
                providerReceiptId: "provider-terminal",
                result: {
                  output: "done",
                  outputDigest: digester.sha256("done"),
                  isError: false,
                  artifactRef: null,
                },
              },
            )
          : resolveToolExecutionReceipt(current, {
              status,
              resolvedAt: now,
              providerReceiptId: null,
            });
      rewritePendingReceipt(fixture, terminal);
      await assert.rejects(
        fixture.store.reconcileWorkflowNode(fixture.reconcileInput),
        (error) => error instanceof RunStoreError,
      );
      fixture.database.close();
    });
  }
  await context.test("bounded array", async () => {
    const fixture = await continuationFixture({
      pendingToolStatuses: Array.from(
        { length: 17 },
        () => "prepared" as const,
      ),
    });
    await assert.rejects(
      fixture.store.reconcileWorkflowNode(fixture.reconcileInput),
      (error) => error instanceof RunStoreError,
    );
    fixture.database.close();
  });
});

test("SQLite re-adopts a continuation after adoption crashes before the next model request", async () => {
  const fixture = await continuationFixture({
    pendingToolStatuses: ["prepared"],
  });
  const first = requireResume(
    await fixture.store.reconcileWorkflowNode(fixture.reconcileInput),
  );
  fixture.database
    .prepare(
      `UPDATE work_items SET lease_owner_id='reconcile-worker-2',
       lease_id='reconcile-lease-2',lease_epoch=2,lease_expires_at_ms=?,attempt_count=2
       WHERE work_item_id=?`,
    )
    .run(nowMs + 60_000, fixture.reconcileInput.lease.workItemId);
  const reclaimedInput = {
    ...fixture.reconcileInput,
    lease: {
      workItemId: fixture.reconcileInput.lease.workItemId,
      ownerId: "reconcile-worker-2",
      leaseId: "reconcile-lease-2",
      leaseEpoch: 2,
    },
  };

  const result = requireResume(
    await fixture.store.reconcileWorkflowNode(reclaimedInput),
  );
  assert.equal(
    result.resume.attempt.workItemId,
    reclaimedInput.lease.workItemId,
  );
  assert.equal(result.resume.attempt.leaseEpoch, 2);
  assert.equal(result.resume.continuation.revision, 3);
  assert.equal(result.execution.revision, first.execution.revision + 1);
  assert.equal(result.execution.nodes[0]?.status, "running");
  assert.equal(result.resume.pendingTools[0]?.receipt.status, "prepared");
  assert.equal(
    result.resume.pendingTools[0]?.receipt.revision,
    first.resume.pendingTools[0]!.receipt.revision + 1,
  );
  assert.equal(result.resume.pendingTools[0]?.attempt.leaseEpoch, 2);
  assert.equal(result.resume.continuation.activeDispatch, null);
  assert.deepEqual(result.resume.continuation.history, fixture.history);
  assert.deepEqual(dispatchState(fixture), {
    status: "terminal",
    revision: fixture.observed.revision + 1,
    terminalOutcome: {
      kind: "completed",
      code: null,
      certainty: "responseObserved",
    },
  });
  const retry = requireResume(
    await fixture.store.reconcileWorkflowNode(reclaimedInput),
  );
  assert.equal(retry.execution.revision, result.execution.revision);
  assert.deepEqual(retry.resume.pendingTools, result.resume.pendingTools);
  assert.equal(storedContinuation(fixture.database).revision, 3);
  fixture.database.close();
});

test("SQLite consumes a prepared next sample before re-adopting its continuation", async () => {
  const fixture = await continuationFixture();
  const adopted = requireResume(
    await fixture.store.reconcileWorkflowNode(fixture.reconcileInput),
  );
  const prepared = prepareSqliteModelDispatch(fixture.database, {
    tenantId: "tenant-1",
    runId: "run-1",
    lease: fixture.reconcileInput.lease,
    attempt: fixture.authority.attempt,
    operationId: "dispatch-2",
    requestSequence: 2,
    operation: "dispatch",
    requestDigest: digester.sha256("request-2"),
    provider: fixture.observed.provider,
    preparedAt: now,
  });
  fixture.database
    .prepare(
      `UPDATE work_items SET lease_owner_id='reconcile-worker-2',
       lease_id='reconcile-lease-2',lease_epoch=2,lease_expires_at_ms=?,attempt_count=2
       WHERE work_item_id=?`,
    )
    .run(nowMs + 60_000, fixture.reconcileInput.lease.workItemId);
  const reclaimedInput = {
    ...fixture.reconcileInput,
    lease: {
      workItemId: fixture.reconcileInput.lease.workItemId,
      ownerId: "reconcile-worker-2",
      leaseId: "reconcile-lease-2",
      leaseEpoch: 2,
    },
  };

  const result = requireResume(
    await fixture.store.reconcileWorkflowNode(reclaimedInput),
  );
  assert.equal(
    result.resume.continuation.revision,
    adopted.resume.continuation.revision + 1,
  );
  const consumed = loadSqliteModelDispatchReceipt(fixture.database, {
    tenantId: "tenant-1",
    runId: "run-1",
    stepId: fixture.authority.attempt.stepId,
    attemptId: fixture.authority.attempt.attemptId,
    operationId: prepared.operationId,
  });
  assert.deepEqual(consumed?.terminalOutcome, {
    kind: "failed",
    code: "workflow_model_not_dispatched",
    certainty: "notSent",
  });
  assert.equal(consumed?.status, "terminal");
  assert.deepEqual(result.resume.continuation.history, fixture.history);
  assert.equal(
    (await fixture.store.reconcileWorkflowNode(reclaimedInput)).disposition,
    "resumeRequired",
  );
  assert.equal(storedContinuation(fixture.database).revision, 3);
  fixture.database.close();
});

test("SQLite settles a retrieved sample after continuation takeover restored running authority", async () => {
  const fixture = await continuationFixture();
  const resumed = requireResume(
    await fixture.store.reconcileWorkflowNode(fixture.reconcileInput),
  );
  const providerCheckpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0" as const,
    adapterName: "responses",
    adapterVersion: "1",
    modelId: "model-1",
    opaquePayload: { responseId: "response-2" },
  };
  const checkpointDigest = digester.sha256(canonicalJson(providerCheckpoint));
  const prepared = prepareSqliteModelDispatch(fixture.database, {
    tenantId: "tenant-1",
    runId: "run-1",
    lease: fixture.reconcileInput.lease,
    attempt: fixture.authority.attempt,
    operationId: "dispatch-2",
    requestSequence: 2,
    operation: "dispatch",
    requestDigest: digester.sha256("request-2"),
    provider: fixture.observed.provider,
    preparedAt: now,
  });
  const sent = markSqliteModelDispatchPossiblySent(fixture.database, {
    tenantId: "tenant-1",
    runId: "run-1",
    lease: fixture.reconcileInput.lease,
    attempt: fixture.authority.attempt,
    operationId: prepared.operationId,
    requestSequence: prepared.requestSequence,
    expectedRevision: prepared.revision,
    transitionedAt: now,
  });
  const observed = observeSqliteModelDispatchResponse(fixture.database, {
    tenantId: "tenant-1",
    runId: "run-1",
    lease: fixture.reconcileInput.lease,
    attempt: fixture.authority.attempt,
    operationId: prepared.operationId,
    requestSequence: prepared.requestSequence,
    expectedRevision: sent.revision,
    checkpointDigest,
    transitionedAt: now,
  });
  checkpointSqliteRunAttempt(
    fixture.database,
    { tenantId: "tenant-1", runId: "run-1", ...fixture.authority.attempt },
    fixture.reconcileInput.lease.workItemId,
    fixture.reconcileInput.lease.leaseEpoch,
    providerCheckpoint,
    checkpointDigest,
    now,
    "replace",
  );

  const retrieval = await fixture.store.reconcileWorkflowNode(
    fixture.reconcileInput,
  );
  assert.equal(retrieval.disposition, "retrieveRequired");
  if (retrieval.disposition !== "retrieveRequired")
    assert.fail("retrieve required");
  assert.equal(retrieval.execution.nodes[0]?.status, "running");
  assert.equal(
    retrieval.recovery.attempt.workItemId,
    fixture.reconcileInput.lease.workItemId,
  );
  const evidence = createWorkflowNodeTerminalEvidence({
    workflow,
    nodeId: fixture.work.nodeId,
    outcome: { status: "completed", value: {} },
    digester,
  });
  const settled = await fixture.store.settleRetrievedWorkflowNode({
    ...fixture.reconcileInput,
    agentVersionId: "agent-v1",
    attempt: {
      stepId: fixture.authority.attempt.stepId,
      attemptId: fixture.authority.attempt.attemptId,
      workItemId: fixture.reconcileInput.lease.workItemId,
      leaseEpoch: fixture.reconcileInput.lease.leaseEpoch,
    },
    dispatch: {
      operationId: observed.operationId,
      requestSequence: observed.requestSequence,
      expectedRevision: observed.revision,
      status: "responseObserved",
    },
    evidence,
    dispatchTerminalOutcome: {
      kind: "completed",
      code: null,
      certainty: "responseObserved",
    },
  });
  assert.equal(settled.disposition, "settled");
  assert.equal(settled.execution.nodes[0]?.status, "completed");
  assert.equal(resumed.execution.nodes[0]?.status, "running");
  fixture.database.close();
});

for (const corruption of [
  {
    name: "stored schema",
    sql: `UPDATE run_events SET event_json=json_set(
      event_json,'$.schemaVersion','forged')
      WHERE json_extract(event_json,'$.data.segmentId')='strict-segment'`,
  },
  {
    name: "stored identity",
    sql: `UPDATE run_events SET event_json=json_set(
      event_json,'$.identity.runId','forged')
      WHERE json_extract(event_json,'$.data.segmentId')='strict-segment'`,
  },
  {
    name: "physical sequence",
    sql: `UPDATE run_events SET sequence=sequence+1000
      WHERE json_extract(event_json,'$.data.segmentId')='strict-segment'`,
  },
  {
    name: "physical event ID",
    sql: `UPDATE run_events SET event_id='forged-event-id'
      WHERE json_extract(event_json,'$.data.segmentId')='strict-segment'`,
  },
] as const) {
  test(`SQLite retrieved prefix fails closed on corrupted ${corruption.name}`, async () => {
    const fixture = await continuationFixture();
    const input = retrievedPrefixInput(fixture);
    assert.equal(
      appendSqliteWorkflowRetrievedEventSuffix(fixture.database, input).appended
        .length,
      1,
    );
    fixture.database.exec(corruption.sql);

    assert.throws(
      () => appendSqliteWorkflowRetrievedEventSuffix(fixture.database, input),
      (error: unknown) =>
        error instanceof RunStoreError &&
        error.code === "workflow_retrieved_continuation_corrupt",
    );
    fixture.database.close();
  });
}

test("SQLite continuation takeover rolls every authority back at the execution crash boundary", async () => {
  const fixture = await continuationFixture();
  const beforeExecution = storedExecution(fixture.database);
  fixture.database.exec(`CREATE TRIGGER fail_continuation_takeover
    BEFORE UPDATE ON workflow_executions
    BEGIN SELECT RAISE(ABORT, 'execution-crash'); END`);

  await assert.rejects(
    fixture.store.reconcileWorkflowNode(fixture.reconcileInput),
    (error: unknown) =>
      error instanceof RunStoreError &&
      error.code === "workflow_composition_store_failed" &&
      error.cause instanceof Error &&
      error.cause.message === "execution-crash",
  );
  assert.deepEqual(dispatchState(fixture), {
    status: "responseObserved",
    revision: fixture.observed.revision,
    terminalOutcome: null,
  });
  assert.deepEqual(attemptAuthority(fixture), {
    workItemId: fixture.authority.workItemId,
    leaseEpoch: fixture.authority.leaseEpoch,
  });
  assert.deepEqual(storedExecution(fixture.database), beforeExecution);
  const checkpoint = storedContinuation(fixture.database);
  assert.equal(checkpoint.revision, 1);
  assert.deepEqual(checkpoint.authority, fixture.authority);
  assert.equal(
    checkpoint.activeDispatch?.operationId,
    fixture.observed.operationId,
  );
  assert.deepEqual(workItemLease(fixture), {
    status: "leased",
    leaseOwnerId: "reconcile-worker",
    leaseId: "reconcile-lease",
    leaseEpoch: 1,
  });

  fixture.database.exec("DROP TRIGGER fail_continuation_takeover");
  assert.equal(
    (await fixture.store.reconcileWorkflowNode(fixture.reconcileInput))
      .disposition,
    "resumeRequired",
  );
  fixture.database.close();
});

test("SQLite reconciliation never resumes a cleared checkpoint without terminal dispatch proof", async () => {
  const fixture = await continuationFixture();
  fixture.database
    .prepare(
      `UPDATE workflow_node_continuations
       SET checkpoint_json=json_set(checkpoint_json,'$.activeDispatch',json('null'))`,
    )
    .run();

  assert.equal(
    (await fixture.store.reconcileWorkflowNode(fixture.reconcileInput))
      .disposition,
    "retrieveRequired",
  );
  assert.deepEqual(dispatchState(fixture), {
    status: "responseObserved",
    revision: fixture.observed.revision,
    terminalOutcome: null,
  });
  assert.deepEqual(attemptAuthority(fixture), {
    workItemId: fixture.authority.workItemId,
    leaseEpoch: fixture.authority.leaseEpoch,
  });
  fixture.database.close();
});

async function continuationFixture(
  options: Readonly<{
    pendingToolStatuses?: readonly (
      | "prepared"
      | "dispatched"
      | "unknownOutcome"
    )[];
  }> = {},
) {
  const database = new DatabaseSync(":memory:");
  const clock: LeaseClock = { nowEpochMilliseconds: () => nowMs };
  const store = new SqliteWorkflowRunCompositionStore(database, {
    digester,
    clock,
  });
  await seed(database);
  const schedulerLease = {
    workItemId: "scheduler-work",
    ownerId: "scheduler-worker",
    leaseId: "scheduler-lease",
    leaseEpoch: 1,
  } as const;
  const inputDigest = digester.sha256("{}");
  const scheduled = await store.scheduleWorkflowNodes({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: schedulerLease,
    binding,
    schedulerOperationId: "schedule-1",
    workflowInput: { valueId: "root-value", valueDigest: inputDigest },
  });
  const work = scheduled.nodeWorkItems[0]!;
  database
    .prepare(
      `UPDATE work_items SET status='leased',lease_owner_id='node-worker',
       lease_id='node-lease',lease_epoch=1,lease_expires_at_ms=?,attempt_count=1
       WHERE work_item_id=?`,
    )
    .run(nowMs + 60_000, work.workItemId);
  const nodeLease = {
    workItemId: work.workItemId,
    ownerId: "node-worker",
    leaseId: "node-lease",
    leaseEpoch: 1,
  } as const;
  const admitted = await store.admitWorkflowNodeWork({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: nodeLease,
    binding,
    nodeId: work.nodeId,
    claimId: work.claimId,
    claimEpoch: work.claimEpoch,
    schedulerOperationId: "schedule-1",
    admissionOperationId: "admit-1",
    attemptLeaseDurationMs: 60_000,
  });
  const attempt = admitted.admission!.attempt;
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
    attempt: { stepId: attempt.stepId, attemptId: attempt.attemptId },
  };
  const providerCheckpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0" as const,
    adapterName: "responses",
    adapterVersion: "1",
    modelId: "model-1",
    opaquePayload: { responseId: "response-1" },
  };
  const checkpointDigest = digester.sha256(canonicalJson(providerCheckpoint));
  const prepared = prepareSqliteModelDispatch(database, {
    tenantId: "tenant-1",
    runId: "run-1",
    lease: nodeLease,
    attempt: authority.attempt,
    operationId: "dispatch-1",
    requestSequence: 1,
    operation: "dispatch",
    requestDigest: digester.sha256("request-1"),
    provider: {
      agentVersionId: "agent-v1",
      adapterName: "responses",
      adapterVersion: "1",
      modelId: "model-1",
    },
    preparedAt: now,
  });
  const sent = markSqliteModelDispatchPossiblySent(database, {
    tenantId: "tenant-1",
    runId: "run-1",
    lease: nodeLease,
    attempt: authority.attempt,
    operationId: prepared.operationId,
    requestSequence: 1,
    expectedRevision: prepared.revision,
    transitionedAt: now,
  });
  const observed = observeSqliteModelDispatchResponse(database, {
    tenantId: "tenant-1",
    runId: "run-1",
    lease: nodeLease,
    attempt: authority.attempt,
    operationId: prepared.operationId,
    requestSequence: 1,
    expectedRevision: sent.revision,
    checkpointDigest,
    transitionedAt: now,
  });
  checkpointSqliteRunAttempt(
    database,
    { tenantId: "tenant-1", runId: "run-1", ...authority.attempt },
    authority.workItemId,
    authority.leaseEpoch,
    providerCheckpoint,
    checkpointDigest,
    now,
    "initialOnly",
  );
  const segmentId = "segment-1";
  const pendingToolStatuses = options.pendingToolStatuses ?? [];
  const history = [
    {
      type: "message" as const,
      role: "assistant" as const,
      content: "tool requested",
    },
    {
      type: "tool_result" as const,
      kind: "function" as const,
      callId: "committed-tool-call",
      output: "effect already committed",
    },
    ...pendingToolStatuses.map((_status, index) => ({
      type: "tool_call" as const,
      kind: "function" as const,
      callId: `pending-call-${index + 1}`,
      name: "tool.read",
      input: JSON.stringify({ index }),
    })),
  ];
  await store.commitWorkflowAssistantContinuation({
    lease: nodeLease,
    authority,
    expectedContinuationRevision: null,
    next: {
      schemaVersion: "crewon.workflow-node-continuation.v0",
      authority,
      segmentId,
      modelSampleIndex: 0,
      toolRoundsConsumed: 1,
      providerCheckpoint,
      providerTurnState: null,
      activeDispatch: {
        operationId: observed.operationId,
        requestSequence: observed.requestSequence,
        expectedRevision: observed.revision,
        status: "responseObserved",
      },
      history,
    },
    committedAt: now,
    terminalResult: null,
  });
  const pendingTools = seedPendingTools(database, {
    authority,
    lease: nodeLease,
    segmentId,
    statuses: pendingToolStatuses,
  });
  database
    .prepare(
      `UPDATE work_items SET status='leased',lease_owner_id='node-reclaimer',
       lease_id='node-reclaim-lease',lease_epoch=2,lease_expires_at_ms=?,attempt_count=2
       WHERE work_item_id=?`,
    )
    .run(nowMs + 60_000, work.workItemId);
  const recovery = await store.admitWorkflowNodeWork({
    tenantId: "tenant-1",
    runId: "run-1",
    lease: {
      workItemId: work.workItemId,
      ownerId: "node-reclaimer",
      leaseId: "node-reclaim-lease",
      leaseEpoch: 2,
    },
    binding,
    nodeId: work.nodeId,
    claimId: work.claimId,
    claimEpoch: work.claimEpoch,
    schedulerOperationId: "schedule-1",
    admissionOperationId: "admit-reclaimed",
    attemptLeaseDurationMs: 60_000,
  });
  assert.equal(recovery.disposition, "reconcileRequired");
  const reconciliationWorkItemId = recovery.handoff.nextWorkItemId!;
  const payload = JSON.parse(
    String(
      database
        .prepare("SELECT work_item_json FROM work_items WHERE work_item_id=?")
        .get(reconciliationWorkItemId)!.work_item_json,
    ),
  ).payload as { reconciliationOperationId: string };
  database
    .prepare(
      `UPDATE work_items SET status='leased',lease_owner_id='reconcile-worker',
       lease_id='reconcile-lease',lease_epoch=1,lease_expires_at_ms=?,attempt_count=1
       WHERE work_item_id=?`,
    )
    .run(nowMs + 60_000, reconciliationWorkItemId);
  const reconcileInput = {
    tenantId: "tenant-1",
    runId: "run-1",
    binding,
    lease: {
      workItemId: reconciliationWorkItemId,
      ownerId: "reconcile-worker",
      leaseId: "reconcile-lease",
      leaseEpoch: 1,
    },
    nodeId: work.nodeId,
    claimId: work.claimId,
    claimEpoch: work.claimEpoch,
    reconciliationOperationId: payload.reconciliationOperationId,
  } as const;
  return {
    database,
    store,
    work,
    authority,
    observed,
    inputDigest,
    history,
    pendingTools,
    reconcileInput,
  };
}

function retrievedPrefixInput(
  fixture: Awaited<ReturnType<typeof continuationFixture>>,
) {
  return {
    tenantId: "tenant-1",
    runId: "run-1",
    attemptId: fixture.authority.attempt.attemptId,
    dispatchOperationId: "strict-dispatch",
    segmentId: "strict-segment",
    payload: {
      events: [
        {
          schemaVersion: "crewon.agent-event.v0" as const,
          runId: "run-1",
          segmentId: "strict-segment",
          sequence: 1,
          type: "tool.requested" as const,
          data: {
            callId: "strict-call",
            kind: "function" as const,
            name: "tool.read",
            input: "{}",
          },
        },
      ],
      assistantContinuation: null,
      next: {
        schemaVersion: "crewon.workflow-node-continuation.v0" as const,
        segmentId: "strict-segment",
        modelSampleIndex: 0,
        toolRoundsConsumed: 0,
        providerCheckpoint: null,
        providerTurnState: null,
        history: [],
      },
    },
    committedAt: now,
    digester,
  };
}

function seedPendingTools(
  database: DatabaseSync,
  input: Readonly<{
    authority: WorkflowAgentAttemptAuthority;
    lease: Readonly<{
      workItemId: string;
      ownerId: string;
      leaseId: string;
      leaseEpoch: number;
    }>;
    segmentId: string;
    statuses: readonly ("prepared" | "dispatched" | "unknownOutcome")[];
  }>,
): readonly Readonly<{ receipt: ToolExecutionReceiptState }>[] {
  let run = JSON.parse(
    String(
      database
        .prepare("SELECT state_json FROM run_snapshots WHERE run_id='run-1'")
        .get()!.state_json,
    ),
  ) as RunState;
  const insertEvent = database.prepare(
    `INSERT INTO run_events(tenant_id,run_id,sequence,event_id,event_json)
     VALUES ('tenant-1','run-1',?,?,?)`,
  );
  return input.statuses.map((status, index) => {
    const callId = `pending-call-${index + 1}`;
    const rawInput = JSON.stringify({ index });
    const stepId = `pending-tool-step-${index + 1}`;
    const attemptId = `pending-tool-attempt-${index + 1}`;
    database.exec("BEGIN IMMEDIATE");
    beginSqliteRunAttempt(database, {
      tenantId: "tenant-1",
      runId: "run-1",
      lease: input.lease,
      stepId,
      kind: "tool",
      attemptId,
      startedAt: now,
    });
    database.exec("COMMIT");
    const actionIntent = {
      schemaVersion: "crewon.action-intent.v0" as const,
      runId: "run-1",
      segmentId: input.segmentId,
      callId,
      tool: {
        kind: "function" as const,
        name: "tool.read",
        inputDigest: digester.sha256(rawInput),
      },
      effect: "readOnly" as const,
      recovery: "replaySafe" as const,
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: { kind: "control" as const, bindingId: "tool-binding" },
      capability: "workspace.read",
      approvalRequirement: "none" as const,
      limits: {
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
        maxArtifactBytes: 1_048_576,
      },
    };
    let receipt = prepareToolExecutionReceipt({
      receiptId: `pending-tool-receipt-${index + 1}`,
      tenantId: "tenant-1",
      runId: "run-1",
      stepId,
      attemptId,
      workItemId: input.authority.workItemId,
      executionId: `pending-tool-execution-${index + 1}`,
      idempotencyKey: `pending-tool-idempotency-${index + 1}`,
      actionDigest: digester.sha256(canonicalActionIntent(actionIntent)),
      actionIntent,
      call: {
        segmentId: input.segmentId,
        callId,
        kind: "function",
        name: "tool.read",
        inputDigest: digester.sha256(rawInput),
      },
      effect: "readOnly",
      recovery: "replaySafe",
      preparedAt: now,
    });
    if (status === "dispatched" || status === "unknownOutcome")
      receipt = dispatchToolExecutionReceipt(receipt, now);
    if (status === "unknownOutcome")
      receipt = markToolExecutionUnknownOutcome(receipt, {
        observedAt: now,
        providerReceiptId: `provider-pending-${index + 1}`,
      });
    insertSqliteToolExecutionReceipt(database, receipt);
    const event = {
      schemaVersion: "crewon.run-event.v0" as const,
      identity: { runId: "run-1" },
      eventId: `pending-tool-requested-${index + 1}`,
      sequence: run.lastSequence + 1,
      occurredAt: now,
      type: "tool.requested" as const,
      data: {
        segmentId: input.segmentId,
        segmentSequence: index + 1,
        callId,
        kind: "function" as const,
        name: "tool.read",
        input: rawInput,
      },
    };
    run = reduceRunLifecycleEvent(run, event);
    insertEvent.run(event.sequence, event.eventId, JSON.stringify(event));
    database
      .prepare(
        `UPDATE run_snapshots
         SET revision=?,last_sequence=?,state_json=?,updated_at=?
         WHERE tenant_id='tenant-1' AND run_id='run-1'`,
      )
      .run(run.revision, run.lastSequence, JSON.stringify(run), run.updatedAt);
    return { receipt };
  });
}

async function seed(database: DatabaseSync): Promise<void> {
  await new SqliteWorkflowVersionStore(
    database,
    digester,
  ).registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0",
    tenantId: "tenant-1",
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: now,
  });
  const run = runState();
  database
    .prepare(
      `INSERT INTO run_snapshots
       (tenant_id,space_id,run_id,revision,last_sequence,state_json,updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run("tenant-1", "space-1", "run-1", 2, 2, JSON.stringify(run), now);
  const events = [
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "run-created",
      sequence: 1,
      occurredAt: now,
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
      occurredAt: now,
      type: "run.started",
      data: {},
    },
  ];
  const insertEvent = database.prepare(
    `INSERT INTO run_events(tenant_id,run_id,sequence,event_id,event_json)
     VALUES ('tenant-1','run-1',?,?,?)`,
  );
  for (const event of events) {
    insertEvent.run(event.sequence, event.eventId, JSON.stringify(event));
  }
  database
    .prepare(
      `INSERT INTO work_items
       (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,
        available_at_ms,lease_owner_id,lease_id,lease_epoch,lease_expires_at_ms,attempt_count)
       VALUES (?,?,?,?,?,?,'leased',?,?,?,?,?,1)`,
    )
    .run(
      "scheduler-work",
      "tenant-1",
      "run-1",
      "run.execute",
      JSON.stringify({
        workItemId: "scheduler-work",
        tenantId: "tenant-1",
        runId: "run-1",
        kind: "run.execute",
        createdAt: now,
        payload: {
          schemaVersion: "crewon.workflow-scheduler-work-item.v1",
          trigger: "workflowScheduler",
          binding,
          schedulerOperationId: "schedule-1",
          workflowInput: {
            valueId: "root-value",
            valueDigest: digester.sha256("{}"),
          },
        },
      }),
      now,
      nowMs,
      "scheduler-worker",
      "scheduler-lease",
      1,
      nowMs + 60_000,
    );
  database
    .prepare(
      `INSERT INTO workflow_execution_values
       (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
       VALUES ('tenant-1','run-1','root-value','rootInput',NULL,?,?,?)`,
    )
    .run(digester.sha256("{}"), "{}", now);
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
    createdAt: now,
    updatedAt: now,
    terminalAt: null,
  };
}

function requireResume(result: unknown) {
  const value = result as {
    disposition: string;
    execution: WorkflowExecutionState;
    resume: {
      claim: unknown;
      attempt: { workItemId: string; leaseEpoch: number; status: string };
      reconciliationLease: unknown;
      continuation: WorkflowNodeContinuationCheckpoint;
      pendingTools: readonly WorkflowPendingToolResume[];
    };
  };
  assert.equal(value.disposition, "resumeRequired");
  return value;
}

function storedExecution(database: DatabaseSync): WorkflowExecutionState {
  const row = database
    .prepare("SELECT state_json FROM workflow_executions WHERE run_id='run-1'")
    .get() as { state_json: string };
  return JSON.parse(row.state_json) as WorkflowExecutionState;
}

function storedContinuation(
  database: DatabaseSync,
): WorkflowNodeContinuationCheckpoint {
  const row = database
    .prepare("SELECT checkpoint_json FROM workflow_node_continuations")
    .get() as { checkpoint_json: string };
  return JSON.parse(row.checkpoint_json) as WorkflowNodeContinuationCheckpoint;
}

function storedPendingTool(
  fixture: Awaited<ReturnType<typeof continuationFixture>>,
): WorkflowPendingToolResume {
  const original = fixture.pendingTools[0]!.receipt;
  const receipt = loadSqliteToolExecutionReceipt(fixture.database, original)!;
  const step = fixture.database
    .prepare("SELECT state_json FROM run_steps WHERE step_id=?")
    .get(receipt.stepId) as { state_json: string };
  const attempt = loadSqliteRunAttempt(fixture.database, {
    tenantId: receipt.tenantId,
    runId: receipt.runId,
    stepId: receipt.stepId,
    attemptId: receipt.attemptId,
  })!;
  return {
    receipt: receipt as WorkflowPendingToolResume["receipt"],
    step: JSON.parse(step.state_json) as WorkflowPendingToolResume["step"],
    attempt: attempt as WorkflowPendingToolResume["attempt"],
  };
}

function toolAttemptAuthority(
  fixture: Awaited<ReturnType<typeof continuationFixture>>,
) {
  const receipt = fixture.pendingTools[0]!.receipt;
  const attempt = loadSqliteRunAttempt(fixture.database, {
    tenantId: receipt.tenantId,
    runId: receipt.runId,
    stepId: receipt.stepId,
    attemptId: receipt.attemptId,
  })!;
  return { workItemId: attempt.workItemId, leaseEpoch: attempt.leaseEpoch };
}

function rewritePendingReceipt(
  fixture: Awaited<ReturnType<typeof continuationFixture>>,
  receipt: ToolExecutionReceiptState,
): void {
  fixture.database
    .prepare(
      `UPDATE tool_execution_receipts
       SET work_item_id=?,action_digest=?,status=?,revision=?,state_json=?,
           updated_at=?,resolved_at=? WHERE receipt_id=?`,
    )
    .run(
      receipt.workItemId,
      receipt.actionDigest,
      receipt.status,
      receipt.revision,
      JSON.stringify(receipt),
      receipt.updatedAt,
      receipt.resolvedAt,
      receipt.receiptId,
    );
}

function dispatchState(
  fixture: Awaited<ReturnType<typeof continuationFixture>>,
) {
  const receipt = loadSqliteModelDispatchReceipt(fixture.database, {
    tenantId: "tenant-1",
    runId: "run-1",
    stepId: fixture.authority.attempt.stepId,
    attemptId: fixture.authority.attempt.attemptId,
    operationId: fixture.observed.operationId,
  })!;
  return {
    status: receipt.status,
    revision: receipt.revision,
    terminalOutcome: receipt.terminalOutcome,
  };
}

function attemptAuthority(
  fixture: Awaited<ReturnType<typeof continuationFixture>>,
) {
  const row = fixture.database
    .prepare(
      "SELECT work_item_id,lease_epoch FROM run_attempts WHERE attempt_id=?",
    )
    .get(fixture.authority.attempt.attemptId) as {
    work_item_id: string;
    lease_epoch: number;
  };
  return { workItemId: row.work_item_id, leaseEpoch: row.lease_epoch };
}

function workItemLease(
  fixture: Awaited<ReturnType<typeof continuationFixture>>,
) {
  const row = fixture.database
    .prepare(
      `SELECT status,lease_owner_id,lease_id,lease_epoch
       FROM work_items WHERE work_item_id=?`,
    )
    .get(fixture.reconcileInput.lease.workItemId) as Record<string, unknown>;
  return {
    status: row.status,
    leaseOwnerId: row.lease_owner_id,
    leaseId: row.lease_id,
    leaseEpoch: row.lease_epoch,
  };
}

function count(database: DatabaseSync, table: "run_events"): number {
  return Number(
    database.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count,
  );
}
