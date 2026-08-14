import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AutomationScheduleClaimInput,
  AutomationSchedulerApplicationService,
  AutomationSchedulerOutcome,
} from "@crewon/application";

import { AutomationSchedulerLoop } from "./automation-scheduler-loop.ts";

test("drains scheduled admissions through unique fenced leases until idle", async () => {
  const claims: AutomationScheduleClaimInput[] = [];
  const outcomes: AutomationSchedulerOutcome[] = [
    {
      kind: "admitted",
      automationId: "automation-1",
      runId: "run-1",
      scheduledFor: "2026-08-14T00:00:00.000Z",
    },
    {
      kind: "replayed",
      automationId: "automation-2",
      runId: "run-2",
      scheduledFor: "2026-08-14T00:00:00.000Z",
    },
    { kind: "idle" },
  ];
  let leaseSequence = 0;
  const loop = new AutomationSchedulerLoop(
    service(async (input) => {
      claims.push(input);
      return outcomes.shift() ?? { kind: "idle" };
    }),
    {
      ownerId: "scheduler-owner-1",
      nextLeaseId: () => `scheduler-lease-${(leaseSequence += 1)}`,
      now: () => "2026-08-14T00:00:01.000Z",
      scanIntervalMs: null,
    },
  );

  await loop.wake();

  assert.deepEqual(claims, [
    {
      ownerId: "scheduler-owner-1",
      leaseId: "scheduler-lease-1",
      leaseDurationMs: 30_000,
      observedAt: "2026-08-14T00:00:01.000Z",
    },
    {
      ownerId: "scheduler-owner-1",
      leaseId: "scheduler-lease-2",
      leaseDurationMs: 30_000,
      observedAt: "2026-08-14T00:00:01.000Z",
    },
    {
      ownerId: "scheduler-owner-1",
      leaseId: "scheduler-lease-3",
      leaseDurationMs: 30_000,
      observedAt: "2026-08-14T00:00:01.000Z",
    },
  ]);
  assert.equal(loop.lastFailureCode(), null);
  await loop.close();
});

test("serializes concurrent wakeups and records a bounded failure code", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loop = new AutomationSchedulerLoop(
    service(async () => {
      calls += 1;
      await blocked;
      throw Object.assign(new Error("hidden detail"), {
        code: "automation_store_unavailable",
      });
    }),
    {
      ownerId: "scheduler-owner-1",
      nextLeaseId: () => "scheduler-lease-1",
      now: () => "2026-08-14T00:00:01.000Z",
      scanIntervalMs: null,
    },
  );

  const first = loop.wake();
  const second = loop.wake();
  release();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(loop.lastFailureCode(), "automation_store_unavailable");
  await loop.close();
});

function service(
  runOnce: (
    input: AutomationScheduleClaimInput,
  ) => Promise<AutomationSchedulerOutcome>,
): Pick<AutomationSchedulerApplicationService, "runOnce"> {
  return { runOnce };
}
