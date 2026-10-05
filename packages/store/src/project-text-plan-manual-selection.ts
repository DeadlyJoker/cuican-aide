import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type {
  ActorContext,
  CreativeProjectMutationReceipt,
  ProjectTextMutationResult,
  ProjectTextUiCommitTransactionAuthority,
} from "@crewon/application";
import {
  checkpointProjectTextPlanSelection,
  type ProjectTextPlan,
  type ProjectTextPlanStep,
} from "@crewon/domain";
import {
  assertSqlitePlanSchema,
  assertPostgresPlanSchema,
} from "./project-text-plan-schema.ts";
import {
  decodePlan,
  decodePlanStep,
  decodePlanRevision,
  planStoreFail,
  planEqual,
} from "./project-text-plan-records.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  writeSqlitePlanCheckpoint,
  writePostgresPlanCheckpoint,
  type PlanCheckpoint,
} from "./project-text-plan-checkpoints.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";

function checked(
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
  result: ProjectTextMutationResult,
  receipt: CreativeProjectMutationReceipt,
): PlanCheckpoint | null {
  const r = step.result;
  if (
    r === null ||
    r.kind === "brief" ||
    result.contentRevision === null ||
    r.artifactId !== result.artifact.artifactId ||
    r.contentRevision !== result.contentRevision.contentRevision ||
    r.contentDigest !== result.contentRevision.contentDigest ||
    step.selection !== null
  )
    return null;
  return checkpointProjectTextPlanSelection(
    plan,
    step,
    {
      mode: "manual",
      idempotencyKey: receipt.idempotencyKey,
      requestDigest: receipt.requestDigest,
      artifactId: result.artifact.artifactId,
      artifactRevision: result.artifact.revision,
      contentRevision: result.contentRevision.contentRevision,
      contentDigest: result.contentRevision.contentDigest,
    },
    result.artifact.updatedAt,
    creativeStoreDigester,
  );
}
/** Only observes the original actual selection receipt; it never grants execution or advances the plan. */
export function observeSqlitePlanManualSelection(
  db: DatabaseSync,
  actor: ActorContext,
  receipt: CreativeProjectMutationReceipt,
  result: ProjectTextMutationResult,
  qualification?: ProjectTextUiCommitTransactionAuthority,
): void {
  if (
    result.kind !== "select-revision" ||
    result.contentRevision === null ||
    !assertSqlitePlanSchema(db, false)
  )
    return;
  const rows = db
    .prepare(
      "SELECT p.*,s.record_json AS step_json,s.step_id FROM project_text_plans p JOIN project_text_plan_steps s ON s.tenant_id=p.tenant_id AND s.space_id=p.space_id AND s.plan_id=p.plan_id AND s.step_id=p.active_step_id WHERE p.tenant_id=? AND p.space_id=? AND p.principal_id=? AND p.actor_id=? AND p.project_id=? AND p.state IN ('waitingSelection','paused','running') AND json_extract(s.record_json,'$.result.artifactId')=? AND json_extract(s.record_json,'$.result.contentRevision')=? LIMIT 2",
    )
    .all(
      actor.tenantId,
      actor.spaceId,
      actor.principalId,
      actor.actorId,
      result.artifact.projectId,
      result.artifact.artifactId,
      result.contentRevision.contentRevision,
    );
  if (rows.length > 1) planStoreFail("project_text_plan_result_invalid");
  for (const row of rows) {
    const plan = decodePlan(row)!;
    const definition = decodePlanRevision(
      db
        .prepare(
          "SELECT * FROM project_text_plan_revisions WHERE tenant_id=? AND space_id=? AND plan_id=? AND plan_revision=?",
        )
        .get(
          actor.tenantId,
          actor.spaceId,
          plan.planId,
          plan.currentPlanRevision,
        ),
    );
    if (definition === null) planStoreFail();
    if (definition.adoption !== "manual") continue;
    if (qualification !== undefined)
      planEqual(
        definition.installation,
        qualification.installation,
        "project_text_plan_installation_changed",
      );
    const step = decodePlanStep(
      db
        .prepare(
          "SELECT * FROM project_text_plan_steps WHERE tenant_id=? AND space_id=? AND plan_id=? AND step_id=?",
        )
        .get(actor.tenantId, actor.spaceId, plan.planId, row.step_id as string),
      plan,
    )!;
    const next = checked(plan, step, result, receipt);
    if (next !== null) writeSqlitePlanCheckpoint(db, { plan, step }, next);
  }
}
export async function observePostgresPlanManualSelection(
  c: PoolClient,
  schema: string,
  actor: ActorContext,
  receipt: CreativeProjectMutationReceipt,
  result: ProjectTextMutationResult,
  qualification?: ProjectTextUiCommitTransactionAuthority,
): Promise<void> {
  if (
    result.kind !== "select-revision" ||
    result.contentRevision === null ||
    !(await assertPostgresPlanSchema(c, schema, false))
  )
    return;
  const p = `${creativeProjectSchemaName(schema)}.`;
  // The original text writer already owns the project lock, before any mutable plan/step lock.
  const rows = (
    await c.query(
      `SELECT p.plan_id FROM ${p}project_text_plans p JOIN ${p}project_text_plan_steps s ON s.tenant_id=p.tenant_id AND s.space_id=p.space_id AND s.plan_id=p.plan_id AND s.step_id=p.active_step_id WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.principal_id=$3 AND p.actor_id=$4 AND p.project_id=$5 AND p.state IN ('waitingSelection','paused','running') AND s.record_json->'result'->>'artifactId'=$6 AND s.record_json->'result'->>'contentRevision'=$7 LIMIT 2`,
      [
        actor.tenantId,
        actor.spaceId,
        actor.principalId,
        actor.actorId,
        result.artifact.projectId,
        result.artifact.artifactId,
        String(result.contentRevision.contentRevision),
      ],
    )
  ).rows;
  if (rows.length > 1) planStoreFail("project_text_plan_result_invalid");
  for (const row of rows) {
    await advisoryLock(
      c,
      JSON.stringify([
        "project-text-plan",
        schema,
        actor.tenantId,
        actor.spaceId,
        row.plan_id,
      ]),
    );
    const scope = [actor.tenantId, actor.spaceId, row.plan_id],
      plan = decodePlan(
        (
          await c.query(
            `SELECT * FROM ${p}project_text_plans WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3 FOR UPDATE`,
            scope,
          )
        ).rows[0],
      );
    if (plan === null) planStoreFail();
    const definition = decodePlanRevision(
      (
        await c.query(
          `SELECT * FROM ${p}project_text_plan_revisions WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3 AND plan_revision=$4`,
          [...scope, plan.currentPlanRevision],
        )
      ).rows[0],
    );
    if (definition === null) planStoreFail();
    if (definition.adoption !== "manual") continue;
    if (qualification !== undefined)
      planEqual(
        definition.installation,
        qualification.installation,
        "project_text_plan_installation_changed",
      );
    const step = decodePlanStep(
      (
        await c.query(
          `SELECT * FROM ${p}project_text_plan_steps WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3 AND step_id=$4 FOR UPDATE`,
          [...scope, plan.activeStepId],
        )
      ).rows[0],
      plan,
    );
    if (step === null) planStoreFail();
    const next = checked(plan, step, result, receipt);
    if (next !== null)
      await writePostgresPlanCheckpoint(c, schema, { plan, step }, next);
  }
}
