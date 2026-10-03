import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { ReserveExternalOperation } from "@crewon/application";
import {
  createExtensionCreditAdmission,
  type RunLifecycleEvent,
} from "@crewon/domain";
import {
  extensionFixture,
  digest,
  timestamp,
} from "./extension-store.test-support.ts";
import { extensionTurnInput } from "./extension-turn.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";

/** Real original Turn/Run/credit transactions; named funding and quote are test fixtures. */
export async function paidExternalOperationFixture(
  t: TestContext,
  options: Readonly<{ billing?: "paid" | "unpriced"; start?: boolean }> = {},
) {
  const f = await extensionFixture(t, "sqlite");
  assert.ok(f.first.parent instanceof SqliteRunStore);
  assert.ok(f.second.parent instanceof SqliteRunStore);
  const parent = f.first.parent;
  const second = f.second.parent;
  await f.seed();
  const base = extensionTurnInput();
  await f.prepare({
    ...base,
    commit: {
      ...base.turn.run,
      tenantId: base.turn.tenantId,
      idempotency: base.turn.idempotency,
    },
  });
  await f.first.store.migrateCredits();
  const creditAdmission = createExtensionCreditAdmission(
    {
      binding: base.binding,
      receipt: base.receipt,
      principalId: "external-operation-actual-payer-fixture",
      poolId: "external-operation-personal-fixture",
      priceRevision: 1,
      quotedCredits: "30",
    },
    extensionStoreDigester,
  );
  const credits = parent.pluginCreditStore();
  if ((options.billing ?? "paid") === "paid")
    await credits.grant({
      scope: creditAdmission.reservation.scope,
      grantId: "external-operation-funding-fixture",
      credits: "100",
    });
  const committed = await f.first.store.commitExtensionTurn({
    ...base,
    ...((options.billing ?? "paid") === "paid" ? { creditAdmission } : {}),
  });
  const claim = await parent.claimNextWorkItem({
    ownerId: "external-operation-worker-fixture",
    leaseId: "external-operation-lease-fixture",
    leaseDurationMs: 30_000,
  });
  assert.ok(claim);
  assert.equal(claim.workItem.runId, base.binding.runId);
  const lease = {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
  const transition = async (
    type: RunLifecycleEvent["type"],
    data: Record<string, unknown>,
  ) => {
    const current = await parent.loadRun(base.binding);
    assert.ok(current);
    const id = randomUUID();
    const event = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: current.runId },
      eventId: id,
      sequence: current.lastSequence + 1,
      occurredAt: new Date(
        Date.parse(timestamp) + current.lastSequence * 1000,
      ).toISOString(),
      type,
      data,
    } as RunLifecycleEvent;
    return parent.commitLeasedRun({
      lease,
      commit: {
        tenantId: current.tenantId,
        idempotency: {
          scope: "paid-external-fixture-transition",
          key: id,
          requestFingerprint: id,
        },
        expectedRevision: current.revision,
        events: [event],
        outbox: [
          {
            messageId: id,
            tenantId: current.tenantId,
            runId: current.runId,
            topic: "run.updated",
            payload: {
              eventId: id,
              eventType: type,
              throughSequence: event.sequence,
            },
            createdAt: event.occurredAt,
          },
        ],
        workItems: [],
      },
      history: null,
    });
  };
  if (options.start !== false) {
    const started = await transition("run.started", {});
    assert.equal(started.state.status, "running");
  }
  const operation: ReserveExternalOperation = {
    tenantId: base.binding.tenantId,
    runId: base.binding.runId,
    bindingDigest: base.binding.bindingDigest,
    operationId: randomUUID(),
    correlationId: randomUUID(),
    executionId: "external-operation-execution-fixture",
    idempotencyKey: "external-operation-request-fixture",
    actionDigest: digest,
    requestDigest: extensionStoreDigester.sha256(
      "external-operation-request-fixture",
    ),
    createdAt: timestamp,
  };
  const nextOperation = (): ReserveExternalOperation => ({
    ...operation,
    operationId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  return {
    ...f,
    parent,
    second,
    binding: base.binding,
    committed,
    creditAdmission,
    credits,
    operation,
    nextOperation,
    transition,
    operations: parent.externalOperationStore(),
    secondOperations: second.externalOperationStore(),
  };
}
