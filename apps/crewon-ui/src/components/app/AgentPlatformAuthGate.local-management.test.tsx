// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentPlatformAuthGate,
  useAgentPlatformAccount,
} from "../auth/AgentPlatformAuthGate";
import { useDesktopLocalManagementAccess } from "../../lib/desktop/DesktopLocalManagementContext";
import { SidebarAccount } from "./CommandWorkspaceSidebarAccount";

const { readUser, login } = vi.hoisted(() => ({
  readUser: vi.fn(),
  login: vi.fn(),
}));
vi.mock("../../lib/agent-platform/agentPlatformSession", () => ({
  readAgentPlatformCurrentUser: readUser,
  readWeComLoginConfig: async () => ({
    enabled: false,
    provider: "wecom",
    label: "企业微信",
  }),
  beginWeComLogin: vi.fn(),
  completeWeComLogin: vi.fn(),
  loginAgentPlatform: login,
  logoutAgentPlatform: vi.fn(),
  registerAgentPlatform: vi.fn(),
  setAgentPlatformPassword: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let nativeChanged: (() => void) | null;
let localValue: unknown;
let actualAccount: unknown;
let disposed = vi.fn<() => void>();
const onSettings = vi.fn();
function WorkspaceProbe() {
  const account = useAgentPlatformAccount();
  const local = useDesktopLocalManagementAccess();
  actualAccount = account;
  useEffect(
    () => () => {
      disposed();
    },
    [],
  );
  return (
    <section data-workspace="true" data-local={local !== null}>
      <SidebarAccount account={account} onSettings={onSettings} />
    </section>
  );
}
async function render() {
  await act(async () => {
    root.render(
      <AgentPlatformAuthGate>
        <WorkspaceProbe />
      </AgentPlatformAuthGate>,
    );
    for (let index = 0; index < 10; index++) await Promise.resolve();
  });
}
function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(match, label).not.toBeUndefined();
  return match!;
}
function approveLocal(generation = 7) {
  localValue = {
    schemaVersion: "crewon.desktop-local-management-access.v1",
    generation,
  };
}
beforeEach(() => {
  localStorage.clear();
  readUser.mockReset().mockRejectedValue(new Error("企业登录不可用"));
  login.mockReset();
  onSettings.mockClear();
  disposed = vi.fn();
  actualAccount = undefined;
  localValue = null;
  nativeChanged = null;
  const runtime = {
    localManagementAccess: vi.fn(async () => localValue),
    onLocalManagementAccessChanged: vi.fn((listener: () => void) => {
      nativeChanged = listener;
      return () => {
        nativeChanged = null;
      };
    }),
  };
  Object.defineProperty(window, "crewonDesktop", {
    configurable: true,
    value: { version: 1, runtime },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  delete (window as unknown as Record<string, unknown>).crewonDesktop;
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

describe("enterprise gate Native management branch", () => {
  it("does not automatically enter local management when an existing session is withdrawn", async () => {
    localStorage.setItem(
      "crewon-agent-platform-token",
      "existing-session-fixture",
    );
    approveLocal();
    readUser.mockImplementation(async () => {
      localStorage.clear();
      return null;
    });
    await render();
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.querySelector(".crewon-auth-shell")).not.toBeNull();
    expect(login).not.toHaveBeenCalled();
  });

  it("keeps an existing session behind authentication while slow restoration settles after the bootstrap deadline", async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      "crewon-agent-platform-token",
      "named-existing-session-fixture",
    );
    approveLocal();
    let complete!: (value: unknown) => void;
    readUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await render();
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.textContent).not.toContain("未登录");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });
    expect(container.querySelector("[data-local='true']")).toBeNull();
    expect(container.textContent).toContain("重新连接账号");
    expect(localStorage.getItem("crewon-agent-platform-token")).toBe(
      "named-existing-session-fixture",
    );
    await act(async () => {
      complete({
        id: 43,
        username: "real-user",
        role: "user",
        password_login_enabled: true,
      });
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(container.querySelector(".crewon-auth-shell")).toBeNull();
    expect(container.textContent).toContain("real-user");
    expect(actualAccount).toMatchObject({ user: { id: 43 } });
    expect(login).not.toHaveBeenCalled();
  });
  it("retry withdraws the old bootstrap consumer and restores the original session without password login", async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      "crewon-agent-platform-refresh-token",
      "named-existing-refresh-fixture",
    );
    approveLocal();
    let late!: (value: unknown) => void;
    readUser.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          late = resolve;
        }),
    );
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });
    readUser.mockResolvedValue({
      id: 43,
      username: "restored",
      role: "user",
      password_login_enabled: true,
    });
    await act(async () => {
      button("重新连接账号").click();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(actualAccount).toMatchObject({ user: { id: 43 } });
    await act(async () => {
      late({ id: 99, username: "stale", role: "admin" });
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(actualAccount).toMatchObject({ user: { id: 43 } });
    expect(container.textContent).not.toContain("stale");
    expect(login).not.toHaveBeenCalled();
  });
  it("keeps Web, unapproved Native and older preloads behind the original login gate", async () => {
    for (const bridge of [
      undefined,
      { version: 1, runtime: {} },
      window.crewonDesktop,
    ]) {
      Object.defineProperty(window, "crewonDesktop", {
        configurable: true,
        value: bridge,
      });
      await render();
      expect(container.querySelector("[data-workspace]")).toBeNull();
      expect(container.querySelector(".crewon-auth-shell")).not.toBeNull();
      expect(container.textContent).not.toContain("返回本机管理");
      expect(container.textContent).not.toContain("登录企业账号");
      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
    }
  });

  it("uses actual Native access while remote account remains null and the original menu opens settings", async () => {
    localValue = {
      schemaVersion: "crewon.desktop-local-management-access.v1",
      generation: 7,
    };
    await render();
    expect(actualAccount).toBeNull();
    expect(container.querySelector("[data-local='true']")).not.toBeNull();
    expect(container.textContent).toContain("本机管理");
    expect(container.textContent).not.toContain("页面预览");
    expect(container.textContent).not.toContain("退出登录");
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "设置",
    )!;
    await act(async () => {
      button.click();
    });
    expect(onSettings).toHaveBeenCalledOnce();
  });

  it("opens the original enterprise login form from the local account menu and can return without fabricating an account", async () => {
    approveLocal();
    await render();
    const menu = container.querySelector("details")!;
    menu.open = true;
    expect(button("登录企业账号").getAttribute("role")).toBe("menuitem");
    await act(async () => {
      button("登录企业账号").click();
    });
    expect(menu.open).toBe(false);
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.querySelector(".crewon-auth-shell")).not.toBeNull();
    expect(container.querySelector("input[name='username']")).not.toBeNull();
    expect(container.querySelector("input[name='password']")).not.toBeNull();
    expect(actualAccount).toBeNull();
    expect(login).not.toHaveBeenCalled();
    expect(button("返回本机管理").className).toBe("crewon-auth-sso");
    await act(async () => {
      button("返回本机管理").click();
    });
    expect(container.querySelector("[data-local='true']")).not.toBeNull();
    expect(container.querySelector(".crewon-auth-shell")).toBeNull();
    expect(actualAccount).toBeNull();
    expect(container.textContent).toContain("登录企业账号");
    expect(container.textContent).not.toContain("退出登录");
  });

  it("removes local return after Native withdrawal and rejects the prior callback before a fresh generation arrives", async () => {
    approveLocal();
    await render();
    await act(async () => {
      button("登录企业账号").click();
    });
    const oldReturn = button("返回本机管理");
    await act(async () => {
      localValue = null;
      nativeChanged?.();
      oldReturn.click();
    });
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.textContent).not.toContain("返回本机管理");
    approveLocal(8);
    await act(async () => {
      nativeChanged?.();
    });
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.querySelector(".crewon-auth-shell")).not.toBeNull();
    await act(async () => {
      button("返回本机管理").click();
    });
    expect(container.querySelector("[data-local='true']")).not.toBeNull();
    expect(actualAccount).toBeNull();
  });

  it("uses the existing authentication port result for a real account after local login navigation", async () => {
    approveLocal();
    login.mockResolvedValue({
      id: 43,
      username: "real-user",
      role: "user",
      password_login_enabled: true,
    });
    await render();
    await act(async () => {
      button("登录企业账号").click();
    });
    const username = container.querySelector<HTMLInputElement>(
      "input[name='username']",
    )!;
    const password = container.querySelector<HTMLInputElement>(
      "input[name='password']",
    )!;
    username.value = "real-user";
    password.value = "fixture-password";
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(login).toHaveBeenCalledExactlyOnceWith(
      "real-user",
      "fixture-password",
    );
    expect(actualAccount).toMatchObject({
      user: { id: 43, username: "real-user" },
    });
    expect(container.querySelector("[data-local='false']")).not.toBeNull();
    expect(container.textContent).toContain("退出登录");
    expect(container.textContent).not.toContain("本机管理");
    expect(container.textContent).not.toContain("登录企业账号");
  });

  it("withdraws the entire local workspace before accepting a later live generation", async () => {
    localValue = {
      schemaVersion: "crewon.desktop-local-management-access.v1",
      generation: 1,
    };
    await render();
    let finish!: (value: unknown) => void;
    localValue = new Promise((resolve) => {
      finish = resolve;
    });
    await act(async () => {
      nativeChanged?.();
    });
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(disposed).toHaveBeenCalledOnce();
    localValue = {
      schemaVersion: "crewon.desktop-local-management-access.v1",
      generation: 3,
    };
    await act(async () => {
      nativeChanged?.();
    });
    expect(container.querySelector("[data-workspace]")).not.toBeNull();
    await act(async () => {
      finish({
        schemaVersion: "crewon.desktop-local-management-access.v1",
        generation: 2,
      });
    });
    expect(container.querySelector("[data-workspace]")).not.toBeNull();
  });

  it("preserves the real enterprise account path without any approved local access", async () => {
    readUser.mockResolvedValue({
      id: 43,
      username: "real-user",
      role: "user",
      password_login_enabled: true,
    });
    await render();
    expect(actualAccount).toMatchObject({
      user: { id: 43, username: "real-user" },
    });
    expect(container.querySelector("[data-local='false']")).not.toBeNull();
    expect(container.textContent).toContain("real-user");
    expect(container.textContent).toContain("退出登录");
    expect(container.textContent).not.toContain("本机管理");
  });
});
