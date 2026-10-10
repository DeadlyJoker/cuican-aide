// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AgentPlatformAuthScreen } from "./AgentPlatformAuthGate";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("account login and registration screen", () => {
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
          enabled
            ? ["登录", "注册", "使用企业微信登录", "进入 CrewON"]
            : ["登录", "注册", "进入 CrewON"],
        );
        expect(
          container.querySelector('[aria-label="账号登录与注册"]'),
        ).not.toBeNull();
        expect(
          container.querySelector("input[name=password]")?.getAttribute("type"),
        ).toBe("password");
        expect(container.textContent).not.toContain("missing config");
        expect(container.innerHTML).toMatchSnapshot();
        if (enabled) {
          await act(async () => {
            buttons[2]!.click();
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

  it("switches between login and registration without exposing extra login providers", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Screen() {
      const [mode, setMode] = useState<"login" | "register">("login");
      return (
        <AgentPlatformAuthScreen
          busy={false}
          error={null}
          notice={null}
          mode={mode}
          onModeChange={setMode}
          onSubmit={vi.fn()}
          onWeComLogin={vi.fn()}
          wecomConfig={{
            enabled: false,
            provider: "wecom",
            label: "企业微信",
          }}
        />
      );
    }
    try {
      await act(async () => root.render(<Screen />));
      const registrationButton = container.querySelectorAll("button")[1]!;
      await act(async () => registrationButton.click());
      expect(registrationButton.getAttribute("aria-pressed")).toBe("true");
      expect(container.querySelector('input[name="email"]')).not.toBeNull();
      expect(
        container.querySelector('input[name="confirmPassword"]'),
      ).not.toBeNull();
      expect(
        container
          .querySelector('input[name="password"]')
          ?.getAttribute("autocomplete"),
      ).toBe("new-password");
      expect(container.textContent).toContain("创建账号");
      expect(container.textContent).not.toContain("agent-platform");
      expect(container.innerHTML).toMatchSnapshot();
      await act(async () => container.querySelector("button")!.click());
      expect(container.querySelector('input[name="email"]')).toBeNull();
      expect(
        container.querySelector('input[name="confirmPassword"]'),
      ).toBeNull();
      expect(container.textContent).toContain("进入 CrewON");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("keeps the selected account operation stable while a request is in progress", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onModeChange = vi.fn();
    try {
      await act(async () =>
        root.render(
          <AgentPlatformAuthScreen
            busy
            error={null}
            notice={null}
            mode="login"
            onModeChange={onModeChange}
            onSubmit={vi.fn()}
            onWeComLogin={vi.fn()}
            wecomConfig={{
              enabled: true,
              provider: "wecom",
              label: "企业微信",
            }}
          />,
        ),
      );
      expect(
        [...container.querySelectorAll("button")].every(
          (button) => button.disabled,
        ),
      ).toBe(true);
      await act(async () => container.querySelectorAll("button")[1]!.click());
      expect(onModeChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
