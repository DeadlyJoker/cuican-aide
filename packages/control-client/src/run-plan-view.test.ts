import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGetRunPlanResponse,
  parseRunPlanView,
  RunPlanViewValidationError,
} from "./run-plan-view.ts";

test("strictly parses a bounded Run Plan response", () => {
  const input = { runId: "run-1", eventSequence: 7, plan: runPlan() };
  const parsed = parseGetRunPlanResponse(input, "run-1");
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.plan, input.plan);
  assert.deepEqual(
    parseGetRunPlanResponse(
      { runId: "run-1", eventSequence: 1, plan: null },
      "run-1",
    ),
    { runId: "run-1", eventSequence: 1, plan: null },
  );
});

test("rejects unknown fields and invalid Run Plan invariants", () => {
  const invalid = [
    { ...runPlan(), callId: "private" },
    { ...runPlan(), schemaVersion: "crewon.run-plan.v1" },
    {
      ...runPlan(),
      items: [
        { itemId: "one", title: "One", status: "inProgress" },
        { itemId: "two", title: "Two", status: "inProgress" },
      ],
    },
    {
      ...runPlan(),
      items: [
        { itemId: "same", title: "One", status: "pending" },
        { itemId: "same", title: "Two", status: "completed" },
      ],
    },
    { ...runPlan(), explanation: ` ${"x".repeat(10)}` },
  ];
  for (const value of invalid) {
    assert.throws(() => parseRunPlanView(value), RunPlanViewValidationError);
  }
});

test("binds a Run Plan response to its requested Run", () => {
  assert.throws(
    () =>
      parseGetRunPlanResponse(
        { runId: "run-2", eventSequence: 7, plan: runPlan() },
        "run-1",
      ),
    RunPlanViewValidationError,
  );
});

function runPlan() {
  return {
    schemaVersion: "crewon.run-plan.v0" as const,
    planId: "run-1",
    revision: 2,
    explanation: "Ship safely",
    items: [
      { itemId: "design", title: "Design", status: "completed" as const },
      {
        itemId: "implement",
        title: "Implement",
        status: "inProgress" as const,
      },
    ],
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:01:00.000Z",
  };
}
