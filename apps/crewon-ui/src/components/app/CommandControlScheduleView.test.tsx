import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CommandControlScheduleView,
  loadScheduledRunHistory,
  type ScheduledItem,
} from "./CommandControlScheduleView";
import type { LibraryPanel } from "../../lib/domain/crewonDomain";

function schedulePanel(): LibraryPanel {
  return {
    actions: [{ id: "prepare-control-automation", label: "新建安排" }],
    items: [
      { section: true, title: "已发布安排", meta: "1 项" },
      {
        action: {
          body: "每天汇总项目进展。",
          controlAutomationId: "automation-1",
          controlAutomationRevision: 1,
          controlSchedule: {
            kind: "daily",
            localTime: "18:00",
            timezone: "Asia/Shanghai",
          },
          prompt: "汇总项目进展",
          subtitle: "每天 18:00",
          threadId: "thread-1",
          title: "每日进展汇总",
          type: "automation-detail",
        },
        description: "每天汇总项目进展。",
        glyph: "◷",
        meta: "每天 18:00 · Asia/Shanghai",
        title: "每日进展汇总",
      },
    ],
    kind: "automation",
    subtitle: "1 个已发布安排",
    title: "自动化",
  };
}

describe("CommandControlScheduleView", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the migration-era calendar over real Control schedules", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T09:00:00.000+08:00"));
    const markup = renderToStaticMarkup(
      <CommandControlScheduleView
        locale="zh"
        panel={schedulePanel()}
        onItemAction={vi.fn()}
        onPanelAction={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(markup).toContain("计划 · 提醒");
    expect(markup).toContain("日程日历");
    expect(markup).toContain("每日进展汇总");
    expect(markup).toContain("新建安排");
    expect(markup).toContain("执行记录");
    expect(markup).toContain("个人日程");
    expect(markup).toContain("小队日程");
    expect(markup).toMatchSnapshot();
  });

  it("loads bounded real Control runs for the scheduled threads", async () => {
    const panel = schedulePanel();
    const item = panel.items[1]!;
    const action = item.action;
    if (action?.type !== "automation-detail" || !action.controlSchedule) {
      throw new Error("automation fixture invalid");
    }
    const scheduled: ScheduledItem = {
      item,
      schedule: action.controlSchedule,
    };
    const run = {
      runId: "run-1",
      threadId: "thread-1",
      status: "completed" as const,
      revision: 2,
      lastSequence: 4,
      cancelRequested: false,
      waitingApproval: null,
      collaborationMode: "default" as const,
      purpose: "turn" as const,
      workflowVersionBinding: null,
      goalBinding: null,
      outputRef: "output-1",
      failure: null,
      createdAt: "2026-08-21T08:00:00.000Z",
      updatedAt: "2026-08-21T08:01:00.000Z",
      terminalAt: "2026-08-21T08:01:00.000Z",
    };
    const listThreadRuns = vi.fn(async () => ({
      data: [run],
      nextCursor: null,
    }));

    await expect(
      loadScheduledRunHistory({ listThreadRuns }, [scheduled]),
    ).resolves.toEqual([{ run, schedules: [scheduled] }]);
    expect(listThreadRuns).toHaveBeenCalledWith(
      "thread-1",
      { limit: 100 },
      { signal: undefined },
    );
  });
});
