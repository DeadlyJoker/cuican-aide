import { describe, expect, it } from "vitest";

import { crewonWorkflowConfigFromValue } from "./crewonWorkflow";
import { workflowRecordsWithRuntimeUpdate } from "./crewonWorkflow";

describe("crewonWorkflowConfigFromValue", () => {
  it("accepts a persisted local workflow run", () => {
    const config = crewonWorkflowConfigFromValue({
      workflowId: "workflow-1",
      name: "Delivery",
      description: "Review and deliver",
      lead: "Reviewer",
      status: "ready",
      resourceSource: "crewon",
      createdAt: 1,
      updatedAt: 2,
      nodes: [
        {
          nodeId: "node-1",
          title: "Review",
          agentId: "agent-reviewer",
          agentName: "Reviewer",
          instruction: "Review the input",
        },
        {
          nodeId: "node-2",
          type: "humanGate",
          title: "Approve delivery",
          instruction: "Confirm the delivery scope",
        },
      ],
      runs: [
        {
          executionId: "run-1",
          status: "completed",
          input: "input",
          output: "done",
          error: null,
          createdAt: 1,
          updatedAt: 2,
          executedNodes: [
            {
              nodeId: "node-1",
              title: "Review",
              agentId: "agent-reviewer",
              agentName: "Reviewer",
              status: "completed",
              input: "input",
              output: "done",
              error: null,
              threadId: "thread-1",
              turnId: "turn-1",
              startedAt: 1,
              completedAt: 2,
            },
            {
              nodeId: "node-2",
              nodeType: "humanGate",
              title: "Approve delivery",
              agentId: null,
              status: "completed",
              input: "done",
              output: "done\n\nHuman gate approved",
              error: null,
              threadId: null,
              turnId: null,
              startedAt: 2,
              completedAt: 3,
            },
          ],
        },
      ],
    });

    expect(config?.runs?.[0]?.executedNodes[0]?.threadId).toBe("thread-1");
    expect(config?.nodes[1]?.type).toBe("humanGate");
    expect(config?.runs?.[0]?.executedNodes[1]?.agentId).toBeNull();
  });

  it("fails closed for non-CrewON or malformed runtime updates", () => {
    expect(
      crewonWorkflowConfigFromValue({
        workflowId: "workflow-1",
        resourceSource: "pim",
      }),
    ).toBeNull();
    expect(
      crewonWorkflowConfigFromValue({
        workflowId: "workflow-1",
        name: "Delivery",
        description: "Review and deliver",
        lead: "Reviewer",
        status: "running",
        resourceSource: "crewon",
        createdAt: 1,
        updatedAt: 2,
        nodes: [],
        runs: [{ executedNodes: "not-an-array" }],
      }),
    ).toBeNull();
  });

  it("replaces only the matching local workflow record", () => {
    const original = crewonWorkflowConfigFromValue({
      workflowId: "workflow-1",
      name: "Delivery",
      description: "Review and deliver",
      lead: "Reviewer",
      status: "running",
      resourceSource: "crewon",
      createdAt: 1,
      updatedAt: 1,
      nodes: [],
      runs: [],
    });
    const completed = crewonWorkflowConfigFromValue({
      ...original!,
      status: "ready",
      updatedAt: 2,
    });
    expect(original).not.toBeNull();
    expect(completed).not.toBeNull();
    const records = [
      {
        filePath: "/repo/.crewon/workflows/workflow-1.json",
        savedAt: "2026-08-05T00:00:00Z",
        config: original!,
      },
    ];

    expect(
      workflowRecordsWithRuntimeUpdate(records, {
        filePath: records[0].filePath,
        config: completed,
      })[0]?.config.status,
    ).toBe("ready");
    expect(
      workflowRecordsWithRuntimeUpdate(records, {
        filePath: records[0].filePath,
        config: { resourceSource: "pim" },
      }),
    ).toBe(records);
  });
});
