import { ContractValidationError } from "./contract-validation-error.ts";
import { captureWorkflowControlJson } from "./workflow-control-json.ts";
import type { ToolPermissionMode } from "./control-api-contract.ts";

export type TeamTaskRuntimeCapability = Readonly<{
  name: string;
  description: string;
}>;
export type TeamTaskRuntimeProfile = Readonly<{
  memberId: string;
  systemPrompt: string;
  skills: readonly TeamTaskRuntimeCapability[];
  mcp: readonly TeamTaskRuntimeCapability[];
  knowledge: readonly TeamTaskRuntimeCapability[];
  teamCoordination?: Readonly<{
    assignmentMode: "roleDirected";
    responsibility: string;
    source: "officeDefinition";
  }>;
}>;
export type TeamTaskMember = Readonly<{
  memberId: string;
  displayName: string;
  agentVersionId: string;
  targetId: string;
  profile?: TeamTaskRuntimeProfile;
}>;
export type TeamTaskPlan = Readonly<{
  officeVersionId: string;
  officeTitle: string;
  manager: TeamTaskMember;
  workers: readonly TeamTaskMember[];
}>;
export type TeamTaskAdmissionRequest = Readonly<{
  threadId: string;
  expectedRevision: number;
  content: string;
  plan: TeamTaskPlan;
  executionIntent?: "none" | "goal";
  toolPermissionMode?: ToolPermissionMode;
  responseMode: "manager" | "member";
  managerResponseKind?: "office" | "experts";
}>;
export type TeamTaskAdmissionResponse = Readonly<{
  schemaVersion: "crewon.team-task-admission.v1";
  disposition: "committed" | "replayed";
  task: Readonly<{
    taskId: string;
    threadId: string;
    status: "coordinating" | "finalAccepted";
    revision: number;
    cancelRequested: boolean;
    mainMessageSequence: number;
  }>;
}>;
export type TeamTaskSnapshotResponse = Readonly<{
  schemaVersion: "crewon.team-task-snapshot.v1";
  task: Readonly<{
    taskId: string;
    threadId: string;
    status: "coordinating" | "finalAccepted";
    revision: number;
    cancelRequested: boolean;
    mainMessageSequence: number | null;
    resultRunId: string | null;
  }>;
}>;

export const MAX_TEAM_TASK_ADMISSION_REQUEST_BYTES = 128 * 1024;
export const MAX_TEAM_TASK_ADMISSION_RESPONSE_BYTES = 32 * 1024;

function invalid(): never {
  throw new ContractValidationError("team_task_admission_invalid");
}
function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, expected: readonly string[]) {
  const row = record(value);
  if (Object.keys(row).sort().join() !== [...expected].sort().join()) invalid();
  return row;
}
function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const row = record(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !allowed.has(key))
  )
    invalid();
  return row;
}
function text(value: unknown, maximum = 512, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maximum ||
    new TextEncoder().encode(value).byteLength > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid();
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
  return Number(value);
}
function member(value: unknown): TeamTaskMember {
  const row = fields(
    value,
    ["agentVersionId", "displayName", "memberId", "targetId"],
    ["profile"],
  );
  const profile =
    row.profile === undefined ? undefined : runtimeProfile(row.profile);
  return {
    memberId: text(row.memberId),
    displayName: text(row.displayName),
    agentVersionId: text(row.agentVersionId),
    targetId: text(row.targetId),
    ...(profile === undefined ? {} : { profile }),
  };
}
function capability(value: unknown): TeamTaskRuntimeCapability {
  const row = exact(value, ["description", "name"]);
  return { name: text(row.name), description: text(row.description) };
}
function runtimeProfile(value: unknown): TeamTaskRuntimeProfile {
  const row = fields(
    value,
    ["knowledge", "mcp", "memberId", "skills", "systemPrompt"],
    ["teamCoordination"],
  );
  const list = (input: unknown): readonly TeamTaskRuntimeCapability[] => {
    if (!Array.isArray(input) || input.length > 128) invalid();
    return input.map(capability);
  };
  let teamCoordination: TeamTaskRuntimeProfile["teamCoordination"];
  if (row.teamCoordination !== undefined) {
    const coordination = exact(row.teamCoordination, [
      "assignmentMode",
      "responsibility",
      "source",
    ]);
    if (
      coordination.assignmentMode !== "roleDirected" ||
      coordination.source !== "officeDefinition"
    )
      invalid();
    teamCoordination = {
      assignmentMode: "roleDirected",
      responsibility: text(coordination.responsibility),
      source: "officeDefinition",
    };
  }
  return {
    memberId: text(row.memberId),
    systemPrompt: text(row.systemPrompt, 16_384, true),
    skills: list(row.skills),
    mcp: list(row.mcp),
    knowledge: list(row.knowledge),
    ...(teamCoordination === undefined ? {} : { teamCoordination }),
  };
}
function plan(value: unknown): TeamTaskPlan {
  const row = exact(value, [
    "manager",
    "officeTitle",
    "officeVersionId",
    "workers",
  ]);
  if (
    !Array.isArray(row.workers) ||
    row.workers.length < 1 ||
    row.workers.length > 5
  )
    invalid();
  const manager = member(row.manager);
  const workers = row.workers.map(member);
  const members = [manager, ...workers];
  if (
    new Set(members.map((item) => item.memberId)).size !== members.length ||
    new Set(members.map((item) => item.targetId)).size !== members.length
  )
    invalid();
  return {
    officeVersionId: text(row.officeVersionId),
    officeTitle: text(row.officeTitle),
    manager,
    workers,
  };
}

export function parseTeamTaskAdmissionRequest(
  value: unknown,
): TeamTaskAdmissionRequest {
  let captured: unknown;
  try {
    captured = captureWorkflowControlJson(
      value,
      MAX_TEAM_TASK_ADMISSION_REQUEST_BYTES,
      true,
    );
  } catch {
    invalid();
  }
  const row = fields(
    captured,
    ["content", "expectedRevision", "plan", "responseMode", "threadId"],
    ["executionIntent", "managerResponseKind", "toolPermissionMode"],
  );
  const responseMode = row.responseMode;
  if (responseMode !== "manager" && responseMode !== "member") invalid();
  if (
    row.managerResponseKind !== undefined &&
    !["office", "experts"].includes(String(row.managerResponseKind))
  )
    invalid();
  if (responseMode === "member" && row.managerResponseKind !== undefined)
    invalid();
  if (
    row.executionIntent !== undefined &&
    !["none", "goal"].includes(String(row.executionIntent))
  )
    invalid();
  if (
    row.toolPermissionMode !== undefined &&
    !["requestApproval", "approveForMe", "fullAccess"].includes(
      String(row.toolPermissionMode),
    )
  )
    invalid();
  return {
    threadId: text(row.threadId),
    expectedRevision: integer(row.expectedRevision),
    content: text(row.content, 32 * 1024),
    plan: plan(row.plan),
    ...(row.executionIntent === undefined
      ? {}
      : { executionIntent: row.executionIntent as "none" | "goal" }),
    ...(row.toolPermissionMode === undefined
      ? {}
      : { toolPermissionMode: row.toolPermissionMode as ToolPermissionMode }),
    responseMode,
    ...(responseMode === "manager"
      ? {
          managerResponseKind: (row.managerResponseKind ?? "office") as
            | "office"
            | "experts",
        }
      : {}),
  };
}

export function parseTeamTaskAdmissionResponse(
  value: unknown,
): TeamTaskAdmissionResponse {
  const row = exact(value, ["disposition", "schemaVersion", "task"]);
  if (
    row.schemaVersion !== "crewon.team-task-admission.v1" ||
    !["committed", "replayed"].includes(String(row.disposition))
  )
    invalid();
  const task = exact(row.task, [
    "cancelRequested",
    "mainMessageSequence",
    "revision",
    "status",
    "taskId",
    "threadId",
  ]);
  if (
    !["coordinating", "finalAccepted"].includes(String(task.status)) ||
    typeof task.cancelRequested !== "boolean" ||
    !Number.isSafeInteger(task.mainMessageSequence)
  )
    invalid();
  const result = {
    schemaVersion: "crewon.team-task-admission.v1" as const,
    disposition: row.disposition as "committed" | "replayed",
    task: {
      taskId: text(task.taskId),
      threadId: text(task.threadId),
      status: task.status as "coordinating" | "finalAccepted",
      revision: integer(task.revision),
      cancelRequested: task.cancelRequested,
      mainMessageSequence: integer(task.mainMessageSequence),
    },
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    MAX_TEAM_TASK_ADMISSION_RESPONSE_BYTES
  )
    invalid();
  return result;
}

export function parseTeamTaskSnapshotResponse(
  value: unknown,
): TeamTaskSnapshotResponse {
  const row = exact(value, ["schemaVersion", "task"]);
  if (row.schemaVersion !== "crewon.team-task-snapshot.v1") invalid();
  const task = exact(row.task, [
    "cancelRequested",
    "mainMessageSequence",
    "resultRunId",
    "revision",
    "status",
    "taskId",
    "threadId",
  ]);
  if (
    !["coordinating", "finalAccepted"].includes(String(task.status)) ||
    typeof task.cancelRequested !== "boolean" ||
    (task.mainMessageSequence !== null &&
      !Number.isSafeInteger(task.mainMessageSequence)) ||
    (task.resultRunId !== null && typeof task.resultRunId !== "string")
  )
    invalid();
  const result = {
    schemaVersion: "crewon.team-task-snapshot.v1" as const,
    task: {
      taskId: text(task.taskId),
      threadId: text(task.threadId),
      status: task.status as "coordinating" | "finalAccepted",
      revision: integer(task.revision),
      cancelRequested: task.cancelRequested,
      mainMessageSequence:
        task.mainMessageSequence === null
          ? null
          : integer(task.mainMessageSequence),
      resultRunId: task.resultRunId === null ? null : text(task.resultRunId),
    },
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    MAX_TEAM_TASK_ADMISSION_RESPONSE_BYTES
  )
    invalid();
  return result;
}

export function parseTeamTaskCancelRequest(
  value: unknown,
): Record<string, never> {
  const row = exact(value, []);
  return row as Record<string, never>;
}
