import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandControlScheduleView } from "./CommandControlScheduleView";
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
    expect(markup).toContain("全部安排");
    expect(markup).toMatchSnapshot();
  });
});
