import type { PoolClient } from "pg";
import type {
  PluginProjectFoundationScope,
  ProjectFoundationCommitAuthority,
  ProjectFoundationMutationResult,
} from "@crewon/application";
import { capturePostgresOwnedProjectAccess } from "./plugin-project-owned-read-postgres.ts";
import {
  hasPostgresPluginProjectMetadataOwnerSchema,
  PLUGIN_PROJECT_METADATA_OWNER_TABLE,
} from "./plugin-project-metadata-owner-schema.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  foundationOwnedSource,
  assertFoundationOwnedTarget,
  foundationOwnedRecord,
} from "./project-foundation-owned-access.ts";

export async function capturePostgresFoundationOwnedAccess(
  client: PoolClient,
  schema: string,
  reference: PluginProjectFoundationScope,
  authority: ProjectFoundationCommitAuthority | undefined,
) {
  const source = foundationOwnedSource(reference, authority);
  if (!(await hasPostgresPluginProjectMetadataOwnerSchema(client, schema)))
    throw new Error("plugin_project_owned_creation_schema_required");
  const access = await capturePostgresOwnedProjectAccess(
    client,
    schema,
    source,
  );
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  return Object.freeze({
    predicate: access.predicate,
    async assertProject(
      scope: Parameters<typeof access.assertProject>[0] & {
        tenantId: string;
        spaceId: string;
      },
    ) {
      assertFoundationOwnedTarget(source, scope);
      if (
        source.snapshot.request.action ===
        "crewon.project-foundation.v1.createProject"
      ) {
        const rows = await client.query(
          `SELECT 1 FROM ${prefix}creative_projects WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 UNION ALL SELECT 1 FROM ${prefix}${PLUGIN_PROJECT_METADATA_OWNER_TABLE} WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3`,
          [source.scope.tenantId, source.scope.spaceId, scope.projectId],
        );
        if (rows.rows.length === 0) return;
      }
      await access.assertProject(scope);
    },
    async insertOwnership(result: ProjectFoundationMutationResult) {
      const record = foundationOwnedRecord(source, result),
        o = record.owner;
      await client.query(
        `INSERT INTO ${prefix}${PLUGIN_PROJECT_METADATA_OWNER_TABLE} (tenant_id,space_id,principal_id,actor_id,profile_id,plugin_id,publisher_id,project_id,created_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          o.tenantId,
          o.spaceId,
          o.principalId,
          o.actorId,
          o.profileId,
          o.pluginId,
          o.publisherId,
          o.projectId,
          record.createdAt,
          JSON.stringify(record),
        ],
      );
      await access.assertProject(result.project);
    },
  });
}
