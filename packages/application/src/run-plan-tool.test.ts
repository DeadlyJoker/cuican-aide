import assert from "node:assert/strict";
import test from "node:test";

import type { RunPlan } from "@crewon/domain";

import { evaluateRunPlanToolCall } from "./run-plan-tool.ts";

const occurredAt = "2026-09-02T00:00:00Z";

function input(
  items: unknown = [
    { id: "design", title: "Finish design", status: "completed" },
    { id: "protocol", title: "Implement protocol", status: "in_progress" },
  ],
): string {
  return JSON.stringify({ explanation: "Ship the vertical slice", items });
}

test("builds a normalized first Run Plan revision", () => {
  const result = evaluateRunPlanToolCall(null, "run-1", input(), occurredAt);
  assert.equal(result.isError, false);
  assert.equal(result.changed, true);
  assert.deepEqual(result.plan, {
    schemaVersion: "crewon.run-plan.v0",
    planId: "run-1",
    revision: 1,
    explanation: "Ship the vertical slice",
    items: [
      { itemId: "design", title: "Finish design", status: "completed" },
      {
        itemId: "protocol",
        title: "Implement protocol",
        status: "inProgress",
      },
    ],
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
});

test("keeps revision stable for an identical retry with a new call", () => {
  const current = evaluateRunPlanToolCall(
    null,
    "run-1",
    input(),
    occurredAt,
  ).plan!;
  const result = evaluateRunPlanToolCall(
    current,
    "run-1",
    input(),
    "2026-09-02T00:01:00Z",
  );
  assert.equal(result.isError, false);
  assert.equal(result.changed, false);
  assert.equal(result.plan, current);
});

test("rejects invalid fields and ambiguous progress without changing state", () => {
  const current: RunPlan = evaluateRunPlanToolCall(
    null,
    "run-1",
    input(),
    occurredAt,
  ).plan!;
  for (const candidate of [
    "not-json",
    JSON.stringify({ items: [], extra: true }),
    input([
      { id: "one", title: "One", status: "in_progress" },
      { id: "two", title: "Two", status: "in_progress" },
    ]),
    input([{ id: "bad id", title: "One", status: "pending" }]),
    input([{ id: "one", title: "One", status: "unknown" }]),
  ]) {
    const result = evaluateRunPlanToolCall(
      current,
      "run-1",
      candidate,
      "2026-09-02T00:01:00Z",
    );
    assert.equal(result.isError, true);
    assert.equal(result.changed, false);
    assert.equal(result.plan, current);
  }
});
