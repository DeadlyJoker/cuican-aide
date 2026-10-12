import {
  captureSqliteCreativeProjectLegacyAccess,
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
  type CreativeProjectLegacyAccess,
  type PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { readSqliteLegacyCreativeProject } from "./creative-project-sqlite-legacy-read.ts";
import {
  assertSqliteSavedSourceUploadProjectAccess,
  assertPostgresSavedSourceUploadProjectAccess,
} from "./project-source-upload-legacy-access.ts";
import { foundationLegacyScope } from "./project-foundation-legacy-scope.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type {
  ProjectFoundationRunAdmissionStore,
  ProjectFoundationRunLocator,
} from "@crewon/application";
import {
  creativeProjectOpaqueId,
  parseProjectFoundationRunAdmission,
} from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  creativeStoreDigester,
  creativeStoreRecord,
} from "./creative-project-store-records.ts";
import {
  assertPostgresProjectFoundationRunSchema,
  assertSqliteProjectFoundationRunSchema,
} from "./project-foundation-run-schema.ts";

export function foundationRunLocator(
  input: ProjectFoundationRunLocator,
): ProjectFoundationRunLocator {
  const v = creativeStoreRecord(input, ["tenantId", "spaceId", "runId"]);
  return Object.freeze({
    tenantId: creativeProjectOpaqueId(v.tenantId),
    spaceId: creativeProjectOpaqueId(v.spaceId),
    runId: creativeProjectOpaqueId(v.runId),
  });
}
export function foundationRunValues(
  input: ProjectFoundationRunLocator,
): string[] {
  return [input.tenantId, input.spaceId, input.runId];
}
function query(p: string): string {
  // FULL parity is checked with two scalar subqueries, including a missing mandatory marker.
  return `SELECT (SELECT content_digest FROM ${p}project_foundation_run_requirements WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3) AS required_digest,
    (SELECT record_json FROM ${p}project_foundation_run_admissions WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3) AS record_json,
    (SELECT content_digest FROM ${p}project_foundation_run_admissions WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3) AS admission_digest`;
}
function decode(
  row: Record<string, unknown> | undefined,
  scope: ProjectFoundationRunLocator,
) {
  if (row === undefined) invalid();
  if (
    row.required_digest === null &&
    row.record_json === null &&
    row.admission_digest === null
  )
    return null;
  if (
    row.required_digest === null ||
    row.record_json === null ||
    row.admission_digest !== row.required_digest
  )
    invalid();
  const input =
    typeof row.record_json === "string"
      ? JSON.parse(row.record_json)
      : row.record_json;
  const admission = parseProjectFoundationRunAdmission(
    input,
    creativeStoreDigester,
  );
  if (
    admission.actor.tenantId !== scope.tenantId ||
    admission.actor.spaceId !== scope.spaceId ||
    admission.runId !== scope.runId ||
    admission.contentDigest !== row.required_digest
  )
    invalid();
  return admission;
}
function invalid(): never {
  throw new Error("project_foundation_run_admission_invalid");
}
/** Reads immutable paired facts on the caller's already borrowed transaction connection. */
export function loadSqliteFoundationRun(
  db: DatabaseSync,
  input: ProjectFoundationRunLocator,
  options?: Readonly<{ projectAccess: CreativeProjectLegacyAccess }>,
) {
  const scope = foundationRunLocator(input);
  const access =
    options?.projectAccess ?? captureSqliteCreativeProjectLegacyAccess(db);
  if (!assertSqliteProjectFoundationRunSchema(db)) return null;
  const admission = decode(
    db
      .prepare(query("").replaceAll(/\$[1-3]/gu, "?"))
      .get(
        ...foundationRunValues(scope),
        ...foundationRunValues(scope),
        ...foundationRunValues(scope),
      ),
    scope,
  );
  if (admission !== null) {
    access.assertProject(
      foundationLegacyScope(admission.actor, admission.projectId),
    );
    if (admission.source !== null)
      assertSqliteSavedSourceUploadProjectAccess(
        db,
        {
          owner: admission.actor,
          projectId: admission.projectId,
          sourceRevision: admission.source.revision,
        },
        access,
      );
  }
  return admission;
}
export async function loadPostgresFoundationRun(
  c: PoolClient,
  schema: string,
  input: ProjectFoundationRunLocator,
  options?: Readonly<{ projectAccess: PostgresCreativeProjectLegacyAccess }>,
) {
  const scope = foundationRunLocator(input);
  await lockPostgresCreativeProjectLegacySchema(c, schema);
  const access =
    options?.projectAccess ??
    (await capturePostgresCreativeProjectLegacyAccess(c, schema));
  if (!(await assertPostgresProjectFoundationRunSchema(c, schema))) return null;
  const admission = decode(
    (
      await c.query(
        query(`${creativeProjectSchemaName(schema)}.`),
        foundationRunValues(scope),
      )
    ).rows[0],
    scope,
  );
  if (admission !== null) {
    await access.assertProject(
      foundationLegacyScope(admission.actor, admission.projectId),
    );
    if (admission.source !== null)
      await assertPostgresSavedSourceUploadProjectAccess(
        c,
        schema,
        {
          owner: admission.actor,
          projectId: admission.projectId,
          sourceRevision: admission.source.revision,
        },
        access,
      );
  }
  return admission;
}
export class SqliteProjectFoundationRunStore
  implements ProjectFoundationRunAdmissionStore
{
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;
  constructor(input: { database: DatabaseSync; assertOpen(): void }) {
    this.#database = input.database;
    this.#assertOpen = input.assertOpen;
  }
  async loadFoundationRunAdmission(scope: ProjectFoundationRunLocator) {
    this.#assertOpen();
    return readSqliteLegacyCreativeProject(this.#database, () =>
      loadSqliteFoundationRun(this.#database, scope),
    );
  }
  async readRequiredFoundationDigest(scope: ProjectFoundationRunLocator) {
    return (
      (await this.loadFoundationRunAdmission(scope))?.contentDigest ?? null
    );
  }
}
export class PostgresProjectFoundationRunStore
  implements ProjectFoundationRunAdmissionStore
{
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #assertOpen: () => void;
  constructor(input: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#pool = input.pool;
    creativeProjectSchemaName(input.schema);
    this.#schema = input.schema;
    this.#assertOpen = input.assertOpen;
  }
  async loadFoundationRunAdmission(scope: ProjectFoundationRunLocator) {
    this.#assertOpen();
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
      const result = await loadPostgresFoundationRun(c, this.#schema, scope);
      this.#assertOpen();
      await c.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(c);
      throw error;
    } finally {
      c.release();
    }
  }
  async readRequiredFoundationDigest(scope: ProjectFoundationRunLocator) {
    return (
      (await this.loadFoundationRunAdmission(scope))?.contentDigest ?? null
    );
  }
}
