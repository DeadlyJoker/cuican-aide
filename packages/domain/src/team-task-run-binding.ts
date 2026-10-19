/**
 * Immutable identity binding between a Run and the Team task that admitted it.
 * Runtime selection must consume this persisted identity rather than infer
 * Team ownership from a thread or ordinary Run fields.
 */
export type TeamTaskRunBinding = Readonly<{
  schemaVersion: "crewon.team-task-run-binding.v0";
  tenantId: string;
  spaceId: string;
  teamTaskId: string;
  parentTaskId: string;
  admissionEpoch: number;
  capabilitySnapshotId: string;
}>;

/** Capture a persisted or transport value without retaining caller objects. */
export function captureTeamTaskRunBinding(
  input: unknown,
): TeamTaskRunBinding {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) invalid();
  const allowed = new Set([
    "schemaVersion",
    "tenantId",
    "spaceId",
    "teamTaskId",
    "parentTaskId",
    "admissionEpoch",
    "capabilitySnapshotId",
  ]);
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== allowed.size ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) invalid();
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
  if (
    typeof record.admissionEpoch !== "number" ||
    !Number.isSafeInteger(record.admissionEpoch) ||
    record.admissionEpoch < 1
  ) invalid();
  return Object.freeze({
    schemaVersion: "crewon.team-task-run-binding.v0",
    tenantId,
    spaceId,
    teamTaskId,
    parentTaskId,
    admissionEpoch: record.admissionEpoch,
    capabilitySnapshotId,
  });
}

function id(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") invalid();
  return value;
}

function invalid(): never {
  throw new Error("team_task_run_binding_invalid");
}
