import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RUN_PLAN_ITEMS,
  RunPlanError,
  sameRunPlanContent,
  type RunPlan,
  validateRunPlan,
} from "./run-plan.ts";

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    schemaVersion: "crewon.run-plan.v0",
    planId: "run-1",
    revision: 1,
    explanation: "Implement the durable slice",
    items: [
      { itemId: "design", title: "Finish design", status: "completed" },
      {
        itemId: "protocol",
        title: "Implement protocol",
        status: "inProgress",
      },
      { itemId: "ui", title: "Connect UI", status: "pending" },
    ],
    createdAt: "2026-09-02T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    ...overrides,
  };
}

test("accepts a complete bounded Run Plan snapshot", () => {
  assert.doesNotThrow(() => validateRunPlan(plan()));
  assert.doesNotThrow(() =>
    validateRunPlan(
      plan({
        items: Array.from({ length: MAX_RUN_PLAN_ITEMS }, (_, index) => ({
          itemId: `item-${index}`,
          title: `Step ${index}`,
          status: index === 0 ? "inProgress" : "pending",
        })),
      }),
    ),
  );
});

test("rejects ambiguous, oversized and schema-drifted snapshots", () => {
  for (const candidate of [
    plan({ items: [] }),
    plan({
      items: [
        { itemId: "same", title: "One", status: "inProgress" },
        { itemId: "same", title: "Two", status: "pending" },
      ],
    }),
    plan({
      items: [
        { itemId: "one", title: "One", status: "inProgress" },
        { itemId: "two", title: "Two", status: "inProgress" },
      ],
    }),
    plan({ explanation: "x".repeat(1_001) }),
    plan({
      items: [{ itemId: "bad id", title: "One", status: "pending" }],
    }),
    { ...plan(), tenantId: "forged" },
  ]) {
    assert.throws(
      () => validateRunPlan(candidate as RunPlan),
      RunPlanError,
    );
  }
});

test("compares only ordered model-visible content", () => {
  assert.equal(sameRunPlanContent(plan(), plan({ revision: 2 })), true);
  assert.equal(
    sameRunPlanContent(
      plan(),
      plan({
        items: [
          { itemId: "design", title: "Finish design", status: "completed" },
          { itemId: "ui", title: "Connect UI", status: "pending" },
          {
            itemId: "protocol",
            title: "Implement protocol",
            status: "inProgress",
          },
        ],
      }),
    ),
    false,
  );
});
