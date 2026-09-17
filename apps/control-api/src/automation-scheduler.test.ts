import assert from "node:assert/strict";
import test from "node:test";

import type { ActorContext } from "@crewon/application";
import { StorageAdmissionError } from "@crewon/application";
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
        return [{ definition, definitionDigest: `sha256:${"0".repeat(64)}` }];
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

test("storage pressure stops background enqueue and recovery retains occurrence idempotency", async (context) => {
  let blocked = true;
  let scans = 0;
  const calls: string[] = [];
  const keys: string[] = [];
  const scheduler = new AutomationScheduler(
    {
      now: () => "2026-08-29T10:00:01Z",
      storageAdmission: {
        async assertNewWorkAllowed() {
          if (blocked) throw new StorageAdmissionError("storage_capacity_low");
        },
      },
      store: {
        async listScheduledAutomations() {
          scans += 1;
          return [1, 2].map((index) => ({
            definition: {
              ...scheduledDefinition(),
              automationId: `automation-${index}`,
            },
            definitionDigest: `sha256:${"0".repeat(64)}`,
          }));
        },
      },
      threads: {
        async getThread() {
          return { revision: 1 } as never;
        },
      },
      automations: {
        async runAutomationNow(_actor, command) {
          calls.push(command.automationId);
          keys.push(command.idempotencyKey);
          blocked = true;
          return {} as never;
        },
      },
    },
    { scanIntervalMs: null },
  );
  context.after(() => scheduler.close());
  for (let index = 0; index < 10; index += 1) await scheduler.wake();
  assert.equal(scans, 0);
  assert.deepEqual(calls, []);
  assert.equal(scheduler.lastFailureCode(), "storage_capacity_low");
  blocked = false;
  await scheduler.wake();
  assert.deepEqual(calls, ["automation-1"]);
  assert.equal(scheduler.lastFailureCode(), "storage_capacity_low");
  blocked = false;
  await scheduler.wake();
  assert.deepEqual(calls, ["automation-1", "automation-2"]);
  blocked = false;
  await scheduler.wake();
  assert.deepEqual(calls, ["automation-1", "automation-2"]);
  assert.equal(new Set(keys).size, 2);
  assert.equal(scheduler.lastFailureCode(), null);
});

test("retains one latest occurrence per automation through 20,000 interval ticks", async () => {
  let now = Date.parse("2026-08-29T10:00:00Z");
  let invocations = 0;
  let lastKey = "";
  const definition = {
    ...scheduledDefinition(),
    schedule: {
      ...schedule("interval"),
      intervalSeconds: 60,
    },
  };
  const scheduler = new AutomationScheduler(
    {
      now: () => new Date(now).toISOString(),
      store: {
        listScheduledAutomations: async () => [
          { definition, definitionDigest: `sha256:${"0".repeat(64)}` },
        ],
      },
      threads: { getThread: async () => ({ revision: 1 }) as never },
      automations: {
        runAutomationNow: async (_actor, command) => {
          assert.notEqual(command.idempotencyKey, lastKey);
          lastKey = command.idempotencyKey;
          invocations += 1;
          return {} as never;
        },
      },
    },
    { scanIntervalMs: null },
  );
  for (let tick = 0; tick < 20_000; tick += 1) {
    await scheduler.wake();
    if (tick % 100 === 0) await scheduler.wake();
    now += 60_000;
  }
  assert.equal(invocations, 20_000);
  assert.deepEqual(scheduler.resourceSnapshot(), {
    cachedAutomationCount: 1,
    cachedIdentityBytes: 128,
    cacheLimit: 4096,
    scanInFlight: false,
    hasScanContinuation: false,
  });
  await scheduler.close();
  assert.equal(scheduler.resourceSnapshot().cachedAutomationCount, 0);
});

test("bounds unique automation identities and retries evictions with the same durable key", async () => {
  let definitions = [scheduledDefinition()];
  const calls: Array<{ tenant: string; id: string; key: string }> = [];
  const scheduler = new AutomationScheduler(
    {
      now: () => "2026-08-29T10:00:01Z",
      store: {
        listScheduledAutomations: async () =>
          definitions.map((definition) => ({
            definition,
            definitionDigest: `sha256:${"0".repeat(64)}`,
          })),
      },
      threads: { getThread: async () => ({ revision: 1 }) as never },
      automations: {
        runAutomationNow: async (actor, command) => {
          calls.push({
            tenant: actor.tenantId,
            id: command.automationId,
            key: command.idempotencyKey,
          });
          return {} as never;
        },
      },
    },
    { scanIntervalMs: null, completedAutomationCacheLimit: 1 },
  );
  await scheduler.wake();
  definitions = [{ ...scheduledDefinition(), tenantId: "tenant-2" }];
  await scheduler.wake();
  definitions = [scheduledDefinition()];
  await scheduler.wake();
  assert.deepEqual(
    calls.map((call) => call.tenant),
    ["tenant-1", "tenant-2", "tenant-1"],
  );
  assert.equal(calls[0]?.key, calls[2]?.key);
  assert.equal(scheduler.resourceSnapshot().cachedAutomationCount, 1);
  assert.equal(scheduler.resourceSnapshot().cachedIdentityBytes, 128);
  await scheduler.close();
});

test("continues past 10,000 definitions with at most one page per wake despite a busy first thread", async () => {
  const total = 10_005;
  let pageReads = 0;
  let calls = 0;
  const scheduler = new AutomationScheduler(
    {
      now: () => "2026-08-29T10:00:01Z",
      store: {
        listScheduledAutomations: async ({ before, limit }) => {
          pageReads += 1;
          const start =
            before === null
              ? total
              : Number(before.automationId.slice("automation-".length)) - 1;
          return Array.from(
            { length: Math.min(limit, Math.max(0, start)) },
            (_, offset) => ({
              definition: {
                ...scheduledDefinition(),
                automationId: `automation-${start - offset}`,
              },
              definitionDigest: `sha256:${"0".repeat(64)}`,
            }),
          );
        },
      },
      threads: { getThread: async () => ({ revision: 1 }) as never },
      automations: {
        runAutomationNow: async (_actor, command) => {
          calls += 1;
          if (command.automationId === `automation-${total}`)
            throw new Error("thread_active_run_conflict");
          return {} as never;
        },
      },
    },
    { scanIntervalMs: null },
  );
  for (let page = 0; page < 101; page += 1) {
    const before = calls;
    await scheduler.wake();
    assert.equal(pageReads, page + 1);
    assert.ok(calls - before <= 100);
    assert.ok(scheduler.resourceSnapshot().cachedAutomationCount <= 4096);
    if (page === 0)
      assert.equal(scheduler.lastFailureCode(), "thread_active_run_conflict");
  }
  assert.equal(calls, total);
  assert.equal(scheduler.resourceSnapshot().hasScanContinuation, false);
  assert.equal(scheduler.lastFailureCode(), null);
  await scheduler.wake();
  assert.equal(pageReads, 102);
  assert.equal(scheduler.lastFailureCode(), "thread_active_run_conflict");
  await scheduler.close();
});

test("storage pressure resumes at the unsubmitted record instead of rescanning the completed prefix", async () => {
  let blocked = false;
  const cursors: (string | null)[] = [];
  const calls: string[] = [];
  const scheduler = new AutomationScheduler(
    {
      now: () => "2026-08-29T10:00:01Z",
      store: {
        listScheduledAutomations: async ({ before }) => {
          cursors.push(before?.automationId ?? null);
          return (before === null ? [2, 1] : [1]).map((index) => ({
            definition: {
              ...scheduledDefinition(),
              automationId: `automation-${index}`,
            },
            definitionDigest: `sha256:${"0".repeat(64)}`,
          }));
        },
      },
      storageAdmission: {
        assertNewWorkAllowed: async () => {
          if (blocked) throw new StorageAdmissionError("storage_capacity_low");
        },
      },
      threads: { getThread: async () => ({ revision: 1 }) as never },
      automations: {
        runAutomationNow: async (_actor, command) => {
          calls.push(command.automationId);
          blocked = true;
          return {} as never;
        },
      },
    },
    { scanIntervalMs: null },
  );
  await scheduler.wake();
  assert.deepEqual(calls, ["automation-2"]);
  for (let index = 0; index < 10; index += 1) await scheduler.wake();
  assert.deepEqual(cursors, [null]);
  blocked = false;
  await scheduler.wake();
  assert.deepEqual(cursors, [null, "automation-2"]);
  assert.deepEqual(calls, ["automation-2", "automation-1"]);
  await scheduler.close();
});

for (const boundary of ["scan", "thread", "enqueue"] as const) {
  test(`close during ${boundary} coalesces wakes and starts no later invocation`, async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pause = async (at: typeof boundary) => {
      if (boundary !== at) return;
      enter();
      await pending;
    };
    let scans = 0;
    let enqueues = 0;
    const scheduler = new AutomationScheduler(
      {
        now: () => "2026-08-29T10:00:01Z",
        store: {
          listScheduledAutomations: async () => {
            scans += 1;
            await pause("scan");
            return [2, 1].map((index) => ({
              definition: {
                ...scheduledDefinition(),
                automationId: `automation-${index}`,
              },
              definitionDigest: `sha256:${"0".repeat(64)}`,
            }));
          },
        },
        threads: {
          getThread: async () => {
            await pause("thread");
            return { revision: 1 } as never;
          },
        },
        automations: {
          runAutomationNow: async () => {
            enqueues += 1;
            await pause("enqueue");
            return {} as never;
          },
        },
      },
      { scanIntervalMs: null },
    );
    const wake = scheduler.wake();
    await entered;
    const wakes = Array.from({ length: 1000 }, () => scheduler.wake());
    assert.ok(wakes.every((pendingWake) => pendingWake === wake));
    assert.equal(scheduler.resourceSnapshot().scanInFlight, true);
    const closed = scheduler.close();
    release();
    await Promise.all([wake, closed, ...wakes]);
    assert.equal(scans, 1);
    assert.equal(enqueues, boundary === "enqueue" ? 1 : 0);
    assert.equal(scheduler.resourceSnapshot().cachedAutomationCount, 0);
    assert.equal(scheduler.resourceSnapshot().hasScanContinuation, false);
    assert.equal(scheduler.resourceSnapshot().scanInFlight, false);
    await scheduler.wake();
    assert.equal(scans, 1);
  });
}

test("cache and page budgets reject invalid configuration before running", () => {
  const dependencies = {
    now: () => "2026-08-29T10:00:01Z",
    store: { listScheduledAutomations: async () => [] },
    threads: { getThread: async () => ({ revision: 1 }) as never },
    automations: { runAutomationNow: async () => ({}) as never },
  };
  for (const completedAutomationCacheLimit of [-1, 0.5, 16_385, Infinity, NaN])
    assert.throws(
      () =>
        new AutomationScheduler(dependencies, {
          completedAutomationCacheLimit,
        }),
      /automation_cache_limit_invalid/,
    );
  for (const maxPagesPerWake of [0, 0.5, 101, Infinity, NaN])
    assert.throws(
      () => new AutomationScheduler(dependencies, { maxPagesPerWake }),
      /automation_scan_page_budget_invalid/,
    );
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
