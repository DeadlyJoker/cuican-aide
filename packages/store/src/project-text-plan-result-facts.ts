import {
  assertSqliteTextPlanProject,
  assertPostgresTextPlanProject,
  assertSqliteTextPlanReceiptProject,
  assertPostgresTextPlanReceiptProject,
} from "./project-text-plan-legacy-access.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type {
  ProjectTextPlan,
  ProjectTextPlanStep,
  ToolExecutionReceiptState,
} from "@crewon/domain";
import { decodeCreativeReceipt } from "./creative-project-store-records.ts";
import { decodeStoredTextReceipt } from "./project-structured-outline-store-support.ts";
import { loadSqliteToolExecutionReceipt } from "./sqlite-tool-execution-receipts.ts";
import { loadPostgresToolExecutionReceipt } from "./postgres-tool-execution.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { planStoreFail } from "./project-text-plan-records.ts";

function facts(
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
  row: Record<string, unknown> | undefined,
  tool: ToolExecutionReceiptState | null,
): void {
  const r = step.result;
  if (r === null) return;
  if (
    tool === null ||
    tool.runId !== r.runId ||
    tool.receiptId !== r.toolReceiptId ||
    tool.call.inputDigest !== r.toolInputDigest ||
    r.runId !== step.run?.runId
  )
    planStoreFail("project_text_plan_result_invalid");
  const owner = {
      tenantId: plan.owner.tenantId,
      spaceId: plan.owner.spaceId,
      principalId: plan.owner.principalId,
    },
    receipt = {
      idempotencyKey: r.idempotencyKey,
      requestDigest: r.requestDigest,
    };
  if (r.kind === "brief") {
    const value = decodeCreativeReceipt(row, {
      actor: plan.owner,
      owner,
      kind: "append-brief",
      receipt,
    });
    if (
      value === null ||
      value.kind !== "append-brief" ||
      value.brief?.briefRevision !== r.briefRevision ||
      value.brief?.contentDigest !== r.contentDigest ||
      value.project.projectId !== plan.projectId
    )
      planStoreFail("project_text_plan_result_invalid");
  } else {
    const value = decodeStoredTextReceipt(row, {
      actor: plan.owner,
      owner,
      kind: r.kind === "outline" ? "save-outline" : "save-script",
      receipt,
    });
    if (
      value === null ||
      value.artifact.projectId !== plan.projectId ||
      value.artifact.artifactId !== r.artifactId ||
      value.artifact.revision !== r.artifactRevision ||
      value.artifact.episodeId !== step.episodeId ||
      value.contentRevision?.contentRevision !== r.contentRevision ||
      value.contentRevision?.contentDigest !== r.contentDigest
    )
      planStoreFail("project_text_plan_result_invalid");
  }
}
function query(
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
  prefix: string,
) {
  const r = step.result!;
  return {
    sql: `SELECT * FROM ${prefix}${r.kind === "brief" ? "creative_project_mutation_receipts" : "project_text_mutation_receipts"} WHERE tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND kind=$5 AND idempotency_key=$6`,
    values: [
      plan.owner.tenantId,
      plan.owner.spaceId,
      plan.owner.principalId,
      plan.owner.actorId,
      r.kind === "brief"
        ? "append-brief"
        : r.kind === "outline"
          ? "save-outline"
          : "save-script",
      r.idempotencyKey,
    ],
  };
}
export function assertSqlitePlanResultFacts(
  db: DatabaseSync,
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
): void {
  assertSqliteTextPlanProject(db, plan.owner, plan.projectId);
  if (step.result === null) return;
  const q = query(plan, step, ""),
    row = db.prepare(q.sql.replaceAll(/\$[1-6]/gu, "?")).get(...q.values);
  assertSqliteTextPlanReceiptProject(db, row);
  facts(
    plan,
    step,
    row,
    loadSqliteToolExecutionReceipt(db, {
      tenantId: plan.owner.tenantId,
      runId: step.result.runId,
      receiptId: step.result.toolReceiptId,
    }),
  );
}
export async function assertPostgresPlanResultFacts(
  c: PoolClient,
  schema: string,
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
): Promise<void> {
  await assertPostgresTextPlanProject(c, schema, plan.owner, plan.projectId);
  if (step.result === null) return;
  const q = query(plan, step, `${creativeProjectSchemaName(schema)}.`),
    row = (await c.query(q.sql, q.values)).rows[0];
  await assertPostgresTextPlanReceiptProject(c, schema, row);
  facts(
    plan,
    step,
    row,
    await loadPostgresToolExecutionReceipt(
      c,
      creativeProjectSchemaName(schema),
      {
        tenantId: plan.owner.tenantId,
        runId: step.result.runId,
        receiptId: step.result.toolReceiptId,
      },
    ),
  );
}
