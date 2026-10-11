// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandSearchCatalogNavigation } from "./CommandSearchCatalogNavigation";
import { CommandSidebarSearchView } from "./CommandSidebarSearchView";
import { CommandSidebar } from "./CommandWorkspaceChrome";
import type { CommandHomeSlots } from "./commandWorkspaceState";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});
const results = [
  {
    action: "thread" as const,
    key: "thread:1",
    threadId: "1",
    title: "创意项目",
    detail: "",
    kind: "对话",
  },
  {
    action: "view" as const,
    key: "view:team",
    view: "team" as const,
    title: "团队",
    detail: "",
    kind: "功能",
  },
];
const props = {
  isSearchOpen: true,
  locale: "zh" as const,
  noMatches: "没有匹配",
  query: "",
  results,
  searchLabel: "搜索对话和能力",
  searchResultsLabel: "搜索结果",
  shortcutLabel: "⌘K",
  triggerRef: { current: null },
  onActivate: vi.fn(),
  onClose: vi.fn(),
  onQueryChange: vi.fn(),
};
function input() {
  return document.querySelector<HTMLInputElement>('[role="combobox"]')!;
}
async function key(value: string, isComposing = false) {
  await act(async () =>
    input().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
        isComposing,
      }),
    ),
  );
}
const slots: CommandHomeSlots = {
  agent: { detail: "Agent", label: "Agent", title: "Agent", value: "agent" },
  knowledge: {
    detail: "Knowledge",
    label: "Knowledge",
    title: "Knowledge",
    value: "knowledge",
  },
  model: "fixture-model",
  mcps: [
    { detail: "MCP 1", label: "MCP", title: "MCP 1", value: "mcp-1" },
    { detail: "MCP 2", label: "MCP", title: "MCP 2", value: "mcp-2" },
  ],
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
describe("centered search catalog interactions", () => {
  it("prevents activation of stale results while loading then supports arrow and Enter selection", async () => {
    const onActivate = vi.fn();
    await act(async () =>
      root.render(
        <CommandSidebarSearchView {...props} loading onActivate={onActivate} />,
      ),
    );
    expect(input().maxLength).toBe(256);
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>('[role="option"]')!.disabled,
    ).toBe(true);
    await key("Enter");
    expect(onActivate).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <CommandSidebarSearchView
          {...props}
          loading={false}
          onActivate={onActivate}
        />,
      ),
    );
    await key("ArrowDown");
    const selected = document.querySelector(
      '[role="option"][aria-selected="true"]',
    );
    expect(selected?.textContent).toContain("团队");
    expect(input().getAttribute("aria-activedescendant")).toBe(selected?.id);
    await key("Enter", true);
    expect(onActivate).not.toHaveBeenCalled();
    await key("Enter");
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(results[1]);
  });
  it("retains real previous/next callbacks and exposes retry only for failed results", async () => {
    const onOlder = vi.fn(),
      onNewer = vi.fn(),
      onRefresh = vi.fn();
    await act(async () =>
      root.render(
        <CommandSidebarSearchView
          {...props}
          failed
          results={[]}
          footer={
            <CommandSearchCatalogNavigation
              locale="zh"
              navigation={{
                loading: false,
                failed: true,
                empty: true,
                searching: true,
                hasOlder: true,
                hasNewer: true,
                onOlder,
                onNewer,
                onRefresh,
              }}
            />
          }
        />,
      ),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("读取失败，请重试");
    expect(dialog.querySelector("[data-search-empty]")).toBeNull();
    const button = (label: string) =>
      [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
        (entry) => entry.textContent?.trim() === label,
      )!;
    await act(async () => button("下一页").click());
    await act(async () => button("上一页").click());
    await act(async () => button("重试").click());
    expect(onOlder).toHaveBeenCalledTimes(1);
    expect(onNewer).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
  it("keeps server full-text matches even when the matching content is absent from title and preview", async () => {
    const onOpen = vi.fn(),
      onQueryChange = vi.fn(),
      onClose = vi.fn();
    await act(async () =>
      root.render(
        <CommandSidebar
          activeView="command"
          cwd=""
          workspaceAuthority="control"
          isSearchOpen
          locale="zh"
          query="仅正文有的关键词"
          slots={slots}
          selectedLinkedThreadId={null}
          linkedThreads={[
            {
              id: "fulltext-hit",
              cwd: null,
              preview: "预览",
              title: "会话标题",
              updatedLabel: "刚刚",
            },
          ]}
          threadCatalogNavigation={{
            loading: false,
            failed: false,
            empty: false,
            searching: true,
            hasOlder: false,
            hasNewer: false,
            onOlder: vi.fn(),
            onNewer: vi.fn(),
            onRefresh: vi.fn(),
          }}
          onCloseSearch={onClose}
          onNewThread={vi.fn()}
          onOpenLinkedThread={onOpen}
          onQueryChange={onQueryChange}
          onSwitchView={vi.fn()}
          onToggleCollapse={vi.fn()}
          onToggleSearch={vi.fn()}
        />,
      ),
    );
    const result = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] [data-thread-id="fulltext-hit"]',
    );
    expect(result?.textContent).toContain("会话标题");
    await act(async () => result!.click());
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("fulltext-hit");
    expect(onQueryChange).toHaveBeenCalledExactlyOnceWith("");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("keeps the Agent workspace context while its plugin panel is selected and resources can still expand", async () => {
    const onToggle = vi.fn(),
      onSwitchView = vi.fn(),
      onOpen = vi.fn();
    const sidebar = (collapsed: boolean) => (
      <CommandSidebar
        activeView="command"
        cwd=""
        workspaceAuthority="control"
        collapsed={collapsed}
        sidebarCollapsed={false}
        isSearchOpen={false}
        locale="zh"
        query=""
        slots={slots}
        selectedLinkedThreadId={null}
        linkedThreads={[]}
        hostModules={[{ id: "short", label: "AI 短剧", active: true, onOpen }]}
        onCloseSearch={vi.fn()}
        onNewThread={vi.fn()}
        onOpenLinkedThread={vi.fn()}
        onQueryChange={vi.fn()}
        onSwitchView={onSwitchView}
        onToggleCollapse={onToggle}
        onToggleSearch={vi.fn()}
      />
    );
    await act(async () => root.render(sidebar(false)));
    expect(container.querySelector("aside")?.dataset.sidebarSection).toBe(
      "work",
    );
    const context = container.querySelector<HTMLDivElement>(
      "#command-sidebar-context",
    )!;
    expect(context.hidden).toBe(false);
    const plugin = context.querySelector<HTMLButtonElement>(
      '[data-host-module-target="short"]',
    )!;
    expect(plugin.getAttribute("aria-current")).toBe("page");
    await act(async () => plugin.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    await act(async () => root.render(sidebar(true)));
    expect(context.hidden).toBe(true);
    expect(
      container
        .querySelector('[data-nav-key="command"]')
        ?.getAttribute("aria-current"),
    ).toBe("page");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-nav-key="resources"]')!
        .click(),
    );
    expect(onSwitchView).toHaveBeenCalledExactlyOnceWith("agents");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
  it.each([
    { hasOlder: true, hasNewer: false, pageLabel: "下一页" },
    { hasOlder: false, hasNewer: true, pageLabel: "上一页" },
  ])(
    "moves history browsing into search while keeping the $pageLabel cursor reachable",
    async (page) => {
      const onOlder = vi.fn(),
        onNewer = vi.fn(),
        onRefresh = vi.fn();
      function Harness() {
        const [open, setOpen] = useState(false);
        return (
          <CommandSidebar
            activeView="command"
            cwd=""
            workspaceAuthority="control"
            isSearchOpen={open}
            locale="zh"
            query=""
            slots={slots}
            selectedLinkedThreadId={null}
            linkedThreads={[]}
            threadCatalogNavigation={{
              loading: false,
              failed: false,
              empty: true,
              searching: false,
              hasOlder: page.hasOlder,
              hasNewer: page.hasNewer,
              onOlder,
              onNewer,
              onRefresh,
            }}
            onCloseSearch={() => setOpen(false)}
            onNewThread={vi.fn()}
            onOpenLinkedThread={vi.fn()}
            onQueryChange={vi.fn()}
            onSwitchView={vi.fn()}
            onToggleCollapse={vi.fn()}
            onToggleSearch={() => setOpen((value) => !value)}
          />
        );
      }
      await act(async () => root.render(<Harness />));
      const sidebar = container.querySelector("aside")!;
      expect(sidebar.querySelector(".thread-catalog-pager")).toBeNull();
      for (const label of ["较新", "最新", "较早"])
        expect(sidebar.textContent).not.toContain(label);
      const more = sidebar.querySelector<HTMLButtonElement>(
        "[data-sidebar-catalog-open]",
      )!;
      expect(more.textContent).toContain("更多会话");
      await act(async () => more.click());
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog).not.toBeNull();
      for (const label of ["较新", "最新", "较早"])
        expect(dialog.textContent).not.toContain(label);
      const pageButton = [
        ...dialog.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === page.pageLabel)!;
      await act(async () => pageButton.click());
      expect(page.hasOlder ? onOlder : onNewer).toHaveBeenCalledTimes(1);
      expect(onRefresh).not.toHaveBeenCalled();
    },
  );
  it("retains per-workspace disclosure without treating it as a remote history page", async () => {
    const onOlder = vi.fn();
    await act(async () =>
      root.render(
        <CommandSidebar
          activeView="command"
          cwd=""
          workspaceAuthority="control"
          isSearchOpen={false}
          locale="zh"
          query=""
          slots={slots}
          selectedLinkedThreadId={null}
          linkedThreads={Array.from({ length: 7 }, (_, index) => ({
            id: `loaded-${index}`,
            cwd: null,
            title: `已加载会话${index}`,
            preview: "",
            updatedLabel: "刚刚",
          }))}
          threadCatalogNavigation={{
            loading: false,
            failed: false,
            empty: false,
            searching: false,
            hasOlder: false,
            hasNewer: false,
            onOlder,
            onNewer: vi.fn(),
            onRefresh: vi.fn(),
          }}
          onCloseSearch={vi.fn()}
          onNewThread={vi.fn()}
          onOpenLinkedThread={vi.fn()}
          onQueryChange={vi.fn()}
          onSwitchView={vi.fn()}
          onToggleCollapse={vi.fn()}
          onToggleSearch={vi.fn()}
        />,
      ),
    );
    expect(container.querySelectorAll("[data-linked-thread-id]")).toHaveLength(
      5,
    );
    expect(container.querySelector("[data-sidebar-catalog-open]")).toBeNull();
    const expand = container.querySelector<HTMLButtonElement>(
      ".sidebar-threads-disclosure[aria-expanded]",
    )!;
    expect(expand.textContent).toContain("展开更多（2）");
    await act(async () => expand.click());
    expect(container.querySelectorAll("[data-linked-thread-id]")).toHaveLength(
      7,
    );
    expect(onOlder).not.toHaveBeenCalled();
  });
});
