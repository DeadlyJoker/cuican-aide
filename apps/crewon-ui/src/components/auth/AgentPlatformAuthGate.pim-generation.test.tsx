// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentPlatformAuthGate,
  useAgentPlatformAccount,
} from "./AgentPlatformAuthGate";
import { SidebarAccount } from "../app/CommandWorkspaceSidebarAccount";
import {
  assertAgentPlatformSessionCurrent,
  captureAgentPlatformSession,
  clearAgentPlatformSession,
  getAgentPlatformAccessSession,
} from "../../lib/agent-platform/agentPlatformClient";
import {
  getPimLaunchToken,
  setPimLaunchToken,
} from "../../lib/agent-platform/pimLaunchBridge";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

/** Actual Response consumption remains pending even when the caller aborts. */
function delayedResponse(status: number) {
  const body = deferred<unknown>();
  const entered = deferred<void>();
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        entered.resolve();
        const value = await body.promise;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    entered,
    response: new Response(stream, {
      status,
      headers: { "content-type": "application/json" },
    }),
  };
}

const TOKEN_A = "named-pim-account-a-fixture";
const TOKEN_B = "named-pim-account-b-fixture";
const USER_A = {
  id: 11,
  username: "pim-account-a",
  email: "a@example.invalid",
  role: "user",
};
const USER_B = {
  id: 22,
  username: "pim-account-b",
  email: "b@example.invalid",
  role: "user",
};

describe("initial PIM account consumer generation", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onSettings = vi.fn();

  function Workspace() {
    return (
      <SidebarAccount
        account={useAgentPlatformAccount()}
        onSettings={onSettings}
      />
    );
  }

  beforeEach(() => {
    vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "false");
    vi.stubGlobal("crewonDesktop", undefined);
    localStorage.clear();
    sessionStorage.clear();
    clearAgentPlatformSession();
    setPimLaunchToken(TOKEN_A);
    onSettings.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    clearAgentPlatformSession();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function settingsButton() {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((candidate) => candidate.textContent?.trim() === "设置");
    expect(button).not.toBeUndefined();
    return button!;
  }

  for (const result of ["success", "error"] as const) {
    it(`a late account-A ${result} body cannot publish A or clear the replacement PIM token`, async () => {
      const late = delayedResponse(result === "success" ? 200 : 400);
      let requestSignal: AbortSignal | null | undefined;
      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = new URL(
          String(input),
          "https://agent-platform-auth.fixture.invalid",
        ).pathname.replace(/^\/agent-platform-api(?=\/|$)/u, "");
        if (path === "/api/v1/auth/wecom/config")
          return Response.json({
            enabled: false,
            provider: "wecom",
            label: "企业微信",
          });
        if (path !== "/api/v1/auth/me")
          throw new Error(`unexpected_fixture_path:${path}`);
        const headers = new Headers(init?.headers);
        if (headers.get("X-PIM-Launch-Token") === TOKEN_A) {
          expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN_A}`);
          requestSignal = init?.signal;
          return late.response;
        }
        expect(headers.get("X-PIM-Launch-Token")).toBe(TOKEN_B);
        expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN_B}`);
        return Response.json(USER_B);
      });
      vi.stubGlobal("fetch", fetchMock);

      await act(async () =>
        root.render(
          <AgentPlatformAuthGate key="initial">
            <Workspace />
          </AgentPlatformAuthGate>,
        ),
      );
      await late.entered.promise;
      expect(requestSignal).toBeInstanceOf(AbortSignal);
      expect(requestSignal?.aborted).toBe(false);

      await act(async () => setPimLaunchToken(TOKEN_B));
      const sessionB = captureAgentPlatformSession();
      expect(requestSignal?.aborted).toBe(true);
      await act(async () => {
        late.body.resolve(
          result === "success"
            ? USER_A
            : { detail: "late account-A fixture failure" },
        );
      });
      await act(async () => {
        await vi.waitFor(() =>
          expect(container.querySelector(".crewon-auth-checking")).toBeNull(),
        );
      });

      expect(getPimLaunchToken()).toBe(TOKEN_B);
      expect(() => assertAgentPlatformSessionCurrent(sessionB)).not.toThrow();
      expect((await getAgentPlatformAccessSession()).accessToken).toBe(TOKEN_B);
      expect(container.textContent).not.toContain(USER_A.username);
      expect(container.textContent).not.toContain(
        "late account-A fixture failure",
      );
      expect(container.textContent).not.toContain("演示访问会话已过期");
      expect(container.querySelector(".crewon-auth-message.error")).toBeNull();

      await act(async () => {
        root.render(
          <AgentPlatformAuthGate key="replacement">
            <Workspace />
          </AgentPlatformAuthGate>,
        );
      });
      await act(async () => {
        await vi.waitFor(() =>
          expect(container.querySelector(".sidebar-account")).not.toBeNull(),
        );
      });
      expect(container.textContent).toContain(USER_B.username);
      expect(container.textContent).not.toContain(USER_A.username);
      expect(
        container.querySelector("summary")?.getAttribute("aria-label"),
      ).toBe(`账号菜单：${USER_B.username}`);
      const menu = container.querySelector("details")!;
      menu.open = true;
      await act(async () => settingsButton().click());
      expect(onSettings).toHaveBeenCalledOnce();
      expect(menu.open).toBe(false);
      expect(
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "退出登录",
        ),
      ).toBe(true);
    });
  }
});
