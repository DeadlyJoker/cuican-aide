import {
  assertPostgresInstalledProjectRunExecution,
  assertPostgresProjectRunLease,
} from "./creative-project-run-commit-postgres.ts";
import { assertPostgresFoundationRunRead } from "./project-foundation-run-read.ts";
import { assertPostgresFoundationRunCommit } from "./project-foundation-run-qualification.ts";
import type { Pool } from "pg";
import {
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
  type CreativeProjectReadStore,
  type PluginProjectReadMethod,
} from "@crewon/application";
import { parsePluginProjectWorkspaceOwner } from "@crewon/domain";
import type { PluginProjectReadCall } from "./plugin-project-owned-read-sqlite.ts";
import {
  admitPostgresPluginInstallationPin,
  assertPostgresPluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";
import {
  hasPostgresPluginProjectMetadataOwnerSchema,
  PLUGIN_PROJECT_METADATA_OWNER_TABLE,
} from "./plugin-project-metadata-owner-schema.ts";
import { decodePluginProjectMetadataOwnerRecord } from "./plugin-project-metadata-owner-records.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { lockPostgresCreativeProjectLegacySchema } from "./creative-project-legacy-access.ts";
import type { PostgresCreativeProjectLegacyRead } from "./creative-project-postgres-legacy-read.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";

export function bindPostgresCreativeProjectReadView(
  store: {
    [K in PluginProjectReadMethod]: (
      input: Parameters<CreativeProjectReadStore[K]>[0],
      scope?: PluginProjectReadScope,
    ) => ReturnType<CreativeProjectReadStore[K]>;
  },
  scope: PluginProjectReadScope,
): CreativeProjectReadStore {
  qualifyPluginProjectReadScope(scope);
  const view: CreativeProjectReadStore = {
    loadProject: (input) => store.loadProject(input, scope),
    loadBrief: (input) => store.loadBrief(input, scope),
    listBriefs: (input) => store.listBriefs(input, scope),
    listProjects: (input) => store.listProjects(input, scope),
    loadConceptAsset: (input) => store.loadConceptAsset(input, scope),
    listConceptAssets: (input) => store.listConceptAssets(input, scope),
    loadConceptRevision: (input) => store.loadConceptRevision(input, scope),
    listConceptRevisions: (input) => store.listConceptRevisions(input, scope),
  };
  return Object.freeze(view);
}

/** Same parent pool and original queries; exact installation and protected ownership are checked in one transaction. */
export async function readPostgresOwnedCreativeProject<T>(
  input: Readonly<{ pool: Pool; schema: string; assertOpen(): void }>,
  call: PluginProjectReadCall,
  read: PostgresCreativeProjectLegacyRead<T>,
): Promise<T> {
  const source = qualifyPluginProjectReadScope(call.scope);
  if (!source.methods.includes(call.method))
    throw new Error("plugin_project_read_method_mismatch");
  for (const key of ["tenantId", "spaceId", "principalId"] as const)
    if (call.query.owner[key] !== source.scope[key])
      throw new Error("plugin_project_read_actor_mismatch");
  const originalRequest = source.request.input as Readonly<
    Record<string, unknown>
  >;
  const request =
    source.purpose === "mutation"
      ? { ...(originalRequest.request as object), ...originalRequest }
      : originalRequest;
  for (const key of [
    "projectId",
    "assetId",
    "briefRevision",
    "assetRevision",
    "revision",
    "digest",
  ] as const)
    if (
      call.query[key] !== undefined &&
      request[key] !== undefined &&
      call.query[key] !== request[key]
    )
      throw new Error("plugin_project_read_target_mismatch");
  await source.assertCurrent();
  input.assertOpen();
  const c = await input.pool.connect();
  const prefix = `${creativeProjectSchemaName(input.schema)}.`;
  let result: T;
  try {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await lockPostgresCreativeProjectLegacySchema(c, input.schema);
    if (!(await hasPostgresPluginProjectMetadataOwnerSchema(c, input.schema)))
      throw new Error("plugin_project_read_schema_required");
    await assertPostgresPluginInstallationPinSchema(c, input.schema);
    const installation = await admitPostgresPluginInstallationPin(
      c,
      input.schema,
      source.snapshot.pin,
    );
    assertCreativeProjectPluginCommitSelection(
      source.snapshot.context,
      installation,
    );
    await assertPostgresPluginProjectRunRead(
      c,
      input.schema,
      source.runAuthority,
    );
    if (source.foundationRunAuthority !== undefined) {
      await assertPostgresInstalledProjectRunExecution(
        c,
        input.schema,
        source.foundationRunAuthority,
      );
      await assertPostgresProjectRunLease(
        c,
        input.schema,
        source.foundationRunAuthority,
      );
    }
    if (source.foundationRunMutationAuthority !== undefined) {
      await assertPostgresInstalledProjectRunExecution(c, input.schema, source.foundationRunMutationAuthority);
      await assertPostgresProjectRunLease(c, input.schema, source.foundationRunMutationAuthority);
    }
    const access = await capturePostgresOwnedProjectAccess(
      c,
      input.schema,
      source,
    );
    const assertProject = access.assertProject;
    if (call.query.projectId !== undefined)
      await assertProject({ projectId: call.query.projectId });
    source.assertActive();
    input.assertOpen();
    if (source.foundationRunAuthority !== undefined)
      await assertPostgresFoundationRunRead(
        c,
        input.schema,
        source.foundationRunAuthority,
        { projectAccess: access },
      );
    if (source.foundationRunMutationAuthority !== undefined)
      await assertPostgresFoundationRunCommit(c, input.schema, source.foundationRunMutationAuthority, "fresh-proposal", { projectAccess: access });
    result = await read(c, access);
    const items =
      result && typeof result === "object" && "projects" in result
        ? result.projects
        : Array.isArray(result)
          ? result
          : result === null
            ? []
            : [result];
    if (!Array.isArray(items))
      throw new Error("plugin_project_read_result_invalid");
    for (const item of items) {
      if (
        item === null ||
        typeof item !== "object" ||
        typeof item.projectId !== "string"
      )
        throw new Error("plugin_project_read_result_invalid");
      await assertProject({ projectId: item.projectId });
    }
    source.assertActive();
    input.assertOpen();
    await assertPostgresPluginProjectRunRead(
      c,
      input.schema,
      source.runAuthority,
    );
    if (source.foundationRunAuthority !== undefined)
      await assertPostgresFoundationRunRead(
        c,
        input.schema,
        source.foundationRunAuthority,
        { projectAccess: access },
      );
    if (source.foundationRunMutationAuthority !== undefined)
      await assertPostgresFoundationRunCommit(c, input.schema, source.foundationRunMutationAuthority, "fresh-proposal", { projectAccess: access });
    await c.query("COMMIT");
  } catch (error) {
    await rollbackPostgres(c);
    throw error;
  } finally {
    c.release();
  }
  // Recheck after releasing the sole connection: Host identity/policy may itself read this pool.
  await source.assertCurrent();
  input.assertOpen();
  return result;
}
import { assertPostgresPluginProjectRunRead } from "./plugin-project-run-read.ts";

/** Same borrowed transaction and original owner predicate; no new connection or grant. */
export async function capturePostgresOwnedProjectAccess(
  c: import("pg").PoolClient,
  schema: string,
  source: Pick<ReturnType<typeof qualifyPluginProjectReadScope>, "scope">,
) {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  const columns = [
    "tenant_id",
    "space_id",
    "principal_id",
    "actor_id",
    "profile_id",
    "plugin_id",
    "publisher_id",
  ];
  const values = [
    source.scope.tenantId,
    source.scope.spaceId,
    source.scope.principalId,
    source.scope.actorId,
    source.scope.profileId,
    source.scope.pluginId,
    source.scope.publisherId,
  ];
  const literals = (
    await c.query<{ v: string }>(
      "SELECT quote_literal(v) v FROM unnest($1::text[]) WITH ORDINALITY AS s(v,n) ORDER BY n",
      [values],
    )
  ).rows.map((row) => row.v);
  const predicate = (alias: string) => {
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(alias))
      throw new Error("plugin_project_read_alias_invalid");
    return `EXISTS(SELECT 1 FROM ${prefix}${PLUGIN_PROJECT_METADATA_OWNER_TABLE} owned_metadata WHERE owned_metadata.tenant_id=${alias}.tenant_id AND owned_metadata.space_id=${alias}.space_id AND owned_metadata.project_id=${alias}.project_id AND ${columns.map((column, i) => `owned_metadata.${column}=${literals[i]}`).join(" AND ")})`;
  };
  const assertProject = async (scope: { projectId: string }) => {
    const owner = parsePluginProjectWorkspaceOwner({
      ...source.scope,
      projectId: scope.projectId,
    });
    const row = (
      await c.query<Record<string, unknown>>(
        `SELECT o.*,p.owner_principal_id AS stored_principal FROM ${prefix}${PLUGIN_PROJECT_METADATA_OWNER_TABLE} o JOIN ${prefix}creative_projects p ON p.tenant_id=o.tenant_id AND p.space_id=o.space_id AND p.project_id=o.project_id WHERE o.tenant_id=$1 AND o.space_id=$2 AND o.project_id=$3 AND ${predicate("p")} FOR SHARE OF o,p`,
        [owner.tenantId, owner.spaceId, owner.projectId],
      )
    ).rows[0];
    if (!row || typeof row.stored_principal !== "string")
      throw new Error("creative_project_not_found");
    if (
      decodePluginProjectMetadataOwnerRecord(row, {
        expectedOwner: owner,
        storedProjectPrincipalId: row.stored_principal,
      }) === null
    )
      throw new Error("creative_project_not_found");
  };
  return Object.freeze({ predicate, assertProject });
}
