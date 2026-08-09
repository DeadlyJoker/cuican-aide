import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PROPOSED_PLAN_BYTES,
  ProposedPlanError,
  type ProposedPlan,
  validateProposedPlan,
} from "./proposed-plan.ts";

function plan(overrides: Partial<ProposedPlan> = {}): ProposedPlan {
  return {
    schemaVersion: "crewon.proposed-plan.v0",
    planId: "plan-1",
    tenantId: "tenant-1",
    threadId: "thread-1",
    runId: "run-1",
    messageId: "message-1",
    content: "1. Inspect\n2. Migrate\n3. Verify",
    contentDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-09T00:00:00Z",
    ...overrides,
  };
}

test("accepts a complete bounded authoritative Plan projection", () => {
  assert.doesNotThrow(() => validateProposedPlan(plan()));
  assert.doesNotThrow(() =>
    validateProposedPlan(plan({ content: "计".repeat(3_333) })),
  );
});

test("rejects oversized, injected and schema-drifted Plan projections", () => {
  for (const candidate of [
    plan({ content: "a".repeat(MAX_PROPOSED_PLAN_BYTES + 1) }),
    plan({ content: "step\u0000injected" }),
    { ...plan(), browserAuthority: "forged" },
  ]) {
    assert.throws(
      () => validateProposedPlan(candidate as ProposedPlan),
      ProposedPlanError,
    );
  }
});
