// @vitest-environment happy-dom
import { ControlApiClient } from "@crewon/control-client";
import type { AutomationView as AutomationDefinition } from "@crewon/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ControlAutomationRuntime } from "../../lib/control-runtime/controlAutomationRuntime";
import { AutomationView } from "./CommandWorkspaceAutomations";
import { scheduleSkillInvocation } from "./automationSkill.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("recovers a blocked Skill schedule through the existing manual Run and conversation path", async () => {
  const definition: AutomationDefinition = {
    automationId: "automation-1",
    threadId: "thread-1",
    title: "每周报告",
    prompt: "运行固定 Skill 版本。",
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
    skillInvocation: scheduleSkillInvocation(),
    skillReadiness: { state: "blocked", code: "skill_dependency_unavailable" },
  };
  const requests: string[] = [];
  const adopter = { adoptAutomationRun: vi.fn(async () => undefined) };
  const onOpenThread = vi.fn();
  const runtime = new ControlAutomationRuntime({
    client: new ControlApiClient({
      baseUrl: "https://control.example/",
      csrfToken: "test-csrf",
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("/automations?"))
          return json({ data: [definition], nextCursor: null });
        if (url.endsWith("/automations/automation-1"))
          return json({ automation: definition });
        if (url.endsWith("/threads/thread-1"))
          return json({
            eventSequence: 1,
            thread: {
              threadId: "thread-1",
              status: "active",
              revision: 1,
              title: "Report",
              lastMessageSequence: 0,
              forkedFromThreadId: null,
              forkedThroughHistorySequence: null,
              createdAt: "2026-09-14T00:00:00Z",
              updatedAt: "2026-09-14T00:00:00Z",
              archivedAt: null,
              deletedAt: null,
            },
          });
        if (url.endsWith(":run-now"))
          return json({
            disposition: "committed",
            automation: {
              ...definition,
              skillReadiness: { state: "ready", code: null },
            },
            invocation: { automationId: "automation-1", runId: "run-1" },
            run: {
              runId: "run-1",
              threadId: "thread-1",
              status: "queued",
              revision: 1,
              lastSequence: 1,
              cancelRequested: false,
              waitingApproval: null,
              collaborationMode: "default",
              purpose: "turn",
              workflowVersionBinding: null,
              goalBinding: null,
              outputRef: null,
              failure: null,
              createdAt: "2026-09-14T00:01:00Z",
              updatedAt: "2026-09-14T00:01:00Z",
              terminalAt: null,
            },
          });
        throw new Error(`unexpected request ${url}`);
      },
    }),
    adopter,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <AutomationView
          active
          connected
          controlConfigured
          modalOpen={false}
          runtime={runtime}
          selectedThreadId="thread-1"
          spaceAuthorityKey="space-1"
          onCloseModal={() => {}}
          onOpenModal={() => {}}
          onOpenThread={onOpenThread}
        />,
      );
    });
    expect(container.textContent).toContain(
      "固定版本：weekly-report · version-1",
    );
    expect(container.textContent).toContain("执行条件待恢复");
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "重试",
    );
    expect(retry).toBeDefined();
    expect(retry?.disabled).toBe(false);
    await act(async () => retry?.click());
    expect(adopter.adoptAutomationRun).toHaveBeenCalledOnce();
    expect(onOpenThread).toHaveBeenCalledWith("thread-1");
    expect(container.textContent).toContain("已开始执行");
    expect(requests.filter((url) => url.endsWith(":run-now"))).toHaveLength(1);
    expect(requests.some((url) => url.includes("/runs?"))).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
