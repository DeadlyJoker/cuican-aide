// @ts-expect-error Vitest runs this check in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  advanceTaskDetailProcessTermination,
  formatTaskDetailCount,
  handleTaskDetailPopoverEscape,
  TaskDetailPopover,
  type TaskDetailPresentation,
} from "./TaskDetailPopover";

const presentation: TaskDetailPresentation = {
  title: "修复团队协作回归",
  environment: {
    status: "ready",
    data: {
      branch: { detail: "当前工作区", label: "codex/task-detail" },
      changes: {
        added: 124,
        detail: "当前分支",
        files: 6,
        removed: 18,
      },
      status: { label: "运行中", tone: "success" },
      target: "控制运行时",
      workspace: "cuican-aide",
    },
  },
  agents: {
    status: "ready",
    data: {
      summary: "2 个活跃",
      items: [
        { id: "security", name: "安全审查", role: "成员", status: "running" },
        {
          id: "test",
          name: "回归测试",
          detail: "组件测试",
          status: "completed",
        },
      ],
    },
  },
  sources: {
    status: "ready",
    data: {
      total: 2,
      items: [
        {
          id: "image",
          kind: "image",
          label: "reference.png",
          thumbnailUrl: "/reference.png",
        },
        {
          id: "file",
          kind: "file",
          label: "TaskDetailPopover.tsx",
          detail: "工作区文件",
        },
      ],
    },
  },
};

const processes = {
  status: "ready",
  data: {
    items: [
      {
        processId: "p1",
        command: "pnpm test -- TaskDetailPopover",
        detail: "PID 4312",
        status: "running",
      },
      { processId: "p2", command: "pnpm build", status: "completed" },
    ],
  },
} as const;

const compactIcons = (markup: string) =>
  markup.replace(/<svg\b[^>]*>.*?<\/svg>/gs, "<svg></svg>");

describe("TaskDetailPopover", () => {
  it("formats large change totals without removing their explicit signs", () => {
    expect([
      `+${formatTaskDetailCount(21_744, "zh")}`,
      `-${formatTaskDetailCount(1_211_153, "zh")}`,
    ]).toEqual(["+21,744", "-1,211,153"]);
  });

  it("renders populated task sections without runtime implementation details", () => {
    const markup = renderToStaticMarkup(
      <TaskDetailPopover
        locale="zh"
        open
        presentation={presentation}
        processes={processes}
        onClose={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenTerminal={vi.fn()}
        onStopTask={vi.fn()}
        onTerminateProcess={vi.fn()}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="false"');
    for (const text of [
      "环境信息",
      "子智能体",
      "后台进程",
      "来源",
      "codex/task-detail",
      "pnpm test -- TaskDetailPopover",
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain("停止进程");
    expect(markup).toContain("停止任务");
    expect(markup).not.toContain("控制运行时");
    expect(markup).not.toContain("cuican-aide");
    expect(markup).not.toContain("command-workbench");
    expect(compactIcons(markup)).toMatchSnapshot();
  });

  it("keeps loading and error feedback while hiding empty resolved sections", () => {
    const partial: TaskDetailPresentation = {
      environment: {
        status: "error",
        error: "Git 状态刷新失败",
        data: { branch: { label: "main" } },
      },
      agents: { status: "loading" },
      sources: { status: "ready", data: { items: [] } },
    };
    const markup = renderToStaticMarkup(
      <TaskDetailPopover
        locale="zh"
        open
        presentation={partial}
        processes={{
          status: "unavailable",
          unavailableReason: "当前运行环境未提供",
        }}
        onClose={vi.fn()}
      />,
    );

    for (const text of [
      "main",
      "Git 状态刷新失败",
      "子智能体",
      "task-detail-skeleton",
    ]) {
      expect(markup).toContain(text);
    }
    for (const text of ["后台进程", "来源", "当前运行环境未提供", "暂无来源"]) {
      expect(markup).not.toContain(text);
    }
    expect(markup).not.toContain('data-status="unavailable"');
    expect(compactIcons(markup)).toMatchSnapshot();
  });

  it("keeps permission failures visible instead of treating them as empty", () => {
    const markup = renderToStaticMarkup(
      <TaskDetailPopover
        locale="zh"
        open
        presentation={{
          environment: { status: "ready", data: null },
          agents: { status: "ready", data: { items: [] } },
          sources: { status: "ready", data: { items: [] } },
        }}
        processes={{
          status: "forbidden",
          unavailableReason: "无权查看后台进程信息",
        }}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain("后台进程");
    expect(markup).toContain("无权查看后台进程信息");
    expect(markup).not.toContain("暂无后台进程");
  });

  it("closes with focus restoration and requires two clicks before termination", () => {
    const preventDefault = vi.fn();
    const onClose = vi.fn();
    expect(
      handleTaskDetailPopoverEscape(
        { defaultPrevented: false, key: "Escape", preventDefault },
        onClose,
      ),
    ).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith({ restoreFocus: true });

    const terminate = vi.fn();
    const pending = advanceTaskDetailProcessTermination(null, "p1", terminate);
    expect(pending).toBe("p1");
    expect(terminate).not.toHaveBeenCalled();
    expect(
      advanceTaskDetailProcessTermination(pending, "p1", terminate),
    ).toBeNull();
    expect(terminate).toHaveBeenCalledWith("p1");
  });

  it("disables the stop-task action while its turn interruption is pending", () => {
    const markup = renderToStaticMarkup(
      <TaskDetailPopover
        locale="zh"
        open
        presentation={presentation}
        processes={processes}
        stopTaskPending
        onClose={vi.fn()}
        onStopTask={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-label="正在停止任务"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("task-detail-spin");
  });

  it("removes an overlapped inactive surface from keyboard and accessibility navigation", () => {
    const markup = renderToStaticMarkup(
      <TaskDetailPopover
        interactionInactive
        locale="zh"
        open
        presentation={presentation}
        processes={processes}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('inert=""');
  });

  it("stays an absolute overlay in the main grid area", () => {
    const styles = readFileSync(
      new URL("./TaskDetailPopover.css", import.meta.url),
      "utf8",
    );
    const rootRule = styles.slice(
      styles.indexOf(".task-detail-popover {"),
      styles.indexOf(".task-detail-popover__header"),
    );
    expect(rootRule).toContain("position: absolute");
    expect(rootRule).toContain("grid-column: 1 / 2");
    expect(rootRule).toContain("grid-row: 1 / 2");
    expect(rootRule).toContain("width: 336px");
    expect(rootRule).not.toContain("width: clamp(");
    expect(rootRule).not.toContain("position: fixed");
    expect(rootRule).not.toContain("grid-template-columns");
    expect(styles).toContain("overflow-y: auto");
    expect(styles).toContain("scrollbar-gutter: auto");
    expect(styles).toContain("width: calc(100% + 10px)");
    expect(styles).toContain("width: min(336px, calc(100% - 16px))");
    expect(styles).toContain("padding-inline-start: 25px");
    expect(styles).not.toContain("command-workbench");
    expect(styles).not.toContain("backdrop-filter");
  });
});
