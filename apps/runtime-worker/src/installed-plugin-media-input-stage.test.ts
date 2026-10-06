import assert from "node:assert/strict";
import test from "node:test";
import { mediaInputStageFixture } from "../../../packages/store/src/project-media-input-stage.test-support.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";

test("a real committed media-input stage cannot dispatch as an unscoped installed Agent when its independent runtime service is not deployed", async (t) => {
  const f = await mediaInputStageFixture(t, "sqlite");
  const task = await f.startStage();
  const locator = {
    tenantId: task.result.binding.tenantId,
    spaceId: task.result.binding.spaceId,
    runId: task.result.binding.runId,
  };
  assert.deepEqual(
    await f.stages.loadMediaInputStageAdmission(locator),
    task.mediaInputStageAdmission,
  );
  const counts = await f.counts();
  const credits = await f.creditObjects();
  for (const stores of [f.first, f.second]) {
    const reader = new InstalledPluginRunContext({
      extensions: stores.store,
      runs: stores.parent,
      installations: stores.parent.pluginInstallationStore(),
      // Named policy fixture; refusal must come from actual persisted stage scope.
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      resolveActor: async () => f.actor,
    });
    for (const purpose of ["submit", "observe"] as const)
      await assert.rejects(
        reader.load({
          locator,
          expectedTarget: task.result.binding.target,
          purpose,
          signal: new AbortController().signal,
        }),
        /installed_plugin_media_input_stage_runtime_unavailable/,
      );
  }
  assert.deepEqual(await f.counts(), counts);
  assert.deepEqual(await f.creditObjects(), credits);
});

test("media-input scope is read from the native required marker and remains tied to its owner's original snapshot", async (t) => {
  const f = await mediaInputStageFixture(t, "sqlite"),
    task = await f.startStage();
  const locator = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    runId: task.result.binding.runId,
  };
  const reader = new InstalledPluginRunContext({
    extensions: f.first.store,
    runs: f.first.parent,
    installations: f.first.parent.pluginInstallationStore(),
    mediaInputStages: f.stages,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    resolveActor: async () => f.actor,
  });
  const snapshot = await reader.load({
    locator,
    expectedTarget: task.result.binding.target,
    purpose: "submit",
    signal: new AbortController().signal,
  });
  assert.ok(snapshot);
  assert.deepEqual(
    reader.verifiedProjectMediaInputStage(snapshot),
    task.mediaInputStageAdmission,
  );
  assert.equal(reader.verifiedProjectStage(snapshot), null);
  assert.equal(reader.verifiedProjectAssetStage(snapshot), null);
  assert.throws(
    () => reader.verifiedProjectMediaInputStage({ ...snapshot }),
    /snapshot_invalid/,
  );
  await reader.assertCurrent(snapshot, "submit", new AbortController().signal);
});
