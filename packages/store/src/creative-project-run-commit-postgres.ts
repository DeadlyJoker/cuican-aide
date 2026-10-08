import { assertPostgresProjectTextPlanTool } from "./project-text-plan-tool.ts";
import { assertPostgresProjectStageTool } from "./project-stage-run-tool-qualification.ts";
import type { PoolClient } from "pg";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import { assertPostgresProjectRunSchema } from "./creative-project-run-commit-schema.ts";
import {
  assertPostgresPluginInstallationPinSchema,
  admitPostgresProjectToolInstallationPin,
} from "./plugin-installation-pin-store-support.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";
import { loadPostgresPluginTaskByReceipt } from "./plugin-task-admission-store-support.ts";
import {
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
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
  denied,
  type ProjectRunQualification,
  type ProjectRunExecutionEvidence,
  type InstalledProjectRunExecutionEvidence,
} from "./creative-project-run-commit-support.ts";

/** Same borrowed transaction connection; installation rows, Run, then queue/Tool locks. */
export async function assertPostgresProjectRunCommit(
  client: PoolClient,
  schema: string,
  q: ProjectRunQualification | undefined,
): Promise<void> {
  if (q === undefined) return;
  await assertPostgresInstalledProjectRunExecution(client, schema, q);
  await assertPostgresProjectStageTool(client, schema, q);
  await assertPostgresProjectTextPlanTool(client, schema, q);
}
/** Shared actual execution facts, without borrowing another business protocol's operation grant. */
export async function assertPostgresInstalledProjectRunExecution(
  client: PoolClient,
  schema: string,
  q: InstalledProjectRunExecutionEvidence,
): Promise<void> {
  const prefix = `${pluginInstallationSchemaName(schema)}.`;
  await assertPostgresProjectRunSchema(client, schema);
  await assertPostgresPluginInstallationPinSchema(client, schema);
  assertCreativeProjectPluginCommitSelection(
    q,
    await admitPostgresProjectToolInstallationPin(
      client,
      schema,
      q.installation,
    ),
  );
  // Matches the original execution Store's lock namespace and Run -> WorkItem order.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `run:${q.actor.tenantId}:${q.run.runId}`,
  ]);
  await assertPostgresProjectRunLease(client, schema, q);
  const locator = { tenantId: q.actor.tenantId, runId: q.run.runId };
  const snapshot = (
    await client.query<PostgresRunRow>(
      `${projectRunSnapshotQuery(prefix)} FOR UPDATE OF s`,
      [locator.tenantId, locator.runId],
    )
  ).rows[0];
  const run =
    snapshot === undefined ? null : decodePostgresRunState(snapshot, locator);
  const receipt = await loadPostgresToolExecutionReceipt(
    client,
    pluginInstallationSchemaName(schema),
    { ...locator, receiptId: q.receipt.receiptId },
    true,
  );
  const step = await loadPostgresRunStep(
    client,
    pluginInstallationSchemaName(schema),
    { ...locator, stepId: q.receipt.stepId },
    true,
  );
  const originalAttempt = await loadPostgresRunAttempt(
    client,
    pluginInstallationSchemaName(schema),
    { ...locator, stepId: q.receipt.stepId, attemptId: q.receipt.attemptId },
    true,
  );
  const currentAttempt = step?.currentAttemptId
    ? await loadPostgresRunAttempt(
        client,
        pluginInstallationSchemaName(schema),
        { ...locator, stepId: step.stepId, attemptId: step.currentAttemptId },
        true,
      )
    : null;
  const admission = await loadPostgresPluginTaskByReceipt(
    client,
    schema,
    projectRunReceiptLocator(q),
  );
  const binding = (
    await client.query<Record<string, unknown>>(
      projectRunBindingQuery(prefix),
      [locator.tenantId, locator.runId],
    )
  ).rows[0];
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
}
/** The physical database clock is re-read after every async fence, immediately before COMMIT. */
export async function assertPostgresProjectRunLease(
  client: PoolClient,
  schema: string,
  q: ProjectRunExecutionEvidence | undefined,
): Promise<void> {
  if (q === undefined) return;
  const row = (
    await client.query<Record<string, unknown>>(
      `SELECT *,clock_timestamp() AS database_now
    FROM ${pluginInstallationSchemaName(schema)}.work_items WHERE work_item_id=$1 FOR UPDATE`,
      [q.receipt.workItemId],
    )
  ).rows[0];
  assertProjectRunQueue(
    q,
    row,
    row?.database_now instanceof Date
      ? row.database_now.getTime()
      : Date.parse(String(row?.database_now)),
  );
}
