import type { AutomationView } from "@crewon/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AutomationSkillStatus } from "./AutomationSkillStatus";
import { CommandScheduleCalendar } from "./CommandScheduleCalendar";
import { scheduleSkillInvocation } from "./automationSkill.test-support";

function definition(): AutomationView {
  return {
    automationId: "automation-1",
    threadId: "thread-1",
    title: "每周报告",
    prompt: "按已绑定的 Skill 版本和参数执行。",
    agentVersionId: "agent-1",
    executionMode: "scheduled",
    automaticScheduling: true,
    schedule: {
      scheduleType: "once",
      nextRunAt: "2026-09-14T08:00:00Z",
      intervalSeconds: 0,
      time: "16:00",
      weekday: 1,
      timezone: "Asia/Shanghai",
    },
    revision: 1,
    createdAt: "2026-09-14T00:00:00Z",
    updatedAt: "2026-09-14T00:00:00Z",
    skillInvocation: scheduleSkillInvocation(),
  };
}

describe("Skill schedule current readiness", () => {
  it("keeps the current fixed version visible without a ready banner", () => {
    const markup = renderToStaticMarkup(
      <AutomationSkillStatus
        definition={{
          ...definition(),
          skillReadiness: { state: "ready", code: null },
        }}
      />,
    );
    expect(markup).toContain("固定版本：weekly-report · version-1");
    expect(markup).not.toContain("待恢复");
    expect(markup).not.toContain('role="status"');
    expect(markup).toContain("每次任务工具审批：请求批准");
  });

  it("shows the persisted whole-task approval mode on the Skill schedule", () => {
    const markup = renderToStaticMarkup(
      <AutomationSkillStatus
        definition={{ ...definition(), toolPermissionMode: "approveForMe" }}
      />,
    );
    expect(markup).toContain("每次任务工具审批：帮我批准");
  });

  it("shows a current authorization block without manufacturing a failed Run", () => {
    const markup = renderToStaticMarkup(
      <AutomationSkillStatus
        definition={{
          ...definition(),
          skillReadiness: { state: "blocked", code: "skill_access_denied" },
        }}
      />,
    );
    expect(markup).toContain("执行条件待恢复");
    expect(markup).toContain("恢复访问权限后重试");
    expect(markup).not.toContain("运行失败");
  });

  it("preserves the prompt-only layout", () => {
    const { skillInvocation: _, ...legacy } = definition();
    expect(
      renderToStaticMarkup(<AutomationSkillStatus definition={legacy} />),
    ).toBe("");
  });

  it("snapshots the existing calendar with recovery, retry, and thread history access", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T07:00:00Z"));
    try {
      const markup = renderToStaticMarkup(
        <CommandScheduleCalendar
          busy={null}
          definitions={[
            {
              ...definition(),
              skillReadiness: {
                state: "blocked",
                code: "skill_dependency_unavailable",
              },
            },
          ]}
          onRunNow={() => {}}
          onOpenThread={() => {}}
        />,
      );
      expect(markup).toContain("等待恢复");
      expect(markup).toContain("恢复依赖和工具授权");
      expect(markup).toContain("重试</button>");
      expect(markup).toContain("打开「每周报告」的对话");
      expect(markup).toMatchSnapshot();
    } finally {
      vi.useRealTimers();
    }
  });
});
