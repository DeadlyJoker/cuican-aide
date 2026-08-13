import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandWorkspaceCapabilityDrawer } from "./CommandWorkspaceCapabilityDrawer";

describe("CommandWorkspaceCapabilityDrawer", () => {
  it("only exposes Control-backed read-only workspace tools", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspaceCapabilityDrawer
        locale="zh"
        open
        readonlyThreadId="thread-1"
        onClose={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    expect(markup).toContain("工作区搜索");
    expect(markup).toContain("Git 状态");
    expect(markup).not.toMatch(/终端|浏览器|文件|审阅|应用与插件/);
    expect(markup).toMatchInlineSnapshot(
      `"<aside aria-label=\"工作区工具\" class=\"command-workbench\" data-empty=\"true\"><header class=\"command-workbench-tabbar\"><div class=\"command-workbench-tabs\" role=\"tablist\"><div aria-selected=\"false\" class=\"command-workbench-tab\" role=\"tab\"><button type=\"button\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-search-code\" aria-hidden=\"true\"><path d=\"m13 13.5 2-2.5-2-2.5\"></path><path d=\"m21 21-4.3-4.3\"></path><path d=\"M9 8.5 7 11l2 2.5\"></path><circle cx=\"11\" cy=\"11\" r=\"8\"></circle></svg><span>工作区搜索</span></button></div><div aria-selected=\"false\" class=\"command-workbench-tab\" role=\"tab\"><button type=\"button\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-git-branch\" aria-hidden=\"true\"><line x1=\"6\" x2=\"6\" y1=\"3\" y2=\"15\"></line><circle cx=\"18\" cy=\"6\" r=\"3\"></circle><circle cx=\"6\" cy=\"18\" r=\"3\"></circle><path d=\"M18 9a9 9 0 0 1-9 9\"></path></svg><span>Git 状态</span></button></div></div><div class=\"command-workbench-window-actions\"><button aria-label=\"关闭工作区工具\" class=\"command-workbench-close\" type=\"button\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-panel-right\" aria-hidden=\"true\"><rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"></rect><path d=\"M15 3v18\"></path></svg></button></div></header><div class=\"command-workbench-content\"><div class=\"command-capability-sidebar-empty\"><strong>选择工作区工具</strong><p>搜索工作区内容，或查看当前 Git 状态。</p></div></div></aside>"`,
    );
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

    expect(markup).toContain("Open workspace tools");
    expect(markup).not.toContain("Terminal");
  });
});
