// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentPlatformAuthGate,
  useAgentPlatformAccount,
} from "./AgentPlatformAuthGate";
import {
  AGENT_PLATFORM_TOKEN_STORAGE_KEY,
  AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
  clearAgentPlatformSession,
  getAgentPlatformAccessSession,
  storeAgentPlatformSession,
} from "../../lib/agent-platform/agentPlatformClient";
import {
  getPimLaunchToken,
  setPimLaunchToken,
} from "../../lib/agent-platform/pimLaunchBridge";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const USER = {
  id: 7,
  username: "actual-admin",
  email: "admin@example.invalid",
  role: "admin",
};
function Workspace() {
  return (
    <section data-workspace="true">
      {useAgentPlatformAccount()?.user.username}
    </section>
  );
}
let root: Root;
let container: HTMLDivElement;
let ready: boolean;
let status: number;
let reads: number;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "false");
  vi.stubGlobal("crewonDesktop", undefined);
  localStorage.clear();
  sessionStorage.clear();
  clearAgentPlatformSession();
  ready = false;
  status = 503;
  reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/auth/wecom/config"))
        return Response.json({ enabled: false, provider: "wecom" });
      if (!String(input).endsWith("/auth/me"))
        throw new Error("unexpected_auth_fixture_request");
      reads++;
      return ready ? Response.json(USER) : new Response(null, { status });
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
  clearAgentPlatformSession();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
async function render(strict = false) {
  await act(async () => {
    const gate = (
      <AgentPlatformAuthGate>
        <Workspace />
      </AgentPlatformAuthGate>
    );
    root.render(strict ? <StrictMode>{gate}</StrictMode> : gate);
    for (let index = 0; index < 20; index++) await Promise.resolve();
  });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function online() {
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    for (let index = 0; index < 30; index++) await Promise.resolve();
  });
}

describe("saved account restoration through the real session reader", () => {
  it("a slow valid WeCom configuration does not block login and remains usable after five seconds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        if (!String(input).endsWith("/auth/wecom/config"))
          throw new Error("unexpected_wecom_fixture_request");
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        return Response.json({
          enabled: true,
          provider: "wecom",
          label: "企业微信",
        });
      }),
    );
    await render();
    expect(container.querySelector("form")).not.toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await advance(6_000);
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(container.textContent).toContain("使用企业微信登录");
  });

  it("retains credentials on 503, hides login and unverified workspace, and reconnects without password", async () => {
    storeAgentPlatformSession("named-access-fixture", "named-refresh-fixture");
    await render(true);
    await advance(600);
    expect(reads).toBe(3);
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain("正在自动重连");
    expect(container.innerHTML).toMatchSnapshot();
    expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(
      "named-access-fixture",
    );
    expect(localStorage.getItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
      "named-refresh-fixture",
    );
    ready = true;
    await online();
    expect(container.textContent).toContain(USER.username);
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("[data-workspace]")).not.toBeNull();
    expect(reads).toBe(4);
  });

  it("automatically reconnects with the same PIM token after temporary service failure", async () => {
    setPimLaunchToken("named-launch-fixture");
    await render();
    await advance(600);
    expect(getPimLaunchToken()).toBe("named-launch-fixture");
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("[data-workspace]")).toBeNull();
    ready = true;
    await advance(1_000);
    expect(container.textContent).toContain(USER.username);
    expect(getPimLaunchToken()).toBe("named-launch-fixture");
  });

  it("a same-account token refresh crosses its epoch once and restores through a fresh authenticated read", async () => {
    const token = (seconds: number) =>
      `header.${btoa(JSON.stringify({ sub: "7", exp: Math.floor(Date.now() / 1_000) + seconds }))}.signature`;
    const expired = token(-60);
    const fresh = token(600);
    let refreshes = 0;
    storeAgentPlatformSession(expired, "named-expired-refresh-fixture");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith("/auth/wecom/config"))
          return Response.json({ enabled: false, provider: "wecom" });
        if (path.endsWith("/auth/refresh")) {
          refreshes++;
          return Response.json({
            access_token: fresh,
            refresh_token: "named-rotated-refresh-fixture",
          });
        }
        if (!path.endsWith("/auth/me"))
          throw new Error("unexpected_refresh_fixture_request");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${fresh}`,
        );
        reads++;
        return Response.json(USER);
      }),
    );
    await render();
    expect(container.textContent).toContain(USER.username);
    expect(container.querySelector("form")).toBeNull();
    expect(refreshes).toBe(1);
    expect(reads).toBe(1);
    expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(fresh);
    await advance(60_000);
    expect(refreshes).toBe(1);
    expect(reads).toBe(1);
  });

  it("a hung authenticated body is cancelled before the owner retries, even if cancellation settles slowly", async () => {
    storeAgentPlatformSession("named-hung-body-access-fixture");
    let finishCancel!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    const cancel = vi.fn(() => cancellation);
    const body = new ReadableStream<Uint8Array>(
      { cancel },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        if (String(input).endsWith("/auth/wecom/config"))
          return Response.json({ enabled: false, provider: "wecom" });
        if (!String(input).endsWith("/auth/me"))
          throw new Error("unexpected_hung_body_fixture_request");
        reads++;
        return reads === 1 ? new Response(body) : Response.json(USER);
      }),
    );
    await render();
    expect(body.locked).toBe(true);
    await advance(10_000);
    expect(cancel).toHaveBeenCalledOnce();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("[data-workspace]")).toBeNull();
    await online();
    await advance(30_000);
    expect(reads).toBe(1);
    await act(async () => {
      finishCancel();
      for (let index = 0; index < 20; index++) await Promise.resolve();
    });
    expect(body.locked).toBe(false);
    await advance(1_000);
    expect(reads).toBe(2);
    expect(container.textContent).toContain(USER.username);
  });

  it("a current account waits for an aborted old refresh's physical completion without anonymous requests or credential loss", async () => {
    const token = (label: string, seconds: number) =>
      `header.${btoa(JSON.stringify({ sub: label, exp: Math.floor(Date.now() / 1_000) + seconds }))}.signature`;
    let finishOld!: (response: Response) => void;
    let enteredOld!: () => void;
    const oldEntered = new Promise<void>((resolve) => {
      enteredOld = resolve;
    });
    const oldResponse = new Promise<Response>((resolve) => {
      finishOld = resolve;
    });
    const currentAccess = token("B", 600);
    let refreshes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith("/auth/wecom/config"))
          return Response.json({ enabled: false, provider: "wecom" });
        if (path.endsWith("/auth/refresh")) {
          refreshes++;
          if (
            new URLSearchParams(String(init?.body)).get("refresh_token") ===
            "named-old-refresh-fixture"
          ) {
            enteredOld();
            return oldResponse;
          }
          return Response.json({
            access_token: currentAccess,
            refresh_token: "named-current-rotated-fixture",
          });
        }
        if (!path.endsWith("/auth/me"))
          throw new Error("unexpected_old_slot_fixture_request");
        reads++;
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${currentAccess}`,
        );
        return Response.json(USER);
      }),
    );
    storeAgentPlatformSession(token("A", -60), "named-old-refresh-fixture");
    const oldAccess = getAgentPlatformAccessSession().catch(() => null);
    await oldEntered;
    const expiredCurrent = token("B", -60);
    storeAgentPlatformSession(expiredCurrent, "named-current-refresh-fixture");
    await render();
    await advance(600);
    expect(refreshes).toBe(1);
    expect(reads).toBe(0);
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(
      expiredCurrent,
    );
    expect(localStorage.getItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
      "named-current-refresh-fixture",
    );
    finishOld(Response.json({ access_token: token("A", 600) }));
    await oldAccess;
    await advance(1_000);
    expect(container.textContent).toContain(USER.username);
    expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(
      currentAccess,
    );
    expect(refreshes).toBe(2);
    expect(reads).toBe(1);
  });

  it("an old SSO logout finally cannot withdraw a subsequently verified account", async () => {
    vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "true");
    let finishLogout!: (response: Response) => void;
    const logoutResponse = new Promise<Response>((resolve) => {
      finishLogout = resolve;
    });
    const userB = { ...USER, id: 8, username: "replacement-account" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith("/auth/wecom/config"))
          return Response.json({ enabled: false, provider: "wecom" });
        if (path.endsWith("/sso/client/crewon/global-logout"))
          return logoutResponse;
        if (!path.endsWith("/auth/me"))
          throw new Error("unexpected_logout_fixture_request");
        return Response.json(
          new Headers(init?.headers).get("Authorization") ===
            "Bearer named-account-b-fixture"
            ? userB
            : USER,
        );
      }),
    );
    storeAgentPlatformSession("named-account-a-fixture");
    await render();
    expect(container.textContent).toContain(USER.username);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "退出")!
        .click();
    });
    await act(async () => {
      storeAgentPlatformSession("named-account-b-fixture");
      for (let index = 0; index < 30; index++) await Promise.resolve();
    });
    expect(container.textContent).toContain(userB.username);
    await act(async () => {
      finishLogout(new Response(null, { status: 204 }));
      for (let index = 0; index < 30; index++) await Promise.resolve();
    });
    expect(container.textContent).toContain(userB.username);
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("[data-workspace]")).not.toBeNull();
  });

  it("a transient account read after password login restores the newly published credentials automatically", async () => {
    let firstRead = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const path = String(input);
        if (path.endsWith("/auth/wecom/config"))
          return Response.json({ enabled: false, provider: "wecom" });
        if (path.endsWith("/auth/login"))
          return Response.json({
            access_token: "named-post-login-access-fixture",
            refresh_token: "named-post-login-refresh-fixture",
          });
        if (!path.endsWith("/auth/me"))
          throw new Error("unexpected_post_login_fixture_request");
        reads++;
        if (firstRead) return new Response(null, { status: 503 });
        return Response.json(USER);
      }),
    );
    await render();
    container.querySelector<HTMLInputElement>("input[name=username]")!.value =
      "actual-admin";
    container.querySelector<HTMLInputElement>("input[name=password]")!.value =
      "named-password-fixture";
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await advance(600);
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(
      "named-post-login-access-fixture",
    );
    firstRead = false;
    await online();
    await advance(1_000);
    expect(container.textContent).toContain(USER.username);
    expect(container.querySelector("form")).toBeNull();
  });

  it("a definitive unauthorized response withdraws the saved session and shows the normal login", async () => {
    storeAgentPlatformSession("named-rejected-access-fixture");
    status = 401;
    await render();
    expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBeNull();
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.querySelector("input[name=username]")).not.toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await advance(60_000);
    expect(reads).toBe(1);
  });

  it("a definitive PIM rejection clears only the rejected session and never opens the workspace", async () => {
    setPimLaunchToken("named-rejected-launch-fixture");
    status = 401;
    await render();
    expect(getPimLaunchToken()).toBeNull();
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
    await advance(60_000);
    expect(reads).toBe(1);
  });
});
