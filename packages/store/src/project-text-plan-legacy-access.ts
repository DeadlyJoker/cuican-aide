import type { DatabaseSync } from "node:sqlite";
import type { PoolClient, Pool } from "pg";
import type {
  CreativeProjectScope,
  CreativeProjectActor,
  ProjectTextPlan,
} from "@crewon/domain";
import type { ProjectTextPlanCommitAuthority } from "@crewon/application";
import {
  captureSqliteCreativeProjectLegacyAccess,
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
} from "./creative-project-legacy-access.ts";

export function textPlanProjectScope(
  actor: CreativeProjectActor,
  projectId: string,
): CreativeProjectScope {
  return { tenantId: actor.tenantId, spaceId: actor.spaceId, projectId };
}
/** Only negative original-DB checks; a saved record is never an authority. */
export function assertSqliteTextPlanProject(
  db: DatabaseSync,
  actor: CreativeProjectActor,
  projectId: string,
): void {
  if (!db.isTransaction)
    throw new Error("creative_project_legacy_transaction_required");
  captureSqliteCreativeProjectLegacyAccess(db).assertProject(
    textPlanProjectScope(actor, projectId),
  );
}
export async function assertPostgresTextPlanProject(
  c: PoolClient,
  schema: string,
  actor: CreativeProjectActor,
  projectId: string,
): Promise<void> {
  await lockPostgresCreativeProjectLegacySchema(c, schema);
  await (
    await capturePostgresCreativeProjectLegacyAccess(c, schema)
  ).assertProject(textPlanProjectScope(actor, projectId));
}
export function assertSqliteTextPlanReceiptProject(
  db: DatabaseSync,
  row: Record<string, unknown> | undefined,
): void {
  if (!db.isTransaction)
    throw new Error("creative_project_legacy_transaction_required");
  if (row !== undefined)
    captureSqliteCreativeProjectLegacyAccess(db).assertProject({
      tenantId: String(row.tenant_id),
      spaceId: String(row.space_id),
      projectId: String(row.project_id),
    });
}
export async function assertPostgresTextPlanReceiptProject(
  c: PoolClient,
  schema: string,
  row: Record<string, unknown> | undefined,
): Promise<void> {
  await lockPostgresCreativeProjectLegacySchema(c, schema);
  if (row !== undefined)
    await (
      await capturePostgresCreativeProjectLegacyAccess(c, schema)
    ).assertProject({
      tenantId: String(row.tenant_id),
      spaceId: String(row.space_id),
      projectId: String(row.project_id),
    });
}
/** Original Pool ownership; all new SQL precedes the final captured policy and live-owner check. */
export async function transactPostgresTextPlan<
  T extends { plan: ProjectTextPlan },
>(
  input: Readonly<{
    pool: Pool;
    schema: string;
    assertOpen(): void;
    work(c: PoolClient): Promise<T>;
    authority?: ProjectTextPlanCommitAuthority;
    checkDownstream?(c: PoolClient): Promise<void>;
  }>,
): Promise<T> {
  input.assertOpen();
  const c = await input.pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await lockPostgresCreativeProjectLegacySchema(c, input.schema);
    await capturePostgresCreativeProjectLegacyAccess(c, input.schema);
    const result = await input.work(c);
    await input.checkDownstream?.(c);
    await assertPostgresTextPlanProject(
      c,
      input.schema,
      result.plan.owner,
      result.plan.projectId,
    );
    await input.authority?.assertTransactionCurrent();
    input.authority?.assertActive();
    input.assertOpen();
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}
export async function readPostgresTextPlan<T>(
  input: Readonly<{
    pool: Pool;
    schema: string;
    assertOpen(): void;
    read(c: PoolClient): Promise<T>;
  }>,
): Promise<T> {
  input.assertOpen();
  const c = await input.pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
    await lockPostgresCreativeProjectLegacySchema(c, input.schema);
    await capturePostgresCreativeProjectLegacyAccess(c, input.schema);
    const result = await input.read(c);
    input.assertOpen();
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}
