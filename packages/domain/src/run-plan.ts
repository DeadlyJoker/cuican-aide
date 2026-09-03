export const RUN_PLAN_STATUSES = [
  "pending",
  "inProgress",
  "completed",
  "blocked",
  "canceled",
] as const;

export const MAX_RUN_PLAN_ITEMS = 32;
export const MAX_RUN_PLAN_SNAPSHOT_BYTES = 9_999;
export const MAX_RUN_PLAN_TITLE_CHARS = 256;
export const MAX_RUN_PLAN_EXPLANATION_CHARS = 1_000;
export const RUN_PLAN_ITEM_ID_PATTERN_SOURCE =
  "^[a-z0-9][a-z0-9._-]{0,63}$";

const RUN_PLAN_ITEM_ID_PATTERN = new RegExp(
  RUN_PLAN_ITEM_ID_PATTERN_SOURCE,
  "u",
);
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export type RunPlanStatus = (typeof RUN_PLAN_STATUSES)[number];

export type RunPlanItem = Readonly<{
  itemId: string;
  title: string;
  status: RunPlanStatus;
}>;

/** Authoritative, bounded execution checklist for one Run. */
export type RunPlan = Readonly<{
  schemaVersion: "crewon.run-plan.v0";
  planId: string;
  revision: number;
  explanation: string | null;
  items: readonly RunPlanItem[];
  createdAt: string;
  updatedAt: string;
}>;

export class RunPlanError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RunPlanError";
    this.code = code;
  }
}

export function validateRunPlan(plan: RunPlan): void {
  if (
    !isPlainObject(plan) ||
    !hasExactKeys(plan, [
      "createdAt",
      "explanation",
      "items",
      "planId",
      "revision",
      "schemaVersion",
      "updatedAt",
    ]) ||
    plan.schemaVersion !== "crewon.run-plan.v0"
  ) {
    throw new RunPlanError("run_plan_shape_invalid");
  }
  requireBoundedText(plan.planId, 512, 512, "run_plan_id_invalid");
  requirePositiveInteger(plan.revision, "run_plan_revision_invalid");
  requireTimestamp(plan.createdAt, "run_plan_created_at_invalid");
  requireTimestamp(plan.updatedAt, "run_plan_updated_at_invalid");
  if (Date.parse(plan.updatedAt) < Date.parse(plan.createdAt)) {
    throw new RunPlanError("run_plan_timestamp_order_invalid");
  }
  if (plan.explanation !== null) {
    requireBoundedText(
      plan.explanation,
      MAX_RUN_PLAN_EXPLANATION_CHARS,
      4_000,
      "run_plan_explanation_invalid",
    );
  }
  if (
    !Array.isArray(plan.items) ||
    plan.items.length < 1 ||
    plan.items.length > MAX_RUN_PLAN_ITEMS
  ) {
    throw new RunPlanError("run_plan_items_invalid");
  }

  const itemIds = new Set<string>();
  let inProgress = 0;
  for (const item of plan.items) {
    if (
      !isPlainObject(item) ||
      !hasExactKeys(item, ["itemId", "status", "title"]) ||
      typeof item.itemId !== "string" ||
      typeof item.title !== "string" ||
      typeof item.status !== "string"
    ) {
      throw new RunPlanError("run_plan_item_shape_invalid");
    }
    if (
      typeof item.itemId !== "string" ||
      !RUN_PLAN_ITEM_ID_PATTERN.test(item.itemId) ||
      itemIds.has(item.itemId)
    ) {
      throw new RunPlanError("run_plan_item_id_invalid");
    }
    itemIds.add(item.itemId);
    requireBoundedText(
      item.title,
      MAX_RUN_PLAN_TITLE_CHARS,
      1_024,
      "run_plan_item_title_invalid",
    );
    if (!RUN_PLAN_STATUSES.some((status) => status === item.status)) {
      throw new RunPlanError("run_plan_item_status_invalid");
    }
    if (item.status === "inProgress") inProgress += 1;
  }
  if (inProgress > 1) {
    throw new RunPlanError("run_plan_multiple_items_in_progress");
  }
  if (byteLength(JSON.stringify(plan)) > MAX_RUN_PLAN_SNAPSHOT_BYTES) {
    throw new RunPlanError("run_plan_snapshot_too_large");
  }
}

export function sameRunPlanContent(
  left: Pick<RunPlan, "explanation" | "items">,
  right: Pick<RunPlan, "explanation" | "items">,
): boolean {
  if (
    left.explanation !== right.explanation ||
    left.items.length !== right.items.length
  ) {
    return false;
  }
  return left.items.every((item, index) => {
    const candidate = right.items[index];
    return (
      candidate !== undefined &&
      item.itemId === candidate.itemId &&
      item.title === candidate.title &&
      item.status === candidate.status
    );
  });
}

function requireBoundedText(
  value: string,
  maxChars: number,
  maxBytes: number,
  code: string,
): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    [...value].length > maxChars ||
    byteLength(value) > maxBytes ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new RunPlanError(code);
  }
}

function requirePositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RunPlanError(code);
  }
}

function requireTimestamp(value: string, code: string): void {
  if (
    typeof value !== "string" ||
    !TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new RunPlanError(code);
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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
