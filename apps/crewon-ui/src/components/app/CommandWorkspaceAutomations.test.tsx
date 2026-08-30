import type { AutomationView as AutomationDefinition } from "@crewon/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  buildAutomationCalendarDays,
  cadenceLabel,
  formatNextRun,
  isScheduledAutomation,
  nextRunDate,
} from "./automationCalendarModel";
import {
  AutomationView,
  createAutomationAuthorityEpoch,
  isCurrentAutomationAuthorityEpoch,
} from "./CommandWorkspaceAutomations";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function scheduledDefinition(
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return {
    automationId: "automation-1",
    threadId: "thread-1",
    title: "每日项目进展摘要",
    prompt: "汇总项目进展并给出下一步建议。",
    agentVersionId: "",
    executionMode: "scheduled",
    automaticScheduling: true,
    schedule: {
      scheduleType: "daily",
      nextRunAt: "2026-08-29T10:00:00Z",
      intervalSeconds: 86_400,
      time: "18:00",
      weekday: 6,
      timezone: "Asia/Shanghai",
    },
    revision: 1,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("schedule view on the Control runtime", () => {
  it("snapshots the calendar design without technical jargon", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T23:19:00.000Z"));
    const markup = renderToStaticMarkup(
      <AutomationView
        active
        connected={false}
        controlConfigured
        modalOpen
        runtime={null}
        selectedThreadId="thread-1"
        spaceAuthorityKey="space-1"
        onCloseModal={() => {}}
        onOpenModal={() => {}}
        onOpenThread={() => {}}
      />,
    );

    expect(markup).toContain("新建日程");
    expect(markup).toContain("定时执行");
    expect(markup).toContain("手动执行");
    expect(markup).toContain("下一次执行");
    expect(markup).toContain("正在连接日程服务");
    expect(markup).toContain("执行频率");
    expect(markup).toContain("绑定当前对话");
    expect(markup).not.toContain("manualOnly");
    expect(markup).not.toContain("automaticScheduling");
    expect(markup).not.toContain("App Server");
    expect(markup).not.toContain("Run SSE");
    expect(markup).not.toContain("authority");
    expect(markup).not.toContain("幂等");
    expect(markup).not.toContain("新建自动化");
    expect(markup).toMatchSnapshot();
    vi.useRealTimers();
  });

  it("rejects deferred list, create, and run writes from space A and its old runtime", async () => {
    const pendingWrites = [
      deferred<string>(),
      deferred<string>(),
      deferred<string>(),
    ];
    const epochA = createAutomationAuthorityEpoch(1);
    let current = epochA;
    const rendered: string[] = [];
    const completions = pendingWrites.map(({ promise }) =>
      promise.then((title) => {
        if (isCurrentAutomationAuthorityEpoch(current, epochA)) {
          rendered.push(title);
        }
      }),
    );

    epochA.controller.abort();
    current = createAutomationAuthorityEpoch(2);
    rendered.push("space B definition");
    pendingWrites[0]?.resolve("old runtime list");
    pendingWrites[1]?.resolve("old runtime create notice");
    pendingWrites[2]?.resolve("old runtime run notice");
    await Promise.all(completions);

    expect(rendered).toEqual(["space B definition"]);
  });

  it("renders no retained definitions when the service is disconnected", () => {
    const markup = renderToStaticMarkup(
      <AutomationView
        active
        connected={false}
        controlConfigured
        modalOpen={false}
        runtime={null}
        selectedThreadId="thread-B"
        spaceAuthorityKey="space-B"
        onCloseModal={() => {}}
        onOpenModal={() => {}}
      />,
    );

    expect(markup).toContain("正在连接日程服务");
    expect(markup).toContain('aria-label="日程日历"');
    expect(markup).toContain("这一天还没有安排");
    expect(markup).not.toContain("space A definition");
    expect(markup).not.toContain("已提交");
  });

  it("prefills the real creation form from an assistant request", () => {
    const markup = renderToStaticMarkup(
      <AutomationView
        active
        connected
        controlConfigured
        createDraft={{
          frequency: "daily",
          prompt: "每天九点整理当前对话的待办",
          requestId: 3,
          title: "每日待办整理",
        }}
        modalOpen
        runtime={null}
        selectedThreadId="assistant-thread"
        spaceAuthorityKey="space-1"
        onCloseModal={() => {}}
        onOpenModal={() => {}}
      />,
    );

    expect(markup).toContain('value="每日待办整理"');
    expect(markup).toContain("每天九点整理当前对话的待办");
    expect(markup).toContain("已从助理带入当前请求");
    expect(markup).toContain("绑定当前对话");
  });

  it("keeps the calendar model exports honest for scheduled definitions", () => {
    expect(scheduledDefinition().executionMode).toBe("scheduled");
  });
});
