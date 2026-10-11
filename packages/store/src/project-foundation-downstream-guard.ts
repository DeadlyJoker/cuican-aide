import {
  assertSqliteSavedSourceUploadLegacyAccess,
  assertPostgresSavedSourceUploadLegacyAccess,
} from "./project-source-upload-legacy-access.ts";
import {
  captureSqliteCreativeProjectLegacyAccess,
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
} from "./creative-project-legacy-access.ts";
import { foundationLegacyScope } from "./project-foundation-legacy-scope.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { ActorContext } from "@crewon/application";
import {
  assertProjectFoundationDownstreamAllowed,
  creativeProjectOpaqueId,
  extensionCanonicalJson,
  validateCreativeProjectActor,
  type CreativeProject,
  type ProjectFoundation,
  type ProjectProposal,
  type ProjectSource,
} from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  creativeStoreRecord,
  decodeCreativeProject,
} from "./creative-project-store-records.ts";
import {
  assertPostgresProjectFoundationSchema,
  assertSqliteProjectFoundationSchema,
} from "./project-foundation-schema.ts";
import {
  decodePostgresFoundation,
  decodePostgresFoundationProposal,
  decodePostgresFoundationSource,
} from "./project-foundation-postgres-records.ts";
import { foundationFailure } from "./project-foundation-store-support.ts";

export type ProjectFoundationDownstreamLocator = Readonly<{
  actor: ActorContext;
  projectId: string;
}>;

/**
 * A private committing-connection snapshot, not a grant or a frozen Run input.
 * It proves only that the current attached foundation permits fresh downstream work.
 */
export type ProjectFoundationDownstreamSnapshot = Readonly<{
  foundation: ProjectFoundation;
  source: ProjectSource | null;
  proposal: ProjectProposal | null;
}> | null;

export type ProjectFoundationDownstreamCheck = Readonly<{
  locator: ProjectFoundationDownstreamLocator;
  snapshot: ProjectFoundationDownstreamSnapshot;
}>;

type Row = Record<string, unknown>;
type Table = "project_foundations" | "project_sources" | "project_proposals";

function locator(input: ProjectFoundationDownstreamLocator) {
  const value = creativeStoreRecord(input, ["actor", "projectId"]);
  const actor = validateCreativeProjectActor(value.actor);
  const projectId = creativeProjectOpaqueId(value.projectId);
  const owner = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    principalId: actor.principalId,
  };
  return { actor, owner, projectId };
}

function projectQuery(prefix: string, predicate: string) {
  return `SELECT p.* FROM ${prefix}creative_projects p WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.project_id=$3 AND p.owner_principal_id=$4 AND ${predicate}`;
}

function childQuery(
  prefix: string,
  predicate: string,
  table: Table,
  revision?: number,
) {
  const revisionColumn =
    table === "project_sources" ? "source_revision" : "proposal_revision";
  return `SELECT c.*,p.owner_principal_id AS project_owner_principal_id FROM ${prefix}${table} c
    JOIN ${prefix}creative_projects p ON p.tenant_id=c.tenant_id AND p.space_id=c.space_id AND p.project_id=c.project_id
    WHERE c.tenant_id=$1 AND c.space_id=$2 AND c.project_id=$3 AND p.owner_principal_id=$4 AND ${predicate}${revision === undefined ? "" : ` AND c.${revisionColumn}=$5`}`;
}

function values(scope: ReturnType<typeof locator>, revision?: number) {
  const result: (string | number)[] = [
    scope.owner.tenantId,
    scope.owner.spaceId,
    scope.projectId,
    scope.owner.principalId,
  ];
  if (revision !== undefined) result.push(revision);
  return result;
}

function actualProject(
  row: Row | undefined,
  scope: ReturnType<typeof locator>,
) {
  const project = decodeCreativeProject(row, scope.owner, scope.projectId);
  if (project === null) foundationFailure("creative_project_not_found");
  return project;
}

function actualFoundation(
  row: Row | undefined,
  scope: ReturnType<typeof locator>,
) {
  if (row === undefined) return null;
  // These decoders validate scalar SQL indexes and detached JSON on both dialects.
  return decodePostgresFoundation(row, scope);
}

function checkedSnapshot(
  project: CreativeProject,
  scope: ReturnType<typeof locator>,
  foundation: ProjectFoundation,
  sourceRow: Row | undefined,
  proposalRow: Row | undefined,
): ProjectFoundationDownstreamSnapshot {
  const source =
    foundation.source === null
      ? null
      : sourceRow === undefined
        ? foundationFailure("project_foundation_source_not_found")
        : decodePostgresFoundationSource(
            {
              ...sourceRow,
              owner_principal_id: sourceRow.project_owner_principal_id,
            },
            scope,
            foundation.source.revision,
          );
  if (source !== null && source.digest !== foundation.source?.digest)
    foundationFailure("project_foundation_source_digest_mismatch");
  const proposal =
    foundation.confirmedProposal === null
      ? null
      : proposalRow === undefined
        ? foundationFailure("project_foundation_confirmed_proposal_mismatch")
        : decodePostgresFoundationProposal(
            {
              ...proposalRow,
              owner_principal_id: proposalRow.project_owner_principal_id,
            },
            scope,
            foundation.confirmedProposal.revision,
          );
  assertProjectFoundationDownstreamAllowed({
    project,
    actor: scope.actor,
    foundation,
    proposal,
  });
  return Object.freeze({ foundation, source, proposal });
}

/** Caller owns BEGIN IMMEDIATE and original receipt/project checks; never migrates. */
export function captureSqliteProjectFoundationDownstream(
  database: DatabaseSync,
  input: ProjectFoundationDownstreamLocator,
): ProjectFoundationDownstreamSnapshot {
  const scope = locator(input);
  const access = captureSqliteCreativeProjectLegacyAccess(database);
  access.assertProject(foundationLegacyScope(scope.owner, scope.projectId));
  const read = (sql: string, revision?: number) =>
    database
      .prepare(sql.replaceAll(/\$[1-5]/gu, "?"))
      .get(...values(scope, revision));
  const project = actualProject(
    read(projectQuery("", access.predicate("p"))),
    scope,
  );
  if (!assertSqliteProjectFoundationSchema(database)) return null;
  const foundation = actualFoundation(
    read(childQuery("", access.predicate("p"), "project_foundations")),
    scope,
  );
  if (foundation === null) return null;
  if (foundation.source !== null)
    assertSqliteSavedSourceUploadLegacyAccess(database, {
      owner: scope.owner,
      projectId: scope.projectId,
      sourceRevision: foundation.source.revision,
    });
  return checkedSnapshot(
    project,
    scope,
    foundation,
    foundation.source === null
      ? undefined
      : read(
          childQuery(
            "",
            access.predicate("p"),
            "project_sources",
            foundation.source.revision,
          ),
          foundation.source.revision,
        ),
    foundation.confirmedProposal === null
      ? undefined
      : read(
          childQuery(
            "",
            access.predicate("p"),
            "project_proposals",
            foundation.confirmedProposal.revision,
          ),
          foundation.confirmedProposal.revision,
        ),
  );
}

/** Caller supplies its existing transaction client and holds the original project lock. */
export async function capturePostgresProjectFoundationDownstream(
  client: PoolClient,
  schema: string,
  input: ProjectFoundationDownstreamLocator,
): Promise<ProjectFoundationDownstreamSnapshot> {
  const scope = locator(input);
  await lockPostgresCreativeProjectLegacySchema(client, schema);
  const access = await capturePostgresCreativeProjectLegacyAccess(
    client,
    schema,
  );
  await access.assertProject(
    foundationLegacyScope(scope.owner, scope.projectId),
  );
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  const read = async (sql: string, revision?: number) =>
    (await client.query<Row>(sql, values(scope, revision))).rows[0];
  const project = actualProject(
    await read(projectQuery(prefix, access.predicate("p"))),
    scope,
  );
  if (!(await assertPostgresProjectFoundationSchema(client, schema))) {
    await access.assertProject(
      foundationLegacyScope(scope.owner, scope.projectId),
    );
    return null;
  }
  const foundation = actualFoundation(
    await read(
      childQuery(prefix, access.predicate("p"), "project_foundations"),
    ),
    scope,
  );
  if (foundation === null) {
    await access.assertProject(
      foundationLegacyScope(scope.owner, scope.projectId),
    );
    return null;
  }
  if (foundation.source !== null)
    await assertPostgresSavedSourceUploadLegacyAccess(client, schema, {
      owner: scope.owner,
      projectId: scope.projectId,
      sourceRevision: foundation.source.revision,
    });
  const snapshot = checkedSnapshot(
    project,
    scope,
    foundation,
    foundation.source === null
      ? undefined
      : await read(
          childQuery(
            prefix,
            access.predicate("p"),
            "project_sources",
            foundation.source.revision,
          ),
          foundation.source.revision,
        ),
    foundation.confirmedProposal === null
      ? undefined
      : await read(
          childQuery(
            prefix,
            access.predicate("p"),
            "project_proposals",
            foundation.confirmedProposal.revision,
          ),
          foundation.confirmedProposal.revision,
        ),
  );
  await access.assertProject(
    foundationLegacyScope(scope.owner, scope.projectId),
  );
  return snapshot;
}

function assertSnapshotUnchanged(
  actual: ProjectFoundationDownstreamSnapshot,
  expected: ProjectFoundationDownstreamSnapshot,
): void {
  if (extensionCanonicalJson(actual) !== extensionCanonicalJson(expected))
    foundationFailure("project_foundation_downstream_changed");
}

export function assertSqliteProjectFoundationDownstreamUnchanged(
  database: DatabaseSync,
  input: ProjectFoundationDownstreamLocator,
  expected: ProjectFoundationDownstreamSnapshot,
): void {
  assertSnapshotUnchanged(
    captureSqliteProjectFoundationDownstream(database, input),
    expected,
  );
}

export async function assertPostgresProjectFoundationDownstreamUnchanged(
  client: PoolClient,
  schema: string,
  input: ProjectFoundationDownstreamLocator,
  expected: ProjectFoundationDownstreamSnapshot,
): Promise<void> {
  assertSnapshotUnchanged(
    await capturePostgresProjectFoundationDownstream(client, schema, input),
    expected,
  );
}
