import type { TestContext } from "node:test";
import type {
  PluginProjectWorkspaceOwner,
  ProjectStageRunAdmission,
} from "@crewon/domain";
import { foundationMetadataFixture } from "./project-foundation-legacy-access.test-support.ts";
import { namespaceColumns } from "./plugin-project-workspace-store-support.ts";
import { parsePluginProjectWorkspaceNamespace } from "@crewon/domain";
import {
  migrateSqlitePluginProjectWorkspaces,
  migratePostgresPluginProjectWorkspaces,
  PLUGIN_PROJECT_WORKSPACE_TABLE,
} from "./plugin-project-workspace-schema.ts";

/** Named persisted constraints over an already genuinely admitted project/Run; not an adoption API. */
export async function projectRunOwnedFixture(
  t: TestContext,
  input: Readonly<{
    backend: "sqlite" | "postgres";
    path: string;
    prefix: string;
    stage: ProjectStageRunAdmission;
    owner?: Partial<PluginProjectWorkspaceOwner>;
    workspace?: string;
    namespace?: "missing";
  }>,
) {
  const metadata = await foundationMetadataFixture(t, {
    backend: input.backend,
    path: input.path,
    prefix: input.prefix,
    schema: input.backend === "sqlite" ? "main" : input.prefix.slice(1, -2),
  });
  await metadata.migrate();
  await metadata.transaction(async () => {
    if (metadata.database)
      migrateSqlitePluginProjectWorkspaces(metadata.database);
    else
      await migratePostgresPluginProjectWorkspaces(
        metadata.client!,
        input.prefix.slice(1, -2),
      );
  });
  const s = input.stage;
  const owner = {
    ...s.actor,
    profileId: s.installation.profileId,
    pluginId: s.installation.pluginId,
    publisherId: s.installation.publisherId,
    projectId: s.projectId,
    ...input.owner,
  };
  await metadata.mark(s.projectId, owner);
  if (input.namespace !== "missing") {
    const n = parsePluginProjectWorkspaceNamespace({
      schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
      owner,
      workspaceId: input.workspace ?? s.workspaceId,
      createdAt: new Date().toISOString(),
    });
    const values = [
      owner.tenantId,
      owner.spaceId,
      owner.principalId,
      owner.actorId,
      owner.profileId,
      owner.pluginId,
      owner.publisherId,
      owner.projectId,
      n.workspaceId,
      n.createdAt,
      JSON.stringify(n),
    ];
    await metadata.execute(
      `INSERT INTO ${input.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE}(${namespaceColumns}) VALUES(${values.map((_, i) => `$${i + 1}`).join(",")})`,
      values,
    );
  }
  return metadata;
}
