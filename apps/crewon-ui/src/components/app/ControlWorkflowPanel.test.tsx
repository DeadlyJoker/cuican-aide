import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ControlWorkflowAdapter } from "../../lib/workflow/controlWorkflowAdapter";
import { ControlWorkflowPanel } from "./ControlWorkflowPanel";

describe("ControlWorkflowPanel", () => {
  it("snapshots the honest Control loading boundary", () => {
    const adapter = {
      discover: vi.fn(),
      readVersion: vi.fn(),
      start: vi.fn(),
      readRun: vi.fn(),
      cancel: vi.fn(),
      events: vi.fn(),
    } as unknown as ControlWorkflowAdapter;
    const markup = renderToStaticMarkup(
      <ControlWorkflowPanel adapter={adapter} selectedThreadId={null} />,
    );
    expect(markup).toContain("正在从 CrewON Control 读取不可变版本目录");
    expect(markup).not.toContain("Human Gate · 等待人工确认");
    expect(markup).not.toContain("创建协作流");
    expect(markup).toMatchSnapshot();
  });
});
