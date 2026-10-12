import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error Browser source omits Node types; Vitest reads the stylesheet in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CommandRailAccount } from "./CommandRailAccount";
import { CommandNavigationRail } from "./CommandNavigationRail";
import { CommandSidebarNavigation } from "./CommandSidebarNavigation";
import {
  commandSidebarHasContext,
  commandSidebarSection,
} from "./commandSidebarSections";

describe("two-level command navigation", () => {
  it.each([
    ["command", "work", true],
    ["projects", "work", true],
    ["assist", "assist", false],
    ["schedule", "schedule", false],
    ["agents", "resources", true],
    ["team", "resources", true],
    ["knowledge", "resources", true],
  ] as const)(
    "maps %s to its functional area and contextual sidebar",
    (view, section, hasContext) => {
      expect(commandSidebarSection(view)).toBe(section);
      expect(commandSidebarHasContext(view)).toBe(hasContext);
    },
  );

  it("keeps global destinations and the account avatar accessible when folded", () => {
    const markup = renderToStaticMarkup(
      <CommandNavigationRail
        activeView="team"
        collapsed
        locale="zh"
        taskAttentionCount={2}
        onSwitchView={vi.fn()}
        onToggleCollapse={vi.fn()}
        accountMenu={
          <CommandRailAccount
            locale="zh"
            onSettings={vi.fn()}
            account={{
              needsPassword: true,
              providerLabel: "企业微信已绑定",
              user: {
                id: 42,
                display_name: "林晓",
                email: "lin@example.com",
                username: "lin.xiao",
                role: "user",
              },
              onLogout: vi.fn(),
              onSetPassword: vi.fn(),
            }}
          />
        }
      />,
    );
    expect(markup).toContain('aria-label="全局导航"');
    expect(markup).toMatch(
      /<button[^>]*aria-current="page"[^>]*aria-label="资源"/,
    );
    expect(markup).toContain('aria-label="账号菜单：林晓"');
    expect(markup).not.toContain("展开侧栏");
    expect(markup).toContain('aria-label="2 个任务需要关注"');
    expect(markup).not.toContain("新建任务");
    expect(markup).toMatchSnapshot();
  });

  it("separates global work navigation from creation and resource selection", () => {
    const props = {
      locale: "zh" as const,
      onNewThread: vi.fn(),
      onSwitchView: vi.fn(),
    };
    const work = renderToStaticMarkup(
      <CommandSidebarNavigation {...props} activeView="command" />,
    );
    const resources = renderToStaticMarkup(
      <CommandSidebarNavigation {...props} activeView="team" />,
    );
    expect(work).toContain("新建任务");
    expect(work).not.toContain("日程安排");
    expect(work).not.toContain("智能体");
    expect(resources).toContain('data-nav-key="agents"');
    expect(resources).toContain(
      'aria-current="page" class="active" data-nav-key="team"',
    );
    expect(resources).toContain('data-nav-key="knowledge"');
    expect(resources).not.toContain("新建任务");
  });

  it("snapshots desktop, collapsed and narrow navigation layout", () => {
    expect(
      readFileSync(
        new URL("../../styles/command-navigation.css", import.meta.url),
        "utf8",
      ),
    ).toMatchSnapshot();
  });
  it("selects Resources and the plugin without selecting a stale built-in view", () => {
    const modules = [
      { id: "short", label: "AI 短剧", active: true, onOpen: vi.fn() },
    ];
    const rail = renderToStaticMarkup(
      <CommandNavigationRail
        activeView="command"
        hostModuleActive
        collapsed={false}
        locale="zh"
        taskAttentionCount={0}
        onSwitchView={vi.fn()}
        onToggleCollapse={vi.fn()}
        accountMenu={null}
      />,
    );
    const context = renderToStaticMarkup(
      <CommandSidebarNavigation
        activeView="command"
        hostModules={modules}
        locale="zh"
        onNewThread={vi.fn()}
        onSwitchView={vi.fn()}
      />,
    );
    expect(rail.match(/aria-current="page"/g)).toHaveLength(1);
    expect(rail).toMatch(/aria-current="page"[^>]*aria-label="资源"/);
    expect(context).toContain('aria-label="资源导航"');
    expect(context).toContain('aria-label="插件"');
    expect(context).toContain('aria-expanded="true"');
    expect(context).toMatch(
      /aria-current="page"[^>]*data-host-module-target="short"/,
    );
    expect(context.match(/aria-current="page"/g)).toHaveLength(1);
    expect(context).not.toContain("新建任务");
  });
  it("places installed plugin entries directly in the global rail with a book icon and an exclusive selection", () => {
    const markup = renderToStaticMarkup(
      <CommandNavigationRail
        activeView="command"
        hostModuleActive
        collapsed
        locale="zh"
        taskAttentionCount={0}
        plugins={[
          { id: "short", label: "AI 短剧", active: true, onOpen: vi.fn() },
        ]}
        onSwitchView={vi.fn()}
        onToggleCollapse={vi.fn()}
        accountMenu={null}
      />,
    );
    expect(markup).toContain('data-plugin-navigation-target="short"');
    expect(markup).toContain("lucide-book-open");
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatchSnapshot();
  });

  it("keeps installed plugins reachable from the resource directory when inactive", () => {
    const markup = renderToStaticMarkup(
      <CommandSidebarNavigation
        activeView="agents"
        locale="zh"
        hostModules={[
          { id: "short", label: "AI 短剧", active: false, onOpen: vi.fn() },
        ]}
        onNewThread={vi.fn()}
        onSwitchView={vi.fn()}
      />,
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-host-module-target="short"');
    expect(markup).toContain(
      'aria-current="page" class="active" data-nav-key="agents"',
    );
  });
});
