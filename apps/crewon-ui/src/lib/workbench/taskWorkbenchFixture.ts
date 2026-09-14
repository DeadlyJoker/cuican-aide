import type { CrewonWorkflowExecution } from "../workflow/crewonWorkflow";

/** Deterministic business fixture used only by workbench tests. */
export const workflowFixture: CrewonWorkflowExecution = {
  workflowId: "notice",
  executionId: "meeting-a",
  status: "completed",
  error: null,
  output: "VERDICT: PASS",
  executedNodes: [
    {
      nodeId: "draft",
      nodeType: "agent",
      title: "通知草稿",
      status: "completed",
      output:
        "## 试点复盘\n9月12日15:00；入会链接待补充。资料页 [示例](https://example.com/)。",
      error: null,
    },
    {
      nodeId: "gate",
      nodeType: "humanGate",
      title: "人工确认",
      status: "completed",
      output: "approve",
      error: null,
    },
    {
      nodeId: "verdict",
      nodeType: "verification",
      title: "核验",
      status: "completed",
      output: "VERDICT: PASS",
      error: null,
    },
  ],
};
