import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "radix-ui";
import { describe, expect, it, vi } from "vitest";
import {
  CommandSearchContent,
  CommandSidebarSearchView,
} from "./CommandSidebarSearchView";
import { CommandSearchCatalogNavigation } from "./CommandSearchCatalogNavigation";

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
    expect(markup).toContain('maxLength="256"');
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
  it.each([
    { loading: true, failed: false, canContinue: false },
    { loading: false, failed: true, canContinue: false },
    { loading: false, failed: false, canContinue: true },
  ])(
    "does not announce a false empty result while the catalog is pending",
    (state) => {
      const markup = renderToStaticMarkup(
        <Dialog.Root open>
          <CommandSearchContent {...props} {...state} results={[]} />
        </Dialog.Root>,
      );
      expect(markup).not.toContain('data-search-empty=""');
    },
  );
  it("preserves the catalog retry and page controls in the centered dialog", () => {
    const markup = renderToStaticMarkup(
      <Dialog.Root open>
        <CommandSearchContent
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
                hasNewer: false,
                onOlder: vi.fn(),
                onNewer: vi.fn(),
                onRefresh: vi.fn(),
              }}
            />
          }
        />
      </Dialog.Root>,
    );
    expect(markup).toContain("读取失败，请重试");
    expect(markup).toContain("下一页");
    expect(markup).toContain("重试");
    expect(markup).not.toContain("最新");
    expect(markup).not.toContain("较新");
    expect(markup).not.toContain("较早");
    expect(markup).not.toContain('data-search-empty=""');
  });
  it("shows only meaningful result page actions without the old generic controls", () => {
    const markup = renderToStaticMarkup(
      <Dialog.Root open>
        <CommandSearchContent
          {...props}
          footer={
            <CommandSearchCatalogNavigation
              locale="zh"
              navigation={{
                loading: false,
                failed: false,
                empty: false,
                searching: true,
                hasOlder: true,
                hasNewer: true,
                onOlder: vi.fn(),
                onNewer: vi.fn(),
                onRefresh: vi.fn(),
              }}
            />
          }
        />
      </Dialog.Root>,
    );
    expect(markup).toContain("上一页");
    expect(markup).toContain("下一页");
    expect(markup).not.toContain("最新");
    expect(markup).not.toContain("较新");
    expect(markup).not.toContain("较早");
    expect(markup).not.toContain("重试");
    expect(markup).toMatchSnapshot();
  });
  it("omits catalog controls when there is only one loaded result page", () => {
    expect(
      renderToStaticMarkup(
        <CommandSearchCatalogNavigation
          locale="zh"
          navigation={{
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
        />,
      ),
    ).toBe("");
  });
  it("blocks result page navigation while the current read is pending", () => {
    const markup = renderToStaticMarkup(
      <CommandSearchCatalogNavigation
        locale="zh"
        navigation={{
          loading: true,
          failed: false,
          empty: false,
          searching: true,
          hasOlder: true,
          hasNewer: true,
          onOlder: vi.fn(),
          onNewer: vi.fn(),
          onRefresh: vi.fn(),
        }}
      />,
    );
    expect(markup).toContain("正在读取会话…");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).not.toContain("重试");
  });
});
