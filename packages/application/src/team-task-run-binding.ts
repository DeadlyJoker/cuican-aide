import { teamJournalId } from "./team-task-journal.ts";
import type { TeamTaskFence } from "./team-task-journal.ts";

export type TeamTaskRunBinding = Readonly<{
  schemaVersion: "crewon.team-task-run-binding.v0";
  tenantId: string;
  spaceId: string;
  teamTaskId: string;
  parentTaskId: string;
  admissionEpoch: number;
  capabilitySnapshotId: string;
}>;

/** Builds the immutable binding from trusted fence/capability inputs. */
export function createTeamTaskRunBinding(input: {
  fence: TeamTaskFence;
  capabilitySnapshotId: string;
}): TeamTaskRunBinding {
  return captureTeamTaskRunBinding({
    schemaVersion: "crewon.team-task-run-binding.v0",
    tenantId: input.fence.tenantId,
    spaceId: input.fence.spaceId,
    teamTaskId: input.fence.taskId,
    parentTaskId: input.fence.taskId,
    admissionEpoch: input.fence.epoch,
    capabilitySnapshotId: input.capabilitySnapshotId,
  });
}

/** Captures the server-created Run binding before persistence or runtime use. */
export function captureTeamTaskRunBinding(input: unknown): TeamTaskRunBinding {
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
    "tenantId",
    "spaceId",
    "teamTaskId",
    "parentTaskId",
    "admissionEpoch",
    "capabilitySnapshotId",
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
  if (record.schemaVersion !== "crewon.team-task-run-binding.v0") invalid();
  const tenantId = id(record.tenantId);
  const spaceId = id(record.spaceId);
  const teamTaskId = id(record.teamTaskId);
  const parentTaskId = id(record.parentTaskId);
  const capabilitySnapshotId = id(record.capabilitySnapshotId);
  const admissionEpoch = record.admissionEpoch;
  if (
    typeof admissionEpoch !== "number" ||
    !Number.isSafeInteger(admissionEpoch) ||
    admissionEpoch < 1
  )
    invalid();
  return Object.freeze({
    schemaVersion: "crewon.team-task-run-binding.v0",
    tenantId,
    spaceId,
    teamTaskId,
    parentTaskId,
    admissionEpoch,
    capabilitySnapshotId,
  });
}

function id(value: unknown): string {
  try {
    teamJournalId(value);
  } catch {
    invalid();
  }
  return value;
}

function invalid(): never {
  throw new Error("team_task_run_binding_invalid");
}
