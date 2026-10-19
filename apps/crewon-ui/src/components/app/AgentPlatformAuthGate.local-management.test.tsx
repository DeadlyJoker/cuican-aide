// @vitest-environment happy-dom
import { act, useEffect, useMemo, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentPlatformAuthGate,
  useAgentPlatformAccount,
} from "../auth/AgentPlatformAuthGate";
import { useDesktopLocalManagementAccess } from "../../lib/desktop/DesktopLocalManagementContext";
import type { ControlApiClient } from "@crewon/control-client";
import type { ControlPluginUiHost } from "../../lib/plugins/controlPluginUiHost";
import type { PluginUiPageNavigation } from "../../lib/plugins/pluginUiPageNavigation";
import type { ProjectChatCreationPorts } from "../../lib/plugins/projectChatCreation";
import {
  controlUiClient,
  controlUiItem,
  controlUiResponse,
} from "../../lib/plugins/controlPluginUi.test-support";
import { uiLease } from "../../lib/plugins/pluginUiLoader.test-support";
import { useInstalledPluginProjectChatCreation } from "../../lib/app/useInstalledPluginProjectChatCreation";
import { isDesktopLocalManagementAccess } from "../../lib/desktop/desktopLocalManagementAccess";
import { SidebarAccount } from "./CommandWorkspaceSidebarAccount";
import {
  clearAgentPlatformSession,
  storeAgentPlatformSession,
} from "../../lib/agent-platform/agentPlatformClient";

const { readUser, login, logout, creationPorts } = vi.hoisted(() => ({
  readUser: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  creationPorts: [] as ProjectChatCreationPorts[],
}));
vi.mock("../../lib/plugins/projectChatCreation", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../lib/plugins/projectChatCreation")
    >();
  return {
    ...original,
    createProjectChatCreation: (ports: ProjectChatCreationPorts) => {
      creationPorts.push(ports);
      return original.createProjectChatCreation(ports);
    },
  };
});
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
  logoutAgentPlatform: logout,
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
const originalLocation = location.href;
let creationClient: ControlApiClient | null = null;
let creationAssets: object | null = null;
let currentCreation: ReturnType<typeof useInstalledPluginProjectChatCreation>;
const creationHost = {
  acquireMount: vi.fn(),
  loader: { closeUnusedMount: vi.fn() },
} as unknown as ControlPluginUiHost;
function WorkspaceProbe() {
  const account = useAgentPlatformAccount();
  const local = useDesktopLocalManagementAccess();
  actualAccount = account;
  const scope = useMemo(
    () =>
      creationClient
        ? {
            client: creationClient,
            sessionKey: account ? String(account.user.id) : null,
            assets: creationAssets,
          }
        : null,
    [account?.user.id],
  );
  const currentScope = useRef(scope),
    mountedScope = useRef(scope);
  currentScope.current = scope;
  mountedScope.current = scope;
  const creation = useInstalledPluginProjectChatCreation({
    scope,
    host: creationHost,
    pageNavigation: {} as PluginUiPageNavigation,
    enabled: true,
    localManagementAccess: local,
    currentScope,
    mountedScope,
    onDiagnostic: vi.fn(),
    rememberConversation: vi.fn(),
    taskContextRef: { current: undefined },
  });
  currentCreation = creation;
  useEffect(
    () => () => {
      mountedScope.current = null;
      disposed();
    },
    [],
  );
  return (
    <section
      data-workspace="true"
      data-local={local !== null}
      data-project-creation={typeof creation === "function"}
    >
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
  clearAgentPlatformSession();
  localStorage.clear();
  readUser.mockReset().mockRejectedValue(new Error("企业登录不可用"));
  login.mockReset();
  logout.mockReset().mockImplementation(async () => {
    clearAgentPlatformSession();
  });
  onSettings.mockClear();
  disposed = vi.fn();
  actualAccount = undefined;
  creationClient = null;
  creationAssets = null;
  creationPorts.length = 0;
  vi.mocked(creationHost.acquireMount).mockReset();
  vi.mocked(creationHost.loader.closeUnusedMount).mockReset();
  currentCreation = undefined;
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
  clearAgentPlatformSession();
  localStorage.clear();
  location.href = originalLocation;
});

describe("enterprise gate Native management branch", () => {
  it("does not automatically enter local management when an existing session is withdrawn", async () => {
    storeAgentPlatformSession("existing-session-fixture");
    approveLocal();
    readUser.mockResolvedValue(null).mockImplementationOnce(async () => {
      clearAgentPlatformSession();
      return null;
    });
    await render();
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.querySelector(".crewon-auth-shell")).not.toBeNull();
    expect(login).not.toHaveBeenCalled();
  });

  it("keeps an existing session behind authentication while slow restoration settles after the bootstrap deadline", async () => {
    vi.useFakeTimers();
    storeAgentPlatformSession("named-existing-session-fixture");
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
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("正在恢复登录状态");
    expect(container.textContent).not.toContain("暂不可用");
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
  it("account replacement withdraws a slow saved-session restoration before its late reply", async () => {
    vi.useFakeTimers();
    storeAgentPlatformSession("", "existing-refresh-fixture");
    approveLocal();
    let late!: (value: unknown) => void;
    readUser
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            late = resolve;
          }),
      )
      .mockResolvedValue({
        id: 43,
        username: "replacement",
        role: "user",
        password_login_enabled: true,
      });
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });
    expect(container.querySelector("form")).toBeNull();
    await act(async () => {
      storeAgentPlatformSession("replacement-session-fixture");
      late({ id: 99, username: "stale", role: "admin" });
      for (let i = 0; i < 20; i++) await Promise.resolve();
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

  it("opens enterprise login without a local bypass button", async () => {
    approveLocal();
    await render();
    const menu = container.querySelector("details")!;
    menu.open = true;
    await act(async () => {
      button("登录企业账号").click();
    });
    expect(menu.open).toBe(false);
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.querySelector("input[name='username']")).not.toBeNull();
    expect(
      container.querySelector("input[name='password']")?.getAttribute("type"),
    ).toBe("password");
    expect(container.querySelectorAll("button")).toHaveLength(3);
    expect(container.textContent).not.toContain("返回本机管理");
    expect(actualAccount).toBeNull();
    expect(login).not.toHaveBeenCalled();
  });

  it("keeps the login gate when Native management is withdrawn or restored", async () => {
    approveLocal();
    await render();
    await act(async () => {
      button("登录企业账号").click();
    });
    await act(async () => {
      localValue = null;
      nativeChanged?.();
    });
    expect(container.querySelector("[data-workspace]")).toBeNull();
    approveLocal(8);
    await act(async () => {
      nativeChanged?.();
    });
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.querySelector(".crewon-auth-shell")).not.toBeNull();
    expect(container.textContent).not.toContain("返回本机管理");
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
    expect(container.querySelector("[data-local='true']")).not.toBeNull();
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

describe("authenticated account and Native project creation composition", () => {
  it("keeps the authenticated admin while actual Native owner withdrawal and refresh fence project creation", async () => {
    storeAgentPlatformSession("named-admin-session-fixture");
    readUser.mockResolvedValue({
      id: 91,
      username: "native-admin",
      role: "admin",
      password_login_enabled: true,
    });
    location.href = "https://app.fixture.invalid/";
    const wire = controlUiClient(async () => {
      throw new Error("no_project_write_before_user_send");
    });
    creationClient = wire.client;
    creationAssets = {};
    location.href = "file:///crewon/dist/index.html";
    approveLocal(7);
    await render();
    expect(actualAccount).toMatchObject({ user: { id: 91, role: "admin" } });
    expect(
      container.querySelector("[data-project-creation='true']"),
    ).not.toBeNull();
    const previous = creationPorts.at(-1)!;
    previous.assertCurrent();
    const beforeDisposed = disposed.mock.calls.length;
    await act(async () => {
      localValue = null;
      nativeChanged?.();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(actualAccount).toMatchObject({ user: { id: 91, role: "admin" } });
    expect(
      container.querySelector("[data-project-creation='false']"),
    ).not.toBeNull();
    expect(() => previous.assertCurrent()).toThrow("plugin_ui_session_changed");
    approveLocal(8);
    await act(async () => {
      nativeChanged?.();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(
      container.querySelector("[data-project-creation='true']"),
    ).not.toBeNull();
    const refreshed = creationPorts.at(-1)!;
    refreshed.assertCurrent();
    expect(refreshed.ownerKey).toBe(previous.ownerKey);
    expect(disposed.mock.calls.length).toBe(beforeDisposed);
    expect(wire.fetch).not.toHaveBeenCalled();
    expect(creationHost.acquireMount).not.toHaveBeenCalled();
    await act(async () => {
      button("退出").click();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.querySelector(".crewon-auth-shell")).not.toBeNull();
    expect(() => refreshed.assertCurrent()).toThrow(
      "plugin_ui_session_changed",
    );
    expect(login).not.toHaveBeenCalled();
  });
  it("keeps authenticated Web account context without Native access or local authorization", async () => {
    delete (window as unknown as Record<string, unknown>).crewonDesktop;
    location.href = "https://app.fixture.invalid/";
    storeAgentPlatformSession("named-web-admin-session-fixture");
    readUser.mockResolvedValue({
      id: 92,
      username: "web-admin",
      role: "admin",
      password_login_enabled: true,
    });
    const wire = controlUiClient(async () => {
      throw new Error("no_project_write_before_user_send");
    });
    creationClient = wire.client;
    creationAssets = null;
    await render();
    expect(actualAccount).toMatchObject({ user: { id: 92, role: "admin" } });
    expect(container.querySelector("[data-local='false']")).not.toBeNull();
    expect(
      container.querySelector("[data-project-creation='true']"),
    ).not.toBeNull();
    expect(isDesktopLocalManagementAccess(localValue)).toBe(false);
    expect(wire.fetch).not.toHaveBeenCalled();
  });
});

it("authenticated Native App context resumes an ordinary project with its original intent through the real client and explicit legacy RPC", async () => {
  storeAgentPlatformSession("named-admin-creation-session");
  readUser.mockResolvedValue({
    id: 93,
    username: "native-creator",
    role: "admin",
    password_login_enabled: true,
  });
  const lease = uiLease();
  const module = {
    key: "module",
    mountKey: "original-mount",
    title: "AI短剧",
    contributionId: "workbench",
    plugin: controlUiItem(lease),
  };
  const content = "创作短剧《重录》";
  const binding = {
    bindingId: "original-binding",
    projectId: "existing-ordinary-project",
    threadId: "original-thread",
    workspaceId: null,
    revision: 1,
    state: "active",
    source: {
      pluginId: lease.descriptor.pluginId,
      publisherId: lease.descriptor.publisherId,
      version: lease.descriptor.version,
      packageDigest: lease.packageDigest,
      selectionRevision: lease.selectionRevision,
    },
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
  const actions: { action: string; input: Record<string, unknown> }[] = [];
  let lostAcknowledgement = true;
  location.href = "https://app.fixture.invalid/";
  const wire = controlUiClient((url, init) => {
    if (url.pathname.endsWith("/actions")) {
      const request = JSON.parse(String(init.body));
      actions.push(request);
      if (request.action.endsWith("getCreationContext"))
        return controlUiResponse({
          output: {
            schemaVersion: "crewon.project-conversation-creation-context.v1",
            workspaceMode: "legacy-nullable",
          },
        });
      if (request.action.endsWith("createConversation")) {
        if (lostAcknowledgement) {
          lostAcknowledgement = false;
          throw new Error("named_conversation_ack_lost");
        }
        return controlUiResponse({
          output: { disposition: "replayed", binding },
        });
      }
      throw new Error("unexpected_project_write_or_target");
    }
    throw new Error("named_thread_read_boundary_after_binding");
  });
  creationClient = wire.client;
  creationAssets = {};
  vi.mocked(creationHost.acquireMount).mockResolvedValue(lease);
  vi.mocked(creationHost.loader.closeUnusedMount).mockResolvedValue(undefined);
  location.href = "file:///crewon/dist/index.html";
  approveLocal(9);
  await render();
  expect(actualAccount).toMatchObject({ user: { id: 93, role: "admin" } });
  expect(currentCreation).toBeTypeOf("function");
  const storageKey = JSON.stringify([
    "crewon.project-chat-creation.v1",
    creationPorts.at(-1)!.ownerKey,
    module.mountKey,
  ]);
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      version: 1,
      key: "01a13f43-094c-767a-9414-b5622b236255",
      content,
      projectId: binding.projectId,
      threadId: null,
      workspaceId: null,
      binding: null,
      threadRevision: null,
      runId: null,
    }),
  );
  await expect(currentCreation!(module, { content })).rejects.toThrow(
    "control_api_transport_unavailable",
  );
  const first = actions.find((a) => a.action.endsWith("createConversation"))!;
  expect(first.input).toMatchObject({
    projectId: binding.projectId,
    workspaceId: null,
    idempotencyKey: "project-chat-thread:01a13f43-094c-767a-9414-b5622b236255",
  });
  expect(JSON.parse(localStorage.getItem(storageKey)!).projectId).toBe(
    binding.projectId,
  );
  approveLocal(10);
  await act(async () => {
    nativeChanged?.();
    for (let i = 0; i < 16; i++) await Promise.resolve();
  });
  expect(currentCreation).toBeTypeOf("function");
  await expect(currentCreation!(module, { content })).rejects.toThrow();
  expect(actions.map((a) => a.action)).toEqual([
    "crewon.project-workspace-target.v1.getCreationContext",
    "crewon.project-conversations.v1.createConversation",
    "crewon.project-workspace-target.v1.getCreationContext",
    "crewon.project-conversations.v1.createConversation",
  ]);
  expect(actions[3]).toEqual(first);
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
    key: "01a13f43-094c-767a-9414-b5622b236255",
    projectId: binding.projectId,
    threadId: binding.threadId,
    binding,
  });
  expect(creationHost.acquireMount).toHaveBeenCalledTimes(2);
});
