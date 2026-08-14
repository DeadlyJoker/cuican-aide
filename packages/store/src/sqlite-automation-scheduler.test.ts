import assert from "node:assert/strict";
import test from "node:test";

import type { AutomationScheduleState } from "@crewon/domain";

import {
  automationApplicationService,
  automationCreateCommand,
  seedAutomationThread,
} from "./automation-store-conformance.test-support.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
} as const;

test("SQLite atomically admits one leased scheduled Automation", async (context) => {
  const store = new SqliteRunStore(":memory:");
  context.after(() => store.close());
  await seedAutomationThread(store);
  const automations = automationApplicationService(store);
  await automations.createAutomation(actor, automationCreateCommand());

  const claim = await store.claimNextDueAutomation({
    ownerId: "scheduler-1",
    leaseId: "lease-1",
    leaseDurationMs: 30_000,
    observedAt: "2026-08-10T10:01:00Z",
  });
  assert.notEqual(claim, null);
  assert.equal(
    await store.claimNextDueAutomation({
      ownerId: "scheduler-2",
      leaseId: "lease-2",
      leaseDurationMs: 30_000,
      observedAt: "2026-08-10T10:01:01Z",
    }),
    null,
  );
  const prepared = await automations.prepare({ actor, claim: claim! });
  const receipt = {
    tenantId: "tenant-1",
    automationId: "automation-1",
    scheduleRevision: 1 as const,
    scheduledFor: claim!.scheduledFor,
    occurrenceDigest: claim!.occurrenceDigest,
  };
  const result = await store.commitScheduledAutomationInvocation({
    receipt,
    lease: {
      tenantId: "tenant-1",
      automationId: "automation-1",
      scheduleRevision: 1,
      scheduledFor: claim!.scheduledFor,
      ownerId: claim!.lease.ownerId,
      leaseId: claim!.lease.leaseId,
      leaseEpoch: claim!.lease.epoch,
    },
    expectedDefinitionDigest: claim!.record.definitionDigest,
    expectedScheduleStateRevision: claim!.record.scheduleState.revision,
    invocation: prepared,
    nextScheduleState: {
      ...claim!.record.scheduleState,
      nextOccurrenceAt: "2026-08-11T10:00:00Z",
      lastScheduledFor: claim!.scheduledFor,
      retryAt: null,
      revision: 2,
      updatedAt: claim!.observedAt,
    },
  });

  assert.equal(result.disposition, "committed");
  assert.equal(result.binding.trigger.kind, "schedule");
  assert.deepEqual(await store.loadScheduledAutomationReceipt(receipt), {
    ...result,
    disposition: "replayed",
  });
  const current = await store.loadAutomation({
    tenantId: "tenant-1",
    spaceId: "space-1",
    automationId: "automation-1",
  });
  assert.deepEqual(current?.scheduleState, {
    ...claim!.record.scheduleState,
    nextOccurrenceAt: "2026-08-11T10:00:00Z",
    lastScheduledFor: claim!.scheduledFor,
    retryAt: null,
    revision: 2,
    updatedAt: claim!.observedAt,
  } satisfies AutomationScheduleState);
  assert.equal(
    (await automations.createAutomation(actor, automationCreateCommand()))
      .disposition,
    "replayed",
  );
});

test("SQLite retry releases the exact schedule lease and keeps the occurrence", async (context) => {
  const store = new SqliteRunStore(":memory:");
  context.after(() => store.close());
  await seedAutomationThread(store);
  await automationApplicationService(store).createAutomation(
    actor,
    automationCreateCommand(),
  );
  const claim = await store.claimNextDueAutomation({
    ownerId: "scheduler-1",
    leaseId: "lease-1",
    leaseDurationMs: 30_000,
    observedAt: "2026-08-10T10:01:00Z",
  });
  assert.notEqual(claim, null);
  const lease = {
    tenantId: "tenant-1",
    automationId: "automation-1",
    scheduleRevision: 1 as const,
    scheduledFor: claim!.scheduledFor,
    ownerId: claim!.lease.ownerId,
    leaseId: claim!.lease.leaseId,
    leaseEpoch: claim!.lease.epoch,
  };
  await store.retryAutomationScheduleClaim({
    ...lease,
    retryAt: "2026-08-10T10:02:00Z",
    reasonCode: "thread_busy",
  });
  await assert.rejects(
    store.disableAutomationScheduleClaim({
      ...lease,
      reasonCode: "stale",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "automation_schedule_lease_lost",
  );
  const retry = await store.claimNextDueAutomation({
    ownerId: "scheduler-2",
    leaseId: "lease-2",
    leaseDurationMs: 30_000,
    observedAt: "2026-08-10T10:02:00Z",
  });
  assert.equal(retry?.scheduledFor, claim!.scheduledFor);
  assert.equal(retry?.record.scheduleState.retryAt, "2026-08-10T10:02:00Z");
});
