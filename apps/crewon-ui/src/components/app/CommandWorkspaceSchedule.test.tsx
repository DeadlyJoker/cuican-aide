import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandScheduleCalendar } from "./CommandScheduleCalendar";
import { buildScheduleCalendarDays } from "./scheduleCalendarModel";
import { nextScheduledAt, ScheduleView } from "./CommandWorkspaceSchedule";

describe("personal schedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 27, 9, 30));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calculates the next local daily and weekly occurrence", () => {
    const now = new Date(2026, 6, 13, 19, 0, 0);

    expect(
      new Date(
        nextScheduledAt(
          "daily",
          { time: "18:00", weekday: 1, intervalMinutes: 60, runAt: "" },
          now,
        ) * 1000,
      ).getDate(),
    ).toBe(14);
    expect(
      new Date(
        nextScheduledAt(
          "weekly",
          { time: "09:00", weekday: 1, intervalMinutes: 60, runAt: "" },
          now,
        ) * 1000,
      ).getDate(),
    ).toBe(20);
  });

  it("renders the real empty schedule state", () => {
    const markup = renderToStaticMarkup(
      <ScheduleView
        active
        client={null}
        cwd="/repo"
        modalOpen={false}
        scheduleMode="tasks"
        scheduleSource="personal"
        onCloseModal={() => {}}
        onModeChange={() => {}}
        onOpenModal={() => {}}
        onOpenThread={() => {}}
        onSourceChange={() => {}}
      />,
    );

    expect(markup).not.toContain('class="schedule-heading"');
    expect(markup).not.toContain("让 CrewON 按计划完成重复工作");
    expect(markup).toContain("2026年7月");
    expect(markup).toContain("这一天还没有安排");
    expect(markup).toContain("执行记录");
    expect(markup).not.toContain("定时任务");
    expect(markup).toMatchSnapshot();
  });

  it("projects recurring schedules into the interactive month calendar", () => {
    const records = [
      {
        filePath: "/daily.json",
        savedAt: "2026-07-01T00:00:00Z",
        config: {
          title: "每日项目摘要",
          subtitle: "按计划自动执行",
          body: "结果发送给我",
          prompt: "汇总项目进展",
          enabled: true,
          trigger: {
            type: "schedule" as const,
            scheduleType: "daily",
            time: "18:00",
          },
        },
      },
      {
        filePath: "/weekly.json",
        savedAt: "2026-07-01T00:00:00Z",
        config: {
          title: "周一复盘",
          subtitle: "按计划自动执行",
          body: "结果发送给我",
          prompt: "复盘本周目标",
          enabled: false,
          trigger: {
            type: "schedule" as const,
            scheduleType: "weekly",
            time: "09:00",
            weekday: 1,
          },
        },
      },
    ];
    const days = buildScheduleCalendarDays(
      new Date(2026, 6, 1),
      new Date(2026, 6, 27),
      records,
      new Date(2026, 6, 27),
    );

    expect(days).toHaveLength(42);
    expect(
      days
        .find(({ key }) => key === "2026-07-27")
        ?.occurrences.map(({ record }) => record.config.title),
    ).toEqual(["周一复盘", "每日项目摘要"]);

    const markup = renderToStaticMarkup(
      <CommandScheduleCalendar
        busy={null}
        clientAvailable
        records={records}
        onCreate={() => {}}
        onOpenThread={() => {}}
        onRunNow={() => {}}
        onToggleSchedule={() => {}}
      />,
    );

    expect(markup).toContain("每日项目摘要");
    expect(markup).toContain("周一复盘");
    expect(markup).toContain("2 项");
    expect(markup).toMatchSnapshot();
  });
});
