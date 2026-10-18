import { parseOfficeDefinition, type RunState } from "@crewon/domain";
import { parseRunView } from "@crewon/contracts";
import {
  captureTeamTaskIntent,
  teamJournalJson,
  teamJournalBytes,
  teamJournalFail,
  validateTeamTaskLocator,
  validateTeamTaskFence,
  teamJournalId,
  TEAM_JOURNAL_LIMITS,
  type TeamTaskRecord,
  type TeamTaskLocator,
  type TeamTaskFence,
  type TeamTaskIntent,
  type TeamTaskEffect,
} from "@crewon/application/team-task-journal";
import type { ControlTeamTurnResult } from "@crewon/application/team-turn";

export type TeamJournalRow = Record<string, unknown>;
export const TEAM_TABLES = [
  "team_task_journal_schema",
  "team_task_journals",
  "team_task_effects",
] as const;
export const TEAM_TASK_COLUMNS = `tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, task_id TEXT NOT NULL,
 thread_id TEXT NOT NULL, intent_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('coordinating','finalAccepted')),
 revision INTEGER NOT NULL CHECK(revision>=1), cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN (0,1)),
 lease_owner TEXT, lease_id TEXT, lease_epoch INTEGER NOT NULL CHECK(lease_epoch>=0), lease_expires_at BIGINT,
 effect_count INTEGER NOT NULL CHECK(effect_count>=0 AND effect_count<=128), journal_bytes INTEGER NOT NULL CHECK(journal_bytes>0 AND journal_bytes<=1048576),
 result_json TEXT, PRIMARY KEY(tenant_id,space_id,task_id)`;
export const TEAM_EFFECT_COLUMNS = `tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, task_id TEXT NOT NULL,
 effect_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('command','observation')),
 request_json TEXT NOT NULL, response_json TEXT, PRIMARY KEY(tenant_id,space_id,task_id,effect_key)`;

export function teamTaskKeys(
  locator: TeamTaskLocator,
): [string, string, string] {
  validateTeamTaskLocator(locator);
  return [locator.tenantId, locator.spaceId, locator.taskId];
}
function number(value: unknown): number {
  const n =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
    teamJournalFail("team_journal_corrupt");
  return n;
}
export function teamParse(value: unknown): unknown {
  if (typeof value !== "string") teamJournalFail("team_journal_corrupt");
  try {
    return JSON.parse(value);
  } catch {
    return teamJournalFail("team_journal_corrupt");
  }
}
export function decodeTeamTask(
  row: TeamJournalRow | undefined,
  locator: TeamTaskLocator,
): TeamTaskRecord | null {
  teamTaskKeys(locator);
  if (!row) return null;
  const intent = captureTeamTaskIntent(
    teamParse(row.intent_json) as TeamTaskIntent,
  );
  if (
    row.tenant_id !== locator.tenantId ||
    row.space_id !== locator.spaceId ||
    row.task_id !== locator.taskId ||
    intent.tenantId !== locator.tenantId ||
    intent.spaceId !== locator.spaceId ||
    intent.taskId !== locator.taskId ||
    row.thread_id !== intent.turn.threadId ||
    !["coordinating", "finalAccepted"].includes(String(row.status))
  )
    teamJournalFail("team_journal_corrupt");
  const revision = number(row.revision),
    epoch = number(row.lease_epoch),
    effectCount = number(row.effect_count),
    journalBytes = number(row.journal_bytes);
  if (
    revision < 1 ||
    effectCount > TEAM_JOURNAL_LIMITS.effects ||
    journalBytes > TEAM_JOURNAL_LIMITS.totalBytes ||
    journalBytes < teamJournalBytes(String(row.intent_json)) ||
    ![0, 1].includes(Number(row.cancel_requested))
  )
    teamJournalFail("team_journal_corrupt");
  let lease: TeamTaskRecord["lease"] = null;
  if (
    row.lease_id !== null ||
    row.lease_owner !== null ||
    row.lease_expires_at !== null
  ) {
    teamJournalId(row.lease_id);
    teamJournalId(row.lease_owner);
    if (epoch < 1) teamJournalFail("team_journal_corrupt");
    lease = {
      ownerId: row.lease_owner,
      leaseId: row.lease_id,
      epoch,
      expiresAt: number(row.lease_expires_at),
    };
  }
  const result =
    row.result_json === null
      ? null
      : captureTeamResult(
          intent,
          teamParse(row.result_json) as ControlTeamTurnResult,
        );
  if (
    (row.status === "finalAccepted") !== (result !== null) ||
    (result && lease)
  )
    teamJournalFail("team_journal_corrupt");
  return {
    intent,
    status: row.status as TeamTaskRecord["status"],
    revision,
    cancelRequested: Number(row.cancel_requested) === 1,
    lease,
    result,
    effectCount,
    journalBytes,
  };
}
export function assertTeamFence(
  task: TeamTaskRecord | null,
  fence: TeamTaskFence,
  now: number,
  allowCanceled = false,
): asserts task is TeamTaskRecord {
  validateTeamTaskFence(fence);
  if (!Number.isSafeInteger(now) || now < 0)
    teamJournalFail("team_journal_clock_invalid");
  if (
    !task ||
    task.status !== "coordinating" ||
    task.lease?.ownerId !== fence.ownerId ||
    task.lease.leaseId !== fence.leaseId ||
    task.lease.epoch !== fence.epoch ||
    task.lease.expiresAt <= now
  )
    teamJournalFail("team_journal_lease_lost");
  if (task.cancelRequested && !allowCanceled)
    teamJournalFail("team_task_cancel_requested");
}
export function decodeTeamEffect(
  row: TeamJournalRow | undefined,
): TeamTaskEffect | null {
  if (!row) return null;
  teamJournalId(row.effect_key);
  if (row.kind !== "command" && row.kind !== "observation")
    teamJournalFail("team_journal_corrupt");
  const request = teamParse(row.request_json),
    response = row.response_json === null ? null : teamParse(row.response_json);
  return {
    key: row.effect_key,
    kind: row.kind,
    request: JSON.parse(teamJournalJson(request)),
    response: JSON.parse(teamJournalJson(response)),
    settled: row.response_json !== null,
  };
}
export function captureTeamEffect(
  effect: Omit<TeamTaskEffect, "response" | "settled">,
) {
  teamJournalId(effect.key);
  if (!["command", "observation"].includes(effect.kind))
    teamJournalFail("team_journal_value_invalid");
  return { ...effect, requestJson: teamJournalJson(effect.request) };
}
export function assertTeamEffectReplay(
  prior: TeamTaskEffect,
  effect: Omit<TeamTaskEffect, "response" | "settled">,
): void {
  if (
    prior.key !== effect.key ||
    prior.kind !== effect.kind ||
    teamJournalJson(prior.request) !== teamJournalJson(effect.request)
  )
    teamJournalFail("team_journal_effect_conflict");
}
export function assertTeamJournalBudget(
  task: TeamTaskRecord,
  bytes: number,
  newEffect: boolean,
): void {
  if (
    task.journalBytes + bytes > TEAM_JOURNAL_LIMITS.totalBytes ||
    (newEffect && task.effectCount >= TEAM_JOURNAL_LIMITS.effects)
  )
    teamJournalFail("team_journal_budget_exceeded");
}
export function assertTeamTaskSource(
  intent: TeamTaskIntent,
  thread: TeamJournalRow | undefined,
  rawOffice: unknown,
): void {
  if (
    !thread ||
    thread.tenant_id !== intent.tenantId ||
    thread.space_id !== intent.spaceId ||
    thread.thread_id !== intent.turn.threadId ||
    thread.status !== "active" ||
    number(thread.revision) !== intent.turn.expectedRevision
  )
    teamJournalFail("team_task_thread_unavailable");
  const office = parseOfficeDefinition(
    typeof rawOffice === "string" ? teamParse(rawOffice) : rawOffice,
  );
  const { plan } = intent.turn,
    members = [plan.manager, ...plan.workers];
  if (
    office.tenantId !== intent.tenantId ||
    office.spaceId !== intent.spaceId ||
    office.officeVersionId !== plan.officeVersionId ||
    office.title !== plan.officeTitle ||
    office.members.length !== members.length ||
    office.executionTargets.length !== members.length
  )
    teamJournalFail("team_task_office_mismatch");
  for (let n = 0; n < members.length; n++) {
    const a = members[n]!,
      b = office.members[n]!,
      target = office.executionTargets[n]!;
    if (
      a.memberId !== b.memberId ||
      a.displayName !== b.displayName ||
      a.agentVersionId !== b.agentVersionId ||
      a.targetId !== target.targetId ||
      a.agentVersionId !== target.agentVersionId ||
      Boolean(a.profile?.teamCoordination) !== Boolean(b.responsibility) ||
      (a.profile?.teamCoordination?.responsibility ?? "") !==
        (b.responsibility?.trim() ?? "")
    )
      teamJournalFail("team_task_office_mismatch");
  }
}
export function captureTeamResult(
  intent: TeamTaskIntent,
  value: ControlTeamTurnResult,
): ControlTeamTurnResult {
  const result = JSON.parse(teamJournalJson(value)) as ControlTeamTurnResult;
  const run = parseRunView(result.run, intent.turn.threadId);
  if (
    run.purpose !== "turn" ||
    !result.message ||
    result.message.threadId !== intent.turn.threadId ||
    result.message.role !== "user" ||
    result.message.content !== intent.turn.content ||
    typeof result.message.messageId !== "string" ||
    Object.keys(result).sort().join() !== "message,run"
  )
    teamJournalFail("team_task_result_invalid");
  return result;
}
export function assertTeamFinalRun(
  intent: TeamTaskIntent,
  result: ControlTeamTurnResult,
  actual: RunState | null,
): void {
  if (
    !actual ||
    actual.tenantId !== intent.tenantId ||
    actual.spaceId !== intent.spaceId ||
    actual.threadId !== intent.turn.threadId ||
    actual.runId !== result.run.runId ||
    (actual.purpose ?? "turn") !== "turn"
  )
    teamJournalFail("team_task_result_invalid");
}
