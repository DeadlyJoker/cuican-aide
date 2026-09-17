import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { WorkItemClaim } from "@crewon/application";
import {
  CONTINUE_RUN,
  executionBudget,
  runWithExecutionBudget,
} from "./runtime-execution-budget.ts";

const claim: WorkItemClaim = {
  workItem: {
    workItemId: "work",
    tenantId: "tenant",
    runId: "run",
    kind: "run.execute",
    payload: {},
    createdAt: "2026-09-10T00:00:00Z",
  },
  lease: {
    ownerId: "owner",
    leaseId: "lease",
    epoch: 4,
    expiresAt: "2026-09-10T00:01:00Z",
  },
};

test("elapsed execution budget waits for the physical safe boundary before giving up scheduling ownership", async (t) => {
  let now = 0,
    release!: () => void,
    steps = 0,
    retries = 0;
  t.mock.method(performance, "now", () => now);
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = runWithExecutionBudget({
    claim,
    budget: executionBudget({ maxDurationMs: 10 }),
    shouldYield: () => false,
    execute: async () => {
      steps++;
      await held;
      return CONTINUE_RUN;
    },
    store: {
      retryWorkItem: async (input) => {
        assert.equal(input.leaseEpoch, 4);
        assert.equal(input.retryAfterMs, 1);
        retries++;
      },
    },
  });
  now = 1000;
  await setImmediate();
  assert.equal(retries, 0);
  assert.equal(steps, 1);
  release();
  assert.deepEqual(await result, {
    kind: "retried",
    runId: "run",
    code: "run_execution_yield",
  });
  assert.equal(retries, 1);
  assert.equal(steps, 1);
});

test("closure at a committed boundary yields without launching the next step", async () => {
  let steps = 0,
    retried = false;
  await runWithExecutionBudget({
    claim,
    budget: executionBudget(),
    shouldYield: () => true,
    execute: async () => {
      steps++;
      return CONTINUE_RUN;
    },
    store: {
      retryWorkItem: async () => {
        retried = true;
      },
    },
  });
  assert.equal(steps, 1);
  assert.equal(retried, true);
});

test("invalid execution budgets cannot silently remove the scheduling bound", () => {
  for (const n of [0, -1, Infinity, NaN, 0.5, 129])
    assert.throws(() => executionBudget({ maxBoundariesPerWake: n }));
  for (const n of [0, -1, Infinity, NaN, 0.5, 60001])
    assert.throws(() => executionBudget({ maxDurationMs: n }));
});
