import type { DatabaseSync } from "node:sqlite";
import type {
  PluginProjectFoundationScope,
  ProjectFoundationCommitAuthority,
  ProjectFoundationMutationResult,
} from "@crewon/application";
import { captureSqliteOwnedProjectAccess } from "./plugin-project-owned-read-sqlite.ts";
import { PLUGIN_PROJECT_METADATA_OWNER_TABLE } from "./plugin-project-metadata-owner-schema.ts";
import {
  foundationOwnedSource,
  assertFoundationOwnedTarget,
  foundationOwnedRecord,
} from "./project-foundation-owned-access.ts";
export function captureSqliteFoundationOwnedAccess(
  db: DatabaseSync,
  reference: PluginProjectFoundationScope,
  authority: ProjectFoundationCommitAuthority | undefined,
) {
  const source = foundationOwnedSource(reference, authority),
    access = captureSqliteOwnedProjectAccess(db, source);
  return Object.freeze({
    predicate: access.predicate,
    assertProject(scope: Parameters<typeof access.assertProject>[0]) {
      assertFoundationOwnedTarget(source, scope);
      if (
        source.snapshot.request.action ===
          "crewon.project-foundation.v1.createProject" &&
        db
          .prepare(
            `SELECT 1 FROM creative_projects WHERE tenant_id=? AND space_id=? AND project_id=? UNION ALL SELECT 1 FROM ${PLUGIN_PROJECT_METADATA_OWNER_TABLE} WHERE tenant_id=? AND space_id=? AND project_id=?`,
          )
          .get(
            source.scope.tenantId,
            source.scope.spaceId,
            scope.projectId,
            source.scope.tenantId,
            source.scope.spaceId,
            scope.projectId,
          ) === undefined
      )
        return;
      access.assertProject(scope);
    },
    insertOwnership(result: ProjectFoundationMutationResult) {
      const record = foundationOwnedRecord(source, result),
        o = record.owner;
      db.prepare(
        `INSERT INTO ${PLUGIN_PROJECT_METADATA_OWNER_TABLE} (tenant_id,space_id,principal_id,actor_id,profile_id,plugin_id,publisher_id,project_id,created_at,record_json) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
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
      );
      access.assertProject(result.project);
    },
  });
}
