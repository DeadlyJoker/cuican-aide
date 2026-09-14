import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CrewonWorkflowExecution } from "../../lib/workflow/crewonWorkflow";
import { projectWorkflowWorkbench } from "../../lib/workbench/taskWorkbenchProjection";
import {
  TaskWorkbenchActionsContext,
  TaskWorkbenchScope,
} from "../workbench/TaskWorkbenchContext";
import { CommandWorkflowNodeOutputs } from "./CommandWorkflowNodeOutputs";

const execution: CrewonWorkflowExecution = {
  executionId: "meeting-1",
  workflowId: "handoff",
  status: "completed",
  error: null,
  output: "VERDICT: PASS",
  executedNodes: [
    {
      nodeId: "draft",
      nodeType: "agent",
      title: "通知草稿",
      status: "completed",
      output: "## 新版帮助页验收\n\n9月10日14:00，会议链接待主持人补充。",
      error: null,
    },
    {
      nodeId: "gate",
      nodeType: "humanGate",
      title: "负责人确认",
      status: "completed",
      output: "approve",
      error: null,
    },
    {
      nodeId: "verify",
      nodeType: "verification",
      title: "独立验收",
      status: "completed",
      output: "VERDICT: PASS",
      error: null,
    },
  ],
};

describe("CommandWorkflowNodeOutputs", () => {
  it("places the icon-only workbench action below its node output", () => {
    const markup = renderToStaticMarkup(
      <TaskWorkbenchActionsContext.Provider
        value={{ publish() {}, reveal() {}, browse: () => true }}
      >
        <TaskWorkbenchScope
          snapshot={projectWorkflowWorkbench(execution, "通知")}
        >
          <CommandWorkflowNodeOutputs execution={execution} />
        </TaskWorkbenchScope>
      </TaskWorkbenchActionsContext.Provider>,
    );
    expect(markup).toContain('aria-label="复制"');
    expect(markup.indexOf('aria-label="复制"')).toBeGreaterThan(
      markup.indexOf("会议链接待主持人补充"),
    );
    expect(markup).not.toContain(">在工作台查看<");
    expect(markup).not.toContain('aria-label="更多操作"');
    expect(markup).toMatchSnapshot();
  });
  it("retains the real deliverable when final verification only returns PASS", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkflowNodeOutputs execution={execution} />,
    );
    expect(markup).toContain("会议链接待主持人补充");
    expect(markup).toContain('open=""');
    expect(markup).not.toContain("approve");
    expect(markup).not.toContain("VERDICT: PASS");
    expect(markup).toMatchSnapshot();
  });

  it("retains drafts without promoting them to approved delivery on FAIL", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkflowNodeOutputs
        execution={{
          ...execution,
          status: "failed",
          output: "VERDICT: FAIL",
          error: "control_workflow_verification_failed",
        }}
      />,
    );
    expect(markup).toContain("通知草稿");
    expect(markup).toContain("供你核对");
    expect(markup).not.toContain("验收通过");
  });

  it("does not duplicate an already visible business output", () => {
    expect(
      renderToStaticMarkup(
        <CommandWorkflowNodeOutputs
          execution={{
            ...execution,
            output: execution.executedNodes[0]!.output,
          }}
        />,
      ),
    ).toBe("");
  });

  it("never presents partial failed or running node text as a completed output", () => {
    for (const status of ["running", "failed", "canceled"]) {
      const nodes = execution.executedNodes.map((node) => ({
        ...node,
        status,
      }));
      expect(
        renderToStaticMarkup(
          <CommandWorkflowNodeOutputs
            execution={{ ...execution, executedNodes: nodes }}
          />,
        ),
      ).toBe("");
    }
  });
});
