import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import type { RunPlanView } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import {
  hasThreadProgress,
  runPlanProgress,
  threadProgressSummary,
} from "./threadProgressSummary";

function turn(id: string, items: ThreadItem[]): Turn {
  return { id, items } as unknown as Turn;
}

function thread(turns: Turn[]): Thread {
  return { id: "thread-1", turns } as unknown as Thread;
}

function planItem(id: string, text: string): ThreadItem {
  return { type: "plan", id, text } as ThreadItem;
}

function fileChangeItem(
  id: string,
  changes: Array<{ path: string; diff: string }>,
  status: Extract<ThreadItem, { type: "fileChange" }>["status"] = "completed",
): ThreadItem {
  return {
    type: "fileChange",
    id,
    status,
    changes: changes.map((change) => ({
      ...change,
      kind: { type: "update" },
    })),
  } as unknown as ThreadItem;
}

function runPlan(
  statuses: RunPlanView["items"][number]["status"][],
): RunPlanView {
  return {
    schemaVersion: "crewon.run-plan.v0",
    planId: "turn-2",
    revision: 2,
    explanation: "按当前 Run 推进",
    items: statuses.map((status, index) => ({
      itemId: `item-${index + 1}`,
      title: `步骤 ${index + 1}`,
      status,
    })),
    createdAt: "2026-09-02T08:00:00.000Z",
    updatedAt: "2026-09-02T08:01:00.000Z",
  };
}

describe("runPlanProgress", () => {
  it("uses the real item position and starts an all-pending Plan at step one", () => {
    expect(runPlanProgress(runPlan(["pending", "pending"]))).toEqual({
      completed: 0,
      current: 1,
      total: 2,
    });
    expect(
      runPlanProgress(
        runPlan(["completed", "pending", "inProgress", "pending"]),
      ),
    ).toEqual({ completed: 1, current: 3, total: 4 });
  });

  it("reports a completed Plan at its final step", () => {
    expect(runPlanProgress(runPlan(["completed", "completed"]))).toEqual({
      completed: 2,
      current: 2,
      total: 2,
    });
  });
});

describe("threadProgressSummary", () => {
  const selectedThread = thread([
    turn("turn-1", [
      planItem("plan-old", "- [inProgress] 旧计划"),
      fileChangeItem("change-1", [{ path: "old.ts", diff: "+old" }]),
    ]),
    turn("turn-2", [
      fileChangeItem("change-2", [
        { path: "a.ts", diff: "--- a/a.ts\n+++ b/a.ts\n-old\n+one" },
        { path: "a.ts", diff: "+two" },
        { path: "b.ts", diff: "+three\n-four" },
      ]),
      fileChangeItem(
        "change-declined",
        [{ path: "declined.ts", diff: "+not-applied" }],
        "declined",
      ),
      planItem("proposed-plan", "- [completed] 这不是执行进度"),
    ]),
  ]);

  it("scopes structured progress and changed files to exactly one Run", () => {
    const plan = runPlan(["completed", "inProgress", "pending"]);
    expect(
      threadProgressSummary(selectedThread, { runId: "turn-2", runPlan: plan }),
    ).toEqual({
      fileChanges: { files: 2 },
      hasProposedPlan: true,
      plan: { completed: 1, current: 2, total: 3 },
      runPlan: plan,
      runId: "turn-2",
    });
  });

  it("does not parse ProposedPlan text as execution progress", () => {
    const summary = threadProgressSummary(selectedThread, { runId: "turn-2" });
    expect(summary.plan).toBeNull();
    expect(summary.runPlan).toBeNull();
    expect(summary.hasProposedPlan).toBe(true);
  });

  it("does not fall back to an old Run while the new active Run is absent", () => {
    expect(threadProgressSummary(selectedThread, { runId: "turn-3" })).toEqual({
      fileChanges: null,
      hasProposedPlan: false,
      plan: null,
      runPlan: null,
      runId: "turn-3",
    });
  });

  it("uses only the latest Turn when no explicit Run scope is supplied", () => {
    const summary = threadProgressSummary(selectedThread);
    expect(summary.runId).toBe("turn-2");
    expect(summary.fileChanges).toEqual({ files: 2 });
    expect(summary.hasProposedPlan).toBe(true);
  });

  it("reports no progress for an empty or missing thread", () => {
    expect(threadProgressSummary(null)).toEqual({
      fileChanges: null,
      hasProposedPlan: false,
      plan: null,
      runPlan: null,
      runId: null,
    });
    expect(hasThreadProgress(threadProgressSummary(thread([])))).toBe(false);
  });
});
