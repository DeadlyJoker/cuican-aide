import type { JsonValue } from "@crewon/contracts";
import type {
  StartControlTeamTurnInput,
  ControlTeamTurnResult,
} from "./team-turn-types.ts";
import type {
  CommitThreadInput,
  CommitThreadResult,
} from "./thread-store-port.ts";
import { canonicalJson } from "./canonical-json.ts";

export type TeamTaskTurn = Pick<
  StartControlTeamTurnInput,
  "threadId" | "expectedRevision" | "content" | "plan" | "toolPermissionMode"
> &
  Readonly<{ executionIntent?: "none" | "goal" }> &
  (
    | { responseMode: "manager"; managerResponseKind: "office" | "experts" }
    | { responseMode: "member"; managerResponseKind?: never }
  );
export type TeamTaskLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  taskId: string;
}>;
export type TeamTaskScope = Readonly<{
  tenantId: string;
  spaceId: string;
}>;
export type TeamTaskIntent = TeamTaskLocator &
  Readonly<{
    schemaVersion: "crewon.team-task.v1";
    actorId: string;
    principalId: string;
    /** Sequence of the atomically admitted user message, when present. */
    mainMessageSequence?: number;
    turn: TeamTaskTurn;
  }>;
export type TeamTaskFence = TeamTaskLocator &
  Readonly<{ ownerId: string; leaseId: string; epoch: number }>;

/** Write authorization passed through internal Store transactions. */
export type TeamTaskWriteFence = TeamTaskFence;
export type TeamTaskRecord = Readonly<{
  intent: TeamTaskIntent;
  status: "coordinating" | "finalAccepted";
  revision: number;
  cancelRequested: boolean;
  lease: {
    ownerId: string;
    leaseId: string;
    epoch: number;
    expiresAt: number;
  } | null;
  result: ControlTeamTurnResult | null;
  effectCount: number;
  journalBytes: number;
}>;
export type TeamTaskEffect = Readonly<{
  key: string;
  kind: "command" | "observation";
  request: JsonValue;
  settled: boolean;
  response: JsonValue | null;
}>;
export type TeamTaskAdmissionResult = Readonly<{
  disposition: "committed" | "replayed";
  task: TeamTaskRecord;
  /** Present only for a newly committed admission. */
  thread: CommitThreadResult | null;
}>;
export interface TeamTaskJournalStore {
  migrate(): Promise<void>;
  listRunnable(
    scope: TeamTaskScope & { limit: number },
  ): Promise<readonly TeamTaskLocator[]>;
  create(intent: TeamTaskIntent): Promise<TeamTaskRecord>;
  /**
   * Atomically reserves the main Thread, appends its user message and creates
   * the durable Team journal. The Store implementation supplies the
   * transaction-bound Thread commit; no network or model call may occur here.
   */
  admit(input: {
    intent: TeamTaskIntent;
    thread: CommitThreadInput;
  }): Promise<TeamTaskAdmissionResult>;
  read(locator: TeamTaskLocator): Promise<TeamTaskRecord | null>;
  claim(
    input: TeamTaskLocator & {
      ownerId: string;
      leaseId: string;
      durationMs: number;
    },
  ): Promise<TeamTaskFence | null>;
  renew(fence: TeamTaskFence, durationMs: number): Promise<void>;
  prepare(
    fence: TeamTaskFence,
    effect: Omit<TeamTaskEffect, "response" | "settled">,
    options: { renewForMs: number },
  ): Promise<TeamTaskEffect>;
  settle(
    fence: TeamTaskFence,
    key: string,
    response: JsonValue,
  ): Promise<TeamTaskEffect>;
  effects(locator: TeamTaskLocator): Promise<readonly TeamTaskEffect[]>;
  requestCancel(locator: TeamTaskLocator): Promise<void>;
  finalAccepted(
    fence: TeamTaskFence,
    result: ControlTeamTurnResult,
  ): Promise<void>;
}

/** These errors stop orchestration immediately; they are not transient Run reads. */
export class TeamTaskJournalError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "TeamTaskJournalError";
  }
}
export const TEAM_JOURNAL_LIMITS = Object.freeze({
  intentBytes: 131_072,
  effectBytes: 262_144,
  totalBytes: 1_048_576,
  effects: 128,
});
export function teamJournalFail(code: string): never {
  throw new TeamTaskJournalError(code);
}
export function teamJournalId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > 256
  )
    teamJournalFail("team_journal_identity_invalid");
}
export function validateTeamTaskLocator(input: TeamTaskLocator): void {
  for (const value of [input.tenantId, input.spaceId, input.taskId])
    teamJournalId(value);
}
export function validateTeamTaskScope(input: TeamTaskScope): void {
  teamJournalId(input.tenantId);
  teamJournalId(input.spaceId);
}
export function validateTeamTaskListLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100)
    teamJournalFail("team_journal_limit_invalid");
}
export function validateTeamTaskFence(input: TeamTaskFence): void {
  validateTeamTaskLocator(input);
  teamJournalId(input.ownerId);
  teamJournalId(input.leaseId);
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1)
    teamJournalFail("team_journal_lease_invalid");
}
export function validateTeamLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 100 || value > 300_000)
    teamJournalFail("team_journal_lease_invalid");
}
export function teamJournalJson(
  value: unknown,
  maximum: number = TEAM_JOURNAL_LIMITS.effectBytes,
): string {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > TEAM_JOURNAL_LIMITS.totalBytes
  )
    teamJournalFail("team_journal_budget_exceeded");
  let nodes = 0,
    bytes = 0;
  const count = (text: string) => {
    if (text.length > maximum) teamJournalFail("team_journal_budget_exceeded");
    bytes += teamJournalBytes(text);
    if (bytes > maximum) teamJournalFail("team_journal_budget_exceeded");
  };
  function capture(v: unknown, depth: number): JsonValue {
    if (depth > 32 || ++nodes > 16_384)
      teamJournalFail("team_journal_value_invalid");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      count(v);
      return v;
    }
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v !== "object") teamJournalFail("team_journal_value_invalid");
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v);
    if (array) {
      if (v.length > 1024 || Object.keys(v).length !== v.length)
        teamJournalFail("team_journal_value_invalid");
    } else if (proto !== Object.prototype && proto !== null)
      teamJournalFail("team_journal_value_invalid");
    const result: Record<string, JsonValue> = Object.create(null);
    const keys = Reflect.ownKeys(v);
    if (keys.length > 1025) teamJournalFail("team_journal_value_invalid");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length))
      )
        teamJournalFail("team_journal_value_invalid");
      const property = Object.getOwnPropertyDescriptor(v, key);
      if (!property || !("value" in property) || !property.enumerable)
        teamJournalFail("team_journal_value_invalid");
      count(key);
      result[key] = capture(property.value, depth + 1);
    }
    return array
      ? Array.from({ length: v.length }, (_, index) => result[String(index)]!)
      : result;
  }
  const text = canonicalJson(capture(value, 0));
  if (new TextEncoder().encode(text).length > maximum)
    teamJournalFail("team_journal_budget_exceeded");
  return text;
}
export function teamJournalBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
export function captureTeamTaskIntent(input: TeamTaskIntent): TeamTaskIntent {
  const value = JSON.parse(
    teamJournalJson(input, TEAM_JOURNAL_LIMITS.intentBytes),
  ) as TeamTaskIntent;
  validateTeamTaskLocator(value);
  teamJournalId(value.actorId);
  teamJournalId(value.principalId);
  if (
    Object.keys(value).sort().join() !==
      [
        "actorId",
        ...(value.mainMessageSequence === undefined
          ? []
          : ["mainMessageSequence"]),
        "principalId",
        "schemaVersion",
        "spaceId",
        "taskId",
        "tenantId",
        "turn",
      ]
        .sort()
        .join() ||
    value.schemaVersion !== "crewon.team-task.v1"
  )
    teamJournalFail("team_task_intent_invalid");
  if (
    value.mainMessageSequence !== undefined &&
    (!Number.isSafeInteger(value.mainMessageSequence) ||
      value.mainMessageSequence < 1)
  )
    teamJournalFail("team_task_intent_invalid");
  const turn = value.turn;
  if (
    !turn ||
    typeof turn.content !== "string" ||
    !turn.content.trim() ||
    !Number.isSafeInteger(turn.expectedRevision) ||
    turn.expectedRevision < 1 ||
    !["none", "goal", undefined].includes(turn.executionIntent) ||
    !["requestApproval", "approveForMe", "fullAccess", undefined].includes(
      turn.toolPermissionMode,
    ) ||
    !["manager", "member"].includes(turn.responseMode)
  )
    teamJournalFail("team_task_intent_invalid");
  if (
    Object.keys(turn).some(
      (key) =>
        ![
          "threadId",
          "expectedRevision",
          "content",
          "plan",
          "responseMode",
          "managerResponseKind",
          "executionIntent",
          "toolPermissionMode",
        ].includes(key),
    )
  )
    teamJournalFail("team_task_intent_invalid");
  if (
    turn.responseMode === "manager"
      ? !["office", "experts"].includes(turn.managerResponseKind)
      : "managerResponseKind" in turn
  )
    teamJournalFail("team_task_intent_invalid");
  teamJournalId(turn.threadId);
  const plan = turn.plan;
  if (
    !plan ||
    typeof plan.officeTitle !== "string" ||
    !Array.isArray(plan.workers) ||
    plan.workers.length < 1 ||
    plan.workers.length > 5 ||
    Object.keys(plan).sort().join() !==
      ["officeVersionId", "officeTitle", "manager", "workers"].sort().join()
  )
    teamJournalFail("team_task_intent_invalid");
  teamJournalId(plan.officeVersionId);
  const members = [plan.manager, ...plan.workers];
  for (const member of members) {
    if (
      !member ||
      Object.keys(member).some(
        (key) =>
          ![
            "memberId",
            "displayName",
            "agentVersionId",
            "targetId",
            "profile",
          ].includes(key),
      )
    )
      teamJournalFail("team_task_intent_invalid");
    for (const v of [
      member.memberId,
      member.displayName,
      member.agentVersionId,
      member.targetId,
    ])
      teamJournalId(v);
    const profile = member.profile;
    if (
      "profile" in member &&
      (!profile || typeof profile !== "object" || Array.isArray(profile))
    )
      teamJournalFail("team_task_intent_invalid");
    if (
      profile &&
      (Object.keys(profile).some(
        (key) =>
          ![
            "memberId",
            "systemPrompt",
            "skills",
            "mcp",
            "knowledge",
            "teamCoordination",
          ].includes(key),
      ) ||
        profile.memberId !== member.memberId ||
        typeof profile.systemPrompt !== "string" ||
        ![profile.skills, profile.mcp, profile.knowledge].every(
          (list) =>
            Array.isArray(list) &&
            list.length <= 128 &&
            list.every(
              (item) =>
                item &&
                typeof item.name === "string" &&
                typeof item.description === "string" &&
                Object.keys(item).sort().join() === "description,name",
            ),
        ))
    )
      teamJournalFail("team_task_intent_invalid");
    if (
      profile &&
      "teamCoordination" in profile &&
      (!profile.teamCoordination ||
        typeof profile.teamCoordination !== "object" ||
        Array.isArray(profile.teamCoordination))
    )
      teamJournalFail("team_task_intent_invalid");
    if (
      profile?.teamCoordination &&
      (Object.keys(profile.teamCoordination).sort().join() !==
        "assignmentMode,responsibility,source" ||
        profile.teamCoordination.assignmentMode !== "roleDirected" ||
        profile.teamCoordination.source !== "officeDefinition" ||
        typeof profile.teamCoordination.responsibility !== "string")
    )
      teamJournalFail("team_task_intent_invalid");
  }
  if (
    new Set(members.map((m) => m.memberId)).size !== members.length ||
    new Set(members.map((m) => m.targetId)).size !== members.length
  )
    teamJournalFail("team_task_intent_invalid");
  return value;
}
