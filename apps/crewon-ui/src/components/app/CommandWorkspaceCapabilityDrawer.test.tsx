import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandWorkspaceCapabilityDrawer } from "./CommandWorkspaceCapabilityDrawer";

describe("CommandWorkspaceCapabilityDrawer", () => {
  it("exposes a real task board and Control-backed read-only workspace tools", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspaceCapabilityDrawer
        locale="zh"
        open
        readonlyThreadId="thread-1"
        onClose={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    expect(markup).toContain("任务看板");
    expect(markup).toContain("工作区搜索");
    expect(markup).toContain("Git 状态");
    expect(markup).not.toMatch(/终端|浏览器|文件|审阅|应用与插件/);
    expect(markup).toMatchSnapshot();
  });

  it("renders the compact Control tool trigger while closed", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspaceCapabilityDrawer
        locale="en"
        open={false}
        onClose={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Workbench apps"');
    expect(markup).toContain('aria-label="Task board"');
    expect(markup).toContain('aria-label="Workspace search"');
    expect(markup).toContain('aria-label="Git status"');
    expect(markup).not.toContain("Terminal");
  });
});
