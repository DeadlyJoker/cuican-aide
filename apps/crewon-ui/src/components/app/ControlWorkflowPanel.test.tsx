import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  RunView,
  WorkflowVersionSummaryView,
  WorkflowVersionView,
} from "@crewon/contracts";

import type { ControlWorkflowAdapter } from "../../lib/workflow/controlWorkflowAdapter";
import { ControlWorkflowPanel } from "./ControlWorkflowPanel";
import {
  ControlWorkflowPanelView,
  type ControlWorkflowPanelViewState,
} from "./ControlWorkflowPanelView";

describe("ControlWorkflowPanel", () => {
  it("snapshots loading, empty, and truthful Control errors", () => {
    const loading = renderState({ catalogState: "loading" });
    const empty = renderState({ catalogState: "ready" });
    const error = renderState({
      catalogState: "unavailable",
      error: "control_workflow_catalog_unavailable",
    });

    expect({ loading, empty, error }).toMatchSnapshot();
    expect(error).toContain("control_workflow_catalog_unavailable");
    expect(error).not.toContain("创建协作流");
  });

  it("snapshots immutable version detail, invalid JSON, and no-thread states", () => {
    const detail = renderState({
      catalogState: "ready",
      selected: workflowVersion(),
      selectedThreadId: "thread-1",
    });
    const invalidJson = renderState({
      catalogState: "ready",
      selected: workflowVersion(),
      selectedThreadId: "thread-1",
      error: "输入必须是有效的严格 JSON。",
    });
    const noThread = renderState({
      catalogState: "ready",
      selected: workflowVersion(),
      selectedThreadId: null,
    });

    expect({ detail, invalidJson, noThread }).toMatchSnapshot();
    expect(detail).toContain("workflow-version-1");
    expect(detail).toContain("Human Gate · 当前不可用");
    expect(detail).not.toContain("批准并继续");
    expect(detail).not.toContain("驳回");
    expect(noThread).toContain("请先打开一个 Control 会话");
  });

  it("snapshots start, SSE, reconnect, terminal, failure, and selection abort", () => {
    const common = {
      catalogState: "ready" as const,
      selected: workflowVersion(),
      selectedThreadId: "thread-1",
    };
    const start = renderState({
      ...common,
      run: workflowRun(),
      streamState: { kind: "connecting" },
    });
    const sse = renderState({
      ...common,
      run: workflowRun({ status: "running", lastSequence: 2 }),
      streamState: { kind: "streaming" },
    });
    const reconnect = renderState({
      ...common,
      run: workflowRun({ status: "running", lastSequence: 2 }),
      streamState: { kind: "reconnecting", attempt: 2, limit: 3 },
    });
    const terminal = renderState({
      ...common,
      run: workflowRun({
        status: "completed",
        lastSequence: 3,
        outputRef: "artifact://delivery",
        terminalAt: "2026-08-13T00:01:00.000Z",
      }),
      streamState: { kind: "terminal" },
    });
    const failure = renderState({
      ...common,
      run: workflowRun({
        status: "failed",
        lastSequence: 3,
        failure: { code: "workflow_node_failed", retryable: false },
        terminalAt: "2026-08-13T00:01:00.000Z",
      }),
      streamState: { kind: "terminal" },
    });
    const selectionAbort = renderState({
      ...common,
      run: null,
      streamState: { kind: "idle" },
    });

    expect({
      start,
      sse,
      reconnect,
      terminal,
      failure,
      selectionAbort,
    }).toMatchSnapshot();
    expect(start).toContain("queued · 排队");
    expect(sse).toContain("running · 运行中");
    expect(reconnect).toContain("重新连接 2/3");
    expect(terminal).toContain("artifact://delivery");
    expect(failure).toContain("workflow_node_failed");
    expect(selectionAbort).not.toContain("data-run-id");
  });

  it("keeps the stateful loading boundary safe during server rendering", () => {
    const adapter = {
      discover: vi.fn(),
      readVersion: vi.fn(),
      start: vi.fn(),
      readRun: vi.fn(),
      events: vi.fn(),
    } as unknown as ControlWorkflowAdapter;
    const markup = renderToStaticMarkup(
      <ControlWorkflowPanel adapter={adapter} selectedThreadId={null} />,
    );

    expect(markup).toContain("正在从 CrewON Control 读取不可变版本目录");
  });
});

function renderState(
  overrides: Partial<ControlWorkflowPanelViewState>,
): string {
  return renderToStaticMarkup(
    <ControlWorkflowPanelView
      state={{
        busy: false,
        catalog: [],
        catalogState: "loading",
        error: null,
        input: "{}",
        run: null,
        selected: null,
        selectedThreadId: null,
        streamState: { kind: "idle" },
        ...overrides,
      }}
      onClose={vi.fn()}
      onInputChange={vi.fn()}
      onOpen={vi.fn()}
      onReload={vi.fn()}
      onStart={vi.fn()}
    />,
  );
}

function workflowSummary(): WorkflowVersionSummaryView {
  return {
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
    name: "交付检查协作流",
    description: "读取风险并保留人工确认边界。",
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

function workflowVersion(): WorkflowVersionView {
  return {
    ...workflowSummary(),
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    entryNodeIds: ["review"],
    outputNodeIds: ["gate"],
    executionOrder: ["review", "gate"],
    nodes: [
      {
        nodeId: "review",
        kind: "agent",
        title: "风险审阅",
        instruction: "读取输入并形成风险清单。",
        dependsOn: [],
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        agentVersionId: "agent-version-1",
      },
      {
        nodeId: "gate",
        kind: "humanGate",
        title: "人工验收",
        instruction: "确认风险清单满足交付口径。",
        dependsOn: ["review"],
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        approvalPolicyId: "approval-policy-1",
      },
    ],
  };
}

function workflowRun(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run-1",
    threadId: "thread-1",
    status: "queued",
    revision: 1,
    lastSequence: 1,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default",
    purpose: "workflow",
    workflowVersionBinding: {
      workflowId: "workflow-1",
      workflowVersionId: "workflow-version-1",
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
    goalBinding: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    terminalAt: null,
    ...overrides,
  };
}
