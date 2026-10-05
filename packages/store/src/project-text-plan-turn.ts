import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  captureProjectTextPlanTurnCommitAuthority,
  type CommitExtensionTurnInput,
  type CommitExtensionTurnOptions,
} from "@crewon/application";
import {
  parseProjectTextPlanRunAdmission,
  parseProjectStageRunAdmission,
  extensionCanonicalJson,
  assertProjectTextPlanRunSources,
  checkpointProjectTextPlanAdmission,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  decodePlan,
  decodePlanRevision,
  decodePlanStep,
  planEqual,
  planStoreFail,
  planScope,
} from "./project-text-plan-records.ts";
import {
  assertSqlitePlanSchema,
  assertPostgresPlanSchema,
} from "./project-text-plan-schema.ts";
import {
  loadSqlitePlanAdmission,
  loadPostgresPlanAdmission,
} from "./project-text-plan-markers.ts";
import {
  writeSqlitePlanCheckpoint,
  writePostgresPlanCheckpoint,
  type PlanCheckpoint,
} from "./project-text-plan-checkpoints.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";
import { parseProjectTextArtifact } from "@crewon/domain";
import { planJson } from "./project-text-plan-records.ts";
import { assertPlanTurnSources } from "./project-text-plan-turn-sources.ts";
import {
  assertSqlitePlanResultFacts,
  assertPostgresPlanResultFacts,
} from "./project-text-plan-result-facts.ts";

export function captureProjectTextPlanTurn(
  input: CommitExtensionTurnInput,
  options: CommitExtensionTurnOptions | undefined,
) {
  const a = Object.getOwnPropertyDescriptor(input, "projectTextPlanAdmission"),
    b =
      options === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(options, "projectTextPlanAuthority");
  if (
    (a === undefined && "projectTextPlanAdmission" in input) ||
    (a !== undefined && (!a.enumerable || !Object.hasOwn(a, "value"))) ||
    (options !== undefined &&
      ((b === undefined && "projectTextPlanAuthority" in options) ||
        (b !== undefined && (!b.enumerable || !Object.hasOwn(b, "value")))))
  )
    planStoreFail("project_text_plan_admission_invalid");
  if (a?.value === undefined) {
    if (b !== undefined) planStoreFail("project_text_plan_admission_required");
    return { plan: null, options };
  }
  if (
    b?.value === undefined ||
    input.projectStageAdmission === undefined ||
    input.pluginAdmission === undefined
  )
    planStoreFail("project_text_plan_admission_required");
  const admission = parseProjectTextPlanRunAdmission(
      a.value,
      creativeStoreDigester,
    ),
    q = captureProjectTextPlanTurnCommitAuthority(b.value),
    stage = parseProjectStageRunAdmission(
      input.projectStageAdmission,
      creativeStoreDigester,
    ),
    content = input.turn.thread.messages[0]?.content;
  if (typeof content !== "string") planStoreFail();
  const expectedKey = `plugin-task:${creativeStoreDigester.sha256(extensionCanonicalJson([admission.actor.tenantId, admission.actor.spaceId, admission.installation.profileId, admission.actor.principalId, admission.actor.actorId, admission.installation.pluginId, admission.taskIdempotencyKey])).slice(7)}`;
  if (expectedKey !== admission.idempotencyKey)
    planStoreFail("project_text_plan_admission_invalid");
  assertProjectTextPlanRunSources(
    q.planRevision,
    q.step,
    admission,
    stage,
    creativeStoreDigester,
  );
  if (
    admission.runId !== input.binding.runId ||
    admission.inputDigest !== input.binding.inputDigest ||
    admission.configurationRevision !== input.binding.configurationRevision ||
    admission.configurationDigest !== input.binding.configurationDigest
  )
    planStoreFail("project_text_plan_admission_invalid");
  planEqual(
    q.planRevision.target,
    input.binding.target,
    "project_text_plan_admission_invalid",
  );
  const remaining = Object.create(
    Object.getPrototypeOf(options),
    Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(options!)).filter(
        ([k]) => k !== "projectTextPlanAuthority",
      ),
    ),
  ) as CommitExtensionTurnOptions;
  return {
    plan: Object.freeze({
      admission,
      q,
      stage,
      content,
      expectedThreadRevision: input.turn.thread.expectedRevision,
    }),
    options: Reflect.ownKeys(remaining).length ? remaining : undefined,
  };
}
export type PreparedPlanTurn = NonNullable<
  ReturnType<typeof captureProjectTextPlanTurn>["plan"]
>;
function checked(
  p: PreparedPlanTurn,
  rows: {
    plan: Record<string, unknown> | undefined;
    revision: Record<string, unknown> | undefined;
    step: Record<string, unknown> | undefined;
    head: Record<string, unknown> | undefined;
    steps: readonly Record<string, unknown>[];
  },
  replay: boolean,
): PlanCheckpoint {
  const plan = decodePlan(rows.plan, {
      actor: p.q.plan.owner,
      profileId: p.q.plan.profileId,
    }),
    revision = decodePlanRevision(rows.revision);
  if (plan === null || revision === null)
    planStoreFail("project_text_plan_not_found");
  const step = decodePlanStep(rows.step, plan);
  if (step === null) planStoreFail("project_text_plan_not_found");
  planEqual(revision, p.q.planRevision, "project_text_plan_revision_conflict");
  if (replay) {
    if (
      step.run?.runId !== p.admission.runId ||
      step.run.planAdmissionDigest !== p.admission.contentDigest ||
      step.run.stageAdmissionDigest !== p.stage.contentDigest
    )
      planStoreFail("project_text_plan_admission_conflict");
    return { plan, step };
  }
  planEqual(plan, p.q.plan, "project_text_plan_revision_conflict");
  planEqual(step, p.q.step, "project_text_plan_step_revision_conflict");
  assertPlanTurnSources(
    p.admission,
    revision,
    step,
    rows.steps.map((row) => decodePlanStep(row, plan)!),
  );
  if (p.admission.baseline !== null) {
    const h =
      rows.head === undefined
        ? null
        : parseProjectTextArtifact(planJson(rows.head.record_json));
    planEqual(
      p.admission.baseline,
      {
        kind: p.admission.kind,
        episodeId: p.admission.episodeId,
        artifactId: h?.artifactId ?? null,
        artifactRevision: h?.revision ?? 0,
        selectedContentRevision: h?.selectedContentRevision ?? null,
        locked: h?.locked ?? false,
      },
      "project_text_plan_selection_changed",
    );
  }
  return { plan, step };
}
function queries(p: PreparedPlanTurn, prefix: string) {
  const a = p.admission,
    scope = [a.actor.tenantId, a.actor.spaceId, a.planId];
  return {
    plan: {
      sql: `SELECT * FROM ${prefix}project_text_plans WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3`,
      values: scope,
    },
    revision: {
      sql: `SELECT * FROM ${prefix}project_text_plan_revisions WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3 AND plan_revision=$4`,
      values: [...scope, a.planRevision],
    },
    step: {
      sql: `SELECT * FROM ${prefix}project_text_plan_steps WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3 AND step_id=$4`,
      values: [...scope, a.stepId],
    },
    steps: {
      sql: `SELECT * FROM ${prefix}project_text_plan_steps WHERE tenant_id=$1 AND space_id=$2 AND plan_id=$3 AND plan_revision=$4 ORDER BY ordinal LIMIT 19`,
      values: [...scope, a.planRevision],
    },
    head:
      a.kind === "brief"
        ? null
        : {
            sql: `SELECT * FROM ${prefix}project_text_artifacts WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND kind=$4 AND episode_id=$5`,
            values: [
              a.actor.tenantId,
              a.actor.spaceId,
              a.projectId,
              a.kind,
              a.episodeId ?? "",
            ],
          },
  };
}
export function beginSqlitePlanTurn(
  db: DatabaseSync,
  p: PreparedPlanTurn | null,
  replay: boolean,
): PlanCheckpoint | null {
  if (p === null) return null;
  assertSqlitePlanSchema(db);
  const qs = queries(p, ""),
    read = (q: { sql: string; values: readonly (string | number)[] } | null) =>
      q === null
        ? undefined
        : db.prepare(q.sql.replaceAll(/\$[1-5]/gu, "?")).get(...q.values),
    before = checked(
      p,
      {
        plan: read(qs.plan),
        revision: read(qs.revision),
        step: read(qs.step),
        head: read(qs.head),
        steps: replay
          ? []
          : db
              .prepare(qs.steps.sql.replaceAll(/\$[1-4]/gu, "?"))
              .all(...qs.steps.values),
      },
      replay,
    );
  if (!replay)
    for (const row of db
      .prepare(qs.steps.sql.replaceAll(/\$[1-4]/gu, "?"))
      .all(...qs.steps.values)) {
      const step = decodePlanStep(row, before.plan)!;
      if (
        step.ordinal < before.step.ordinal &&
        step.state === "succeeded" &&
        (step.kind === "brief" || step.kind === "outline")
      )
        assertSqlitePlanResultFacts(db, before.plan, step);
    }
  if (replay)
    planEqual(
      loadSqlitePlanAdmission(db, {
        tenantId: p.admission.actor.tenantId,
        runId: p.admission.runId,
      }),
      p.admission,
      "project_text_plan_admission_conflict",
    );
  return before;
}
export async function beginPostgresPlanTurn(
  c: PoolClient,
  schema: string,
  p: PreparedPlanTurn | null,
  replay: boolean,
): Promise<PlanCheckpoint | null> {
  if (p === null) return null;
  await assertPostgresPlanSchema(c, schema);
  const a = p.admission;
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
  const qs = queries(p, `${creativeProjectSchemaName(schema)}.`),
    read = async (
      q: { sql: string; values: readonly (string | number)[] } | null,
      lock = false,
    ) =>
      q === null
        ? undefined
        : (
            await c.query<Record<string, unknown>>(
              q.sql + (lock ? " FOR UPDATE" : ""),
              [...q.values],
            )
          ).rows[0],
    before = checked(
      p,
      {
        plan: await read(qs.plan, true),
        revision: await read(qs.revision),
        step: await read(qs.step, true),
        head: await read(qs.head, true),
        steps: replay
          ? []
          : (await c.query(qs.steps.sql, [...qs.steps.values])).rows,
      },
      replay,
    );
  if (!replay)
    for (const row of (await c.query(qs.steps.sql, [...qs.steps.values]))
      .rows) {
      const step = decodePlanStep(row, before.plan)!;
      if (
        step.ordinal < before.step.ordinal &&
        step.state === "succeeded" &&
        (step.kind === "brief" || step.kind === "outline")
      )
        await assertPostgresPlanResultFacts(c, schema, before.plan, step);
    }
  if (replay)
    planEqual(
      await loadPostgresPlanAdmission(c, schema, {
        tenantId: a.actor.tenantId,
        runId: a.runId,
      }),
      a,
      "project_text_plan_admission_conflict",
    );
  return before;
}
export function finishSqlitePlanTurn(
  db: DatabaseSync,
  p: PreparedPlanTurn | null,
  before: PlanCheckpoint | null,
): void {
  if (p === null || before === null) return;
  const a = p.admission;
  db.prepare(
    "INSERT INTO project_text_plan_run_admissions VALUES(?,?,?,?,?,?,?)",
  ).run(
    a.actor.tenantId,
    a.actor.spaceId,
    a.runId,
    a.planId,
    a.planRevision,
    a.stepId,
    JSON.stringify(a),
  );
  writeSqlitePlanCheckpoint(
    db,
    before,
    checkpointProjectTextPlanAdmission(
      before.plan,
      before.step,
      a,
      p.content,
      p.expectedThreadRevision,
      a.createdAt,
      creativeStoreDigester,
    ),
  );
}
export async function finishPostgresPlanTurn(
  c: PoolClient,
  schema: string,
  p: PreparedPlanTurn | null,
  before: PlanCheckpoint | null,
): Promise<void> {
  if (p === null || before === null) return;
  const a = p.admission;
  await c.query(
    `INSERT INTO ${creativeProjectSchemaName(schema)}.project_text_plan_run_admissions VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      a.actor.tenantId,
      a.actor.spaceId,
      a.runId,
      a.planId,
      a.planRevision,
      a.stepId,
      JSON.stringify(a),
    ],
  );
  await writePostgresPlanCheckpoint(
    c,
    schema,
    before,
    checkpointProjectTextPlanAdmission(
      before.plan,
      before.step,
      a,
      p.content,
      p.expectedThreadRevision,
      a.createdAt,
      creativeStoreDigester,
    ),
  );
}
export async function assertPlanTurnCurrent(
  p: PreparedPlanTurn | null,
): Promise<void> {
  if (p === null) return;
  await p.q.authority.assertCurrent();
  await p.q.authority.assertTransactionCurrent();
  p.q.authority.assertActive();
}
