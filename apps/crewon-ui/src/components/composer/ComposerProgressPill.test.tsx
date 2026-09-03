import { renderToStaticMarkup } from "react-dom/server";
import type { RunPlanView } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadProgressSummary } from "../../lib/thread/threadProgressSummary";
import {
  ComposerProgressChecklist,
  ComposerProgressPill,
} from "./ComposerProgressPill";

function plan(): RunPlanView {
  return {
    schemaVersion: "crewon.run-plan.v0",
    planId: "run-1",
    revision: 3,
    explanation: "先核对边界，再完成交付。",
    items: [
      { itemId: "done", title: "读取 <AGENTS.md>", status: "completed" },
      { itemId: "active", title: "实现结构化投影", status: "inProgress" },
      { itemId: "blocked", title: "等待外部依赖", status: "blocked" },
      { itemId: "canceled", title: "移除旧路径", status: "canceled" },
      { itemId: "pending", title: "运行验证", status: "pending" },
    ],
    createdAt: "2026-09-02T08:00:00.000Z",
    updatedAt: "2026-09-02T08:02:00.000Z",
  };
}

function summary(
  overrides: Partial<ThreadProgressSummary> = {},
): ThreadProgressSummary {
  return {
    fileChanges: null,
    hasProposedPlan: false,
    plan: null,
    runPlan: null,
    runId: "run-1",
    ...overrides,
  };
}

describe("ComposerProgressPill", () => {
  it("keeps ProposedPlan as a non-interactive status", () => {
    const markup = renderToStaticMarkup(
      <ComposerProgressPill
        locale="zh"
        running={false}
        summary={summary({ hasProposedPlan: true })}
      />,
    );

    expect(markup).toContain("计划已生成");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("<button");
    expect(markup).toMatchSnapshot();
  });

  it("shows the current task's recorded edit operations without a Plan", () => {
    const markup = renderToStaticMarkup(
      <ComposerProgressPill
        locale="en"
        running={false}
        summary={summary({ fileChanges: { files: 12 } })}
        taskChanges={{ additions: 727, deletions: 86, files: 12 }}
      />,
    );

    expect(markup).toContain("12 files changed");
    expect(markup).toContain("+727");
    expect(markup).toContain("-86");
    expect(markup).not.toContain("<button");
    expect(markup).toMatchSnapshot();
  });

  it("renders a structured execution Plan as an accessible popover trigger", () => {
    const runPlan = plan();
    const markup = renderToStaticMarkup(
      <ComposerProgressPill
        locale="zh"
        running
        summary={summary({
          fileChanges: { files: 2 },
          plan: { completed: 1, current: 2, total: 5 },
          runPlan,
        })}
        taskChanges={{ additions: 15, deletions: 4, files: 2 }}
      />,
    );

    expect(markup).toContain("<button");
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("第 2 / 5 步");
    expect(markup).toContain("2 个文件已更改");
    expect(markup).toContain("+15");
    expect(markup).toContain("-4");
    expect(markup).toContain("查看执行计划");
    expect(markup).toContain("composer-progress-disclosure");
    expect(markup).toMatchSnapshot();
  });

  it("renders every status as text and escapes untrusted Plan titles", () => {
    const runPlan = plan();
    const markup = renderToStaticMarkup(
      <ComposerProgressChecklist
        descriptionId="description"
        locale="zh"
        summary={summary({
          plan: { completed: 1, current: 2, total: 5 },
          runPlan,
        })}
        titleId="title"
      />,
    );

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="1"');
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain("已完成");
    expect(markup).toContain("进行中");
    expect(markup).toContain("受阻");
    expect(markup).toContain("已取消");
    expect(markup).toContain("待处理");
    expect(markup).toContain("读取 &lt;AGENTS.md&gt;");
    expect(markup).not.toContain("<AGENTS.md>");
    expect(markup).toMatchSnapshot();
  });
});
