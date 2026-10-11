import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type {
  ProjectFoundationMutationResult,
  ProjectSourceUploadRead,
} from "@crewon/application";
import {
  creativeProjectOpaqueId,
  creativeProjectRevision,
} from "@crewon/domain";
import {
  captureSqliteCreativeProjectLegacyAccess,
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
  type CreativeProjectLegacyAccess,
  type PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertSqliteProjectSourceUploadSchema,
  assertPostgresProjectSourceUploadSchema,
} from "./project-source-upload-schema.ts";
import {
  sourceUploadRead,
  sourceUploadOwnerValues,
  sourceUploadFailure,
} from "./project-source-upload-store-support.ts";

type Source = Readonly<{
  owner: ProjectSourceUploadRead["owner"];
  projectId: string;
  sourceRevision: number;
}>;
export type SqliteSourceUploadLegacyAccess = Readonly<{
  assertUpload(scope: ProjectSourceUploadRead): void;
  assertCurrent(): void;
}>;
export type PostgresSourceUploadLegacyAccess = Readonly<{
  assertUpload(scope: ProjectSourceUploadRead): Promise<void>;
  assertCurrent(): Promise<void>;
}>;
const sqliteWhere =
  "a.tenant_id=? AND a.space_id=? AND a.owner_principal_id=? AND a.upload_id=?";
const postgresWhere =
  "a.tenant_id=$1 AND a.space_id=$2 AND a.owner_principal_id=$3 AND a.upload_id=$4";
function remember(
  scopes: Map<string, ProjectSourceUploadRead>,
  input: ProjectSourceUploadRead,
) {
  const scope = sourceUploadRead({
      owner: input.owner,
      uploadId: input.uploadId,
    }),
    key = JSON.stringify([
      ...sourceUploadOwnerValues(scope.owner),
      scope.uploadId,
    ]);
  scopes.set(key, scope);
  return scope;
}
function deny(found: boolean) {
  if (found) sourceUploadFailure("project_source_upload_not_found", "notFound");
}
function assertSqliteUpload(
  db: DatabaseSync,
  access: CreativeProjectLegacyAccess,
  scope: ProjectSourceUploadRead,
) {
  deny(
    db
      .prepare(
        `SELECT 1 FROM main.project_source_upload_associations a WHERE ${sqliteWhere} AND NOT (${access.predicate("a")}) LIMIT 1`,
      )
      .get(...sourceUploadOwnerValues(scope.owner), scope.uploadId) !==
      undefined,
  );
}
async function assertPostgresUpload(
  client: PoolClient,
  schema: string,
  access: PostgresCreativeProjectLegacyAccess,
  scope: ProjectSourceUploadRead,
) {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  deny(
    (
      await client.query(
        `SELECT 1 FROM ${prefix}project_source_upload_associations a WHERE ${postgresWhere} AND NOT (${access.predicate("a")}) LIMIT 1`,
        [...sourceUploadOwnerValues(scope.owner), scope.uploadId],
      )
    ).rowCount !== 0,
  );
}
/** Negative checks in the original caller-owned snapshot, never a protected-access grant. */
export function captureSqliteSourceUploadLegacyAccess(
  db: DatabaseSync,
): SqliteSourceUploadLegacyAccess {
  if (!db.isTransaction)
    throw new Error("project_source_upload_legacy_transaction_required");
  const access = captureSqliteCreativeProjectLegacyAccess(db),
    scopes = new Map<string, ProjectSourceUploadRead>();
  return Object.freeze({
    assertUpload(input: ProjectSourceUploadRead) {
      assertSqliteUpload(db, access, remember(scopes, input));
    },
    assertCurrent() {
      const current = captureSqliteCreativeProjectLegacyAccess(db);
      for (const scope of scopes.values())
        assertSqliteUpload(db, current, scope);
    },
  });
}
/** Same RC client/transaction; shared upload locks retain the original stable multipart ledger. */
export async function capturePostgresSourceUploadLegacyAccess(
  client: PoolClient,
  schema: string,
): Promise<PostgresSourceUploadLegacyAccess> {
  await lockPostgresCreativeProjectLegacySchema(client, schema);
  const access = await capturePostgresCreativeProjectLegacyAccess(
      client,
      schema,
    ),
    scopes = new Map<string, ProjectSourceUploadRead>();
  return Object.freeze({
    async assertUpload(input: ProjectSourceUploadRead) {
      const scope = remember(scopes, input);
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
        [
          JSON.stringify([
            "project-source-upload",
            schema,
            ...sourceUploadOwnerValues(scope.owner),
            scope.uploadId,
          ]),
        ],
      );
      await assertPostgresUpload(client, schema, access, scope);
    },
    async assertCurrent() {
      const current = await capturePostgresCreativeProjectLegacyAccess(
        client,
        schema,
      );
      for (const scope of scopes.values())
        await assertPostgresUpload(client, schema, current, scope);
    },
  });
}
/** Exact saved source association, including all uploads associated with that saved source revision. */
export function assertSqliteSavedSourceUploadLegacyAccess(
  db: DatabaseSync,
  input: Source,
): void {
  if (!db.isTransaction)
    throw new Error("project_source_upload_legacy_transaction_required");
  const access = captureSqliteCreativeProjectLegacyAccess(db);
  if (assertSqliteProjectSourceUploadSchema(db) === false) return;
  const projectId = creativeProjectOpaqueId(input.projectId),
    revision = creativeProjectRevision(input.sourceRevision);
  deny(
    db
      .prepare(
        `SELECT 1 FROM main.project_source_upload_associations saved JOIN main.project_source_upload_associations a ON a.tenant_id=saved.tenant_id AND a.space_id=saved.space_id AND a.owner_principal_id=saved.owner_principal_id AND a.upload_id=saved.upload_id WHERE saved.tenant_id=? AND saved.space_id=? AND saved.owner_principal_id=? AND saved.project_id=? AND saved.source_revision=? AND NOT (${access.predicate("a")}) LIMIT 1`,
      )
      .get(...sourceUploadOwnerValues(input.owner), projectId, revision) !==
      undefined,
  );
}
export async function assertPostgresSavedSourceUploadLegacyAccess(
  client: PoolClient,
  schema: string,
  input: Source,
): Promise<void> {
  await lockPostgresCreativeProjectLegacySchema(client, schema);
  const access = await capturePostgresCreativeProjectLegacyAccess(
    client,
    schema,
  );
  if ((await assertPostgresProjectSourceUploadSchema(client, schema)) === false)
    return;
  const prefix = `${creativeProjectSchemaName(schema)}.`,
    projectId = creativeProjectOpaqueId(input.projectId),
    revision = creativeProjectRevision(input.sourceRevision);
  const actual = await client.query<{ upload_id: string }>(
    `SELECT DISTINCT upload_id FROM ${prefix}project_source_upload_associations WHERE tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND project_id=$4 AND source_revision=$5 ORDER BY upload_id`,
    [...sourceUploadOwnerValues(input.owner), projectId, revision],
  );
  for (const row of actual.rows) {
    const uploadId = creativeProjectOpaqueId(row.upload_id);
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
      [
        JSON.stringify([
          "project-source-upload",
          schema,
          ...sourceUploadOwnerValues(input.owner),
          uploadId,
        ]),
      ],
    );
  }
  deny(
    (
      await client.query(
        `SELECT 1 FROM ${prefix}project_source_upload_associations saved JOIN ${prefix}project_source_upload_associations a ON a.tenant_id=saved.tenant_id AND a.space_id=saved.space_id AND a.owner_principal_id=saved.owner_principal_id AND a.upload_id=saved.upload_id WHERE saved.tenant_id=$1 AND saved.space_id=$2 AND saved.owner_principal_id=$3 AND saved.project_id=$4 AND saved.source_revision=$5 AND NOT (${access.predicate("a")}) LIMIT 1`,
        [...sourceUploadOwnerValues(input.owner), projectId, revision],
      )
    ).rowCount !== 0,
  );
}

/** The saved result may carry its exact source only as the foundation revision pointer. */
export function foundationResultSavedSource(
  result: ProjectFoundationMutationResult,
): Source | null {
  const revision =
    result.source === null
      ? (result.foundation.source?.revision ?? null)
      : result.source.revision;
  if (revision === null) return null;
  return {
    owner: {
      tenantId: result.project.tenantId,
      spaceId: result.project.spaceId,
      principalId: result.project.ownerPrincipalId,
    },
    projectId: result.project.projectId,
    sourceRevision: revision,
  };
}
