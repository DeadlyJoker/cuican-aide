// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentPlatformAuthGate,
  useAgentPlatformAccount,
} from "./AgentPlatformAuthGate";
import {
  AGENT_PLATFORM_TOKEN_STORAGE_KEY,
  clearAgentPlatformSession,
} from "../../lib/agent-platform/agentPlatformClient";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const USER = {
  id: 17,
  username: "registered-user",
  email: "registered-user@example.invalid",
  role: "user",
};
function Workspace() {
  return (
    <section data-workspace="true">
      {useAgentPlatformAccount()?.user.username}
    </section>
  );
}

describe("registration through the account screen and real session client", () => {
  let root: Root;
  let container: HTMLDivElement;
  let registrationResponse: (
    signal: AbortSignal,
  ) => Response | Promise<Response>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "false");
    vi.stubGlobal("crewonDesktop", undefined);
    localStorage.clear();
    sessionStorage.clear();
    clearAgentPlatformSession();
    registrationResponse = () => Response.json(USER);
    fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/auth/wecom/config"))
        return Response.json({ enabled: false, provider: "wecom" });
      if (String(input).endsWith("/auth/register")) {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/json",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          username: USER.username,
          email: USER.email,
          password: "CrewON123",
        });
        return registrationResponse(init?.signal as AbortSignal);
      }
      if (String(input).endsWith("/auth/me")) {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer named-registration-access-fixture",
        );
        return Response.json(USER);
      }
      throw new Error("unexpected_registration_fixture_request");
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <AgentPlatformAuthGate>
          <Workspace />
        </AgentPlatformAuthGate>,
      ),
    );
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>("button")[1]!.click();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    clearAgentPlatformSession();
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  async function submit(confirmation = "CrewON123") {
    const form = container.querySelector("form")!;
    const fields: Record<string, string> = {
      username: ` ${USER.username} `,
      email: ` ${USER.email} `,
      password: "CrewON123",
      confirmPassword: confirmation,
    };
    for (const [name, value] of Object.entries(fields)) {
      const input = form.elements.namedItem(name) as HTMLInputElement;
      input.value = value;
    }
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      for (let index = 0; index < 30; index++) await Promise.resolve();
    });
  }

  function registrations() {
    return fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith("/auth/register"),
    );
  }

  it("checks password confirmation before submitting a registration", async () => {
    await submit("Different123");
    expect(registrations()).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "两次输入的密码不一致",
    );
    expect(container.querySelector('input[name="email"]')).not.toBeNull();
    expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBeNull();
    expect(container.querySelector("[data-workspace]")).toBeNull();
  });

  it("preserves server registration validation without granting a session", async () => {
    registrationResponse = () =>
      Response.json(
        { detail: "该邮箱已经注册，请使用邮箱登录。" },
        { status: 422 },
      );
    await submit();
    expect(registrations()).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "该邮箱已经注册，请使用邮箱登录。",
    );
    expect(container.querySelector('input[name="email"]')).not.toBeNull();
    expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBeNull();
    expect(container.querySelector("[data-workspace]")).toBeNull();
  });

  it("returns to login with verification guidance when registration does not issue credentials", async () => {
    await submit();
    expect(registrations()).toHaveLength(1);
    expect(container.textContent).toContain(
      "注册申请已提交，请完成邮箱验证或等待管理员审批后登录。",
    );
    expect(container.querySelector('input[name="email"]')).toBeNull();
    expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBeNull();
    expect(container.querySelector("[data-workspace]")).toBeNull();
  });

  it("enters the workspace only after registration credentials verify the actual account", async () => {
    registrationResponse = () =>
      Response.json({
        ...USER,
        access_token: "named-registration-access-fixture",
        refresh_token: "named-registration-refresh-fixture",
      });
    await submit();
    expect(registrations()).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/auth/me"),
      ),
    ).toHaveLength(1);
    expect(container.querySelector("[data-workspace]")?.textContent).toBe(
      USER.username,
    );
    expect(container.querySelector("form")).toBeNull();
  });

  it.each(["headers", "body"] as const)(
    "aborts a registration waiting for %s after fifteen seconds, releases the form, and retries only after another user submission",
    async (phase) => {
      vi.useFakeTimers();
      let requestSignal: AbortSignal | undefined;
      const cancelBody = vi.fn();
      registrationResponse = (signal) => {
        requestSignal = signal;
        if (phase === "headers") {
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"id":17,'));
            },
            cancel: cancelBody,
          }),
          { headers: { "content-type": "application/json" } },
        );
      };

      await submit();
      expect(registrations()).toHaveLength(1);
      expect(requestSignal).toBeInstanceOf(AbortSignal);
      expect(requestSignal?.aborted).toBe(false);
      expect(
        container.querySelector<HTMLButtonElement>('button[type="submit"]')
          ?.disabled,
      ).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_999);
      });
      expect(requestSignal?.aborted).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(requestSignal?.aborted).toBe(true);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "账号服务暂时不可用",
      );
      expect(
        container.querySelector<HTMLButtonElement>('button[type="submit"]')
          ?.disabled,
      ).toBe(false);
      expect(
        container.querySelector<HTMLInputElement>('input[name="username"]')
          ?.value,
      ).toBe(` ${USER.username} `);
      expect(
        container.querySelector<HTMLInputElement>('input[name="email"]')?.value,
      ).toBe(USER.email);
      expect(
        container.querySelector<HTMLInputElement>('input[name="password"]')
          ?.value,
      ).toBe("CrewON123");
      expect(container.querySelector("[data-workspace]")).toBeNull();
      expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBeNull();
      expect(cancelBody).toHaveBeenCalledTimes(phase === "body" ? 1 : 0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(registrations()).toHaveLength(1);

      await act(async () => container.querySelector("button")!.click());
      expect(container.querySelector('input[name="email"]')).toBeNull();
      await act(async () => {
        container.querySelectorAll<HTMLButtonElement>("button")[1]!.click();
      });
      expect(container.querySelector('input[name="email"]')).not.toBeNull();
      registrationResponse = () => Response.json(USER);
      await submit();
      expect(registrations()).toHaveLength(2);
      expect(container.textContent).toContain("注册申请已提交");
    },
  );
});
