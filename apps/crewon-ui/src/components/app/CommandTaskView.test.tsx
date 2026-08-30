import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProjectsView } from "./CommandWorkspaceViews";
import type { CommandLinkedThread } from "./CommandWorkspaceChrome";

const tasks: CommandLinkedThread[] = [
  {
    cwd: null,
    id: "completed",
    preview: "发布说明已经完成",
    scope: "personal",
    scopeLabel: "个人任务",
    state: "completedViewed",
    stateLabel: "已完成",
    title: "撰写发布说明",
    updatedAt: 300,
    updatedLabel: "20 分钟前",
    workspaceLabel: "cuican-aide",
  },
  {
    cwd: null,
    id: "running",
    preview: "正在整理发布计划",
    scope: "personal",
    scopeLabel: "个人任务",
    state: "running",
    stateLabel: "进行中",
    title: "整理发布计划",
    updatedAt: 200,
    updatedLabel: "刚刚",
    workspaceLabel: "cuican-aide",
  },
  {
    cwd: null,
    id: "pending",
    preview: "等待团队确认发布范围",
    scope: "team",
    scopeLabel: "团队任务",
    state: "pendingUnread",
    stateLabel: "新的待确认",
    title: "确认发布范围",
    updatedAt: 100,
    updatedLabel: "12 分钟前",
    workspaceLabel: "产品交付小队",
  },
];

describe("ProjectsView", () => {
  it("shows real personal and team tasks with attention first", () => {
    const markup = renderToStaticMarkup(
      <ProjectsView
        active
        locale="zh"
        tasks={tasks}
        onNewTask={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    expect(markup.indexOf("确认发布范围")).toBeLessThan(
      markup.indexOf("整理发布计划"),
    );
    expect(markup.indexOf("整理发布计划")).toBeLessThan(
      markup.indexOf("撰写发布说明"),
    );
    expect(markup).toContain('data-task-scope="team"');
    expect(markup).toContain('data-thread-state="pendingUnread"');
    expect(markup).toContain("产品交付小队 · 团队任务");
    expect(markup).not.toContain("Workflow");
    expect(markup).not.toContain("Gate");
    expect(markup).toMatchSnapshot();
  });
});
