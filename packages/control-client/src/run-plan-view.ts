import type { GetRunPlanResponse, RunPlanView } from "@crewon/contracts";

const RUN_PLAN_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const RUN_PLAN_STATUSES = new Set([
  "pending",
  "inProgress",
  "completed",
  "blocked",
  "canceled",
]);
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export class RunPlanViewValidationError extends Error {
  constructor() {
    super("run_plan_view_invalid");
    this.name = "RunPlanViewValidationError";
  }
}

export function parseGetRunPlanResponse(
  input: unknown,
  expectedRunId: string,
): GetRunPlanResponse {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["eventSequence", "plan", "runId"]) ||
    !isBoundedText(input.runId, 128, 512) ||
    input.runId !== expectedRunId ||
    !isPositiveInteger(input.eventSequence)
  ) {
    fail();
  }
  const plan = input.plan === null ? null : parseRunPlanView(input.plan);
  if (plan !== null && plan.planId !== input.runId) {
    fail();
  }
  return {
    runId: input.runId,
    eventSequence: Number(input.eventSequence),
    plan,
  };
}

/** Strictly validates and clones one bounded public Run Plan snapshot. */
export function parseRunPlanView(input: unknown): RunPlanView {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, [
      "createdAt",
      "explanation",
      "items",
      "planId",
      "revision",
      "schemaVersion",
      "updatedAt",
    ]) ||
    input.schemaVersion !== "crewon.run-plan.v0" ||
    !isBoundedText(input.planId, 512, 512) ||
    !isPositiveInteger(input.revision) ||
    !isTimestamp(input.createdAt) ||
    !isTimestamp(input.updatedAt) ||
    Date.parse(input.updatedAt) < Date.parse(input.createdAt) ||
    (input.explanation !== null &&
      !isBoundedText(input.explanation, 1_000, 4_000)) ||
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 32
  ) {
    fail();
  }

  const itemIds = new Set<string>();
  let inProgress = 0;
  for (const item of input.items) {
    if (
      !isPlainObject(item) ||
      !hasExactKeys(item, ["itemId", "status", "title"]) ||
      typeof item.itemId !== "string" ||
      !RUN_PLAN_ITEM_ID_PATTERN.test(item.itemId) ||
      itemIds.has(item.itemId) ||
      !isBoundedText(item.title, 256, 1_024) ||
      typeof item.status !== "string" ||
      !RUN_PLAN_STATUSES.has(item.status)
    ) {
      fail();
    }
    itemIds.add(item.itemId);
    if (item.status === "inProgress") inProgress += 1;
  }
  if (inProgress > 1 || byteLength(JSON.stringify(input)) > 9_999) {
    fail();
  }
  return structuredClone(input) as RunPlanView;
}

function fail(): never {
  throw new RunPlanViewValidationError();
}

function isBoundedText(
  value: unknown,
  maximumCharacters: number,
  maximumBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim() &&
    [...value].length <= maximumCharacters &&
    byteLength(value) <= maximumBytes &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
