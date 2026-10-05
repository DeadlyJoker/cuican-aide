import { assertSqliteProjectTextPlanTool } from "./project-text-plan-tool.ts";
import { assertSqliteProjectStageTool } from "./project-stage-run-tool-qualification.ts";
import type { DatabaseSync } from "node:sqlite";
import { assertSqliteProjectRunSchema } from "./creative-project-run-commit-schema.ts";
import {
  assertSqlitePluginInstallationPinSchema,
  admitSqliteProjectToolInstallationPin,
} from "./plugin-installation-pin-store-support.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";
import { loadSqlitePluginTaskByReceipt } from "./plugin-task-admission-store-support.ts";
import {
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import { loadSqliteToolExecutionReceipt } from "./sqlite-tool-execution-receipts.ts";
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
  denied,
  type ProjectRunQualification,
} from "./creative-project-run-commit-support.ts";

/** Synchronous only: called after BEGIN IMMEDIATE, and once more immediately before COMMIT. */
export function assertSqliteProjectRunCommit(
  db: DatabaseSync,
  q: ProjectRunQualification | undefined,
): void {
  if (q === undefined) return;
  assertSqliteProjectRunSchema(db);
  assertSqlitePluginInstallationPinSchema(db);
  assertCreativeProjectPluginCommitSelection(
    q,
    admitSqliteProjectToolInstallationPin(db, q.installation),
  );
  const locator = { tenantId: q.actor.tenantId, runId: q.run.runId };
  const snapshot = db
    .prepare(projectRunSnapshotQuery("").replaceAll(/\$[12]/gu, "?"))
    .get(locator.tenantId, locator.runId);
  const run =
    snapshot === undefined
      ? null
      : decodePostgresRunState(
          {
            ...snapshot,
            state_json: projectRunJson(snapshot.state_json),
          } as unknown as PostgresRunRow,
          locator,
        );
  const receipt = loadSqliteToolExecutionReceipt(db, {
    ...locator,
    receiptId: q.receipt.receiptId,
  });
  const step = loadSqliteRunStep(db, { ...locator, stepId: q.receipt.stepId });
  const originalAttempt = loadSqliteRunAttempt(db, {
    ...locator,
    stepId: q.receipt.stepId,
    attemptId: q.receipt.attemptId,
  });
  const currentAttempt = step?.currentAttemptId
    ? loadSqliteRunAttempt(db, {
        ...locator,
        stepId: step.stepId,
        attemptId: step.currentAttemptId,
      })
    : null;
  const admission = loadSqlitePluginTaskByReceipt(
    db,
    projectRunReceiptLocator(q),
  );
  const binding = db
    .prepare(projectRunBindingQuery("").replaceAll(/\$[12]/gu, "?"))
    .get(locator.tenantId, locator.runId);
  if (binding === undefined) denied();
  assertProjectRunExecution(q, {
    run,
    receipt,
    step,
    originalAttempt,
    currentAttempt,
    admission,
    binding: projectRunJson(binding.binding_json),
    configuration: projectRunJson(binding.configuration_json),
  });
  assertSqliteProjectStageTool(db, q);
  assertSqliteProjectTextPlanTool(db, q);
  assertSqliteProjectRunLease(db, q);
}
export function assertSqliteProjectRunLease(
  db: DatabaseSync,
  q: ProjectRunQualification | undefined,
): void {
  if (q === undefined) return;
  assertProjectRunQueue(
    q,
    db
      .prepare("SELECT * FROM work_items WHERE work_item_id=?")
      .get(q.receipt.workItemId),
    Date.now(),
  );
}
