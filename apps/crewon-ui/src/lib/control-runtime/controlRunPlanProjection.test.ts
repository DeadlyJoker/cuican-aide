import type { RunPlanView } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import {
  applyControlRunPlanProjection,
  removeThreadRunPlanProjections,
  selectThreadRunPlanProjection,
  type ControlRunPlanProjectionState,
} from "./controlRunPlanProjection";

function plan(
  runId: string,
  revision: number,
  title = `revision ${revision}`,
): RunPlanView {
  return {
    schemaVersion: "crewon.run-plan.v0",
    planId: runId,
    revision,
    explanation: null,
    items: [{ itemId: "step", title, status: "inProgress" }],
    createdAt: "2026-09-02T08:00:00.000Z",
    updatedAt: `2026-09-02T08:00:0${revision}.000Z`,
  };
}

function update(
  state: ControlRunPlanProjectionState,
  input: {
    eventSequence: number;
    plan: RunPlanView | null;
    runId?: string;
    threadId?: string;
  },
) {
  return applyControlRunPlanProjection(state, {
    runId: input.runId ?? "run-1",
    threadId: input.threadId ?? "thread-1",
    eventSequence: input.eventSequence,
    plan: input.plan,
  });
}

describe("controlRunPlanProjection", () => {
  it("keeps Plans isolated by exact Thread and Run identity", () => {
    let state = update({}, { eventSequence: 4, plan: plan("run-1", 1) });
    state = update(state, {
      eventSequence: 0,
      plan: null,
      runId: "run-2",
    });

    expect(
      selectThreadRunPlanProjection(state, "thread-1", "run-2"),
    ).toEqual(
      expect.objectContaining({ runId: "run-2", plan: null }),
    );
    expect(
      selectThreadRunPlanProjection(state, "thread-1", "run-1")?.plan,
    ).toEqual(plan("run-1", 1));
    expect(selectThreadRunPlanProjection(state, "thread-2", "run-1")).toBeNull();
  });

  it("ignores duplicate and older revisions without erasing a trusted Plan", () => {
    const first = update({}, {
      eventSequence: 4,
      plan: plan("run-1", 2),
    });
    expect(
      update(first, { eventSequence: 0, plan: null }),
    ).toBe(first);
    expect(
      update(first, { eventSequence: 3, plan: plan("run-1", 1) }),
    ).toBe(first);
    expect(
      update(first, { eventSequence: 4, plan: plan("run-1", 2) }),
    ).toBe(first);
  });

  it("accepts a newer revision only with a newer Run event sequence", () => {
    const first = update({}, {
      eventSequence: 4,
      plan: plan("run-1", 1),
    });
    const second = update(first, {
      eventSequence: 6,
      plan: plan("run-1", 2),
    });
    expect(second["run-1"]?.plan?.revision).toBe(2);
    expect(() =>
      update(second, { eventSequence: 5, plan: plan("run-1", 3) }),
    ).toThrow("control_run_plan_sequence_regression");
  });

  it("fails closed for identity and same-revision content conflicts", () => {
    expect(() =>
      update({}, { eventSequence: 1, plan: plan("another-run", 1) }),
    ).toThrow("control_run_plan_projection_invalid");

    const state = update({}, {
      eventSequence: 4,
      plan: plan("run-1", 1),
    });
    expect(() =>
      update(state, {
        eventSequence: 5,
        plan: plan("run-1", 1, "different content"),
      }),
    ).toThrow("control_run_plan_revision_conflict");
    expect(() =>
      update(state, {
        eventSequence: 5,
        plan: plan("run-1", 2),
        threadId: "thread-2",
      }),
    ).toThrow("control_run_plan_thread_identity_conflict");
  });

  it("purges every projection owned by a rolled-back or deleted Thread", () => {
    let state = update({}, { eventSequence: 1, plan: plan("run-1", 1) });
    state = update(state, {
      eventSequence: 1,
      plan: plan("run-2", 1),
      runId: "run-2",
      threadId: "thread-2",
    });

    expect(Object.keys(removeThreadRunPlanProjections(state, "thread-1"))).toEqual([
      "run-2",
    ]);
  });
});
