import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  projectToolRunMutationCommand,
  projectStructuredOutlineCommandReceipt,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  checkpointProjectTextPlanResult,
  assertProjectTextPlanOutlineEpisodes,
  type ProjectTextPlanRunAdmission,
  type ProjectTextPlan,
  type ProjectTextPlanStep,
} from "@crewon/domain";
import type { projectOutlineRunCommitQualification } from "./project-outline-run-qualification.ts";
type PlanResultQualification =
  | ProjectRunQualification
  | NonNullable<ReturnType<typeof projectOutlineRunCommitQualification>>;
import type { ProjectRunQualification } from "./creative-project-run-commit-support.ts";
import {
  loadSqlitePlanAdmission,
  loadPostgresPlanAdmission,
} from "./project-text-plan-markers.ts";
import {
  decodePlan,
  decodePlanRevision,
  decodePlanStep,
  planEqual,
  planStoreFail,
} from "./project-text-plan-records.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";
import {
  writeSqlitePlanCheckpoint,
  writePostgresPlanCheckpoint,
  type PlanCheckpoint,
} from "./project-text-plan-checkpoints.ts";
import type {
  StoredProjectTextMutationResult,
  CreativeProjectMutationResult,
} from "@crewon/application";

function assertImmutable(
  q: PlanResultQualification,
  a: ProjectTextPlanRunAdmission | null,
): void {
  const structured = q.operationId === "outline_change";
  const requested = structured ? (a ?? undefined) : q.projectTextPlanAdmission;
  if (a === null && requested === undefined) return;
  if (a === null || requested === undefined)
    planStoreFail("project_text_plan_tool_qualification_denied");
  planEqual(a, requested, "project_text_plan_tool_qualification_denied");
  if (
    a.runId !== q.run.runId ||
    a.threadId !== q.run.threadId ||
    a.stageAdmissionDigest !== q.projectStageAdmission?.contentDigest ||
    a.extensionBindingDigest !== q.admission.extensionBindingDigest
  )
    planStoreFail("project_text_plan_tool_qualification_denied");
  planEqual(a.actor, q.actor, "project_text_plan_tool_qualification_denied");
  planEqual(
    a.installation,
    q.installation,
    "project_text_plan_tool_qualification_denied",
  );
  const expected =
    a.kind === "brief"
      ? "brief_append"
      : a.kind === "outline"
        ? "outline_save"
        : "script_save";
  if (
    q.operationId !==
    (structured && a.kind === "outline" ? "outline_change" : expected)
  )
    planStoreFail("project_text_plan_tool_qualification_denied");
  if (structured) return;
  const command = projectToolRunMutationCommand(
    q,
    creativeStoreDigester,
  ).command;
  if (a.kind === "outline") {
    if (!("content" in command) || !("episodes" in command.content))
      planStoreFail("project_text_plan_result_invalid");
    assertProjectTextPlanOutlineEpisodes(
      a,
      command.content.episodes.map((e) => e.episodeId),
    );
  }
}
/** Immutable admission only: no mutable plan lock before the original receipt/project lock. */
export function assertSqliteProjectTextPlanTool(
  db: DatabaseSync,
  q: PlanResultQualification,
): void {
  assertImmutable(
    q,
    loadSqlitePlanAdmission(db, {
      tenantId: q.actor.tenantId,
      runId: q.run.runId,
    }),
  );
}
export async function assertPostgresProjectTextPlanTool(
  c: PoolClient,
  schema: string,
  q: PlanResultQualification,
): Promise<void> {
  assertImmutable(
    q,
    await loadPostgresPlanAdmission(c, schema, {
      tenantId: q.actor.tenantId,
      runId: q.run.runId,
    }),
  );
}
export type PlanToolCheckpoint = Readonly<
  PlanCheckpoint & {
    admission: ProjectTextPlanRunAdmission;
    qualification: PlanResultQualification;
  }
>;
function checkMutable(
  q: PlanResultQualification,
  a: ProjectTextPlanRunAdmission,
  plan: ProjectTextPlan | null,
  step: ProjectTextPlanStep | null,
): PlanToolCheckpoint {
  if (
    plan === null ||
    step === null ||
    plan.state === "revoked" ||
    plan.currentPlanRevision !== a.planRevision ||
    plan.activeStepId !== a.stepId ||
    step.run?.runId !== a.runId ||
    step.run.planAdmissionDigest !== a.contentDigest ||
    step.terminal !== null
  )
    planStoreFail("project_text_plan_result_not_authorized");
  if (
    step.result !== null &&
    (step.result.toolReceiptId !== q.receipt.receiptId ||
      step.result.toolInputDigest !== q.receipt.call.inputDigest)
  )
    planStoreFail("project_text_plan_result_limit");
  return { plan, step, admission: a, qualification: q };
}
export function beginSqlitePlanResult(
  db: DatabaseSync,
  q: PlanResultQualification | undefined,
): PlanToolCheckpoint | null {
  if (q === undefined) return null;
  const a = loadSqlitePlanAdmission(db, {
    tenantId: q.actor.tenantId,
    runId: q.run.runId,
  });
  if (a === null) return null;
  assertImmutable(q, a);
  const plan = decodePlan(
      db
        .prepare(
          "SELECT * FROM project_text_plans WHERE tenant_id=? AND space_id=? AND plan_id=?",
        )
        .get(a.actor.tenantId, a.actor.spaceId, a.planId),
    ),
    step =
      plan === null
        ? null
        : decodePlanStep(
            db
              .prepare(
                "SELECT * FROM project_text_plan_steps WHERE tenant_id=? AND space_id=? AND plan_id=? AND step_id=?",
              )
              .get(a.actor.tenantId, a.actor.spaceId, a.planId, a.stepId),
            plan,
          );
  return checkMutable(q, a, plan, step);
}
export async function beginPostgresPlanResult(
  c: PoolClient,
  schema: string,
  q: PlanResultQualification | undefined,
): Promise<PlanToolCheckpoint | null> {
  if (q === undefined) return null;
  const a = await loadPostgresPlanAdmission(c, schema, {
    tenantId: q.actor.tenantId,
    runId: q.run.runId,
  });
  if (a === null) return null;
  assertImmutable(q, a);
  await advisoryLock(
    c,
    JSON.stringify([
      "creative-project-project",
      schema,
      a.actor.tenantId,
      a.actor.spaceId,
      a.projectId,
    ]),
  );
  await advisoryLock(
    c,
    JSON.stringify([
      "project-text-plan",
      schema,
      a.actor.tenantId,
      a.actor.spaceId,
      a.planId,
    ]),
  );
  const p = `${creativeProjectSchemaName(schema)}.`,
    values = [a.actor.tenantId, a.actor.spaceId, a.planId],
    plan = decodePlan(
      (
        await c.query(
          `SELECT * FROM ${p}project_text_plans WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3 FOR UPDATE`,
          values,
        )
      ).rows[0],
    ),
    step =
      plan === null
        ? null
        : decodePlanStep(
            (
              await c.query(
                `SELECT * FROM ${p}project_text_plan_steps WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3 AND step_id=$4 FOR UPDATE`,
                [...values, a.stepId],
              )
            ).rows[0],
            plan,
          );
  return checkMutable(q, a, plan, step);
}
function resultCheckpoint(
  p: PlanToolCheckpoint,
  result: StoredProjectTextMutationResult | CreativeProjectMutationResult,
): PlanCheckpoint {
  const a = p.admission,
    q = p.qualification,
    identity =
      q.operationId === "outline_change"
        ? {
            receipt: projectStructuredOutlineCommandReceipt(
              q.actor,
              "save-outline",
              q.command,
              creativeStoreDigester,
            ),
          }
        : projectToolRunMutationCommand(q, creativeStoreDigester),
    base = {
      kind: a.kind,
      idempotencyKey: identity.receipt.idempotencyKey,
      requestDigest: identity.receipt.requestDigest,
      runId: a.runId,
      toolReceiptId: q.receipt.receiptId,
      toolInputDigest: q.receipt.call.inputDigest,
    };
  if (a.kind === "brief") {
    if (
      result.kind !== "append-brief" ||
      !("brief" in result) ||
      result.brief === null ||
      result.project.projectId !== a.projectId
    )
      planStoreFail("project_text_plan_result_invalid");
    return checkpointProjectTextPlanResult(
      p.plan,
      p.step,
      {
        ...base,
        briefRevision: result.brief.briefRevision,
        artifactId: null,
        artifactRevision: null,
        contentRevision: null,
        contentDigest: result.brief.contentDigest,
      },
      result.project.updatedAt,
      creativeStoreDigester,
    );
  }
  if (
    result.kind !== (a.kind === "outline" ? "save-outline" : "save-script") ||
    !("artifact" in result) ||
    result.contentRevision === null ||
    result.artifact.projectId !== a.projectId ||
    result.artifact.kind !== a.kind ||
    result.artifact.episodeId !== a.episodeId
  )
    planStoreFail("project_text_plan_result_invalid");
  if (a.kind === "outline") {
    if (result.contentRevision.kind !== "outline")
      planStoreFail("project_text_plan_result_invalid");
    assertProjectTextPlanOutlineEpisodes(
      a,
      result.contentRevision.content.episodes.map((e) => e.episodeId),
    );
  }
  return checkpointProjectTextPlanResult(
    p.plan,
    p.step,
    {
      ...base,
      briefRevision: null,
      artifactId: result.artifact.artifactId,
      artifactRevision: result.artifact.revision,
      contentRevision: result.contentRevision.contentRevision,
      contentDigest: result.contentRevision.contentDigest,
    },
    result.artifact.updatedAt,
    creativeStoreDigester,
  );
}
/** The caller has just read/inserted the original immutable business receipt on this same connection. */
export function finishSqlitePlanResult(
  db: DatabaseSync,
  p: PlanToolCheckpoint | null,
  result: StoredProjectTextMutationResult | CreativeProjectMutationResult,
): void {
  if (p !== null) writeSqlitePlanCheckpoint(db, p, resultCheckpoint(p, result));
}
export async function finishPostgresPlanResult(
  c: PoolClient,
  schema: string,
  p: PlanToolCheckpoint | null,
  result: StoredProjectTextMutationResult | CreativeProjectMutationResult,
): Promise<void> {
  if (p !== null)
    await writePostgresPlanCheckpoint(
      c,
      schema,
      p,
      resultCheckpoint(p, result),
    );
}
