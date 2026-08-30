import type { RunState } from "@crewon/domain";
import type { ToolDefinition } from "@crewon/tool-broker";

export const GOAL_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: "get_goal",
    description:
      "Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: "create_goal",
    description: `Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.
Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.`,
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string" },
        token_budget: { type: "integer", minimum: 1 },
      },
      required: ["objective"],
      additionalProperties: false,
    },
  },
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: "update_goal",
    description: `Update the existing Goal only to mark it achieved or genuinely blocked.
Complete requires the full objective, every named phase/round/milestone, and every final deliverable to be finished with no required work left. A turn-scoped clause such as "this turn only" or "本轮只做" limits current progress, not the persistent completion scope. If any progress report still names a later phase, future input, final decision, or final deliverable, complete is forbidden. Never invent missing evidence, and do not complete merely because the budget is low or the turn is ending.
Blocked requires the same blocker in at least three consecutive Goal turns, including automatic continuations, with no meaningful progress possible without user input or external change. A resumed Goal starts a fresh three-turn audit. Do not use blocked because work is hard, slow, uncertain, incomplete, or would merely benefit from clarification; once the threshold is met, mark blocked.
Pause, resume, budget-limit, and usage-limit are controlled by the user or system. When completing a budgeted Goal, report final token usage from the tool result.`,
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["complete", "blocked"],
        },
      },
      required: ["status"],
      additionalProperties: false,
    },
  },
];

export function goalToolsForRun(run: RunState): readonly ToolDefinition[] {
  if (run.collaborationMode !== "default") return [];
  return run.goalBinding === null
    ? GOAL_TOOL_DEFINITIONS.filter(({ name }) => name !== "update_goal")
    : GOAL_TOOL_DEFINITIONS.filter(({ name }) => name !== "create_goal");
}

export function isGoalToolCall(call: {
  kind: "function" | "custom";
  name: string;
}): boolean {
  return (
    call.kind === "function" &&
    (call.name === "get_goal" ||
      call.name === "create_goal" ||
      call.name === "update_goal")
  );
}
