import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import {
  hasThreadProgress,
  parsePlanProgress,
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
): ThreadItem {
  return {
    type: "fileChange",
    id,
    status: { type: "completed" },
    changes: changes.map((change) => ({
      ...change,
      kind: { type: "update" },
    })),
  } as unknown as ThreadItem;
}

describe("parsePlanProgress", () => {
  it("reads step counts from plan step lines", () => {
    expect(
      parsePlanProgress(
        "- [completed] 读代码\n- [completed] 改样式\n- [inProgress] 跑测试\n- [pending] 提交",
      ),
    ).toEqual({ completed: 2, current: 3, total: 4 });
  });

  it("treats a finished plan as fully advanced", () => {
    expect(parsePlanProgress("- [completed] a\n- [completed] b")).toEqual({
      completed: 2,
      current: 2,
      total: 2,
    });
  });

  it("ignores text without plan step lines", () => {
    expect(parsePlanProgress("没有步骤的说明文字")).toBeNull();
  });
});

describe("threadProgressSummary", () => {
  it("summarizes the latest plan and every file change", () => {
    const summary = threadProgressSummary(
      thread([
        turn("turn-1", [
          planItem("plan-old", "- [pending] 旧计划"),
          fileChangeItem("change-1", [
            { path: "a.ts", diff: "--- a\n+++ b\n+one\n-two" },
          ]),
        ]),
        turn("turn-2", [
          fileChangeItem("change-2", [
            { path: "a.ts", diff: "+three" },
            { path: "b.ts", diff: "+four\n-five" },
          ]),
          planItem(
            "plan-new",
            "- [completed] 一\n- [inProgress] 二\n- [pending] 三",
          ),
        ]),
      ]),
    );

    expect(summary).toEqual({
      fileChanges: { added: 3, files: 2, removed: 2 },
      hasProposedPlan: true,
      plan: { completed: 1, current: 2, total: 3 },
    });
  });

  it("reports no progress for an empty or missing thread", () => {
    expect(threadProgressSummary(null)).toEqual({
      fileChanges: null,
      hasProposedPlan: false,
      plan: null,
    });
    expect(hasThreadProgress(threadProgressSummary(thread([])))).toBe(false);
    expect(
      hasThreadProgress(
        threadProgressSummary(
          thread([turn("turn-1", [planItem("plan-1", "- [pending] 一")])]),
        ),
      ),
    ).toBe(true);
    expect(
      hasThreadProgress(
        threadProgressSummary(
          thread([turn("turn-2", [planItem("plan-2", "实施建议")])]),
        ),
      ),
    ).toBe(true);
  });
});
