import {
  DEFAULT_THREAD_GOAL_TOKEN_BUDGET,
  ThreadGoalError,
  settleThreadGoalForRun,
  settleThreadGoalFromAccounting,
  validateThreadGoal,
  validateThreadGoalObjective,
  type RunState,
  type ThreadGoal,
} from "@crewon/domain";

import { canonicalJson } from "./canonical-json.ts";
import type { TurnStartGoalMutation } from "./thread-goal-store-port.ts";

export const GET_GOAL_TOOL_NAME = "get_goal";
export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";

export type GoalToolName =
  | typeof GET_GOAL_TOOL_NAME
  | typeof CREATE_GOAL_TOOL_NAME
  | typeof UPDATE_GOAL_TOOL_NAME;

export type GoalToolEvaluation = Readonly<{
  mutation: TurnStartGoalMutation;
  goalState: ThreadGoal | null;
  output: string;
  isError: boolean;
}>;

const COMPLETION_BUDGET_REPORT =
  "Goal achieved. Report final usage from this tool result's structured goal fields. If `goal.tokenBudget` is present, include token usage from `goal.tokensUsed` and `goal.tokenBudget`. If `goal.timeUsedSeconds` is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language.";
const MAX_GOAL_TOOL_OUTPUT_BYTES = 40_000;

/** Pure Goal Tool evaluator used by every transactional Store authority. */
export function evaluateGoalToolCall(
  current: ThreadGoal | null,
  run: RunState,
  name: GoalToolName,
  input: string,
  occurredAt: string,
  proposedGoalId: string | null = null,
): GoalToolEvaluation {
  if (name === GET_GOAL_TOOL_NAME) {
    if (!isEmptyObjectArguments(input)) {
      return toolError(current, "get_goal_arguments_invalid");
    }
    const output = goalToolResponse(current, false);
    if (output === null) {
      return toolError(current, "goal_tool_output_too_large");
    }
    return {
      mutation: keepGoal(current),
      goalState: current,
      output,
      isError: false,
    };
  }

  if (name === CREATE_GOAL_TOOL_NAME) {
    const creation = parseCreateGoal(input);
    if (creation === null) {
      return toolError(current, "create_goal_arguments_invalid");
    }
    if (run.status !== "running" || run.collaborationMode !== "default") {
      return toolError(current, "create_goal_run_not_default");
    }
    if (current !== null && current.status !== "complete") {
      return toolError(current, "create_goal_unfinished_goal");
    }
    if (proposedGoalId === null) {
      return toolError(current, "create_goal_identity_missing");
    }
    const revision = current === null ? 1 : incrementRevision(current.revision);
    const next: ThreadGoal = {
      schemaVersion: "crewon.thread-goal.v0",
      tenantId: run.tenantId,
      threadId: run.threadId,
      goalId: proposedGoalId,
      revision,
      objective: creation.objective,
      status: "active",
      tokenBudget: creation.tokenBudget ?? DEFAULT_THREAD_GOAL_TOKEN_BUDGET,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    validateThreadGoal(next);
    const output = goalToolResponse(next, false);
    if (output === null) {
      return toolError(current, "goal_tool_output_too_large");
    }
    return {
      mutation: {
        kind: "set",
        expectedRevision: current?.revision ?? null,
        goal: next,
      },
      goalState: next,
      output,
      isError: false,
    };
  }

  const status = parseUpdateStatus(input);
  if (status === null) {
    return toolError(current, "update_goal_arguments_invalid");
  }
  if (
    run.status !== "running" ||
    run.collaborationMode !== "default" ||
    (run.goalAccounting?.attribution ?? run.goalBinding) === null
  ) {
    return toolError(current, "update_goal_run_not_bound");
  }
  if (
    current === null ||
    current.goalId !==
      (run.goalAccounting?.attribution?.goalId ?? run.goalBinding?.goalId) ||
    current.revision !==
      (run.goalAccounting?.attribution?.goalRevision ??
        run.goalBinding?.revision)
  ) {
    return toolError(current, "update_goal_binding_stale");
  }

  const accounted =
    run.goalAccounting === null
      ? settleThreadGoalForRun(current, run, { kind: "completed" }, occurredAt)
      : settleThreadGoalFromAccounting(
          current,
          run,
          { kind: "completed" },
          occurredAt,
        );
  if (accounted === null) {
    return toolError(current, "update_goal_binding_stale");
  }
  const revision =
    accounted === current
      ? incrementRevision(current.revision)
      : accounted.revision;
  const next: ThreadGoal = {
    ...accounted,
    revision,
    status,
    updatedAt: occurredAt,
  };
  validateThreadGoal(next);
  const output = goalToolResponse(next, status === "complete");
  if (output === null) {
    return toolError(current, "goal_tool_output_too_large");
  }
  return {
    mutation: {
      kind: "set",
      expectedRevision: current.revision,
      goal: next,
    },
    goalState: next,
    output,
    isError: false,
  };
}

function goalToolResponse(
  goal: ThreadGoal | null,
  includeCompletionReport: boolean,
): string | null {
  const visibleGoal =
    goal === null
      ? null
      : {
          threadId: goal.threadId,
          objective: goal.objective,
          status: goal.status,
          tokenBudget: goal.tokenBudget,
          tokensUsed: goal.tokensUsed,
          timeUsedSeconds: goal.timeUsedSeconds,
          createdAt: unixSeconds(goal.createdAt),
          updatedAt: unixSeconds(goal.updatedAt),
        };
  const output = canonicalJson({
    goal: visibleGoal,
    remainingTokens:
      goal?.tokenBudget === null || goal === null
        ? null
        : Math.max(0, goal.tokenBudget - goal.tokensUsed),
    completionBudgetReport:
      includeCompletionReport &&
      goal !== null &&
      (goal.tokenBudget !== null || goal.timeUsedSeconds > 0)
        ? COMPLETION_BUDGET_REPORT
        : null,
  });
  return new TextEncoder().encode(output).byteLength <=
    MAX_GOAL_TOOL_OUTPUT_BYTES
    ? output
    : null;
}

function toolError(
  current: ThreadGoal | null,
  code: string,
): GoalToolEvaluation {
  return {
    mutation: keepGoal(current),
    goalState: current,
    output: canonicalJson({ error: code }),
    isError: true,
  };
}

function keepGoal(current: ThreadGoal | null): TurnStartGoalMutation {
  return { kind: "keep", expectedRevision: current?.revision ?? null };
}

function isEmptyObjectArguments(input: string): boolean {
  try {
    const value: unknown = JSON.parse(input);
    return isPlainObject(value) && Object.keys(value).length === 0;
  } catch {
    return false;
  }
}

function parseUpdateStatus(input: string): "complete" | "blocked" | null {
  try {
    const value: unknown = JSON.parse(input);
    if (
      !isPlainObject(value) ||
      Object.keys(value).length !== 1 ||
      (value.status !== "complete" && value.status !== "blocked")
    ) {
      return null;
    }
    return value.status;
  } catch {
    return null;
  }
}

function parseCreateGoal(
  input: string,
): Readonly<{ objective: string; tokenBudget: number | null }> | null {
  try {
    const value: unknown = JSON.parse(input);
    if (
      !isPlainObject(value) ||
      !Object.hasOwn(value, "objective") ||
      Object.keys(value).some(
        (key) => key !== "objective" && key !== "token_budget",
      ) ||
      typeof value.objective !== "string"
    ) {
      return null;
    }
    const objective = value.objective.trim();
    try {
      validateThreadGoalObjective(objective);
    } catch (error) {
      if (!(error instanceof ThreadGoalError)) throw error;
      return null;
    }
    if (!Object.hasOwn(value, "token_budget")) {
      return { objective, tokenBudget: null };
    }
    if (
      !Number.isSafeInteger(value.token_budget) ||
      Number(value.token_budget) < 1
    ) {
      return null;
    }
    return { objective, tokenBudget: Number(value.token_budget) };
  } catch {
    return null;
  }
}

function incrementRevision(revision: number): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) {
    throw new ThreadGoalError("goal_revision_overflow");
  }
  return next;
}

function unixSeconds(timestamp: string): number {
  return Math.floor(Date.parse(timestamp) / 1_000);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
