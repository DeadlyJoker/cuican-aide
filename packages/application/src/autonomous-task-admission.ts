import {
  captureAutonomousTaskBudget,
  captureAutonomousTaskCapability,
  captureAutonomousTaskEdgeLink,
  type AutonomousTaskBudget,
  type AutonomousTaskCapabilitySnapshot,
  type AutonomousTaskEdgeLink,
} from "./task-lineage-policy.ts";
import {
  captureTeamTaskIntent,
  teamJournalId,
  type TeamTaskIntent,
} from "./team-task-journal.ts";

export type AutonomousTaskChildAdmission = Readonly<{
  schemaVersion: "crewon.autonomous-task-child-admission.v0";
  idempotencyKey: string;
  parentTaskId: string;
  childTaskId: string;
  edge: AutonomousTaskEdgeLink;
  budget: AutonomousTaskBudget;
  capability: AutonomousTaskCapabilitySnapshot;
  childIntent: TeamTaskIntent;
}>;

/**
 * Captures the complete child admission input before a Store transaction.
 * This does not write a task, edge, wake item or effect receipt.
 */
export function captureAutonomousTaskChildAdmission(
  input: unknown,
): AutonomousTaskChildAdmission {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    invalid();
  const keys = Reflect.ownKeys(input);
  const allowed = [
    "schemaVersion",
    "idempotencyKey",
    "parentTaskId",
    "childTaskId",
    "edge",
    "budget",
    "capability",
    "childIntent",
  ];
  if (
    keys.length !== allowed.length ||
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
  )
    invalid();
  const record: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      invalid();
    record[key] = descriptor.value;
  }
  if (record.schemaVersion !== "crewon.autonomous-task-child-admission.v0")
    invalid();
  const idempotencyKey = record.idempotencyKey;
  if (
    typeof idempotencyKey !== "string" ||
    !idempotencyKey ||
    idempotencyKey.trim() !== idempotencyKey ||
    idempotencyKey.length > 256
  )
    invalid();
  const parentTaskId = requireId(record.parentTaskId);
  const childTaskId = requireId(record.childTaskId);
  const edge = captureAutonomousTaskEdgeLink(record.edge);
  const budget = captureAutonomousTaskBudget(record.budget);
  const capability = captureAutonomousTaskCapability(record.capability);
  const childIntent = captureTeamTaskIntent(
    record.childIntent as TeamTaskIntent,
  );
  if (
    edge.parentTaskId !== parentTaskId ||
    edge.childTaskId !== childTaskId ||
    edge.depth > budget.maxDepth ||
    childIntent.taskId !== childTaskId ||
    childIntent.tenantId !== capability.tenantId ||
    childIntent.spaceId !== capability.spaceId ||
    childIntent.actorId !== capability.actorId ||
    childIntent.principalId !== capability.principalId
  )
    invalid();
  return Object.freeze({
    schemaVersion: "crewon.autonomous-task-child-admission.v0",
    idempotencyKey,
    parentTaskId,
    childTaskId,
    edge,
    budget,
    capability,
    childIntent,
  });
}

function requireId(value: unknown): string {
  try {
    teamJournalId(value);
  } catch {
    invalid();
  }
  return value;
}

function invalid(): never {
  throw new Error("autonomous_task_child_admission_invalid");
}
