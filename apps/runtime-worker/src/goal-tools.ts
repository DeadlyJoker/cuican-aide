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
    description: `Update the existing goal.
Use this tool only to mark the goal achieved or genuinely blocked.
Set status to complete only when the objective has actually been achieved and no required work remains.
Set status to blocked only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.
If the user resumes a goal that was previously marked blocked, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to blocked again.
Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to blocked.
Do not use blocked merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.
Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.
You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.
When marking a budgeted goal achieved with status complete, report the final token usage from the tool result to the user.`,
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
    : GOAL_TOOL_DEFINITIONS;
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
