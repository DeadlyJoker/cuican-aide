import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommandShellNotice } from "./AppCommandShellRoute";

describe("CommandShellNotice", () => {
  it("renders command-route failures as a visible dismissible notice", () => {
    const markup = renderToStaticMarkup(
      <CommandShellNotice
        locale="zh"
        notice={{
          text: "没有可用于创建自动化的 Control 任务。",
          tone: "warning",
        }}
        onDismissNotice={() => {}}
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-tone="warning"');
    expect(markup).toContain("没有可用于创建自动化的 Control 任务。");
    expect(markup).toContain('aria-label="关闭通知"');
    expect(markup).toMatchSnapshot();
  });

  it("renders nothing without a notice", () => {
    expect(
      renderToStaticMarkup(
        <CommandShellNotice
          locale="en"
          notice={null}
          onDismissNotice={() => {}}
        />,
      ),
    ).toBe("");
  });
});
