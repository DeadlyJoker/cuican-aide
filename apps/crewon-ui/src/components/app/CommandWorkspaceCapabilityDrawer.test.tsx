import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandWorkspaceCapabilityDrawer } from "./CommandWorkspaceCapabilityDrawer";

describe("CommandWorkspaceCapabilityDrawer", () => {
  it("exposes a real task board and Control-backed read-only workspace tools", () => {
    const onOpenApps = vi.fn();
    const markup = renderToStaticMarkup(
      <CommandWorkspaceCapabilityDrawer
        locale="zh"
        open
        readonlyThreadId="thread-1"
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onOpenApps={onOpenApps}
      />,
    );

    expect(markup).toContain("任务看板");
    expect(markup).toContain("打开工作台工具");
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-valuemin="360"');
    expect(markup).toContain('aria-valuemax="648"');
    expect(markup).toContain("最大化工作台");
    expect(markup).toContain("关闭 任务看板");
    expect(markup).toMatchSnapshot();
  });

  it("renders the compact Control tool trigger while closed", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspaceCapabilityDrawer
        locale="en"
        open={false}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onOpenApps={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Workbench apps"');
    expect(markup).toContain('aria-label="Task board"');
    expect(markup).toContain('aria-label="Files and search"');
    expect(markup).toContain('aria-label="Review"');
    expect(markup).toContain('aria-label="Terminal"');
    expect(markup).toContain('aria-label="Browser"');
    expect(markup).toContain('aria-label="Apps and plugins"');
  });
});
