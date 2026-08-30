import assert from "node:assert/strict";
import test from "node:test";

import {
  ExecutionLifecycleError,
  finishRunAttempt,
  startRunAttempt,
} from "./execution-lifecycle.ts";

test("creates a current model Attempt then completes its Step", () => {
  const started = startRunAttempt(null, null, startInput("attempt-1", 1));
  const completed = finishRunAttempt(started.step, started.attempt, {
    status: "completed",
    finishedAt: "2026-08-08T00:00:02Z",
    checkpointDigest: `sha256:${"a".repeat(64)}`,
  });

  assert.equal(completed.step.status, "completed");
  assert.equal(completed.step.attemptCount, 1);
  assert.equal(completed.attempt.status, "completed");
});

test("creates a retryOf Attempt and abandons a stale running Attempt", () => {
  const first = startRunAttempt(null, null, startInput("attempt-1", 1));
  const retried = startRunAttempt(
    first.step,
    first.attempt,
    startInput("attempt-2", 2),
  );

  assert.equal(retried.attempt.attemptNumber, 2);
  assert.equal(retried.attempt.retryOfAttemptId, "attempt-1");
  assert.equal(retried.abandonedAttempt?.status, "abandoned");
});

test("moves retryable failure to ready and rejects stale terminal writes", () => {
  const started = startRunAttempt(null, null, startInput("attempt-1", 1));
  const failed = finishRunAttempt(started.step, started.attempt, {
    status: "failed",
    finishedAt: "2026-08-08T00:00:02Z",
    checkpointDigest: null,
    failure: { code: "provider_unavailable", retryable: true },
  });
  assert.equal(failed.step.status, "ready");
  assert.throws(
    () =>
      finishRunAttempt(failed.step, failed.attempt, {
        status: "completed",
        finishedAt: "2026-08-08T00:00:03Z",
        checkpointDigest: null,
      }),
    (error: unknown) =>
      error instanceof ExecutionLifecycleError &&
      error.code === "attempt_not_current",
  );
});

function startInput(attemptId: string, leaseEpoch: number) {
  return {
    tenantId: "tenant-1",
    runId: "run-1",
    stepId: "step-1",
    kind: "model" as const,
    attemptId,
    workItemId: "work-item-1",
    leaseEpoch,
    startedAt: `2026-08-08T00:00:0${leaseEpoch}Z`,
  };
}
