import {
  assertSqliteTextPlanProject,
  assertPostgresTextPlanProject,
} from "./project-text-plan-legacy-access.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { ProjectTextPlan, ProjectTextPlanStep } from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { planScope, planStoreFail } from "./project-text-plan-records.ts";

export type PlanCheckpoint = Readonly<{
  plan: ProjectTextPlan;
  step: ProjectTextPlanStep;
}>;
/** No nested transaction: the genuine admission/candidate/selection writer owns COMMIT. */
export function writeSqlitePlanCheckpoint(
  db: DatabaseSync,
  before: PlanCheckpoint,
  next: PlanCheckpoint,
): void {
  assertSqliteTextPlanProject(db, before.plan.owner, before.plan.projectId);
  assertSqliteTextPlanProject(db, next.plan.owner, next.plan.projectId);
  if (
    before.plan.contentDigest !== next.plan.contentDigest &&
    db
      .prepare(
        "UPDATE project_text_plans SET revision=?,current_plan_revision=?,state=?,active_step_id=?,wake_revision=?,record_json=? WHERE tenant_id=? AND space_id=? AND plan_id=? AND revision=?",
      )
      .run(
        next.plan.revision,
        next.plan.currentPlanRevision,
        next.plan.state,
        next.plan.activeStepId,
        next.plan.wakeRevision,
        JSON.stringify(next.plan),
        ...planScope(next.plan),
        before.plan.revision,
      ).changes !== 1
  )
    planStoreFail("project_text_plan_revision_conflict");
  if (
    before.step.contentDigest !== next.step.contentDigest &&
    db
      .prepare(
        "UPDATE project_text_plan_steps SET revision=?,state=?,record_json=? WHERE tenant_id=? AND space_id=? AND plan_id=? AND step_id=? AND revision=?",
      )
      .run(
        next.step.revision,
        next.step.state,
        JSON.stringify(next.step),
        ...planScope(next.plan),
        next.step.stepId,
        before.step.revision,
      ).changes !== 1
  )
    planStoreFail("project_text_plan_step_revision_conflict");
}
export async function writePostgresPlanCheckpoint(
  c: PoolClient,
  schema: string,
  before: PlanCheckpoint,
  next: PlanCheckpoint,
): Promise<void> {
  await assertPostgresTextPlanProject(
    c,
    schema,
    before.plan.owner,
    before.plan.projectId,
  );
  await assertPostgresTextPlanProject(
    c,
    schema,
    next.plan.owner,
    next.plan.projectId,
  );
  const p = `${creativeProjectSchemaName(schema)}.`;
  if (
    before.plan.contentDigest !== next.plan.contentDigest &&
    (
      await c.query(
        `UPDATE ${p}project_text_plans SET revision=$1,current_plan_revision=$2,state=$3,active_step_id=$4,wake_revision=$5,record_json=$6 WHERE tenant_id=$7 AND space_id=$8 AND plan_id=$9 AND revision=$10`,
        [
          next.plan.revision,
          next.plan.currentPlanRevision,
          next.plan.state,
          next.plan.activeStepId,
          next.plan.wakeRevision,
          JSON.stringify(next.plan),
          ...planScope(next.plan),
          before.plan.revision,
        ],
      )
    ).rowCount !== 1
  )
    planStoreFail("project_text_plan_revision_conflict");
  if (
    before.step.contentDigest !== next.step.contentDigest &&
    (
      await c.query(
        `UPDATE ${p}project_text_plan_steps SET revision=$1,state=$2,record_json=$3 WHERE tenant_id=$4 AND space_id=$5 AND plan_id=$6 AND step_id=$7 AND revision=$8`,
        [
          next.step.revision,
          next.step.state,
          JSON.stringify(next.step),
          ...planScope(next.plan),
          next.step.stepId,
          before.step.revision,
        ],
      )
    ).rowCount !== 1
  )
    planStoreFail("project_text_plan_step_revision_conflict");
}
