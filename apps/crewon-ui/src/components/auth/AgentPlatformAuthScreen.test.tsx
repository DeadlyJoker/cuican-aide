// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AgentPlatformAuthScreen } from "./AgentPlatformAuthGate";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("simple login screen", () => {
  it.each([false, true])(
    "only offers WeCom when service configuration enables it: %s",
    async (enabled) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const onWeComLogin = vi.fn();
      try {
        await act(async () => {
          root.render(
            <AgentPlatformAuthScreen
              busy={false}
              error={null}
              notice={null}
              mode="login"
              onModeChange={vi.fn()}
              onSubmit={vi.fn()}
              onWeComLogin={onWeComLogin}
              onRetryAccount={vi.fn()}
              onReturnToLocalManagement={vi.fn()}
              wecomConfig={{
                enabled,
                provider: "wecom",
                label: "企业微信",
                reason: "missing config",
              }}
            />,
          );
        });
        const buttons = [...container.querySelectorAll("button")];
        expect(buttons.map((button) => button.textContent?.trim())).toEqual(
          enabled ? ["使用企业微信登录", "进入 CrewON"] : ["进入 CrewON"],
        );
        expect(container.querySelector("[role=tablist]")).toBeNull();
        expect(
          container.querySelector("input[name=password]")?.getAttribute("type"),
        ).toBe("password");
        expect(container.textContent).not.toContain("missing config");
        if (enabled) {
          await act(async () => {
            buttons[0]!.click();
          });
          expect(onWeComLogin).toHaveBeenCalledOnce();
        }
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      }
    },
  );
});
