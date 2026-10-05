import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { ProjectTextPlan, ProjectTextPlanStep } from "@crewon/domain";
import {
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
} from "@crewon/domain";
import {
  decodeCreativeProject,
  decodeCreativeBrief,
  creativeStoreDigester,
} from "./creative-project-store-records.ts";
import { decodeTextReceipt } from "./project-text-store-support.ts";
import { planJson, planStoreFail } from "./project-text-plan-records.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertSqlitePlanResultFacts,
  assertPostgresPlanResultFacts,
} from "./project-text-plan-result-facts.ts";

type Rows = {
  project: Record<string, unknown> | undefined;
  brief: Record<string, unknown> | undefined;
  head: Record<string, unknown> | undefined;
  outline: Record<string, unknown> | undefined;
  selected: Record<string, unknown> | undefined;
};
function checked(
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
  rows: Rows,
): void {
  const r = step.result,
    s = step.selection;
  if (
    r === null ||
    r.kind === "brief" ||
    s === null ||
    step.sources?.brief === null ||
    step.sources === null
  )
    planStoreFail("project_text_plan_selection_required");
  const project = decodeCreativeProject(
      rows.project,
      plan.owner,
      plan.projectId,
    ),
    brief = decodeCreativeBrief(rows.brief, plan.owner, plan.projectId);
  if (
    project === null ||
    project.state !== "active" ||
    brief === null ||
    project.latestBriefRevision !== step.sources.brief.briefRevision ||
    brief.contentDigest !== step.sources.brief.contentDigest
  )
    planStoreFail("project_text_plan_source_changed");
  if (rows.head === undefined)
    planStoreFail("project_text_plan_selection_changed");
  const head = parseProjectTextArtifact(planJson(rows.head.record_json));
  if (
    head.projectId !== plan.projectId ||
    head.ownerPrincipalId !== plan.owner.principalId ||
    head.artifactId !== r.artifactId ||
    head.kind !== step.kind ||
    head.episodeId !== step.episodeId ||
    head.selectedContentRevision !== r.contentRevision ||
    head.revision < s.artifactRevision
  )
    planStoreFail("project_text_plan_selection_changed");
  if (step.kind === "script" && step.sources.outline !== null) {
    if (rows.outline === undefined)
      planStoreFail("project_text_plan_source_changed");
    const h = parseProjectTextArtifact(planJson(rows.outline.head_json)),
      v = parseProjectTextArtifactRevision(
        planJson(rows.outline.revision_json),
        creativeStoreDigester,
      ),
      source = step.sources.outline;
    if (
      h.kind !== "outline" ||
      h.artifactId !== source.artifactId ||
      h.selectedContentRevision !== source.contentRevision ||
      v.contentDigest !== source.contentDigest
    )
      planStoreFail("project_text_plan_source_changed");
  }
  const receipt = decodeTextReceipt(rows.selected, {
    actor: plan.owner,
    owner: {
      tenantId: plan.owner.tenantId,
      spaceId: plan.owner.spaceId,
      principalId: plan.owner.principalId,
    },
    kind: "select-revision",
    receipt: {
      idempotencyKey: s.idempotencyKey,
      requestDigest: s.requestDigest,
    },
  });
  if (
    receipt === null ||
    receipt.artifact.artifactId !== r.artifactId ||
    receipt.artifact.revision !== s.artifactRevision ||
    receipt.artifact.selectedContentRevision !== r.contentRevision ||
    receipt.contentRevision?.contentDigest !== r.contentDigest
  )
    planStoreFail("project_text_plan_selection_changed");
}
function queries(plan: ProjectTextPlan, step: ProjectTextPlanStep, p: string) {
  const scope = [plan.owner.tenantId, plan.owner.spaceId, plan.projectId],
    s = step.selection!,
    source = step.sources!.outline;
  return {
    project: {
      sql: `SELECT * FROM ${p}creative_projects WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3`,
      values: scope,
    },
    brief: {
      sql: `SELECT b.*,p.owner_principal_id FROM ${p}creative_project_briefs b JOIN ${p}creative_projects p ON p.tenant_id=b.tenant_id AND p.space_id=b.space_id AND p.project_id=b.project_id WHERE b.tenant_id=$1 AND b.space_id=$2 AND b.project_id=$3 AND b.brief_revision=$4`,
      values: [...scope, step.sources!.brief!.briefRevision],
    },
    head: {
      sql: `SELECT * FROM ${p}project_text_artifacts WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND artifact_id=$4`,
      values: [...scope, s.artifactId],
    },
    outline:
      source === null
        ? null
        : {
            sql: `SELECT h.record_json AS head_json,c.record_json AS revision_json FROM ${p}project_text_artifacts h JOIN ${p}project_text_revisions c ON c.tenant_id=h.tenant_id AND c.space_id=h.space_id AND c.project_id=h.project_id AND c.artifact_id=h.artifact_id WHERE h.tenant_id=$1 AND h.space_id=$2 AND h.project_id=$3 AND h.artifact_id=$4 AND c.content_revision=$5`,
            values: [...scope, source.artifactId, source.contentRevision],
          },
    selected: {
      sql: `SELECT * FROM ${p}project_text_mutation_receipts WHERE tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND kind='select-revision' AND idempotency_key=$5`,
      values: [
        plan.owner.tenantId,
        plan.owner.spaceId,
        plan.owner.principalId,
        plan.owner.actorId,
        s.idempotencyKey,
      ],
    },
  };
}
function active(
  plan: ProjectTextPlan,
  steps: readonly ProjectTextPlanStep[],
): ProjectTextPlanStep {
  const step = steps.find((s) => s.stepId === plan.activeStepId);
  if (
    step === undefined ||
    step.selection === null ||
    step.sources?.brief == null
  )
    planStoreFail("project_text_plan_selection_required");
  return step;
}
export function assertSqlitePlanContinuation(
  db: DatabaseSync,
  plan: ProjectTextPlan,
  steps: readonly ProjectTextPlanStep[],
): void {
  const step = active(plan, steps);
  assertSqlitePlanResultFacts(db, plan, step);
  const q = queries(plan, step, ""),
    read = (x: { sql: string; values: readonly (string | number)[] } | null) =>
      x === null
        ? undefined
        : db.prepare(x.sql.replaceAll(/\$[1-5]/gu, "?")).get(...x.values);
  checked(plan, step, {
    project: read(q.project),
    brief: read(q.brief),
    head: read(q.head),
    outline: read(q.outline),
    selected: read(q.selected),
  });
}
export async function assertPostgresPlanContinuation(
  c: PoolClient,
  schema: string,
  plan: ProjectTextPlan,
  steps: readonly ProjectTextPlanStep[],
): Promise<void> {
  const step = active(plan, steps);
  await assertPostgresPlanResultFacts(c, schema, plan, step);
  const q = queries(plan, step, `${creativeProjectSchemaName(schema)}.`),
    read = async (
      x: { sql: string; values: readonly (string | number)[] } | null,
    ) =>
      x === null ? undefined : (await c.query(x.sql, [...x.values])).rows[0];
  checked(plan, step, {
    project: await read(q.project),
    brief: await read(q.brief),
    head: await read(q.head),
    outline: await read(q.outline),
    selected: await read(q.selected),
  });
}
