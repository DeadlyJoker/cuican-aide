import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandWorkflowPanel } from "./CommandWorkflowPanel";

describe("CommandWorkflowPanel", () => {
  it("snapshots the design-aligned real Workflow list", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkflowPanel
        workflows={[
          {
            id: 42,
            name: "需求风险分析",
            description: "分析输入并返回交付风险清单",
            status: "ready",
            is_active: true,
            resource_source: "online",
            nodes: [
              { id: "review", name: "需求审阅", agent_name: "产品审阅智能体" },
              {
                id: "delivery",
                name: "交付检查",
                agent_name: "开发交付智能体",
              },
            ],
          },
          {
            id: 43,
            name: "交付验收协作流",
            description: "串联需求审阅、实现检查和人工验收。",
            is_active: true,
            resource_source: "online",
          },
        ]}
        onReload={vi.fn(async () => undefined)}
        onRun={vi.fn()}
      />,
    );

    expect(markup).toContain('class="workflow-list"');
    expect(markup).toContain("进入群聊");
    expect(markup).toContain("交付验收协作流");
    expect(markup).toContain("产品审阅智能体");
    expect(markup).toContain("2 成员");
    expect(markup).not.toContain("/repo");
    expect(markup).not.toContain("本地工作空间");
    expect(markup).toMatchSnapshot();
  });

  it("snapshots the design-aligned Workflow room with real execution", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkflowPanel
        defaultOpenWorkflowId={42}
        workflows={[
          {
            id: 42,
            name: "需求风险分析",
            description: "分析输入并返回交付风险清单",
            status: "ready",
            is_active: true,
            resource_source: "online",
            nodes: [
              { id: "review", name: "需求审阅", agent_name: "产品审阅智能体" },
              {
                id: "delivery",
                name: "交付检查",
                agent_name: "开发交付智能体",
              },
            ],
          },
        ]}
        onReload={vi.fn(async () => undefined)}
        onRun={vi.fn()}
      />,
    );

    expect(markup).toContain(
      'class="workflow-room-inline workflow-runtime-room"',
    );
    expect(markup).toContain("返回");
    expect(markup).toContain("协作流群聊");
    expect(markup).toContain("workflow-execution-strip");
    expect(markup).toContain("workflow-global-composer");
    expect(markup).toContain("需求审阅");
    expect(markup).not.toContain("模拟阶段");
    expect(markup).toMatchSnapshot();
  });

  it("does not turn catalog-only definitions into runnable workflows", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkflowPanel
        workflows={[
          {
            id: 43,
            name: "目录演示协作流",
            is_active: true,
            resource_source: "catalog",
          },
        ]}
        onReload={vi.fn(async () => undefined)}
        onRun={vi.fn()}
      />,
    );

    expect(markup).toContain("当前账号没有可运行的协作流");
    expect(markup).not.toContain("目录演示协作流");
    expect(markup).toMatchSnapshot();
  });
});
