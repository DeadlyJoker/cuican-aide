import { createHash } from "node:crypto";
import { extensionCanonicalJson } from "@crewon/domain";
import assert from "node:assert/strict";
import test from "node:test";
import {
  issuePluginProjectRuntimeObservation,
  type PluginProjectRuntimeObservationAuthority,
} from "@crewon/application/host-project-workspaces";
import { foundationToolsOwnerFixture } from "../../../apps/runtime-worker/src/plugins/project-foundation-tools-service-owner.test-support.ts";
import { foundationMetadataFixture } from "./project-foundation-legacy-access.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: original paired Store consumes live runtime metadata identity without granting ordinary project reads`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await foundationToolsOwnerFixture(t, "novel", backend);
      const m = await foundationMetadataFixture(t, {
        backend,
        path: f.databasePath,
        schema: f.schema ?? "main",
        prefix: f.prefix,
      });
      await m.migrate();
      const owner = {
        ...f.actor,
        profileId: f.taskAdmission.profileId,
        pluginId: f.taskAdmission.pluginId,
        publisherId: f.taskAdmission.publisherId,
      };
      await m.mark(f.admission.projectId, owner);
      let live = true,
        allowed = true,
        checks = 0;
      const authority: PluginProjectRuntimeObservationAuthority = {
        version: "crewon.plugin-project-runtime-observation.v1",
        actor: f.actor,
        admission: f.taskAdmission,
        binding: f.binding,
        stage: f.stage,
        purpose: "observe",
        async assertCurrent() {
          checks++;
          assert.ok(allowed, "runtime-pdp-denied");
        },
        assertActive() {
          assert.ok(live, "runtime-ended");
        },
      };
      const ref = await issuePluginProjectRuntimeObservation(authority);
      const locator = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: f.binding.runId,
      };
      const before = await f.counts();
      assert.ok(f.foundationRuns.loadRuntimeFoundationRunAdmission);
      await assert.rejects(
        f.foundationRuns.loadFoundationRunAdmission(locator),
      );
      assert.deepEqual(
        await f.foundationRuns.loadRuntimeFoundationRunAdmission(ref),
        f.admission,
      );
      assert.equal(checks, 3);
      const cold = f.parent.projectFoundationRunStore();
      assert.deepEqual(
        await cold.loadRuntimeFoundationRunAdmission(ref),
        f.admission,
      );
      let rechecks = 0;
      const withdrawn = await issuePluginProjectRuntimeObservation({
        ...authority,
        async assertCurrent() {
          rechecks++;
          assert.ok(rechecks < 3, "runtime-withdrawn-after-read");
        },
      });
      await assert.rejects(
        cold.loadRuntimeFoundationRunAdmission(withdrawn),
        /runtime-withdrawn-after-read/u,
      );
      await assert.rejects(
        f.foundationRuns.loadRuntimeFoundationRunAdmission({ ...ref } as never),
      );
      const { contentDigest: _digest, ...body } = f.stage;
      const wrongBody = { ...body, bindingRevision: body.bindingRevision + 1 };
      const wrong = await issuePluginProjectRuntimeObservation({
        ...authority,
        stage: {
          ...wrongBody,
          contentDigest: `sha256:${createHash("sha256").update(extensionCanonicalJson(wrongBody)).digest("hex")}`,
        },
      });
      await assert.rejects(
        f.foundationRuns.loadRuntimeFoundationRunAdmission(wrong),
        /plugin_project_runtime_observation_facts_mismatch/u,
      );
      allowed = false;
      await assert.rejects(
        f.foundationRuns.loadRuntimeFoundationRunAdmission(ref),
        /runtime-pdp-denied/u,
      );
      allowed = true;
      live = false;
      await assert.rejects(
        f.foundationRuns.loadRuntimeFoundationRunAdmission(ref),
        /runtime-ended/u,
      );
      assert.deepEqual(await f.counts(), before);
    },
  );
