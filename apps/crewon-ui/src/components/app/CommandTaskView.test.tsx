import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProjectsView } from "./CommandWorkspaceViews";
import type { CommandLinkedThread } from "./CommandWorkspaceChrome";

const tasks: CommandLinkedThread[] = [
  {
    cwd: null,
    id: "failed-unread",
    preview: "任务异常中断",
    scope: "personal",
    scopeLabel: "个人任务",
    state: "failedUnread",
    stateLabel: "异常结束，结果未查看",
    title: "修复发布阻塞",
    updatedAt: 600,
    updatedLabel: "2 分钟前",
    workspaceLabel: "cuican-aide",
  },
  {
    cwd: null,
    id: "completed-unread",
    preview: "验收已经完成",
    scope: "personal",
    scopeLabel: "个人任务",
    state: "completedUnread",
    stateLabel: "新完成，结果未查看",
    title: "验收发布结果",
    updatedAt: 500,
    updatedLabel: "5 分钟前",
    workspaceLabel: "cuican-aide",
  },
  {
    cwd: null,
    id: "pending-viewed",
    preview: "等待已查看的确认",
    scope: "team",
    scopeLabel: "团队任务",
    state: "pendingViewed",
    stateLabel: "已查看，仍待确认",
    title: "继续确认发布范围",
    updatedAt: 450,
    updatedLabel: "8 分钟前",
    workspaceLabel: "产品交付小队",
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
    updatedAt: 400,
    updatedLabel: "12 分钟前",
    workspaceLabel: "产品交付小队",
  },
  {
    cwd: null,
    id: "completed",
    preview: "发布说明已经完成",
    scope: "personal",
    scopeLabel: "个人任务",
    state: "completedViewed",
    stateLabel: "已完成",
    title: "撰写发布说明",
    updatedAt: 200,
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
    updatedAt: 300,
    updatedLabel: "刚刚",
    workspaceLabel: "cuican-aide",
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

    expect(markup.indexOf("修复发布阻塞")).toBeLessThan(
      markup.indexOf("整理发布计划"),
    );
    expect(markup.indexOf("确认发布范围")).toBeLessThan(
      markup.indexOf("整理发布计划"),
    );
    expect(markup.indexOf("整理发布计划")).toBeLessThan(
      markup.indexOf("撰写发布说明"),
    );
    expect(markup).toContain('data-task-scope="team"');
    expect(markup).toContain('data-thread-state="pendingUnread"');
    expect(markup).toContain(
      'class="command-thread-status is-completed-unread"',
    );
    expect(markup).toContain(
      'class="command-thread-status is-failed-unread"',
    );
    expect(markup.match(/class="command-thread-status is-/gu)).toHaveLength(3);
    expect(markup).not.toContain("is-pending-viewed");
    expect(markup).not.toContain("is-running");
    expect(markup).toContain("产品交付小队 · 团队任务");
    expect(markup).not.toContain("Workflow");
    expect(markup).not.toContain("Gate");
    expect(markup).toMatchSnapshot();
  });
});
