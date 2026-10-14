import { capturePostgresFoundationOwnedAccess } from "./project-foundation-owned-postgres.ts";
import {
  qualifyPluginProjectFoundationScope,
  type PluginProjectFoundationScope,
} from "@crewon/application";
import {
  assertPostgresSavedSourceUploadLegacyAccess,
  assertPostgresSavedSourceUploadProjectAccess,
  foundationResultSavedSource,
} from "./project-source-upload-legacy-access.ts";
import type { Pool, PoolClient } from "pg";
import {
  assertProjectFoundationCommitActive,
  assertProjectFoundationCommitCurrent,
  assertProjectFoundationCommitTransactionCurrent,
  type ProjectFoundationCommitAuthority,
  type ProjectFoundationMutationResult,
} from "@crewon/application";
import type { CreativeProjectScope } from "@crewon/domain";
import {
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
  type PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { assertPostgresProjectFoundationSchema } from "./project-foundation-schema.ts";
import {
  assertPostgresFoundationRunCommit,
  isFoundationReplay,
} from "./project-foundation-run-qualification.ts";
import { assertPostgresProjectRunLease } from "./creative-project-run-commit-postgres.ts";
import { foundationLegacyScope } from "./project-foundation-legacy-scope.ts";
import {
  foundationFailure,
  foundationJson,
} from "./project-foundation-store-support.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";

type Context = Readonly<{ pool: Pool; schema: string; assertOpen(): void }>;
type Body<T> = (
  client: PoolClient,
  access: PostgresCreativeProjectLegacyAccess,
) => Promise<T>;

/** Original pool, same client and short read transaction. No DDL or protected-access grant. */
export async function readPostgresFoundationLegacy<T>(
  context: Context,
  scope: CreativeProjectScope,
  body: Body<T>,
  absent: T | (() => never),
): Promise<T> {
  context.assertOpen();
  const client = await context.pool.connect();
  try {
    // READ COMMITTED observes a first migration completed while the shared lock waited.
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
    await lockPostgresCreativeProjectLegacySchema(client, context.schema);
    const access = await capturePostgresCreativeProjectLegacyAccess(
      client,
      context.schema,
    );
    await access.assertProject(scope);
    const configured = await assertPostgresProjectFoundationSchema(
      client,
      context.schema,
    );
    context.assertOpen();
    const result = configured
      ? await body(client, access)
      : typeof absent === "function"
        ? (absent as () => never)()
        : absent;
    await access.assertProject(scope);
    context.assertOpen();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackPostgres(client);
    throw error;
  } finally {
    client.release();
  }
}

/** Keeps the original authority, Run/lease checks and transaction; no second runtime. */
export async function transactPostgresFoundationLegacy<
  T extends ProjectFoundationMutationResult | null | void,
>(
  context: Context,
  body: Body<T>,
  authority?: ProjectFoundationCommitAuthority,
  projectScope?: PluginProjectFoundationScope,
): Promise<T> {
  context.assertOpen();
  if (projectScope !== undefined)
    qualifyPluginProjectFoundationScope(projectScope).assertActive();
  await assertProjectFoundationCommitCurrent(authority);
  assertProjectFoundationCommitActive(authority);
  context.assertOpen();
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await lockPostgresCreativeProjectLegacySchema(client, context.schema);
    const owned =
      projectScope === undefined
        ? undefined
        : await capturePostgresFoundationOwnedAccess(
            client,
            context.schema,
            projectScope,
            authority,
          );
    const access =
      owned ??
      (await capturePostgresCreativeProjectLegacyAccess(
        client,
        context.schema,
      ));
    context.assertOpen();
    const result = await body(client, access);
    if (
      owned !== undefined &&
      result != null &&
      result.kind === "create-project" &&
      result.disposition === "committed"
    )
      await owned.insertOwnership(result);
    await assertProjectFoundationCommitTransactionCurrent(authority);
    assertProjectFoundationCommitActive(authority);
    await assertPostgresFoundationRunCommit(
      client,
      context.schema,
      authority?.runTransaction,
      isFoundationReplay(result) ? "receipt-publication" : "fresh-proposal",
    );
    if (result != null)
      await access.assertProject(
        foundationLegacyScope(result.project, result.project.projectId),
      );
    const savedSource =
      result == null ? null : foundationResultSavedSource(result);
    if (savedSource !== null) {
      if (owned === undefined)
        await assertPostgresSavedSourceUploadLegacyAccess(
          client,
          context.schema,
          savedSource,
        );
      else
        await assertPostgresSavedSourceUploadProjectAccess(
          client,
          context.schema,
          savedSource,
          access,
        );
    }
    // The final asynchronous SQL check must not weaken the original authorization fence.
    await assertProjectFoundationCommitTransactionCurrent(authority);
    assertProjectFoundationCommitActive(authority);
    // The physical lease must still be current after every new awaited fence.
    await assertPostgresProjectRunLease(
      client,
      context.schema,
      authority?.runTransaction,
    );
    assertProjectFoundationCommitActive(authority);
    context.assertOpen();
    // No post-COMMIT check can deny a confirmed successful original transaction.
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackPostgres(client);
    throw error;
  } finally {
    client.release();
  }
}

/** Original project and brief SQL, on the caller's already fenced transaction. */
export async function insertPostgresFoundationOriginalProject(
  context: Readonly<{ client: PoolClient; prefix: string; assertOpen(): void }>,
  result: ProjectFoundationMutationResult,
): Promise<void> {
  const project = result.project;
  const brief = result.brief;
  if (brief === null) foundationFailure("project_foundation_recipe_invalid");
  await write(
    `INSERT INTO ${context.prefix}creative_projects
      (tenant_id,space_id,project_id,owner_principal_id,revision,state,latest_brief_revision,updated_at,record_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      project.tenantId,
      project.spaceId,
      project.projectId,
      project.ownerPrincipalId,
      project.revision,
      project.state,
      project.latestBriefRevision,
      project.updatedAt,
      foundationJson(project),
    ],
  );
  await write(
    `INSERT INTO ${context.prefix}creative_project_briefs
      (tenant_id,space_id,project_id,brief_revision,content_digest,record_json) VALUES($1,$2,$3,$4,$5,$6)`,
    [
      brief.tenantId,
      brief.spaceId,
      brief.projectId,
      brief.briefRevision,
      brief.contentDigest,
      foundationJson(brief),
    ],
  );
  async function write(sql: string, values: readonly unknown[]) {
    context.assertOpen();
    await context.client.query(sql, [...values]);
    context.assertOpen();
  }
}
