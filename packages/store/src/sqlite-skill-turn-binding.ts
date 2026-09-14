import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type CommitTurnStartInput,
  type SkillExecutionRecord,
  type DemonstratedSkillRecord,
} from "@crewon/application";
import {
  parseSkillVersion,
  renderSkillInvocationContext,
  skillJson,
  type RunState,
} from "@crewon/domain";
/** Called inside the existing Run transaction, before any queue handoff is committed. */
export function bindSqliteSkillTurn(
  database: DatabaseSync,
  input: CommitTurnStartInput,
  run: RunState,
): void {
  if (!input.skillExecution) return;
  const where =
    "tenant_id = ? AND space_id = ? AND owner_actor_id = ? AND skill_id = ?";
  const args = [
    run.tenantId,
    run.spaceId,
    run.createdByActorId,
    input.skillExecution.skillId,
  ];
  const skillRow = database
    .prepare(`SELECT record_json FROM demonstrated_skills WHERE ${where}`)
    .get(...args) as { record_json: string } | undefined;
  if (!skillRow) throw new RunStoreError("skill_not_found");
  const skill = JSON.parse(skillRow.record_json) as DemonstratedSkillRecord;
  if (skill.disabled || skill.deleted)
    throw new RunStoreError("skill_disabled");
  const row = database
    .prepare(
      `SELECT record_json FROM demonstrated_skill_executions WHERE ${where} AND execution_id = ?`,
    )
    .get(...args, input.skillExecution.executionId) as
    | { record_json: string }
    | undefined;
  if (!row) throw new RunStoreError("skill_execution_not_found");
  const execution = JSON.parse(row.record_json) as SkillExecutionRecord;
  const ref = execution.invocation.skill;
  const versionRow = database
    .prepare(
      `SELECT version_json FROM demonstrated_skill_versions WHERE ${where} AND version_id = ?`,
    )
    .get(...args, ref.versionId) as { version_json: string } | undefined;
  if (!versionRow) throw new RunStoreError("skill_version_not_found");
  const version = parseSkillVersion(JSON.parse(versionRow.version_json), {
    sha256: (value) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  });
  if (
    execution.purpose === "execute" &&
    !skill.activatedVersionIds.includes(ref.versionId)
  )
    throw new RunStoreError("skill_not_active");
  const command = execution.command;
  if (
    execution.skillId !== skill.skillId ||
    execution.ownerActorId !== run.createdByActorId ||
    execution.tenantId !== run.tenantId ||
    execution.spaceId !== run.spaceId ||
    command.threadId !== run.threadId ||
    command.route.agentVersionId !== run.agentVersionId ||
    command.route.policySnapshotId !== run.policySnapshotId ||
    command.route.runtimeGeneration !== run.runtimeGeneration ||
    command.route.workspaceBindingId !== run.workspaceBindingId ||
    command.route.authorityId !== run.authorityId ||
    command.expectedThreadRevision !== input.thread.expectedRevision ||
    command.idempotencyKey !== input.idempotency.key ||
    skillJson(command.skillExecution) !== skillJson(input.skillExecution) ||
    command.content !==
      renderSkillInvocationContext(version, execution.invocation) ||
    input.thread.messages.length !== 1 ||
    input.thread.messages[0]?.content !== command.content ||
    (execution.runId !== null && execution.runId !== run.runId)
  )
    throw new RunStoreError("skill_execution_binding_mismatch");
  database
    .prepare(
      `UPDATE demonstrated_skill_executions SET record_json = ? WHERE ${where} AND execution_id = ?`,
    )
    .run(
      skillJson({ ...execution, runId: run.runId }),
      ...args,
      execution.executionId,
    );
}
