import {
  MAX_RUN_PLAN_EXPLANATION_CHARS,
  MAX_RUN_PLAN_ITEMS,
  MAX_RUN_PLAN_TITLE_CHARS,
  RUN_PLAN_ITEM_ID_PATTERN_SOURCE,
  type RunState,
} from "@crewon/domain";
import type { ToolDefinition } from "@crewon/tool-broker";

export const UPDATE_PLAN_TOOL_NAME = "update_plan";

const RUN_PLAN_TOOL_DEFINITION: ToolDefinition = {
  schemaVersion: "crewon.tool-definition.v0",
  kind: "function",
  name: UPDATE_PLAN_TOOL_NAME,
  description: `Maintain the execution checklist for the current Run.
Use this for multi-step work. Create the plan before substantial execution, then update it whenever a step changes state. Keep stable item IDs and at most one item in_progress. Do not use this tool for a simple one-step task or for a read-only Plan-mode proposal.`,
  execution: "serial",
  inputSchema: {
    type: "object",
    properties: {
      explanation: {
        anyOf: [
          {
            type: "string",
            minLength: 1,
            maxLength: MAX_RUN_PLAN_EXPLANATION_CHARS,
          },
          { type: "null" },
        ],
      },
      items: {
        type: "array",
        minItems: 1,
        maxItems: MAX_RUN_PLAN_ITEMS,
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              minLength: 1,
              maxLength: 64,
              pattern: RUN_PLAN_ITEM_ID_PATTERN_SOURCE,
            },
            title: {
              type: "string",
              minLength: 1,
              maxLength: MAX_RUN_PLAN_TITLE_CHARS,
            },
            status: {
              type: "string",
              enum: [
                "pending",
                "in_progress",
                "completed",
                "blocked",
                "canceled",
              ],
            },
          },
          required: ["id", "title", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

export function runPlanToolsForRun(
  run: RunState,
): readonly ToolDefinition[] {
  return run.collaborationMode === "default" &&
    (run.purpose ?? "turn") === "turn"
    ? [RUN_PLAN_TOOL_DEFINITION]
    : [];
}

export function isRunPlanToolCall(call: {
  kind: "function" | "custom";
  name: string;
}): call is { kind: "function"; name: typeof UPDATE_PLAN_TOOL_NAME } {
  return call.kind === "function" && call.name === UPDATE_PLAN_TOOL_NAME;
}
