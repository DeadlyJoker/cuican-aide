import assert from "node:assert/strict";
import test from "node:test";
import { parseProjectMediaGenerationRecoveryResponse } from "@crewon/contracts/project-media-generation-recovery";
import {
  parsePluginUiRecoveryHintsResponse,
  parseStagePluginUiRecoveryResponse,
} from "@crewon/contracts/plugins";
import { PROJECT_MEDIA_GENERATE_UI_ACTION } from "@crewon/contracts/project-media-generations";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { mediaGenerationUiFixture } from "./project-media-generation-plugin-ui.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: media UI stages before dispatch, survives remount and shares one Run with HTTP`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend, { recovery: true });
      const counts = await f.countRuns();
      await assert.rejects(
        f.invoke(),
        "declared recovery requires a durable staged intent",
      );
      assert.equal(f.state.uploads, 0);
      const request = {
        action: PROJECT_MEDIA_GENERATE_UI_ACTION,
        input: f.command,
      } as const;
      const staged = parseStagePluginUiRecoveryResponse(
        await f.stage(),
        request,
      );
      assert.equal(staged.intent.phase, "prepared");
      assert.deepEqual(await f.countRuns(), counts);
      const restored = parseProjectMediaGenerationRecoveryResponse(
        await f.recover(),
      );
      assert.deepEqual(restored.intent?.request, request);
      assert.equal(restored.intent?.retryable, true);
      const accepted = await f.invoke();
      const io = [f.state.uploads, f.state.sourceGets, f.state.targetGets];
      assert.equal(accepted.disposition, "committed");
      await f.ui.closeMount(f.actor, { mountRef: f.mount.mountRef });
      const mount = await f.ui.openMount(f.actor, {
        pluginId: f.pin.pluginId,
        contributionId: "workbench",
        expectedPackageDigest: f.pin.packageDigest,
        expectedSelectionRevision: f.target.selection.revision,
      });
      const recovered = parseProjectMediaGenerationRecoveryResponse(
        await f.recover(mount.mountRef),
      );
      assert.equal(recovered.intent?.phase, "accepted");
      assert.deepEqual(recovered.intent?.receipt, accepted);
      const replay = await f.post();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().runId, accepted.runId);
      assert.deepEqual(
        [f.state.uploads, f.state.sourceGets, f.state.targetGets],
        io,
      );
    },
  );
  test(
    `${backend}: media intent keeps legacy three-action GET empty and blocks changed generation keys`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend, { recovery: true });
      await f.stage();
      const legacy = await f.requests.run(
        { request: f.request, actor: f.actor },
        () => f.ui.getRecovery(f.actor, { mountRef: f.mount.mountRef }),
      );
      assert.deepEqual(parsePluginUiRecoveryHintsResponse(legacy).intents, []);
      await assert.rejects(
        f.stage({
          ...f.command,
          idempotencyKey: "another-key",
          executionId: "another-execution",
        }),
      );
      const recovered = parseProjectMediaGenerationRecoveryResponse(
        await f.recover(),
      );
      assert.deepEqual(recovered.intent?.request.input, f.command);
      assert.equal(f.state.uploads, 0);
      assert.throws(() =>
        parsePluginUiRecoveryHintsResponse({
          version: "crewon.plugin-ui-recovery.v1",
          intents: [recovered.intent],
        }),
      );
    },
  );
  test(
    `${backend}: withdrawing UI access keeps the staged request durable and cannot read another owner's recovery`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend, { recovery: true });
      await f.stage();
      f.stateUi.allowed = false;
      await assert.rejects(f.recover());
      await assert.rejects(f.invoke());
      assert.equal(f.state.uploads, 0);
      f.stateUi.allowed = true;
      assert.equal(
        parseProjectMediaGenerationRecoveryResponse(await f.recover()).intent
          ?.phase,
        "prepared",
      );
      await assert.rejects(
        f.requests.run({ request: f.request, actor: f.actor }, () =>
          f.ui.invoke(
            { ...f.actor, actorId: "foreign" },
            {
              mountRef: f.mount.mountRef,
              action: "crewon.project-media-generations.v1.getRecovery",
              input: null,
            },
          ),
        ),
      );
    },
  );
}
