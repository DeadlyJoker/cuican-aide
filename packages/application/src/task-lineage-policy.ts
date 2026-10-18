import type { ToolPermissionMode } from "@crewon/contracts";

export const MAX_AUTONOMOUS_TASK_DEPTH = 8;
export const MAX_AUTONOMOUS_TASK_CHILDREN = 32;
export const MAX_AUTONOMOUS_TASK_TOKEN_BUDGET = 10_000_000;
export const MAX_AUTONOMOUS_TASK_OUTPUT_BYTES = 16 * 1024 * 1024;

export type AutonomousTaskLineage = Readonly<{
  schemaVersion: "crewon.autonomous-task-lineage.v0";
  rootTaskId: string;
  parentTaskId: string | null;
  depth: number;
  childOrdinal: number | null;
}>;

export type AutonomousTaskBudget = Readonly<{
  schemaVersion: "crewon.autonomous-task-budget.v0";
  maxDepth: number;
  maxChildren: number;
  deadlineAt: string;
  tokenBudget: number | null;
  outputBytesBudget: number;
}>;

export type AutonomousTaskCapabilitySnapshot = Readonly<{
  schemaVersion: "crewon.autonomous-task-capability.v0";
  tenantId: string;
  spaceId: string;
  actorId: string;
  principalId: string;
  authorityId: string;
  runtimeGeneration: string;
  policySnapshotId: string;
  workspaceBindingId: string | null;
  toolPermissionMode: ToolPermissionMode;
}>;

export type AutonomousTaskEdgeLink = Readonly<{
  schemaVersion: "crewon.autonomous-task-edge.v0";
  rootTaskId: string;
  parentTaskId: string;
  childTaskId: string;
  depth: number;
  childOrdinal: number;
}>;

export class AutonomousTaskPolicyError extends Error {
  readonly code = "autonomous_task_policy_invalid";

  constructor(reason: string) {
    super(`${"autonomous_task_policy_invalid"}:${reason}`);
    this.name = "AutonomousTaskPolicyError";
  }
}

/**
 * Copies the lineage without invoking accessors or accepting caller-owned
 * prototypes. This is an internal value object; it does not admit a child.
 */
export function captureAutonomousTaskLineage(
  input: unknown,
): AutonomousTaskLineage {
  const record = recordOf(input, [
    "schemaVersion",
    "rootTaskId",
    "parentTaskId",
    "depth",
    "childOrdinal",
  ]);
  if (record.schemaVersion !== "crewon.autonomous-task-lineage.v0")
    invalid("schema");
  const rootTaskId = taskId(record.rootTaskId);
  const parentTaskId = nullableTaskId(record.parentTaskId);
  const depth = boundedInteger(record.depth, 0, MAX_AUTONOMOUS_TASK_DEPTH);
  const childOrdinal = nullablePositiveInteger(record.childOrdinal);
  if (depth === 0) {
    if (parentTaskId !== null || childOrdinal !== null) invalid("root_shape");
  } else if (parentTaskId === null || childOrdinal === null) {
    invalid("child_shape");
  }
  return Object.freeze({
    schemaVersion: "crewon.autonomous-task-lineage.v0",
    rootTaskId,
    parentTaskId,
    depth,
    childOrdinal,
  });
}

/** Copies and bounds a frozen budget. Relative deadline policy is evaluated by admission. */
export function captureAutonomousTaskBudget(
  input: unknown,
): AutonomousTaskBudget {
  const record = recordOf(input, [
    "schemaVersion",
    "maxDepth",
    "maxChildren",
    "deadlineAt",
    "tokenBudget",
    "outputBytesBudget",
  ]);
  if (record.schemaVersion !== "crewon.autonomous-task-budget.v0")
    invalid("schema");
  const deadlineAt = isoTimestamp(record.deadlineAt);
  const tokenBudget = nullablePositiveInteger(
    record.tokenBudget,
    MAX_AUTONOMOUS_TASK_TOKEN_BUDGET,
  );
  return Object.freeze({
    schemaVersion: "crewon.autonomous-task-budget.v0",
    maxDepth: boundedInteger(record.maxDepth, 0, MAX_AUTONOMOUS_TASK_DEPTH),
    maxChildren: boundedInteger(
      record.maxChildren,
      0,
      MAX_AUTONOMOUS_TASK_CHILDREN,
    ),
    deadlineAt,
    tokenBudget,
    outputBytesBudget: boundedInteger(
      record.outputBytesBudget,
      1,
      MAX_AUTONOMOUS_TASK_OUTPUT_BYTES,
    ),
  });
}

/** Copies only the capability snapshot; it does not grant or re-evaluate authority. */
export function captureAutonomousTaskCapability(
  input: unknown,
): AutonomousTaskCapabilitySnapshot {
  const record = recordOf(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "actorId",
    "principalId",
    "authorityId",
    "runtimeGeneration",
    "policySnapshotId",
    "workspaceBindingId",
    "toolPermissionMode",
  ]);
  if (record.schemaVersion !== "crewon.autonomous-task-capability.v0")
    invalid("schema");
  return Object.freeze({
    schemaVersion: "crewon.autonomous-task-capability.v0",
    tenantId: taskId(record.tenantId),
    spaceId: taskId(record.spaceId),
    actorId: taskId(record.actorId),
    principalId: taskId(record.principalId),
    authorityId: taskId(record.authorityId),
    runtimeGeneration: taskId(record.runtimeGeneration),
    policySnapshotId: taskId(record.policySnapshotId),
    workspaceBindingId: nullableTaskId(record.workspaceBindingId),
    toolPermissionMode: permissionMode(record.toolPermissionMode),
  });
}

/** Copies one parent/child edge. Linking it to a durable task is a separate transaction. */
export function captureAutonomousTaskEdgeLink(
  input: unknown,
): AutonomousTaskEdgeLink {
  const record = recordOf(input, [
    "schemaVersion",
    "rootTaskId",
    "parentTaskId",
    "childTaskId",
    "depth",
    "childOrdinal",
  ]);
  if (record.schemaVersion !== "crewon.autonomous-task-edge.v0")
    invalid("edge_schema");
  const rootTaskId = taskId(record.rootTaskId);
  const parentTaskId = taskId(record.parentTaskId);
  const childTaskId = taskId(record.childTaskId);
  const depth = boundedInteger(record.depth, 1, MAX_AUTONOMOUS_TASK_DEPTH);
  const childOrdinal = boundedInteger(
    record.childOrdinal,
    1,
    MAX_AUTONOMOUS_TASK_CHILDREN,
  );
  if (parentTaskId === childTaskId || rootTaskId === childTaskId)
    invalid("edge_self_reference");
  return Object.freeze({
    schemaVersion: "crewon.autonomous-task-edge.v0",
    rootTaskId,
    parentTaskId,
    childTaskId,
    depth,
    childOrdinal,
  });
}

/** Ensures a child capability never crosses identity or widens tool permission. */
export function assertAutonomousTaskCapabilitySubset(
  parent: AutonomousTaskCapabilitySnapshot,
  child: AutonomousTaskCapabilitySnapshot,
): void {
  for (const key of [
    "tenantId",
    "spaceId",
    "actorId",
    "principalId",
    "authorityId",
    "runtimeGeneration",
    "policySnapshotId",
    "workspaceBindingId",
  ] as const) {
    if (parent[key] !== child[key]) invalid(`capability_${key}`);
  }
  if (
    permissionRank(child.toolPermissionMode) >
    permissionRank(parent.toolPermissionMode)
  )
    invalid("capability_tool_permission");
}

/** Applies a captured budget to current durable usage at admission or resume. */
export function assertAutonomousTaskWithinBudget(input: {
  lineage: AutonomousTaskLineage;
  budget: AutonomousTaskBudget;
  childCount: number;
  tokensUsed: number;
  outputBytesUsed: number;
  now: string;
}): void {
  if (input.lineage.depth > input.budget.maxDepth) invalid("budget_depth");
  if (
    !Number.isSafeInteger(input.childCount) ||
    input.childCount < 0 ||
    input.childCount > input.budget.maxChildren
  )
    invalid("budget_children");
  const now = Date.parse(isoTimestamp(input.now));
  if (now >= Date.parse(input.budget.deadlineAt)) invalid("budget_deadline");
  const tokensUsed = boundedInteger(
    input.tokensUsed,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (
    input.budget.tokenBudget !== null &&
    tokensUsed > input.budget.tokenBudget
  )
    invalid("budget_tokens");
  const outputBytesUsed = boundedInteger(
    input.outputBytesUsed,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (outputBytesUsed > input.budget.outputBytesBudget)
    invalid("budget_output");
}

function recordOf(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    invalid("record");
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
  )
    invalid("keys");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      invalid("descriptor");
    result[key] = descriptor.value;
  }
  return result;
}

function taskId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid("id");
  return value as ToolPermissionMode;
}

function nullableTaskId(value: unknown): string | null {
  return value === null ? null : taskId(value);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value)) invalid("integer");
  const integer = value as number;
  if (integer < minimum || integer > maximum) invalid("integer");
  return integer;
}

function nullablePositiveInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  return value === null ? null : boundedInteger(value, 1, maximum);
}

function isoTimestamp(value: unknown): string {
  if (typeof value !== "string") invalid("deadline");
  const time = Date.parse(value);
  if (!Number.isFinite(time)) invalid("deadline");
  return new Date(time).toISOString();
}

function permissionMode(value: unknown): ToolPermissionMode {
  if (
    value !== "requestApproval" &&
    value !== "approveForMe" &&
    value !== "fullAccess"
  )
    invalid("tool_permission");
  return value;
}

function permissionRank(value: ToolPermissionMode): number {
  return value === "requestApproval" ? 0 : value === "approveForMe" ? 1 : 2;
}

function invalid(reason: string): never {
  throw new AutonomousTaskPolicyError(reason);
}
