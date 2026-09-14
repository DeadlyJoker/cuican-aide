import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CrewonWorkflowRecord } from "../../lib/workflow/crewonWorkflow";
import {
  CommandWorkflowPanel,
  workflowControlPresentation,
} from "./CommandWorkflowPanel";

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
      lead: nodes[0] && "agentName" in nodes[0] ? nodes[0].agentName : "CrewON",
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
  it("keeps cancel available while Gate resolution waits on verification", () => {
    expect(
      workflowControlPresentation({ gateBusy: true, cancelBusy: false }),
    ).toEqual({
      cancelDisabled: false,
      cancelLabel: "取消运行",
      gateDisabled: true,
    });
    expect(
      workflowControlPresentation({ gateBusy: true, cancelBusy: true }),
    ).toEqual({
      cancelDisabled: true,
      cancelLabel: "取消中…",
      gateDisabled: true,
    });
  });

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
    expect(markup).toContain("团队协作");
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

    expect(markup).toContain("暂时无法打开协作流");
    expect(markup).toContain('class="command-team-empty-state"');
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

    expect(markup).toContain("等待你确认");
    expect(markup).toContain("批准并继续");
    expect(markup).toContain("驳回并结束");
    expect(markup).toContain("取消运行");
    expect(markup).not.toContain("云端节点");
    expect(markup).toMatchSnapshot();

    const refreshingMarkup = renderToStaticMarkup(
      <CommandWorkflowPanel
        defaultOpenWorkflowId="workflow-gate"
        status="loading"
        workflows={[workflow]}
        onCancel={vi.fn()}
        onReload={vi.fn(async () => undefined)}
        onResolveGate={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(refreshingMarkup).toContain("workflow-runtime-room");
    expect(refreshingMarkup).toContain("带人工验收的交付流");
    expect(refreshingMarkup).not.toContain("正在读取协作流");
  });

  it("renders a completed result as readable Markdown without exposing run ids", () => {
    const workflow = workflowRecord(
      "workflow-complete",
      "上线验收",
      "核对上线结果。",
      reviewNodes,
    );
    workflow.config.status = "completed";
    workflow.config.runs = [
      {
        executionId: "internal-run-42",
        status: "completed",
        input: "给我最终验收结论",
        output:
          "### 验收结论\n\n已完成全部检查。\n\n- 登录正常\n- 核心流程正常",
        error: null,
        createdAt: 1,
        updatedAt: 2,
        executedNodes: reviewNodes.map((node) => ({
          nodeId: node.nodeId,
          nodeType: "agent" as const,
          title: node.title,
          agentId: "agentId" in node ? node.agentId : null,
          agentName: "agentName" in node ? node.agentName : undefined,
          status: "completed" as const,
          output: "检查完成",
          error: null,
        })),
      },
    ];

    const markup = renderToStaticMarkup(
      <CommandWorkflowPanel
        defaultOpenWorkflowId="workflow-complete"
        status="ready"
        workflows={[workflow]}
        onCancel={vi.fn()}
        onReload={vi.fn(async () => undefined)}
        onResolveGate={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    expect(markup).toContain("<h3>验收结论</h3>");
    expect(markup).toContain("<li>登录正常</li>");
    expect(markup).toContain("本次协作 · 已完成");
    expect(markup).not.toContain("internal-run-42");
    expect(markup).not.toContain("### 验收结论");
    expect(markup).toMatchSnapshot();
  });

  it("does not retain Gate actions or a waiting stage after cancellation", () => {
    const workflow = workflowRecord(
      "workflow-canceled-gate",
      "已取消的人工验收流",
      "取消后不能继续审批。",
      [
        ...reviewNodes.slice(0, 1),
        {
          nodeId: "approval",
          type: "humanGate" as const,
          title: "人工验收",
          instruction: "确认结果。",
        },
      ],
    );
    workflow.config.status = "canceled";
    workflow.config.runs = [
      {
        executionId: "workflow-run-canceled",
        status: "canceled",
        input: "检查后取消",
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
            status: "completed",
            output: "已完成审阅",
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
        defaultOpenWorkflowId="workflow-canceled-gate"
        status="ready"
        workflows={[workflow]}
        onCancel={vi.fn()}
        onReload={vi.fn(async () => undefined)}
        onResolveGate={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    expect(markup).toContain("协作已取消，后续步骤不会继续");
    expect(markup).toContain("已取消");
    expect(markup).not.toContain("等待你确认");
    expect(markup).not.toContain("批准并继续");
    expect(markup).not.toContain("驳回并结束");
    expect(markup).not.toContain('aria-label="确认环节"');
    expect(markup).toMatchSnapshot();

    const canceledRun = workflow.config.runs[0]!;
    workflow.config.status = "failed";
    workflow.config.runs = [
      {
        ...canceledRun,
        status: "failed",
        error: "workflow_gate_rejected",
        executedNodes: canceledRun.executedNodes.map((node) =>
          node.nodeId === "approval"
            ? { ...node, status: "rejected", output: "reject" }
            : node,
        ),
      },
    ];
    const rejectedMarkup = renderToStaticMarkup(
      <CommandWorkflowPanel
        defaultOpenWorkflowId="workflow-canceled-gate"
        status="ready"
        workflows={[workflow]}
        onCancel={vi.fn()}
        onReload={vi.fn(async () => undefined)}
        onResolveGate={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(rejectedMarkup).toContain("人工确认已驳回，协作流已结束");
    expect(rejectedMarkup).not.toContain("workflow_gate_rejected");
  });

  it("shows a readable verification failure while preserving its detailed output", () => {
    const workflow = workflowRecord(
      "workflow-verification-failed",
      "独立验收流",
      "独立验证发布证据。",
      [
        ...reviewNodes.slice(0, 1),
        {
          nodeId: "verification",
          type: "verification" as const,
          title: "独立验证",
          agentId: "agent-verifier",
          agentName: "独立验证成员",
          instruction: "给出明确判定。",
        },
      ],
    );
    workflow.config.status = "failed";
    workflow.config.runs = [
      {
        executionId: "workflow-run-verification-failed",
        status: "failed",
        input: "验证本次发布",
        output: "### 验证详情\n\nVERDICT: FAIL\n\n- 缺少回滚证据\n- 不允许发布",
        error: "control_workflow_verification_failed",
        createdAt: 1,
        updatedAt: 2,
        executedNodes: [
          {
            nodeId: "review",
            nodeType: "agent",
            title: "需求审阅",
            agentId: "agent-product-review",
            status: "completed",
            output: "已完成审阅",
            error: null,
          },
          {
            nodeId: "verification",
            nodeType: "verification",
            title: "独立验证",
            agentId: "agent-verifier",
            status: "failed",
            output: "VERDICT: FAIL",
            error: "control_workflow_verification_failed",
          },
        ],
      },
    ];

    const markup = renderToStaticMarkup(
      <CommandWorkflowPanel
        defaultOpenWorkflowId="workflow-verification-failed"
        status="ready"
        workflows={[workflow]}
        onCancel={vi.fn()}
        onReload={vi.fn(async () => undefined)}
        onResolveGate={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    expect(markup).toContain("独立验证未通过");
    expect(markup).toContain("缺少回滚证据");
    expect(markup).toContain("不允许发布");
    expect(markup).not.toContain("control_workflow_verification_failed");
    expect(markup).toMatchSnapshot();

    workflow.config.runs = [
      {
        ...workflow.config.runs[0]!,
        output: "验证成员没有返回协议要求的 verdict。",
        error: "control_workflow_verification_invalid",
      },
    ];
    const invalidMarkup = renderToStaticMarkup(
      <CommandWorkflowPanel
        defaultOpenWorkflowId="workflow-verification-failed"
        status="ready"
        workflows={[workflow]}
        onCancel={vi.fn()}
        onReload={vi.fn(async () => undefined)}
        onResolveGate={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(invalidMarkup).toContain("没有返回唯一且合法的结论");
    expect(invalidMarkup).toContain("没有返回协议要求的 verdict");
    expect(invalidMarkup).not.toContain(
      "control_workflow_verification_invalid",
    );
  });
});
