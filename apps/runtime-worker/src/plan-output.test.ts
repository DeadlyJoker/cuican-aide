import assert from "node:assert/strict";
import test from "node:test";

import { PlanOutputError, parseProposedPlan } from "./plan-output.ts";
import { MAX_PROPOSED_PLAN_BYTES } from "@crewon/domain";

test("extracts exactly one non-empty proposed Plan", () => {
  assert.equal(
    parseProposedPlan(
      "\n<proposed_plan>\n1. Inspect\n2. Migrate\n</proposed_plan>\n",
    ),
    "1. Inspect\n2. Migrate",
  );
});

test("rejects commentary, empty and multiple Plan envelopes", () => {
  for (const output of [
    "prefix <proposed_plan>plan</proposed_plan>",
    "<proposed_plan> </proposed_plan>",
    "<proposed_plan>one</proposed_plan><proposed_plan>two</proposed_plan>",
  ]) {
    assert.throws(
      () => parseProposedPlan(output),
      (error) => error instanceof PlanOutputError,
    );
  }
});

test("enforces the complete public Plan item byte cap", () => {
  assert.equal(
    parseProposedPlan(
      `<proposed_plan>${"a".repeat(MAX_PROPOSED_PLAN_BYTES)}</proposed_plan>`,
    ).length,
    MAX_PROPOSED_PLAN_BYTES,
  );
  assert.throws(
    () =>
      parseProposedPlan(
        `<proposed_plan>${"a".repeat(MAX_PROPOSED_PLAN_BYTES + 1)}</proposed_plan>`,
      ),
    (error) => error instanceof PlanOutputError,
  );
});
