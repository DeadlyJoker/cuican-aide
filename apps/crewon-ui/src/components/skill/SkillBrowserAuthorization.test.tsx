// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  BrowserExecutionBridge,
  BrowserGrantScope,
} from "../../lib/browser-execution/browserExecutionGrant";
import type { SkillExecutionInput } from "../../lib/skill/demonstratedSkillClient";
import { SkillBrowserAuthorization } from "./SkillBrowserAuthorization";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const command: SkillExecutionInput = {
  executionId: "execution-1",
  threadId: "thread-1",
  expectedThreadRevision: 1,
  agentVersionId: null,
  purpose: "trial",
  invocation: {
    schemaVersion: "crewon.skill-invocation.v1",
    skill: {
      skillId: "skill-1",
      versionId: "version-1",
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
    parameters: {},
    requiredToolRefs: ["crewon_browser_act"],
  },
};
function bridgeFixture(): BrowserExecutionBridge {
  return {
    status: vi.fn(async () => null),
    authorize: vi.fn<BrowserExecutionBridge["authorize"]>(
      async ({ threadId, scope }) => ({
        threadId,
        sessionId: "session-1",
        revision: 1,
        mode: scope ? "scoped" : "perAction",
      }),
    ),
    revoke: vi.fn(async () => {}),
  };
}

it("requires scope for scoped-only Skills even if a caller passes false", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const bridge = bridgeFixture();
  const onProceed = vi.fn();
  try {
    await act(async () =>
      root.render(
        <SkillBrowserAuthorization
          command={{
            ...command,
            invocation: {
              ...command.invocation,
              parameters: { date: "2026-09-14" },
              requiredToolRefs: ["crewon_browser_act_scoped"],
            },
          }}
          requiredScope={false}
          awaitingChoice
          busy={false}
          bridge={bridge}
          onProceed={onProceed}
        />,
      ),
    );
    expect(container.textContent).toContain("此技能需要限定范围授权");
    expect(container.textContent).not.toContain("按逐次确认开始试跑");
    expect(container.textContent).not.toContain("普通授权（按任务设置审批）");
    expect(bridge.authorize).not.toHaveBeenCalled();
    expect(onProceed).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each(["trial", "execute"] as const)(
  "forwards delegated %s approval copy without creating a browser grant when continuing",
  async (purpose) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const bridge = bridgeFixture();
    const onProceed = vi.fn();
    try {
      await act(async () =>
        root.render(
          <SkillBrowserAuthorization
            command={{
              ...command,
              purpose,
              toolPermissionMode: "approveForMe",
            }}
            awaitingChoice
            busy={false}
            bridge={bridge}
            onProceed={onProceed}
          />,
        ),
      );
      expect(container.textContent).toContain(
        "浏览器动作按本次任务的工具审批设置由 CrewON 代为批准；仍需单独授权当前任务使用浏览器。",
      );
      expect(container.textContent).not.toContain("按逐次确认");
      expect(bridge.authorize).not.toHaveBeenCalled();
      const label =
        purpose === "trial" ? "按当前审批设置开始试跑" : "按当前审批设置运行";
      const proceed = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      );
      expect(proceed).toBeDefined();
      await act(async () => proceed!.click());
      expect(onProceed).toHaveBeenCalledExactlyOnceWith("perAction");
      expect(bridge.authorize).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

it("keeps legacy request-approval copy when the command omits the mode", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const bridge = bridgeFixture();
  try {
    await act(async () =>
      root.render(
        <SkillBrowserAuthorization
          command={command}
          awaitingChoice
          busy={false}
          bridge={bridge}
          onProceed={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("按逐次确认开始试跑");
    expect(container.textContent).toContain(
      "浏览器动作仍需逐次确认。此授权仅用于当前任务。",
    );
    expect(bridge.authorize).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it("forwards reviewed scope rules under delegated task approval and requires a separate authorization click", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const bridge = bridgeFixture();
  const onProceed = vi.fn();
  const scope: BrowserGrantScope = {
    skillVersionRef: command.invocation.skill,
    origins: ["https://reports.example"],
    rules: [{ action: "click", target: { role: "button", name: "导出文件" } }],
  };
  try {
    await act(async () =>
      root.render(
        <SkillBrowserAuthorization
          command={{ ...command, toolPermissionMode: "approveForMe" }}
          awaitingChoice
          busy={false}
          bridge={bridge}
          scope={scope}
          onProceed={onProceed}
        />,
      ),
    );
    expect(container.textContent).toContain(
      "自动批准模式下此范围仍生效，超出范围会停止，需要重新授权",
    );
    expect(container.textContent).toContain("https://reports.example");
    expect(container.textContent).toContain("导出文件");
    expect(bridge.authorize).not.toHaveBeenCalled();
    const authorize = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "允许此任务使用浏览器",
    )!;
    await act(async () => authorize.click());
    expect(bridge.authorize).toHaveBeenCalledExactlyOnceWith({
      threadId: command.threadId,
      scope,
    });
    expect(onProceed).toHaveBeenCalledExactlyOnceWith("authorized");
  } finally {
    await act(async () => root.unmount());
  }
});
