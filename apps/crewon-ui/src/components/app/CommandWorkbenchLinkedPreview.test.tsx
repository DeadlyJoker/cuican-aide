import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CommandWorkbenchBrowser } from "./CommandWorkbenchBrowser";

describe("task-linked browser preview", () => {
  it("opens linked URLs with an explicit source disclaimer and an isolated web frame", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkbenchBrowser
        initialUrl="https://example.com/"
        sourceLabel="资料页"
        active
        instanceId="linked-test"
        locale="zh"
        onNewTab={vi.fn()}
        onTitleChange={vi.fn()}
      />,
    );
    expect(markup).toContain('src="https://example.com/"');
    expect(markup).toContain('data-linked-preview="true"');
    expect(markup).toContain("不会重放 Agent 操作或共享其会话");
    expect(markup).toContain(
      'sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"',
    );
    expect(markup).not.toContain("allow-same-origin");
  });
});
