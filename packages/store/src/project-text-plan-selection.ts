import {
  assertSqlitePlanResultFacts,
  assertPostgresPlanResultFacts,
} from "./project-text-plan-result-facts.ts";
import { projectStructuredOutlineCommandReceipt } from "@crewon/application";
import { decodeConversation } from "./project-conversation-store-support.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type {
  CreativeProjectCommitAuthority,
  ProjectTextPlanSelectionCommitAuthority,
  ProjectTextMutationKind,
  CreativeProjectMutationReceipt,
  StoredProjectTextMutationResult,
  ActorContext,
} from "@crewon/application";
import {
  advanceProjectTextPlanSelection,
  parseProjectTextArtifact,
  extensionCanonicalJson,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  planEqual,
  planStoreFail,
  planJson,
  decodePlan,
  decodePlanStep,
  decodePlanRevision,
} from "./project-text-plan-records.ts";
import {
  loadSqlitePlanAdmission,
  loadPostgresPlanAdmission,
} from "./project-text-plan-markers.ts";
import {
  assertSqliteProjectTextUiCommit,
  assertPostgresProjectTextUiCommit,
} from "./project-text-ui-commit-support.ts";
import {
  writeSqlitePlanCheckpoint,
  writePostgresPlanCheckpoint,
  type PlanCheckpoint,
} from "./project-text-plan-checkpoints.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";
import { decodeStoredTextReceipt } from "./project-structured-outline-store-support.ts";

export function planSelectionQualification(
  authority: CreativeProjectCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectTextMutationKind,
  receipt: CreativeProjectMutationReceipt,
  dialect: "legacy-text" | "structured-outline" = "legacy-text",
) {
  const q = authority?.planTransaction;
  if (q === undefined) return undefined;
  planEqual(
    actor,
    q.authority.actor,
    "project_text_plan_selection_not_authorized",
  );
  if (
    kind !== "select-revision" ||
    receipt.idempotencyKey !== q.input.idempotencyKey ||
    (dialect === "structured-outline" &&
      (q.result.kind !== "outline" ||
        q.step.kind !== "outline" ||
        q.admission.kind !== "outline")) ||
    receipt.requestDigest !==
      (dialect === "structured-outline"
        ? projectStructuredOutlineCommandReceipt(
            actor,
            "select-revision",
            q.input,
            creativeStoreDigester,
          ).requestDigest
        : creativeStoreDigester.sha256(
            extensionCanonicalJson({
              schemaVersion: "crewon.project-text-command.v1",
              actor,
              kind,
              command: q.input,
            }),
          ))
  )
    planStoreFail("project_text_plan_selection_not_authorized");
  return q;
}
type SelectionCheckpoint = PlanCheckpoint &
  Readonly<{ qualification: ProjectTextPlanSelectionCommitAuthority }>;
function checked(
  q: ProjectTextPlanSelectionCommitAuthority,
  rows: {
    plan: Record<string, unknown> | undefined;
    revision: Record<string, unknown> | undefined;
    step: Record<string, unknown> | undefined;
    head: Record<string, unknown> | undefined;
    receipt: Record<string, unknown> | undefined;
  },
  admission: ReturnType<typeof loadSqlitePlanAdmission>,
): SelectionCheckpoint {
  const plan = decodePlan(rows.plan),
    revision = decodePlanRevision(rows.revision),
    step = plan === null ? null : decodePlanStep(rows.step, plan);
  if (
    plan === null ||
    revision === null ||
    step === null ||
    rows.head === undefined
  )
    planStoreFail("project_text_plan_selection_not_authorized");
  planEqual(
    admission,
    q.admission,
    "project_text_plan_selection_not_authorized",
  );
  planEqual(
    revision,
    q.planRevision,
    "project_text_plan_selection_not_authorized",
  );
  const expectedResult = q.result,
    r = decodeStoredTextReceipt(rows.receipt, {
      actor: q.authority.actor,
      owner: {
        tenantId: q.authority.actor.tenantId,
        spaceId: q.authority.actor.spaceId,
        principalId: q.authority.actor.principalId,
      },
      kind: expectedResult.kind === "outline" ? "save-outline" : "save-script",
      receipt: {
        idempotencyKey: expectedResult.idempotencyKey,
        requestDigest: expectedResult.requestDigest,
      },
    });
  if (
    r === null ||
    r.contentRevision === null ||
    r.artifact.artifactId !== expectedResult.artifactId ||
    r.artifact.revision !== expectedResult.artifactRevision ||
    r.contentRevision.contentRevision !== expectedResult.contentRevision ||
    r.contentRevision.contentDigest !== expectedResult.contentDigest
  )
    planStoreFail("project_text_plan_result_invalid");
  planEqual(step.result, expectedResult, "project_text_plan_result_invalid");
  // A confirmed replay is allowed to observe the already advanced checkpoint unchanged.
  if (step.selection !== null) {
    if (
      step.selection.mode !== "whenUnchanged" ||
      step.selection.idempotencyKey !== q.input.idempotencyKey
    )
      planStoreFail("project_text_plan_selection_changed");
    return { plan, step, qualification: q };
  }
  planEqual(plan, q.plan, "project_text_plan_revision_conflict");
  planEqual(step, q.step, "project_text_plan_step_revision_conflict");
  const h = parseProjectTextArtifact(planJson(rows.head.record_json)),
    baseline = q.admission.baseline;
  if (
    baseline === null ||
    h.locked ||
    h.projectId !== q.plan.projectId ||
    h.ownerPrincipalId !== q.authority.actor.principalId ||
    h.revision !== q.input.expectedArtifactRevision ||
    h.revision !== baseline.artifactRevision + 1 ||
    h.artifactId !== q.input.artifactId ||
    h.selectedContentRevision !== baseline.selectedContentRevision ||
    (baseline.artifactId !== null && baseline.artifactId !== h.artifactId)
  )
    planStoreFail("project_text_plan_selection_changed");
  return { plan, step, qualification: q };
}
function queries(q: ProjectTextPlanSelectionCommitAuthority, p: string) {
  const a = q.admission,
    scope = [a.actor.tenantId, a.actor.spaceId, a.planId],
    project = [a.actor.tenantId, a.actor.spaceId, a.projectId];
  return {
    plan: {
      sql: `SELECT * FROM ${p}project_text_plans WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3`,
      values: scope,
    },
    revision: {
      sql: `SELECT * FROM ${p}project_text_plan_revisions WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3 AND plan_revision=$4`,
      values: [...scope, a.planRevision],
    },
    step: {
      sql: `SELECT * FROM ${p}project_text_plan_steps WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3 AND step_id=$4`,
      values: [...scope, a.stepId],
    },
    head: {
      sql: `SELECT * FROM ${p}project_text_artifacts WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND artifact_id=$4`,
      values: [...project, q.input.artifactId],
    },
    receipt: {
      sql: `SELECT * FROM ${p}project_text_mutation_receipts WHERE tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND kind=$5 AND idempotency_key=$6`,
      values: [
        a.actor.tenantId,
        a.actor.spaceId,
        a.actor.principalId,
        a.actor.actorId,
        q.result.kind === "outline" ? "save-outline" : "save-script",
        q.result.idempotencyKey,
      ],
    },
  };
}
export function beginSqlitePlanSelection(
  db: DatabaseSync,
  q: ProjectTextPlanSelectionCommitAuthority | undefined,
): SelectionCheckpoint | null {
  if (q === undefined) return null;
  assertSqliteProjectTextUiCommit(db, {
    ...q.authority,
    installation: q.authority.binding.currentInstallation,
  });
  const admission = loadSqlitePlanAdmission(db, {
      tenantId: q.admission.actor.tenantId,
      runId: q.admission.runId,
    }),
    qs = queries(q, ""),
    read = (v: { sql: string; values: readonly (string | number)[] }) =>
      db.prepare(v.sql.replaceAll(/\$[1-6]/gu, "?")).get(...v.values);
  planEqual(
    decodeConversation(
      db
        .prepare(
          "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
        )
        .get(
          q.admission.actor.tenantId,
          q.admission.actor.spaceId,
          q.admission.bindingId,
        ),
    ),
    q.authority.binding,
    "project_text_plan_binding_changed",
  );
  const result = checked(
    q,
    {
      plan: read(qs.plan),
      revision: read(qs.revision),
      step: read(qs.step),
      head: read(qs.head),
      receipt: read(qs.receipt),
    },
    admission,
  );
  assertSqlitePlanResultFacts(db, result.plan, result.step);
  return result;
}
export async function beginPostgresPlanSelection(
  c: PoolClient,
  schema: string,
  q: ProjectTextPlanSelectionCommitAuthority | undefined,
): Promise<SelectionCheckpoint | null> {
  if (q === undefined) return null;
  await assertPostgresProjectTextUiCommit(c, schema, {
    ...q.authority,
    installation: q.authority.binding.currentInstallation,
  });
  const a = q.admission;
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
  const admission = await loadPostgresPlanAdmission(c, schema, {
      tenantId: a.actor.tenantId,
      runId: a.runId,
    }),
    qs = queries(q, `${creativeProjectSchemaName(schema)}.`),
    read = async (
      v: { sql: string; values: readonly (string | number)[] },
      lock = false,
    ) =>
      (
        await c.query<Record<string, unknown>>(
          v.sql + (lock ? " FOR UPDATE" : ""),
          [...v.values],
        )
      ).rows[0];
  planEqual(
    decodeConversation(
      (
        await c.query(
          `SELECT * FROM ${creativeProjectSchemaName(schema)}.project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3`,
          [a.actor.tenantId, a.actor.spaceId, a.bindingId],
        )
      ).rows[0],
    ),
    q.authority.binding,
    "project_text_plan_binding_changed",
  );
  const result = checked(
    q,
    {
      plan: await read(qs.plan, true),
      revision: await read(qs.revision),
      step: await read(qs.step, true),
      head: await read(qs.head, true),
      receipt: await read(qs.receipt),
    },
    admission,
  );
  await assertPostgresPlanResultFacts(c, schema, result.plan, result.step);
  return result;
}
function afterSelection(
  p: SelectionCheckpoint,
  result: StoredProjectTextMutationResult,
  steps: readonly import("@crewon/domain").ProjectTextPlanStep[],
): PlanCheckpoint {
  const q = p.qualification;
  if (
    result.kind !== "select-revision" ||
    result.contentRevision === null ||
    result.artifact.artifactId !== q.input.artifactId ||
    result.artifact.selectedContentRevision !== q.input.contentRevision ||
    result.contentRevision.contentDigest !== q.result.contentDigest
  )
    planStoreFail("project_text_plan_selection_not_authorized");
  if (p.step.selection !== null) return p;
  const receiptDigest =
    result.contentRevision.schemaVersion === "crewon.project-text-revision.v2"
      ? projectStructuredOutlineCommandReceipt(
          q.authority.actor,
          "select-revision",
          q.input,
          creativeStoreDigester,
        ).requestDigest
      : creativeStoreDigester.sha256(
          extensionCanonicalJson({
            schemaVersion: "crewon.project-text-command.v1",
            actor: q.authority.actor,
            kind: "select-revision",
            command: q.input,
          }),
        );
  return advanceProjectTextPlanSelection(
    p.plan,
    p.step,
    {
      mode: "whenUnchanged",
      idempotencyKey: q.input.idempotencyKey,
      requestDigest: receiptDigest,
      artifactId: result.artifact.artifactId,
      artifactRevision: result.artifact.revision,
      contentRevision: result.contentRevision.contentRevision,
      contentDigest: result.contentRevision.contentDigest,
    },
    steps,
    result.artifact.updatedAt,
    creativeStoreDigester,
  );
}
export function finishSqlitePlanSelection(
  db: DatabaseSync,
  p: SelectionCheckpoint | null,
  result: StoredProjectTextMutationResult,
): void {
  if (p === null) return;
  const a = p.qualification.admission,
    steps = db
      .prepare(
        "SELECT * FROM project_text_plan_steps WHERE tenant_id=? AND space_id=? AND plan_id=? AND plan_revision=? ORDER BY ordinal LIMIT 19",
      )
      .all(a.actor.tenantId, a.actor.spaceId, a.planId, a.planRevision)
      .map((r) => decodePlanStep(r, p.plan)!);
  if (steps.length > 18) planStoreFail();
  writeSqlitePlanCheckpoint(db, p, afterSelection(p, result, steps));
}
export async function finishPostgresPlanSelection(
  c: PoolClient,
  schema: string,
  p: SelectionCheckpoint | null,
  result: StoredProjectTextMutationResult,
): Promise<void> {
  if (p === null) return;
  const a = p.qualification.admission,
    steps = (
      await c.query(
        `SELECT * FROM ${creativeProjectSchemaName(schema)}.project_text_plan_steps WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3 AND plan_revision=$4 ORDER BY ordinal LIMIT 19 FOR UPDATE`,
        [a.actor.tenantId, a.actor.spaceId, a.planId, a.planRevision],
      )
    ).rows.map((r) => decodePlanStep(r, p.plan)!);
  if (steps.length > 18) planStoreFail();
  await writePostgresPlanCheckpoint(
    c,
    schema,
    p,
    afterSelection(p, result, steps),
  );
}
