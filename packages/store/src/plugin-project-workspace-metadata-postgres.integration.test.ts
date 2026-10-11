import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { workspaceNamespaceFixture } from "./plugin-project-workspace.test-support.ts";
import { creationRecipe } from "./creative-project-store.test-support.ts";
import { migratePostgresPluginProjectMetadataOwners } from "./plugin-project-metadata-owner-schema.ts";
import { pluginProjectMetadataOwnerColumns } from "./plugin-project-metadata-owner-records.ts";
import { parsePluginProjectWorkspaceNamespace } from "@crewon/domain";
import {
  namespaceColumns,
  namespaceValues,
} from "./plugin-project-workspace-store-support.ts";

for (const matching of [true, false]) {
  test(
    `postgres: original namespace writer ${matching ? "matches" : "rejects"} the persisted project's full metadata owner`,
    {
      skip: !process.env.CREWON_TEST_POSTGRES_URL,
    },
    async (t) => {
      const f = await workspaceNamespaceFixture(t, "postgres");
      const schema = f.prefix.slice(1, -2);
      const projects = f.parent.creativeProjectStore();
      await projects.migrate();
      const owner = f.namespaceOwner("protected-metadata-new");
      const input = f.namespaceRecipe(owner.projectId);
      await projects.commitProjectCreation(
        creationRecipe(owner.projectId, "metadata-parent", f.actor),
      );
      const pool = new Pool({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      });
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await migratePostgresPluginProjectMetadataOwners(c, schema);
        const storedOwner = {
          ...owner,
          profileId: matching ? owner.profileId : "foreign-profile",
        };
        const createdAt = input.createdAt;
        const record = {
          schemaVersion: "crewon.plugin-project-metadata-owner.v1",
          owner: storedOwner,
          createdAt,
        };
        await c.query(
          `INSERT INTO ${schema}.plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${pluginProjectMetadataOwnerColumns.map((_, i) => `$${i + 1}`).join(",")})`,
          [
            storedOwner.tenantId,
            storedOwner.spaceId,
            storedOwner.principalId,
            storedOwner.actorId,
            storedOwner.profileId,
            storedOwner.pluginId,
            storedOwner.publisherId,
            storedOwner.projectId,
            createdAt,
            JSON.stringify(record),
          ],
        );
        await c.query("COMMIT");
        await f.parent.migratePluginProjectWorkspaceNamespaces();
        const mount = await f.mounted();
        if (matching) {
          assert.equal(
            ((await mount.write(input)) as { disposition: string }).disposition,
            "committed",
          );
          assert.equal(
            ((await mount.write(input)) as { disposition: string }).disposition,
            "replayed",
          );
        } else {
          await assert.rejects(
            mount.write(input),
            (error: unknown) =>
              error instanceof Error &&
              error.message === "plugin_ui_unavailable" &&
              error.cause instanceof Error &&
              error.cause.message ===
                "plugin_project_workspace_metadata_owner_conflict",
          );
          // Persisted stale registration fixture: the production writer above correctly refused it.
          const stale = parsePluginProjectWorkspaceNamespace({
            schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
            owner,
            workspaceId: input.workspaceId,
            createdAt,
          });
          await c.query(
            `INSERT INTO ${schema}.plugin_project_workspace_namespaces(${namespaceColumns}) VALUES(${Array.from({ length: 11 }, (_, i) => `$${i + 1}`).join(",")})`,
            [...namespaceValues(stale)],
          );
        }
        const reads = f.parent.pluginProjectWorkspaceNamespaces();
        const { projectId: _, ...scope } = owner;
        if (matching) {
          assert.equal(
            (await reads.loadNamespace({ owner }))!.workspaceId,
            input.workspaceId,
          );
          assert.equal(
            (
              await reads.listNamespaces({
                owner: scope,
                afterProjectId: null,
                limit: 1,
              })
            ).namespaces[0]!.workspaceId,
            input.workspaceId,
          );
          await c.query(
            `DROP TABLE ${schema}.plugin_project_metadata_owner_schema_version`,
          );
          await assert.rejects(
            reads.loadNamespace({ owner }),
            /plugin_project_metadata_owner_schema_invalid/,
          );
          await assert.rejects(
            reads.listNamespaces({
              owner: scope,
              afterProjectId: null,
              limit: 1,
            }),
            /plugin_project_metadata_owner_schema_invalid/,
          );
        } else {
          await assert.rejects(
            reads.loadNamespace({ owner }),
            /plugin_project_workspace_metadata_owner_conflict/,
          );
          await assert.rejects(
            reads.listNamespaces({
              owner: scope,
              afterProjectId: null,
              limit: 1,
            }),
            /plugin_project_workspace_metadata_owner_conflict/,
          );
        }
        const count = await c.query(
          `SELECT COUNT(*) AS n FROM ${schema}.plugin_project_workspace_namespaces`,
        );
        assert.equal(Number(count.rows[0].n), 1);
      } finally {
        c.release();
        await pool.end();
      }
    },
  );
}
