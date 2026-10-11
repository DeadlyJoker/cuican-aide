import type { DatabaseSync } from "node:sqlite";
import {
  qualifyPluginProjectReadScope,
  PLUGIN_PROJECT_READ_METHODS,
  type PluginProjectReadScope,
  type PluginProjectMutationScope,
  type PluginProjectReadMethod,
  type CreativeProjectReadStore,
  type CreativeProjectOwnerScope,
} from "@crewon/application";
import { parsePluginProjectWorkspaceOwner } from "@crewon/domain";
import {
  admitSqlitePluginInstallationPin,
  assertSqlitePluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";
import {
  hasSqlitePluginProjectMetadataOwnerSchema,
  PLUGIN_PROJECT_METADATA_OWNER_TABLE,
} from "./plugin-project-metadata-owner-schema.ts";
import { decodePluginProjectMetadataOwnerRecord } from "./plugin-project-metadata-owner-records.ts";
import type { CreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";

export type PluginProjectReadCall = Readonly<{
  scope: PluginProjectReadScope | PluginProjectMutationScope;
  method: PluginProjectReadMethod;
  query: Readonly<{
    owner: CreativeProjectOwnerScope;
    projectId?: string;
    assetId?: string;
    briefRevision?: number;
    assetRevision?: number;
  }>;
}>;
/** The same Store's original read methods, bound to a genuine source, never a new database or manager. */
export function bindSqliteCreativeProjectReadView(
  store: {
    [K in PluginProjectReadMethod]: (
      input: Parameters<CreativeProjectReadStore[K]>[0],
      scope?: PluginProjectReadScope | PluginProjectMutationScope,
    ) => ReturnType<CreativeProjectReadStore[K]>;
  },
  scope: PluginProjectReadScope | PluginProjectMutationScope,
): CreativeProjectReadStore {
  qualifyPluginProjectReadScope(scope);
  return Object.freeze(
    Object.fromEntries(
      PLUGIN_PROJECT_READ_METHODS.map((method) => [
        method,
        (input: never) => store[method](input, scope),
      ]),
    ),
  ) as CreativeProjectReadStore;
}

/** Installation, owner predicates and records are read in the original SQLite snapshot. */
export async function readSqliteOwnedCreativeProject<T>(
  db: DatabaseSync,
  call: PluginProjectReadCall,
  read: (access: CreativeProjectLegacyAccess) => T,
  assertOpen: () => void,
): Promise<T> {
  const source = qualifyPluginProjectReadScope(call.scope);
  if (!source.methods.includes(call.method))
    throw new Error("plugin_project_read_method_mismatch");
  for (const key of ["tenantId", "spaceId", "principalId"] as const)
    if (call.query.owner[key] !== source.scope[key])
      throw new Error("plugin_project_read_actor_mismatch");
  const originalInput = source.request.input as Readonly<
    Record<string, unknown>
  >;
  const input =
    source.purpose === "mutation"
      ? ({ ...(originalInput.request as object), ...originalInput } as Readonly<
          Record<string, unknown>
        >)
      : originalInput;
  for (const key of [
    "projectId",
    "assetId",
    "briefRevision",
    "assetRevision",
  ] as const)
    if (
      call.query[key] !== undefined &&
      input[key] !== undefined &&
      call.query[key] !== input[key]
    )
      throw new Error("plugin_project_read_target_mismatch");
  await source.assertCurrent();
  assertOpen();
  if (db.isTransaction)
    throw new Error("plugin_project_read_nested_transaction");
  db.exec("BEGIN DEFERRED");
  let result: T;
  try {
    if (!hasSqlitePluginProjectMetadataOwnerSchema(db))
      throw new Error("plugin_project_read_schema_required");
    assertSqlitePluginInstallationPinSchema(db);
    const installation = admitSqlitePluginInstallationPin(
      db,
      source.snapshot.pin,
    );
    assertCreativeProjectPluginCommitSelection(
      source.snapshot.context,
      installation,
    );
    const access = captureSqliteOwnedProjectAccess(db, source);
    source.assertActive();
    result = read(access);
    const items = Array.isArray(result)
      ? result
      : result && typeof result === "object" && "projects" in result
        ? result.projects
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
      access.assertProject({
        tenantId: source.scope.tenantId,
        spaceId: source.scope.spaceId,
        projectId: item.projectId,
      });
    }
    source.assertActive();
    assertOpen();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* Preserve original error. */
    }
    throw error;
  }
  await source.assertCurrent();
  assertOpen();
  return result;
}

export function captureSqliteOwnedProjectAccess(
  db: DatabaseSync,
  source: ReturnType<typeof qualifyPluginProjectReadScope>,
): CreativeProjectLegacyAccess {
  if (!db.isTransaction || !hasSqlitePluginProjectMetadataOwnerSchema(db))
    throw new Error("plugin_project_owned_access_schema_required");
  const columns = [
    "tenant_id",
    "space_id",
    "principal_id",
    "actor_id",
    "profile_id",
    "plugin_id",
    "publisher_id",
  ] as const;
  const values = [
    source.scope.tenantId,
    source.scope.spaceId,
    source.scope.principalId,
    source.scope.actorId,
    source.scope.profileId,
    source.scope.pluginId,
    source.scope.publisherId,
  ];
  // SQLite itself quotes the captured, validated values. Caller strings never become SQL syntax.
  const literals = columns.map((_, i) =>
    String(db.prepare("SELECT quote(?) AS v").get(values[i]!)!.v),
  );
  const predicate = (alias: string) => {
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(alias))
      throw new Error("plugin_project_read_alias_invalid");
    return `EXISTS(SELECT 1 FROM ${PLUGIN_PROJECT_METADATA_OWNER_TABLE} owned_metadata WHERE owned_metadata.tenant_id=${alias}.tenant_id AND owned_metadata.space_id=${alias}.space_id AND owned_metadata.project_id=${alias}.project_id AND ${columns.map((column, i) => `owned_metadata.${column}=${literals[i]}`).join(" AND ")})`;
  };
  const checkProject = (projectId: string) => {
    const scope = parsePluginProjectWorkspaceOwner({
      ...source.scope,
      projectId,
    });
    const row = db
      .prepare(
        `SELECT o.*,p.owner_principal_id AS stored_principal FROM ${PLUGIN_PROJECT_METADATA_OWNER_TABLE} o JOIN creative_projects p ON p.tenant_id=o.tenant_id AND p.space_id=o.space_id AND p.project_id=o.project_id WHERE o.tenant_id=? AND o.space_id=? AND o.project_id=? AND ${predicate("p")}`,
      )
      .get(scope.tenantId, scope.spaceId, projectId);
    if (!row || typeof row.stored_principal !== "string")
      throw new Error("creative_project_not_found");
    if (
      decodePluginProjectMetadataOwnerRecord(row, {
        expectedOwner: scope,
        storedProjectPrincipalId: row.stored_principal,
      }) === null
    )
      throw new Error("creative_project_not_found");
  };

  return Object.freeze({
    predicate,
    assertProject: (scope) => checkProject(scope.projectId),
  });
}
