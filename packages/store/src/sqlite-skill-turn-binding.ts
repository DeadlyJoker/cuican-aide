import type { DatabaseSync } from "node:sqlite";
import { requireSqliteSkillVersion } from "./sqlite-skill-admission.ts";
import {
  RunStoreError,
  type CommitTurnStartInput,
  type SkillExecutionRecord,
} from "@crewon/application";
import {
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
  const { skill, version } = requireSqliteSkillVersion(database, {
    locator: {
      tenantId: run.tenantId,
      spaceId: run.spaceId,
      ownerActorId: run.createdByActorId,
      skillId: input.skillExecution.skillId,
    },
    ref,
    purpose: execution.purpose,
  });
  const command = execution.command;
  if (
    execution.skillId !== skill.skillId ||
    execution.ownerActorId !== run.createdByActorId ||
    execution.tenantId !== run.tenantId ||
    execution.spaceId !== run.spaceId ||
    command.threadId !== run.threadId ||
    (command.toolPermissionMode ?? "requestApproval") !== (run.toolPermissionMode ?? "requestApproval") ||
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
