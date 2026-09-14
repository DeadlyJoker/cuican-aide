// @vitest-environment happy-dom
import type { AutomationView as AutomationDefinition } from "@crewon/contracts";
import { ControlApiClient } from "@crewon/control-client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserExecutionBridge } from "../../lib/browser-execution/browserExecutionGrant";
import { ControlAutomationRuntime } from "../../lib/control-runtime/controlAutomationRuntime";
import { AutomationView } from "./CommandWorkspaceAutomations";
import { scheduleSkillInvocation } from "./automationSkill.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function definition(
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return {
    automationId: "automation-1",
    threadId: "thread-1",
    title: "每日销售报告",
    prompt: "读取当日订单并生成表格。",
    agentVersionId: "agent-1",
    executionMode: "manualOnly",
    automaticScheduling: false,
    schedule: {
      scheduleType: "once",
      nextRunAt: "9999-12-31T23:59:59Z",
      intervalSeconds: 0,
      time: "00:00",
      weekday: 0,
      timezone: "UTC",
    },
    revision: 1,
    createdAt: "2026-09-14T00:00:00Z",
    updatedAt: "2026-09-14T00:00:00Z",
    skillInvocation: {
      ...scheduleSkillInvocation(),
      requiredToolRefs: ["crewon_browser_act"],
    },
    ...overrides,
  };
}

function runtimeFor(definitions: readonly AutomationDefinition[]) {
  return new ControlAutomationRuntime({
    client: new ControlApiClient({
      baseUrl: "https://control.example/",
      fetch: async (input) => {
        if (!String(input).includes("/automations?"))
          throw new Error(`Unexpected request: ${String(input)}`);
        return new Response(
          JSON.stringify({ data: definitions, nextCursor: null }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    }),
    adopter: { adoptAutomationRun: async () => undefined },
  });
}

describe("persisted schedule browser authorization", () => {
  let root: Root;
  let container: HTMLDivElement;
  let bridge: ReturnType<typeof createBridge>;

  function createBridge() {
    return {
      status: vi.fn<BrowserExecutionBridge["status"]>().mockResolvedValue(null),
      authorize: vi
        .fn<BrowserExecutionBridge["authorize"]>()
        .mockImplementation(async ({ threadId, scope }) => ({
          threadId,
          sessionId: "browser-session-1",
          revision: 1,
          mode: scope ? "scoped" : "perAction",
        })),
      revoke: vi
        .fn<BrowserExecutionBridge["revoke"]>()
        .mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    bridge = createBridge();
    Object.defineProperty(window, "crewonDesktop", {
      configurable: true,
      value: { browserExecution: bridge },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "crewonDesktop");
    vi.useRealTimers();
  });

  async function render(
    definitions: readonly AutomationDefinition[],
    spaceAuthorityKey = "space-1",
  ) {
    const runtime = runtimeFor(definitions);
    await act(async () =>
      root.render(
        <AutomationView
          active
          connected
          controlConfigured
          modalOpen={false}
          runtime={runtime}
          selectedThreadId="unrelated-current-task"
          spaceAuthorityKey={spaceAuthorityKey}
          onCloseModal={() => {}}
          onOpenModal={() => {}}
        />,
      ),
    );
  }

  function button(label: string) {
    const result = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === label,
    );
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  }

  async function setField(label: string, value: string) {
    const field = Array.from(container.querySelectorAll("label"))
      .find((candidate) => candidate.textContent?.startsWith(label))
      ?.querySelector("input, select");
    if (
      !(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)
    )
      throw new Error(`Missing field: ${label}`);
    const prototype =
      field instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLSelectElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        field,
        value,
      );
      field.dispatchEvent(
        new Event(field instanceof HTMLInputElement ? "input" : "change", {
          bubbles: true,
        }),
      );
    });
  }

  it("restores a scoped-only schedule using explicitly entered scope for the frozen version and parameters", async () => {
    const invocation = {
      ...scheduleSkillInvocation(),
      requiredToolRefs: ["crewon_browser_act_scoped"],
    };
    await render([
      definition({
        skillInvocation: invocation,
        toolPermissionMode: "approveForMe",
      }),
    ]);
    await act(async () => button("浏览器授权").click());
    expect(container.textContent).toContain("此技能需要限定范围授权");
    expect(button("允许此任务使用浏览器").disabled).toBe(true);
    expect(container.querySelector('option[value="perAction"]')).toBeNull();
    await setField("网站 1", "https://reports.example.com");
    await act(async () => button("添加操作").click());
    await setField("操作类型", "navigate");
    expect(container.textContent).toContain(
      "可用参数：date、count、includeNotes",
    );
    await setField(
      "页面地址模板",
      "https://reports.example.com/export?date={date}",
    );
    expect(bridge.authorize).not.toHaveBeenCalled();
    expect(button("允许此任务使用浏览器").disabled).toBe(false);
    await act(async () => button("允许此任务使用浏览器").click());
    expect(bridge.authorize).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-1",
      scope: {
        skillVersionRef: invocation.skill,
        origins: ["https://reports.example.com"],
        rules: [
          {
            action: "navigate",
            urlTemplate: "https://reports.example.com/export?date={date}",
          },
        ],
      },
    });
    expect(container.textContent).toContain("已授权 · 限定范围连续执行");
  });

  it("authorizes and revokes the saved task only after explicit clicks, using its persisted approval mode", async () => {
    await render([definition({ toolPermissionMode: "approveForMe" })]);
    expect(bridge.status).not.toHaveBeenCalled();
    expect(bridge.authorize).not.toHaveBeenCalled();
    await act(async () => button("浏览器授权").click());
    expect(bridge.status).toHaveBeenCalledExactlyOnceWith("thread-1");
    expect(container.textContent).toContain("按任务设置审批");
    expect(bridge.authorize).not.toHaveBeenCalled();
    await act(async () => button("允许此任务使用浏览器").click());
    expect(bridge.authorize).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-1",
    });
    expect(container.textContent).toContain("已授权");
    await act(async () => button("接管并撤销授权").click());
    expect(bridge.revoke).toHaveBeenCalledExactlyOnceWith("thread-1");
    expect(container.textContent).toContain("授权已撤销");
  });

  it("makes the same entry available on the scheduled calendar card", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T07:00:00Z"));
    await render([
      definition({
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
      }),
    ]);
    expect(
      button("浏览器授权").closest('[aria-label="所选日期的日程"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector(".schedule-agenda-item")
        ?.innerHTML.replace(/_r_[a-z0-9]+_/g, "_react-id_"),
    ).toMatchSnapshot();
    await act(async () => button("浏览器授权").click());
    expect(container.textContent).toContain("本次授权方式：逐次确认");
    expect(bridge.status).toHaveBeenCalledExactlyOnceWith("thread-1");
  });

  it("does not claim an old authorization survives a page remount or authority switch", async () => {
    await render([definition()]);
    await act(async () => button("浏览器授权").click());
    await act(async () => button("允许此任务使用浏览器").click());
    await render([definition()], "space-2");
    expect(container.textContent).not.toContain("已授权");
    await act(async () => button("浏览器授权").click());
    expect(container.textContent).toContain("尚未授权");
    expect(bridge.authorize).toHaveBeenCalledTimes(1);
    await act(async () => button("允许此任务使用浏览器").click());
    expect(bridge.authorize).toHaveBeenCalledTimes(2);
  });

  it("keeps disconnected browser bridges actionable only as an explanation", async () => {
    Reflect.deleteProperty(window, "crewonDesktop");
    await render([definition()]);
    await act(async () => button("浏览器授权").click());
    expect(container.textContent).toContain("当前浏览器未连接");
    expect(button("允许此任务使用浏览器").disabled).toBe(true);
    expect(bridge.authorize).not.toHaveBeenCalled();
  });

  it("omits the entry for legacy prompts and Skills without browser mutations", async () => {
    const { skillInvocation: _, ...legacy } = definition();
    await render([
      legacy,
      definition({
        automationId: "automation-2",
        skillInvocation: {
          ...scheduleSkillInvocation(),
          requiredToolRefs: ["crewon_browser_observe"],
        },
      }),
    ]);
    expect(container.textContent).not.toContain("浏览器授权");
    expect(bridge.status).not.toHaveBeenCalled();
  });
});
