import assert from "node:assert/strict";
import test from "node:test";
import { issuePluginProjectFoundationRunMutationReadScope } from "@crewon/application/host-project-workspaces";
import { foundationToolFixture } from "./project-foundation-run-commit.test-support.ts";
import { foundationRunTestOptions } from "./project-foundation-run.test-support.ts";
import { pluginProjectMetadataOwnerColumns } from "./plugin-project-metadata-owner-records.ts";
import { namespaceColumns } from "./plugin-project-workspace-store-support.ts";
import { PLUGIN_PROJECT_WORKSPACE_TABLE } from "./plugin-project-workspace-schema.ts";
const sql = (value: unknown) => "'" + String(value).replaceAll("'", "''") + "'";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const profile of ["matching", "foreign"] as const)
    test(
      `${backend}: actual leased Foundation Tool can write and cold-replay only its protected project namespace (${profile})`,
      foundationRunTestOptions(backend),
      async (t) => {
        const f = await foundationToolFixture(t, backend),
          op = await f.prepare();
        await f.parent.migratePluginProjectOwnership();
        await f.parent.migratePluginProjectWorkspaceNamespaces();
        const q = op.transaction;
        const owner = {
          ...q.actor,
          profileId:
            profile === "matching"
              ? q.installation.profileId
              : "foreign-profile",
          pluginId: q.installation.pluginId,
          publisherId: q.installation.publisherId,
          projectId: q.foundationAdmission.projectId,
        };
        const at = new Date().toISOString();
        // Named persisted owner/namespace fixture over the already admitted original project, Run, real queue lease and Tool receipt.
        // This fixture is not an adoption API or a fabricated execution authority.
        const metadata = {
          schemaVersion: "crewon.plugin-project-metadata-owner.v1",
          owner,
          createdAt: at,
        };
        const namespace = {
          schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
          owner,
          workspaceId: q.projectStageAdmission.workspaceId,
          createdAt: at,
        };
        const values = [
          owner.tenantId,
          owner.spaceId,
          owner.principalId,
          owner.actorId,
          owner.profileId,
          owner.pluginId,
          owner.publisherId,
          owner.projectId,
        ];
        await f.corruptSidecar(
          `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${[...values, at, JSON.stringify(metadata)].map(sql).join(",")}); INSERT INTO ${f.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE}(${namespaceColumns}) VALUES(${[...values, namespace.workspaceId, at, JSON.stringify(namespace)].map(sql).join(",")})`,
        );
        const source = await issuePluginProjectFoundationRunMutationReadScope({
          authority: q,
          assertActive: op.options.authority!.assertActive,
        });
        const service = f.application().bindRunMutationReads(source);
        const before = await f.count("project_proposals");
        await assert.rejects(
          f.application().saveProposal(f.actor, op.command, op.options),
        );
        if (profile === "foreign") {
          await assert.rejects(
            service.saveProposal(f.actor, op.command, op.options),
          );
          assert.equal(await f.count("project_proposals"), before);
          return;
        }
        const saved = await service.saveProposal(
          f.actor,
          op.command,
          op.options,
        );
        assert.equal(saved.disposition, "committed");
        assert.equal(saved.proposal!.text, op.command.text);
        assert.equal(await f.count("project_proposals"), before + 1);
        const cold = f
          .application()
          .bindRunMutationReads(
            await issuePluginProjectFoundationRunMutationReadScope({
              authority: q,
              assertActive: op.options.authority!.assertActive,
            }),
          );
        const replay = await cold.saveProposal(f.actor, op.command, op.options);
        assert.deepEqual({ ...replay, disposition: "committed" }, saved);
        assert.equal(await f.count("project_proposals"), before + 1);
        f.state.live = false;
        await assert.rejects(
          cold.saveProposal(f.actor, op.command, op.options),
        );
        assert.equal(await f.count("project_proposals"), before + 1);
      },
    );
}
