import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CrewonWorkflowRecord } from "../../lib/workflow/crewonWorkflow";
import { CommandWorkflowPanel } from "./CommandWorkflowPanel";

function workflowRecord(
  workflowId: string,
  name: string,
  description: string,
  nodes: CrewonWorkflowRecord["config"]["nodes"],
): CrewonWorkflowRecord {
  return {
    filePath: `/repo/.crewon/workflows/${workflowId}.json`,
    savedAt: "2026-08-05T00:00:00Z",
    config: {
      workflowId,
      name,
      description,
      lead:
        nodes[0] && "agentName" in nodes[0]
          ? nodes[0].agentName
          : "CrewON",
      status: "ready",
      resourceSource: "crewon",
      createdAt: 1,
      updatedAt: 1,
      nodes,
      runs: [],
    },
  };
}

const reviewNodes: CrewonWorkflowRecord["config"]["nodes"] = [
  {
    nodeId: "review",
    title: "需求审阅",
    agentId: "agent-product-review",
    agentName: "产品审阅智能体",
    instruction: "审阅需求",
  },
  {
    nodeId: "delivery",
    title: "交付检查",
    agentId: "agent-delivery",
    agentName: "开发交付智能体",
    instruction: "检查交付",
  },
];

describe("CommandWorkflowPanel", () => {
  it("snapshots the design-aligned local Workflow list", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkflowPanel
        status="ready"
        workflows={[
          workflowRecord(
            "workflow-42",
            "需求风险分析",
            "分析输入并返回交付风险清单",
            reviewNodes,
          ),
          workflowRecord(
            "workflow-43",
            "交付验收协作流",
            "串联需求审阅、实现检查和人工验收。",
            reviewNodes.slice(0, 1),
          ),
        ]}
        onCancel={vi.fn()}
        onReload={vi.fn(async () => undefined)}
        onResolveGate={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    expect(markup).toContain('class="workflow-list"');
    expect(markup).toContain("进入群聊");
    expect(markup).toContain("交付验收协作流");
    expect(markup).toContain("产品审阅智能体");
    expect(markup).toContain("2 成员");
    expect(markup).not.toContain("PIM");
    expect(markup).toMatchSnapshot();
  });

  it("snapshots the local Workflow room", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkflowPanel
        defaultOpenWorkflowId="workflow-42"
        status="ready"
        workflows={[
          workflowRecord(
            "workflow-42",
            "需求风险分析",
            "分析输入并返回交付风险清单",
            reviewNodes,
          ),
        ]}
        onCancel={vi.fn()}
        onReload={vi.fn(async () => undefined)}
        onResolveGate={vi.fn()}
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

  it("shows the unavailable local service state without catalog fallbacks", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkflowPanel
        status="unavailable"
        workflows={[]}
        onCancel={vi.fn()}
        onReload={vi.fn(async () => undefined)}
        onResolveGate={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    expect(markup).toContain("协作流服务暂不可用");
    expect(markup).not.toContain("目录演示协作流");
    expect(markup).toMatchSnapshot();
  });

  it("snapshots a persisted Human Gate with approve, reject, and cancel controls", () => {
    const workflow = workflowRecord(
      "workflow-gate",
      "带人工验收的交付流",
      "本地 Agent 完成后等待人工确认。",
      [
        ...reviewNodes,
        {
          nodeId: "approval",
          type: "humanGate" as const,
          title: "人工验收",
          instruction: "确认风险清单是否满足交付口径。",
        },
      ],
    );
    workflow.config.status = "waitingForApproval";
    workflow.config.runs = [
      {
        executionId: "workflow-run-gate",
        status: "waitingForApproval",
        input: "检查交付风险",
        output: "",
        error: null,
        createdAt: 1,
        updatedAt: 2,
        executedNodes: [
          {
            nodeId: "review",
            nodeType: "agent",
            title: "需求审阅",
            agentId: "agent-product-review",
            agentName: "产品审阅智能体",
            status: "completed",
            output: "风险清单",
            error: null,
          },
          {
            nodeId: "delivery",
            nodeType: "agent",
            title: "交付检查",
            agentId: "agent-delivery",
            agentName: "开发交付智能体",
            status: "completed",
            output: "交付检查通过",
            error: null,
          },
          {
            nodeId: "approval",
            nodeType: "humanGate",
            title: "人工验收",
            agentId: null,
            status: "waitingForApproval",
            output: "",
            error: null,
          },
        ],
      },
    ];

    const markup = renderToStaticMarkup(
      <CommandWorkflowPanel
        defaultOpenWorkflowId="workflow-gate"
        status="ready"
        workflows={[workflow]}
        onCancel={vi.fn()}
        onReload={vi.fn(async () => undefined)}
        onResolveGate={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    expect(markup).toContain("Human Gate · 等待人工确认");
    expect(markup).toContain("批准并继续");
    expect(markup).toContain("驳回并结束");
    expect(markup).toContain("取消运行");
    expect(markup).not.toContain("云端节点");
    expect(markup).toMatchSnapshot();
  });
});
