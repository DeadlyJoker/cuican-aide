import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CommandSidebar,
  paletteSearchKeyAction,
  SidebarAccount,
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
