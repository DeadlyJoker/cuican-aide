import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type {
  ProjectAssetCommitAuthority,
  ProjectAssetRunCommitTransactionAuthority,
} from "@crewon/application";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  extensionCanonicalJson,
  extensionToolName,
  projectAssetFailure,
} from "@crewon/domain";
import {
  assertSqliteProjectTextUiCommit,
  assertPostgresProjectTextUiCommit,
} from "./project-text-ui-commit-support.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  assertSqliteProjectRunSchema,
  assertPostgresProjectRunSchema,
} from "./creative-project-run-commit-schema.ts";
import {
  loadSqlitePluginTaskByReceipt,
  loadPostgresPluginTaskByReceipt,
} from "./plugin-task-admission-store-support.ts";
import {
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import {
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import { loadSqliteToolExecutionReceipt } from "./sqlite-tool-execution-receipts.ts";
import { loadPostgresToolExecutionReceipt } from "./postgres-tool-execution.ts";
import {
  decodePostgresRunState,
  type PostgresRunRow,
} from "./postgres-run-codec.ts";
import {
  assertProjectRunExecution,
  assertProjectRunQueue,
  projectRunReceiptLocator,
  projectRunSnapshotQuery,
  projectRunBindingQuery,
  projectRunJson,
} from "./creative-project-run-commit-support.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertSqliteProjectAssetStageTool,
  assertPostgresProjectAssetStageTool,
} from "./project-asset-stage-tool.ts";

function exactTool(q: ProjectAssetRunCommitTransactionAuthority) {
  if (
    q.receipt.call.inputDigest !==
      creativeStoreDigester.sha256(q.commandInput) ||
    q.receipt.call.name !==
      extensionToolName(q.installation.pluginId, q.operationId) ||
    q.receipt.actionIntent?.capability !== "project.asset.write" ||
    q.receipt.actionDigest !==
      creativeStoreDigester.sha256(
        canonicalActionIntent(q.receipt.actionIntent),
      )
  )
    projectAssetFailure("project_asset_run_qualification_denied");
}
export function assertSqliteProjectAssetQualification(
  db: DatabaseSync,
  authority: ProjectAssetCommitAuthority | undefined,
): void {
  const q = authority?.uiTransaction ?? authority?.runTransaction;
  if (!q) return;
  // This existing helper checks only the actual installation tables, never a text action or text grant.
  assertSqliteProjectTextUiCommit(db, q);
  const r = authority!.runTransaction;
  if (!r) return;
  exactTool(r);
  assertSqliteProjectRunSchema(db);
  const locator = { tenantId: r.actor.tenantId, runId: r.run.runId },
    raw = db
      .prepare(projectRunSnapshotQuery("").replaceAll(/\$[12]/gu, "?"))
      .get(locator.tenantId, locator.runId);
  const run =
    raw === undefined
      ? null
      : decodePostgresRunState(
          {
            ...raw,
            state_json: projectRunJson(raw.state_json),
          } as unknown as PostgresRunRow,
          locator,
        );
  const receipt = loadSqliteToolExecutionReceipt(db, {
      ...locator,
      receiptId: r.receipt.receiptId,
    }),
    step = loadSqliteRunStep(db, { ...locator, stepId: r.receipt.stepId });
  const originalAttempt = loadSqliteRunAttempt(db, {
      ...locator,
      stepId: r.receipt.stepId,
      attemptId: r.receipt.attemptId,
    }),
    currentAttempt = step?.currentAttemptId
      ? loadSqliteRunAttempt(db, {
          ...locator,
          stepId: step.stepId,
          attemptId: step.currentAttemptId,
        })
      : null;
  const admission = loadSqlitePluginTaskByReceipt(
      db,
      projectRunReceiptLocator(r),
    ),
    binding = db
      .prepare(projectRunBindingQuery("").replaceAll(/\$[12]/gu, "?"))
      .get(locator.tenantId, locator.runId);
  if (!binding) projectAssetFailure("project_asset_run_qualification_denied");
  assertProjectRunExecution(r, {
    run,
    receipt,
    step,
    originalAttempt,
    currentAttempt,
    admission,
    binding: projectRunJson(binding.binding_json),
    configuration: projectRunJson(binding.configuration_json),
  });
  assertSqliteProjectAssetStageTool(db, r);
  assertProjectRunQueue(
    r,
    db
      .prepare("SELECT * FROM work_items WHERE work_item_id=?")
      .get(r.receipt.workItemId),
    Date.now(),
  );
}
export async function assertPostgresProjectAssetQualification(
  c: PoolClient,
  schema: string,
  authority: ProjectAssetCommitAuthority | undefined,
): Promise<void> {
  const q = authority?.uiTransaction ?? authority?.runTransaction;
  if (!q) return;
  await assertPostgresProjectTextUiCommit(c, schema, q);
  const r = authority!.runTransaction;
  if (!r) return;
  exactTool(r);
  await assertPostgresProjectRunSchema(c, schema);
  const p = `${creativeProjectSchemaName(schema)}.`,
    locator = { tenantId: r.actor.tenantId, runId: r.run.runId };
  const raw = (
      await c.query<PostgresRunRow>(projectRunSnapshotQuery(p), [
        locator.tenantId,
        locator.runId,
      ])
    ).rows[0],
    run = raw === undefined ? null : decodePostgresRunState(raw, locator);
  const receipt = await loadPostgresToolExecutionReceipt(c, schema, {
      ...locator,
      receiptId: r.receipt.receiptId,
    }),
    step = await loadPostgresRunStep(c, schema, {
      ...locator,
      stepId: r.receipt.stepId,
    });
  const originalAttempt = await loadPostgresRunAttempt(c, schema, {
      ...locator,
      stepId: r.receipt.stepId,
      attemptId: r.receipt.attemptId,
    }),
    currentAttempt = step?.currentAttemptId
      ? await loadPostgresRunAttempt(c, schema, {
          ...locator,
          stepId: step.stepId,
          attemptId: step.currentAttemptId,
        })
      : null;
  const admission = await loadPostgresPluginTaskByReceipt(
      c,
      schema,
      projectRunReceiptLocator(r),
    ),
    binding = (
      await c.query<Record<string, unknown>>(projectRunBindingQuery(p), [
        locator.tenantId,
        locator.runId,
      ])
    ).rows[0];
  if (!binding) projectAssetFailure("project_asset_run_qualification_denied");
  assertProjectRunExecution(r, {
    run,
    receipt,
    step,
    originalAttempt,
    currentAttempt,
    admission,
    binding: projectRunJson(binding.binding_json),
    configuration: projectRunJson(binding.configuration_json),
  });
  await assertPostgresProjectAssetStageTool(c, schema, r);
  assertProjectRunQueue(
    r,
    (
      await c.query<Record<string, unknown>>(
        `SELECT * FROM ${p}work_items WHERE work_item_id=$1 FOR SHARE`,
        [r.receipt.workItemId],
      )
    ).rows[0],
    Date.now(),
  );
}
