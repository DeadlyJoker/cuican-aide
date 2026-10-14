import assert from "node:assert/strict";
import test from "node:test";
import { foundationToolsOwnerFixture } from "./project-foundation-tools-service-owner.test-support.ts";
import { foundationMetadataFixture } from "../../../../packages/store/src/project-foundation-legacy-access.test-support.ts";
import {
  namespaceColumns,
  namespaceValues,
} from "../../../../packages/store/src/plugin-project-workspace-store-support.ts";
import { PLUGIN_PROJECT_WORKSPACE_TABLE } from "../../../../packages/store/src/plugin-project-workspace-schema.ts";
import { parsePluginProjectWorkspaceNamespace } from "@crewon/domain";
const literal = (v: unknown) => "'" + String(v).replaceAll("'", "''") + "'";
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: original checked Worker proposal dispatch writes its protected project and cold owner replays once`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await foundationToolsOwnerFixture(t, "creative", backend);
      const metadata = await foundationMetadataFixture(t, {
        backend,
        schema: f.schema ?? "main",
        prefix: f.prefix,
        path: f.databasePath,
      });
      await metadata.migrate();
      const ownerScope = {
        ...f.actor,
        profileId: f.taskAdmission.profileId,
        pluginId: f.taskAdmission.pluginId,
        publisherId: f.taskAdmission.publisherId,
      };
      await metadata.mark(f.admission.projectId, ownerScope);
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      const namespace = parsePluginProjectWorkspaceNamespace({
        schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
        owner: { ...ownerScope, projectId: f.admission.projectId },
        workspaceId: f.stage.workspaceId,
        createdAt: new Date().toISOString(),
      });
      await f.sql(
        `INSERT INTO ${f.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE}(${namespaceColumns}) VALUES(${namespaceValues(namespace).map(literal).join(",")})`,
      );
      const owner = f.owner({ projectOwnership: "plugin-project-v1" });
      const request = {
        projectId: f.admission.projectId,
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "creative-plan" as const,
        text: "原创短剧的真实候选方案，等待用户确认。",
      };
      const op = await f.prepare("saveProposal", request);
      const value = await f.invoke(owner, op, (command) =>
        f.service(owner).saveProposal({ command, request }),
      );
      assert.equal(value.disposition, "committed");
      assert.equal(value.proposal.revision, 1);
      assert.equal(Object.hasOwn(value.proposal, "text"), false);
      await owner.close();
      const cold = f.owner({ projectOwnership: "plugin-project-v1" });
      const replay = await f.invoke(
        cold,
        op,
        (command) => f.service(cold).saveProposal({ command, request }),
        { method: "reconcile" },
      );
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.proposal, value.proposal);
      await assert.rejects(
        f.invoke(
          cold,
          op,
          (command) => f.service(cold).saveProposal({ command, request }),
          { copied: true },
        ),
      );
      f.controls.service = false;
      await assert.rejects(
        f.invoke(cold, op, (command) =>
          f.service(cold).saveProposal({ command, request }),
        ),
      );
      await cold.close();
    },
  );
