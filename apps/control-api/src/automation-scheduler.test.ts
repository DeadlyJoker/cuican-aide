import assert from "node:assert/strict";
import test from "node:test";

import type { ActorContext } from "@crewon/application";
import type { AutomationDefinition } from "@crewon/domain";

import {
  AutomationScheduler,
  latestScheduledOccurrence,
} from "./automation-scheduler.ts";

const actor: ActorContext = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};

test("derives the latest due occurrence for every schedule kind", () => {
  assert.equal(
    latestScheduledOccurrence(schedule("once"), "2026-08-29T10:00:01Z"),
    "2026-08-29T10:00:00.000Z",
  );
  assert.equal(
    latestScheduledOccurrence(
      { ...schedule("interval"), intervalSeconds: 300 },
      "2026-08-29T10:12:00Z",
    ),
    "2026-08-29T10:10:00.000Z",
  );
  assert.equal(
    latestScheduledOccurrence(
      {
        ...schedule("daily"),
        nextRunAt: "2026-08-29T10:00:00Z",
        time: "18:00",
        timezone: "Asia/Shanghai",
      },
      "2026-08-30T10:05:00Z",
    ),
    "2026-08-30T10:00:00.000Z",
  );
  assert.equal(
    latestScheduledOccurrence(
      {
        ...schedule("weekly"),
        nextRunAt: "2026-08-24T01:00:00Z",
        time: "09:00",
        weekday: 1,
        timezone: "Asia/Shanghai",
      },
      "2026-08-31T02:00:00Z",
    ),
    "2026-08-31T01:00:00.000Z",
  );
});

test("runs one due occurrence once and keeps the idempotency key stable after restart", async () => {
  const calls: Array<{ idempotencyKey: string; revision: number }> = [];
  const definition = scheduledDefinition();
  const dependencies = {
    now: () => "2026-08-29T10:00:01Z",
    store: {
      async listScheduledAutomations() {
        return [
          { definition, definitionDigest: `sha256:${"0".repeat(64)}` },
        ];
      },
    },
    automations: {
      async runAutomationNow(
        _actor: ActorContext,
        command: { idempotencyKey: string; expectedThreadRevision: number },
      ) {
        calls.push({
          idempotencyKey: command.idempotencyKey,
          revision: command.expectedThreadRevision,
        });
        return {} as never;
      },
    },
    threads: {
      async getThread() {
        return { revision: calls.length + 1 } as never;
      },
    },
  };
  const first = new AutomationScheduler(dependencies, { scanIntervalMs: null });
  await first.wake();
  await first.wake();
  const restarted = new AutomationScheduler(dependencies, {
    scanIntervalMs: null,
  });
  await restarted.wake();
  assert.deepEqual(calls, [
    {
      idempotencyKey:
        "scheduled:07b12b2b0f381b22258af28489c3499723d96afc6e5744403ad01ed95064ae9c",
      revision: 1,
    },
    {
      idempotencyKey:
        "scheduled:07b12b2b0f381b22258af28489c3499723d96afc6e5744403ad01ed95064ae9c",
      revision: 2,
    },
  ]);
});

test("retries a due occurrence after a busy-thread conflict", async () => {
  let attempts = 0;
  const scheduler = new AutomationScheduler(
    {
      now: () => "2026-08-29T10:00:01Z",
      store: {
        async listScheduledAutomations() {
          return [
            {
              definition: scheduledDefinition(),
              definitionDigest: `sha256:${"0".repeat(64)}`,
            },
          ];
        },
      },
      automations: {
        async runAutomationNow() {
          attempts += 1;
          if (attempts === 1) throw new Error("thread_active_run_conflict");
          return {} as never;
        },
      },
      threads: {
        async getThread() {
          return { revision: attempts + 1 } as never;
        },
      },
    },
    { scanIntervalMs: null },
  );
  await scheduler.wake();
  assert.equal(scheduler.lastFailureCode(), "thread_active_run_conflict");
  await scheduler.wake();
  assert.equal(attempts, 2);
});

function schedule(
  scheduleType: AutomationDefinition["schedule"]["scheduleType"],
): AutomationDefinition["schedule"] {
  return {
    scheduleType,
    nextRunAt: "2026-08-29T10:00:00Z",
    intervalSeconds: scheduleType === "interval" ? 300 : 0,
    time: "10:00",
    weekday: 6,
    timezone: "UTC",
  };
}

function scheduledDefinition(): AutomationDefinition {
  return {
    schemaVersion: "crewon.automation.v0",
    automationId: "automation-1",
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    createdByPrincipalId: actor.principalId,
    createdByActorId: actor.actorId,
    threadId: "thread-1",
    title: "Scheduled report",
    prompt: "Report progress",
    agentVersionId: "agent-v1",
    schedule: schedule("once"),
    executionMode: "scheduled",
    revision: 1,
    createdAt: "2026-08-29T09:00:00Z",
    updatedAt: "2026-08-29T09:00:00Z",
  };
}
