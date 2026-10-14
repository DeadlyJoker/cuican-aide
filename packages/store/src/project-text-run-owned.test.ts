import assert from "node:assert/strict";
import test from "node:test";
import { issuePluginProjectTextRunMutationReadScope } from "@crewon/application/host-project-workspaces";
import { outlineToolFixture } from "./project-outline-run-commit.test-support.ts";
import { projectRunOwnedFixture } from "./project-run-owned-fixture.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30_000,
  };
  test(
    `${backend}: actual outline Tool writes plugin-owned project, preserves original tables and cold receipt replay`,
    options,
    async (t) => {
      const f = await outlineToolFixture(t, backend),
        op = await f.prepare();
      const owner = {
        ...f.actor,
        profileId: f.installation.profileId,
        pluginId: f.installation.pluginId,
        publisherId: f.installation.publisherId,
      };
      await projectRunOwnedFixture(t, {
        backend,
        path: f.databasePath,
        prefix: f.prefix,
        stage: op.transaction.projectStageAdmission,
        owner,
      });
      const scope = await issuePluginProjectTextRunMutationReadScope({
        authority: op.transaction,
        assertActive: f.active,
      });
      const service = await f.application().withPluginProjectRunReads(scope);
      const saved = await service.saveCandidate(
        f.actor,
        op.command,
        op.options,
      );
      assert.equal(saved.disposition, "committed");
      assert.equal(
        saved.contentRevision?.schemaVersion,
        "crewon.project-text-revision.v2",
      );
      assert.equal(saved.artifact.selectedContentRevision, null);
      assert.equal(await f.count("project_text_revisions"), 1);
      assert.equal(
        await f.store.loadOutline({
          owner: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          },
          projectId: f.reference.projectId,
        }),
        null,
      );
      const cold = await f.open();
      const replayService = await f
        .application(cold.parent)
        .withPluginProjectRunReads(scope);
      const replay = await replayService.saveCandidate(
        f.actor,
        op.command,
        op.options,
      );
      assert.deepEqual({ ...replay, disposition: "committed" }, saved);
      assert.equal(await f.count("project_text_revisions"), 1);
      assert.equal(await f.count("project_text_mutation_receipts"), 1);
      await assert.rejects(
        f.application().withPluginProjectRunReads({ ...scope }),
      );
      await assert.rejects(
        f.application().saveCandidate(f.actor, op.command, op.options),
      );
    },
  );
  test(
    `${backend}: genuine outline dispatch cannot borrow another plugin namespace and persists no text`,
    options,
    async (t) => {
      const f = await outlineToolFixture(t, backend),
        op = await f.prepare();
      const owner = {
        ...f.actor,
        profileId: f.installation.profileId,
        pluginId: "foreign.protected",
        publisherId: f.installation.publisherId,
      };
      await projectRunOwnedFixture(t, {
        backend,
        path: f.databasePath,
        prefix: f.prefix,
        stage: op.transaction.projectStageAdmission,
        owner,
      });
      const scope = await issuePluginProjectTextRunMutationReadScope({
        authority: op.transaction,
        assertActive: f.active,
      });
      const service = await f.application().withPluginProjectRunReads(scope);
      await assert.rejects(
        service.saveCandidate(f.actor, op.command, op.options),
      );
      assert.equal(await f.count("project_text_revisions"), 0);
      assert.equal(await f.count("project_text_mutation_receipts"), 0);
    },
  );
}
