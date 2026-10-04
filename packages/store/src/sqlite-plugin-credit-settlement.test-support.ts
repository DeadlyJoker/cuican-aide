import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  PluginCreditSettlementDecision,
  PluginCreditSettlementEvidence,
  ReserveExternalOperation,
  WorkItem,
} from "@crewon/application";
import {
  prepareToolExecutionReceipt,
  type RunLifecycleEvent,
  type ToolExecutionReceiptStatus,
} from "@crewon/domain";
import {
  extensionFixture,
  digest,
  timestamp,
} from "./extension-store.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { seedProbeAdmission } from "./plugin-task-admission-probe.test-support.ts";
import { toolReceipt } from "./run-execution-store-conformance.test-support.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";

/** Original installed v1 Turn, personal reservation and leased Run; amounts are named test facts. */
export async function sqliteSettlementFixture(
  t: TestContext,
  options: Readonly<{ start?: boolean }> = {},
) {
  const f = await extensionFixture(t, "sqlite");
  assert.ok(f.first.parent instanceof SqliteRunStore);
  assert.ok(f.second.parent instanceof SqliteRunStore);
  const parent = f.first.parent;
  const second = f.second.parent;
  const input = await seedProbeAdmission(f);
  assert.ok(input.creditAdmission);
  const admission = input.creditAdmission;
  const locator = {
    tenantId: input.binding.tenantId,
    runId: input.binding.runId,
  };
  const settlement = parent.pluginCreditSettlementStore();
  const secondSettlement = second.pluginCreditSettlementStore();
  await settlement.migrate();
  const claim = await parent.claimNextWorkItem({
    ownerId: "settlement-worker-fixture",
    leaseId: "settlement-lease-fixture",
    leaseDurationMs: 300_000,
  });
  assert.ok(claim);
  assert.equal(claim.workItem.runId, locator.runId);
  const lease = {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
  let observedTime = Date.parse(timestamp);
  const nextTimestamp = () => new Date((observedTime += 1000)).toISOString();
  const transition = async (
    type: RunLifecycleEvent["type"],
    data: Record<string, unknown>,
    workItems: readonly WorkItem[] = [],
  ) => {
    const current = await parent.loadRun(locator);
    assert.ok(current);
    const id = randomUUID();
    const event = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: current.runId },
      eventId: id,
      sequence: current.lastSequence + 1,
      occurredAt: nextTimestamp(),
      type,
      data,
    } as RunLifecycleEvent;
    return parent.commitLeasedRun({
      lease,
      commit: {
        tenantId: locator.tenantId,
        idempotency: {
          scope: "settlement-run-transition-fixture",
          key: id,
          requestFingerprint: id,
        },
        expectedRevision: current.revision,
        events: [event],
        outbox: [
          {
            messageId: id,
            tenantId: locator.tenantId,
            runId: locator.runId,
            topic: "run.updated",
            payload: {
              eventId: id,
              eventType: type,
              throughSequence: event.sequence,
            },
            createdAt: event.occurredAt,
          },
        ],
        workItems,
      },
      history: null,
    });
  };
  if (options.start !== false) await transition("run.started", {});
  const complete = async (
    options: Readonly<{ completeWork?: boolean }> = {},
  ) => {
    await transition("run.completed", { outputRef: null });
    if (options.completeWork !== false) await parent.completeWorkItem(lease);
  };
  const addOperation = async (status?: "succeeded" | "failed") => {
    const tool = toolReceipt(claim);
    const operation: ReserveExternalOperation = {
      ...locator,
      bindingDigest: input.binding.bindingDigest,
      operationId: randomUUID(),
      correlationId: randomUUID(),
      executionId: tool.executionId,
      idempotencyKey: tool.idempotencyKey,
      actionDigest: tool.actionDigest,
      requestDigest: extensionStoreDigester.sha256(
        "settlement-operation-fixture",
      ),
      createdAt: nextTimestamp(),
    };
    const saved = await parent
      .externalOperationStore()
      .reserveExternalOperation(operation);
    if (status === undefined) return saved.operation;
    const advanced = await parent
      .externalOperationStore()
      .advanceExternalOperation({
        ...locator,
        bindingDigest: operation.bindingDigest,
        operationId: operation.operationId,
        expectedRevision: saved.operation.revision,
        status,
        providerOperationId: "settlement-provider-operation-fixture",
        resultJson:
          status === "succeeded" ? '{"artifact":"fixture-result"}' : null,
        updatedAt: nextTimestamp(),
      });
    return advanced.operation;
  };
  const addMutation = async (
    status: ToolExecutionReceiptStatus,
    options: Readonly<{ finishAttempt?: boolean; dispatch?: boolean }> = {},
  ) => {
    const recipe = toolReceipt(claim);
    const preparedAt = nextTimestamp();
    assert.ok(recipe.actionIntent);
    const receipt = prepareToolExecutionReceipt({
      ...recipe,
      preparedAt,
      actionIntent: {
        ...recipe.actionIntent,
        policySnapshotId: input.binding.target.policySnapshotId,
        workspaceBindingId: input.binding.target.workspaceBindingId,
        approvalRequirement: "none",
      },
    });
    const attempt = { stepId: receipt.stepId, attemptId: receipt.attemptId };
    await parent.beginRunAttempt({
      ...locator,
      lease,
      ...attempt,
      kind: "tool",
      startedAt: preparedAt,
    });
    let current = await parent.prepareToolExecution({ lease, receipt });
    if (
      status !== "prepared" &&
      !(status === "canceled" && options.dispatch === false)
    )
      current = await parent.transitionToolExecution({
        ...locator,
        receiptId: receipt.receiptId,
        lease,
        expectedRevision: current.revision,
        transition: { kind: "dispatch", occurredAt: nextTimestamp() },
      });
    if (status === "unknownOutcome")
      current = await parent.transitionToolExecution({
        ...locator,
        receiptId: receipt.receiptId,
        lease,
        expectedRevision: current.revision,
        transition: {
          kind: "unknownOutcome",
          occurredAt: nextTimestamp(),
          providerReceiptId: null,
        },
      });
    else if (status === "canceled")
      current = await parent.transitionToolExecution({
        ...locator,
        receiptId: receipt.receiptId,
        lease,
        expectedRevision: current.revision,
        transition: {
          kind: "cancel",
          occurredAt: nextTimestamp(),
          providerReceiptId: null,
        },
      });
    else if (status === "completed")
      current = await parent.transitionToolExecution({
        ...locator,
        receiptId: receipt.receiptId,
        lease,
        expectedRevision: current.revision,
        transition: {
          kind: "complete",
          occurredAt: nextTimestamp(),
          providerReceiptId: "settlement-tool-provider-receipt-fixture",
          result: {
            output: "saved mutation",
            outputDigest: extensionStoreDigester.sha256("saved mutation"),
            isError: false,
            artifactRef: null,
          },
        },
      });
    if (options.finishAttempt !== false)
      await parent.completeRunAttempt({
        ...locator,
        lease,
        attempt: {
          ...attempt,
          finishedAt: nextTimestamp(),
          checkpointDigest: null,
        },
      });
    return current;
  };
  const expireLease = async () => {
    const renewed = await parent.renewWorkItemLease({
      ...lease,
      leaseDurationMs: 1,
    });
    const expiresAt = Date.parse(renewed.expiresAt);
    await delay(Math.max(1, expiresAt - Date.now() + 1));
    assert.ok(Date.now() >= expiresAt);
    return renewed;
  };
  return {
    ...f,
    parent,
    second,
    input,
    admission,
    locator,
    lease,
    settlement,
    secondSettlement,
    credits: parent.pluginCreditStore(),
    transition,
    complete,
    addOperation,
    addMutation,
    expireLease,
  };
}

/** An explicit fixture authority decision, never a product default price or refund policy. */
export function settlementDecision(
  evidence: PluginCreditSettlementEvidence,
  outcome: PluginCreditSettlementDecision["outcome"] = {
    kind: "settle",
    actualCredits: "25",
  },
): PluginCreditSettlementDecision {
  return {
    schemaVersion: "crewon.plugin-credit-settlement-decision.v1",
    evidenceDigest: evidence.evidenceDigest,
    authorityId: "settlement-authority-fixture",
    authorityRevision: "fixture-policy-1",
    decisionId: randomUUID(),
    outcome,
  };
}
