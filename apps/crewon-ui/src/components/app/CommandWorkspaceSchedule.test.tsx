import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { nextScheduledAt, ScheduleView } from "./CommandWorkspaceSchedule";

describe("personal schedule", () => {
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

    expect(markup).toContain("让 CrewON 按计划完成重复工作");
    expect(markup).toContain("执行记录");
    expect(markup).not.toContain("定时任务");
    expect(markup).toMatchSnapshot();
  });
});
