import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  commandSidebarHasFolderPicker,
  CommandSidebar,
  paletteSearchKeyAction,
  pickCommandSidebarWorkspaceFolder,
  readCommandSidebarWorkspaceRoster,
  SidebarAccount,
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

function renderSidebar() {
  return renderToStaticMarkup(
    <CommandSidebar
      activeView="command"
      cwd="/Users/me/projects/crewon"
      isSearchOpen={false}
      linkedThreads={[]}
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
}

describe("CommandSidebar", () => {
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
        onOpenLinkedThread={vi.fn()}
        onQueryChange={vi.fn()}
        onSwitchView={vi.fn()}
        onToggleCollapse={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    );

    expect(markup).toContain("crewon");
    expect(markup).toContain("codex-rs");
    expect(markup).not.toContain('data-nav-key="projects"');
    expect(markup).toMatchSnapshot();
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
    Object.defineProperty(globalThis, "isTauri", {
      configurable: true,
      value: true,
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
      delete (globalThis as { isTauri?: boolean }).isTauri;
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
        hasTasksTree: markup.includes('aria-label="Tasks and conversations"'),
        hasTask: markup.includes("Control task"),
      }).toEqual({
        getItemCalls: [],
        setItemCalls: [],
        pickerAvailableCalls: [],
        pickFolderCalls: [],
        hasAbsolutePath: false,
        hasLegacyPathInput: false,
        hasTasksTree: true,
        hasTask: true,
      });
      expect(markup).toMatchSnapshot();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
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
