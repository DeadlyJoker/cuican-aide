import {
  RunPlanError,
  sameRunPlanContent,
  type RunPlan,
  type RunPlanItem,
  validateRunPlan,
} from "@crewon/domain";

import { canonicalJson } from "./canonical-json.ts";

export const UPDATE_PLAN_TOOL_NAME = "update_plan";

export type RunPlanToolEvaluation = Readonly<{
  changed: boolean;
  isError: boolean;
  output: string;
  plan: RunPlan | null;
}>;

/** Pure evaluator for the server-owned Run Plan tool. */
export function evaluateRunPlanToolCall(
  current: RunPlan | null,
  runId: string,
  input: string,
  occurredAt: string,
): RunPlanToolEvaluation {
  const content = parseRunPlanToolInput(input);
  if (content === null) {
    return toolError(current, "update_plan_arguments_invalid");
  }
  const plan: RunPlan = {
    schemaVersion: "crewon.run-plan.v0",
    planId: runId,
    revision: (current?.revision ?? 0) + 1,
    explanation: content.explanation,
    items: content.items,
    createdAt: current?.createdAt ?? occurredAt,
    updatedAt: occurredAt,
  };
  try {
    validateRunPlan(plan);
  } catch (error) {
    return toolError(
      current,
      error instanceof RunPlanError ? error.code : "run_plan_invalid",
    );
  }
  if (current !== null && sameRunPlanContent(current, plan)) {
    return success(current, false);
  }
  return success(plan, true);
}

function parseRunPlanToolInput(
  input: string,
): Readonly<{
  explanation: string | null;
  items: readonly RunPlanItem[];
}> | null {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return null;
  }
  if (
    !isPlainObject(value) ||
    !Object.hasOwn(value, "items") ||
    Object.keys(value).some(
      (key) => key !== "explanation" && key !== "items",
    ) ||
    !Array.isArray(value.items)
  ) {
    return null;
  }
  const explanation = Object.hasOwn(value, "explanation")
    ? value.explanation
    : null;
  if (explanation !== null && typeof explanation !== "string") {
    return null;
  }
  const items: RunPlanItem[] = [];
  for (const item of value.items) {
    if (
      !isPlainObject(item) ||
      !hasExactKeys(item, ["id", "status", "title"]) ||
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.status !== "string"
    ) {
      return null;
    }
    const status = parseToolStatus(item.status);
    if (status === null) return null;
    items.push({
      itemId: item.id.trim(),
      title: item.title.trim(),
      status,
    });
  }
  return {
    explanation: explanation === null ? null : explanation.trim(),
    items,
  };
}

function parseToolStatus(value: string): RunPlanItem["status"] | null {
  switch (value) {
    case "pending":
    case "completed":
    case "blocked":
    case "canceled":
      return value;
    case "in_progress":
      return "inProgress";
    default:
      return null;
  }
}

function success(plan: RunPlan, changed: boolean): RunPlanToolEvaluation {
  const completed = plan.items.filter(
    (item) => item.status === "completed",
  ).length;
  return {
    changed,
    isError: false,
    output: canonicalJson({
      disposition: changed ? "updated" : "unchanged",
      completed,
      total: plan.items.length,
      plan,
    }),
    plan,
  };
}

function toolError(
  current: RunPlan | null,
  code: string,
): RunPlanToolEvaluation {
  return {
    changed: false,
    isError: true,
    output: canonicalJson({ error: code }),
    plan: current,
  };
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
