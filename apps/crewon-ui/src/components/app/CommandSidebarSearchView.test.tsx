import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "radix-ui";
import { describe, expect, it, vi } from "vitest";
import {
  CommandSearchContent,
  CommandSidebarSearchView,
} from "./CommandSidebarSearchView";

const props = {
  locale: "zh" as const,
  noMatches: "没有匹配的对话或能力",
  query: "",
  results: [
    {
      action: "thread" as const,
      key: "thread:1",
      threadId: "1",
      title: "讨论 <script> 与接口",
      detail: "cuican-aide / UI",
      kind: "对话",
    },
    {
      action: "view" as const,
      key: "view:team",
      view: "team" as const,
      title: "团队",
      detail: "办公室与协作流",
      kind: "功能",
    },
  ],
  searchLabel: "搜索对话和能力",
  searchResultsLabel: "搜索结果",
  shortcutLabel: "⌘K",
  triggerRef: { current: null },
  onActivate: vi.fn(),
  onClose: vi.fn(),
  onQueryChange: vi.fn(),
};

describe("window search dialog", () => {
  it("renders an accessible modal with input-owned keyboard selection and escaped results", () => {
    const markup = renderToStaticMarkup(
      <Dialog.Root open>
        <CommandSearchContent {...props} />
      </Dialog.Root>,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    const activeId = markup.match(/aria-activedescendant="([^"]+)"/)?.[1];
    expect(activeId).toBeTruthy();
    expect(markup).toContain(`tabindex="-1" id="${activeId}"`);
    expect(markup).toContain('aria-label="关闭搜索"');
    expect(markup).toContain(
      'role="option" aria-selected="true" tabindex="-1"',
    );
    expect(markup).toContain("讨论 &lt;script&gt; 与接口");
    expect(markup).toMatchSnapshot();
  });
  it("announces an empty result without a stale active descendant", () => {
    const markup = renderToStaticMarkup(
      <Dialog.Root open>
        <CommandSearchContent {...props} query="不存在" results={[]} />
      </Dialog.Root>,
    );
    expect(markup).toContain('role="status">没有匹配的对话或能力');
    expect(markup).not.toContain("aria-activedescendant=");
    expect(markup).not.toContain('role="option"');
  });
  it("keeps closed search out of the sidebar markup", () => {
    expect(
      renderToStaticMarkup(
        <CommandSidebarSearchView {...props} isSearchOpen={false} />,
      ),
    ).toBe("");
  });
});
