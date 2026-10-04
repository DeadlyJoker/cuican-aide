import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  commandSidebarHasFolderPicker,
  CommandSidebar,
  paletteSearchKeyAction,
  pickCommandSidebarWorkspaceFolder,
  readCommandSidebarWorkspaceRoster,
  SidebarAccount,
  type CommandLinkedThread,
  writeCommandSidebarWorkspaceRoster,
} from "./CommandWorkspaceChrome";
import type { CommandHomeSlots } from "./commandWorkspaceState";

describe("Palette", () => {
  it("blocks form submission when Enter has no selectable result", () => {
    expect(paletteSearchKeyAction("Enter", false)).toBe("blockSubmit");
    expect(paletteSearchKeyAction("Enter", true)).toBe("selectFirst");
  });
});

const sidebarSlots: CommandHomeSlots = {
  agent: { detail: "Agent", label: "Agent", title: "Agent", value: "agent" },
  knowledge: {
    detail: "Knowledge",
    label: "Knowledge",
    title: "Knowledge",
    value: "knowledge",
  },
  mcps: [
    { detail: "MCP 1", label: "MCP", title: "MCP 1", value: "mcp-1" },
    { detail: "MCP 2", label: "MCP", title: "MCP 2", value: "mcp-2" },
  ],
  model: "gpt-5",
  skills: [
    { detail: "Skill 1", label: "Skill", title: "Skill 1", value: "skill-1" },
    { detail: "Skill 2", label: "Skill", title: "Skill 2", value: "skill-2" },
  ],
  workflow: {
    detail: "Workflow",
    label: "Workflow",
    title: "Workflow",
    value: "workflow",
  },
};

function renderSidebar({
  sidebarCollapsed,
  locale,
}: { sidebarCollapsed?: boolean; locale?: "zh" | "en" } = {}) {
  return renderToStaticMarkup(
    <CommandSidebar
      activeView="command"
      cwd="/Users/me/projects/crewon"
      isSearchOpen={false}
      linkedThreads={[]}
      locale={locale}
      query=""
      selectedLinkedThreadId={null}
      sidebarCollapsed={sidebarCollapsed}
      slots={sidebarSlots}
      workspaceAuthority="legacy"
      onCloseSearch={vi.fn()}
      onCreateWorkspace={vi.fn()}
      onNewThread={vi.fn()}
      onOpenLinkedThread={vi.fn()}
      onQueryChange={vi.fn()}
      onSwitchView={vi.fn()}
      onToggleCollapse={vi.fn()}
      onToggleSearch={vi.fn()}
    />,
  );
}

function linkedThread(
  id: string,
  state: NonNullable<CommandLinkedThread["state"]>,
): CommandLinkedThread {
  return {
    cwd: "/Users/me/projects/crewon",
    id,
    preview: id,
    scope: "personal",
    scopeLabel: "个人任务",
    state,
    stateLabel: state,
    title: id,
    updatedLabel: "刚刚",
  };
}

describe("CommandSidebar", () => {
  it.each([
    ["zh", false, "折叠侧栏"],
    ["zh", true, "展开侧栏"],
    ["en", false, "Collapse sidebar"],
    ["en", true, "Expand sidebar"],
  ] as const)(
    "reflects the actual collapsed state in the %s toggle (%s)",
    (locale, sidebarCollapsed, label) => {
      const markup = renderSidebar({ locale, sidebarCollapsed });
      expect(markup).toContain(
        `aria-label="${label}" aria-pressed="${sidebarCollapsed}"`,
      );
    },
  );

  it.each(["legacy", "control"] as const)(
    "limits each %s workspace to five without limiting search",
    (authority) => {
      const threads = ["/repo/current", "/repo/other", null].flatMap(
        (cwd, groupIndex) =>
          Array.from({ length: 7 }, (_, index) => ({
            cwd,
            id: `group-${groupIndex}-thread-${index}`,
            title: `group-${groupIndex}-thread-${index}`,
            preview: "",
            updatedAt: 100 - index,
            updatedLabel: "刚刚",
          })),
      );
      const markup = renderToStaticMarkup(
        <CommandSidebar
          activeView="command"
          cwd="/repo/current"
          controlWorkspace={{ name: "测试空间", busy: false }}
          isSearchOpen
          linkedThreads={threads}
          locale="zh"
          query="group-0-thread-6"
          selectedLinkedThreadId={null}
          slots={sidebarSlots}
          workspaceAuthority={authority}
          onCloseSearch={vi.fn()}
          onNewThread={vi.fn()}
          onOpenLinkedThread={vi.fn()}
          onQueryChange={vi.fn()}
          onSwitchView={vi.fn()}
          onToggleCollapse={vi.fn()}
          onToggleSearch={vi.fn()}
        />,
      );
      const visibleIds = Array.from(
        markup.matchAll(/data-linked-thread-id="([^"]+)"/g),
        (match) => match[1],
      );
      expect(visibleIds).toEqual(
        authority === "control"
          ? threads.slice(0, 5).map((thread) => thread.id)
          : threads
              .filter(
                (thread) =>
                  !thread.id.endsWith("-5") && !thread.id.endsWith("-6"),
              )
              .map((thread) => thread.id),
      );
      expect(markup).toContain(
        authority === "control" ? "展开更多（16）" : "展开更多（2）",
      );
      expect(markup).toContain('data-thread-id="group-0-thread-6"');
    },
  );

  it("keeps an explicit draft workspace visible beside conversation workspaces", () => {
    const markup = renderToStaticMarkup(
      <CommandSidebar
        activeView="command"
        cwd="/Users/me/projects/crewon"
        isSearchOpen={false}
        linkedThreads={[
          {
            cwd: "/Users/me/projects/crewon/codex-rs",
            id: "thread-codex-rs",
            preview: "Existing backend conversation",
            scope: "personal",
            scopeLabel: "个人任务",
            state: "pendingUnread",
            stateLabel: "新的待确认",
            title: "Backend conversation",
            updatedLabel: "Today",
          },
        ]}
        query=""
        selectedLinkedThreadId={null}
        slots={sidebarSlots}
        workspaceAuthority="legacy"
        onCloseSearch={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onNewThread={vi.fn()}
        onArchiveThread={vi.fn()}
        onOpenLinkedThread={vi.fn()}
        onQueryChange={vi.fn()}
        onSwitchView={vi.fn()}
        onToggleCollapse={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    );

    expect(markup).toContain("crewon");
    expect(markup).toContain("codex-rs");
    expect(markup).toContain('data-nav-key="projects"');
    expect(markup).toContain("sidebar-task-attention");
    expect(markup).toContain('data-thread-state="pendingUnread"');
    expect(markup).toMatchSnapshot();
  });

  it("aggregates only unseen terminal and interaction signals", () => {
    const markup = renderToStaticMarkup(
      <CommandSidebar
        activeView="projects"
        cwd="/Users/me/projects/crewon"
        isSearchOpen={false}
        linkedThreads={[
          linkedThread("pending-unread", "pendingUnread"),
          linkedThread("completed-unread", "completedUnread"),
          linkedThread("failed-unread", "failedUnread"),
          linkedThread("pending-viewed", "pendingViewed"),
          linkedThread("failed-viewed", "failedViewed"),
          linkedThread("running", "running"),
          linkedThread("completed-viewed", "completedViewed"),
        ]}
        query=""
        selectedLinkedThreadId={null}
        slots={sidebarSlots}
        workspaceAuthority="legacy"
        onCloseSearch={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onNewThread={vi.fn()}
        onOpenLinkedThread={vi.fn()}
        onQueryChange={vi.fn()}
        onSwitchView={vi.fn()}
        onToggleCollapse={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="3 个任务需要关注"');
    expect(markup.match(/sidebar-task-attention/gu)).toHaveLength(1);
    expect(markup.match(/command-thread-status is-/gu)).toHaveLength(3);
    expect(markup).not.toContain("is-pending-viewed");
    expect(markup).not.toContain("is-running");
  });

  it("offers a remove control for every workspace row", () => {
    const markup = renderToStaticMarkup(
      <CommandSidebar
        activeView="command"
        cwd="/Users/me/projects/crewon"
        isSearchOpen={false}
        linkedThreads={[
          {
            cwd: "/Users/me/projects/crewon/codex-rs",
            id: "thread-codex-rs",
            preview: "Existing backend conversation",
            title: "Backend conversation",
            updatedLabel: "Today",
          },
        ]}
        query=""
        selectedLinkedThreadId={null}
        slots={sidebarSlots}
        workspaceAuthority="legacy"
        onCloseSearch={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onNewThread={vi.fn()}
        onArchiveThread={vi.fn()}
        onOpenLinkedThread={vi.fn()}
        onQueryChange={vi.fn()}
        onSwitchView={vi.fn()}
        onToggleCollapse={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    );

    // The active folder and the conversation-only folder both get one.
    expect(markup.match(/workspace-remove-action/g)).toHaveLength(2);
    expect(markup).toContain("将 crewon 移出空间列表");
    expect(markup).toContain("将 codex-rs 移出空间列表");
    // Confirmation is required, so nothing is removed on first render.
    expect(markup).not.toContain("workspace-remove-dialog");
  });

  it("replaces the typed-path form with a folder dialog on desktop", () => {
    vi.stubGlobal("window", {
      crewonDesktop: { version: 1 },
      location: { search: "" },
    });
    try {
      const markup = renderSidebar();

      expect({
        offersDialog: markup.includes('aria-label="选择文件夹…"'),
        offersPathField: markup.includes('id="command-workspace-path"'),
        pathFormHidden: markup.includes(
          '<form class="sidebar-workspace-form" hidden=""',
        ),
      }).toEqual({
        offersDialog: true,
        // The form stays in the tree for web; desktop just never shows it.
        offersPathField: true,
        pathFormHidden: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the typed-path form on web, where no native dialog exists", () => {
    const markup = renderSidebar();

    expect({
      offersDialog: markup.includes('aria-label="选择文件夹…"'),
      offersPathField: markup.includes('id="command-workspace-path"'),
      addWorkspaceAction: markup.includes('aria-label="新增空间"'),
    }).toEqual({
      offersDialog: false,
      offersPathField: true,
      addWorkspaceAction: true,
    });
  });

  it("cuts local storage, folder picker, and cwd markup out of Control authority", async () => {
    const getItem = vi.fn(() => null);
    const setItem = vi.fn();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem, setItem },
    });
    const pickerAvailable = vi.fn(() => true);
    const pickFolder = vi.fn(async () => "/Users/private/control-secret");

    try {
      expect(readCommandSidebarWorkspaceRoster("control", "account-1")).toEqual(
        [],
      );
      writeCommandSidebarWorkspaceRoster("control", "account-1", [
        { path: "/Users/private/control-secret", usedAt: 1 },
      ]);
      expect(commandSidebarHasFolderPicker("control", pickerAvailable)).toBe(
        false,
      );
      await expect(
        pickCommandSidebarWorkspaceFolder("control", "Choose", pickFolder),
      ).resolves.toBeNull();

      const markup = renderToStaticMarkup(
        <CommandSidebar
          activeView="command"
          cwd="/Users/private/control-secret"
          isSearchOpen
          linkedThreads={[
            {
              cwd: "/Users/private/control-secret/child",
              id: "thread-control",
              preview: "Safe preview",
              title: "Control task",
              updatedLabel: "Today",
            },
          ]}
          locale="en"
          query=""
          selectedLinkedThreadId={null}
          slots={sidebarSlots}
          workspaceAuthority="control"
          onCloseSearch={vi.fn()}
          onCreateWorkspace={vi.fn()}
          onNewThread={vi.fn()}
          onOpenLinkedThread={vi.fn()}
          onQueryChange={vi.fn()}
          onSwitchView={vi.fn()}
          onToggleCollapse={vi.fn()}
          onToggleSearch={vi.fn()}
        />,
      );

      expect({
        getItemCalls: getItem.mock.calls,
        setItemCalls: setItem.mock.calls,
        pickerAvailableCalls: pickerAvailable.mock.calls,
        pickFolderCalls: pickFolder.mock.calls,
        hasAbsolutePath: markup.includes("/Users/private"),
        hasLegacyPathInput: markup.includes("command-workspace-path"),
        hasWorkspaceTree: markup.includes(
          'aria-label="Workspaces and conversations"',
        ),
        hasTask: markup.includes("Control task"),
      }).toEqual({
        getItemCalls: [],
        setItemCalls: [],
        pickerAvailableCalls: [],
        pickFolderCalls: [],
        hasAbsolutePath: false,
        hasLegacyPathInput: false,
        hasWorkspaceTree: true,
        hasTask: true,
      });
      expect(markup).toMatchSnapshot();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("shows the bound Control workspace as a tree node with its conversations", () => {
    const markup = renderToStaticMarkup(
      <CommandSidebar
        activeView="command"
        controlWorkspace={{
          name: "cuican-aide",
          workspaceId: "workspace-a",
          workspaces: [
            { workspaceId: "workspace-a", displayName: "cuican-aide" },
          ],
          onActivate: vi.fn(),
          busy: false,
          onClear: vi.fn(),
          onSelect: vi.fn(),
        }}
        cwd=""
        isSearchOpen={false}
        linkedThreads={[
          {
            cwd: null,
            id: "thread-control",
            workspaceId: "workspace-a",
            preview: "Safe preview",
            title: "Control task",
            updatedLabel: "Today",
          },
        ]}
        locale="zh"
        query=""
        selectedLinkedThreadId={null}
        slots={sidebarSlots}
        workspaceAuthority="control"
        onCloseSearch={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onNewThread={vi.fn()}
        onArchiveThread={vi.fn()}
        onOpenLinkedThread={vi.fn()}
        onQueryChange={vi.fn()}
        onSwitchView={vi.fn()}
        onToggleCollapse={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="工作空间和对话"');
    expect(markup).toContain("cuican-aide");
    expect(markup).toContain("Control task");
    expect(markup).toContain('aria-label="新增空间"');
    expect(markup).toContain('aria-label="取消选择工作空间"');
    expect(markup).toContain('aria-label="归档会话"');
    expect(markup).toContain('data-archive-thread-id="thread-control"');
    expect(markup).not.toContain("command-thread-operations-rail");
    expect(markup).toMatchSnapshot();
  });

  it("offers workspace selection when Control has no bound folder", () => {
    const markup = renderToStaticMarkup(
      <CommandSidebar
        activeView="command"
        controlWorkspace={{ name: null, busy: false, onSelect: vi.fn() }}
        cwd=""
        isSearchOpen={false}
        linkedThreads={[]}
        locale="zh"
        query=""
        selectedLinkedThreadId={null}
        slots={sidebarSlots}
        workspaceAuthority="control"
        onCloseSearch={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onNewThread={vi.fn()}
        onOpenLinkedThread={vi.fn()}
        onQueryChange={vi.fn()}
        onSwitchView={vi.fn()}
        onToggleCollapse={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="新增空间"');
    expect(markup).toContain("尚未绑定本机文件夹作为工作空间。");
  });

  it("shows a Control workspace selection failure without hiding retry", () => {
    const markup = renderToStaticMarkup(
      <CommandSidebar
        activeView="command"
        controlWorkspace={{
          name: null,
          busy: false,
          error: "desktop_workspace_transitioning",
          onSelect: vi.fn(),
        }}
        cwd=""
        isSearchOpen={false}
        linkedThreads={[]}
        locale="zh"
        query=""
        selectedLinkedThreadId={null}
        slots={sidebarSlots}
        workspaceAuthority="control"
        onCloseSearch={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onNewThread={vi.fn()}
        onOpenLinkedThread={vi.fn()}
        onQueryChange={vi.fn()}
        onSwitchView={vi.fn()}
        onToggleCollapse={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    );

    expect(markup).toContain(
      "工作空间切换失败：desktop_workspace_transitioning",
    );
    expect(markup).toContain('aria-label="新增空间"');
    expect(
      markup.slice(
        markup.indexOf('<p class="sidebar-error-hint"'),
        markup.indexOf("</p>", markup.indexOf("sidebar-error-hint")) + 4,
      ),
    ).toMatchSnapshot();
  });

  it("keeps legacy local storage and folder picker authority", async () => {
    const getItem = vi.fn(() => "[]");
    const setItem = vi.fn();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem, setItem },
    });
    const pickerAvailable = vi.fn(() => true);
    const pickFolder = vi.fn(async () => "/Users/me/project");

    try {
      expect(readCommandSidebarWorkspaceRoster("legacy", "account-1")).toEqual(
        [],
      );
      writeCommandSidebarWorkspaceRoster("legacy", "account-1", [
        { path: "/Users/me/project", usedAt: 1 },
      ]);
      expect(commandSidebarHasFolderPicker("legacy", pickerAvailable)).toBe(
        true,
      );
      await expect(
        pickCommandSidebarWorkspaceFolder("legacy", "Choose", pickFolder),
      ).resolves.toBe("/Users/me/project");

      expect({
        getItemCalls: getItem.mock.calls.length,
        setItemCalls: setItem.mock.calls.length,
        pickerAvailableCalls: pickerAvailable.mock.calls.length,
        pickFolderCalls: pickFolder.mock.calls.length,
      }).toEqual({
        getItemCalls: 1,
        setItemCalls: 1,
        pickerAvailableCalls: 1,
        pickFolderCalls: 1,
      });
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("SidebarAccount", () => {
  it("keeps the original footer style for an explicit signed-out preview without account actions", () => {
    const markup = renderToStaticMarkup(
      <SidebarAccount account={null} onSettings={vi.fn()} />,
    );

    expect(markup).toContain('aria-label="账号"');
    expect(markup).toContain('class="sidebar-account"');
    expect(markup).toContain("未登录");
    expect(markup).toContain("页面预览");
    expect(markup).toContain("设置");
    expect(markup).not.toContain("当前企业账号");
    expect(markup).not.toContain("退出登录");
    expect(markup).not.toContain("设置登录密码");
  });

  it("prefers the synchronized enterprise display name", () => {
    const markup = renderToStaticMarkup(
      <SidebarAccount
        onSettings={vi.fn()}
        account={{
          needsPassword: false,
          providerLabel: "企业微信已绑定",
          user: {
            id: 42,
            display_name: "企业微信姓名",
            email: "lin@example.com",
            linked_providers: ["wecom"],
            nickname: "PIM 昵称",
            role: "user",
            username: "lin.xiao",
          },
          onLogout: vi.fn(),
          onSetPassword: vi.fn(),
        }}
      />,
    );

    expect(markup).toContain("企业微信姓名");
    expect(markup).toContain("设置");
    expect(markup).not.toContain("PIM 昵称");
  });

  it("keeps account actions in an upward footer menu", () => {
    const markup = renderToStaticMarkup(
      <SidebarAccount
        onSettings={vi.fn()}
        account={{
          needsPassword: true,
          providerLabel: "企业微信已绑定",
          user: {
            id: 42,
            email: "lin@example.com",
            linked_providers: ["wecom"],
            nickname: "林晓",
            password_login_enabled: false,
            role: "user",
            username: "lin.xiao",
          },
          onLogout: vi.fn(),
          onSetPassword: vi.fn(),
        }}
      />,
    );

    expect(markup).toMatchSnapshot();
  });
});
