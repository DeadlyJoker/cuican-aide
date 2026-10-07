import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { nativeMediaFlowFixture } from "./desktop-native-project-media-flow.test-support.ts";
import {
  parseGenerateProjectMediaResponse,
  PROJECT_MEDIA_GENERATE_UI_ACTION,
  PROJECT_MEDIA_RECOVERY_UI_ACTION,
} from "@crewon/contracts/project-media-generations";
import { parseProjectMediaGenerationRecoveryResponse } from "@crewon/contracts/project-media-generation-recovery";

for (const kind of ["T10", "D18"] as const)
  test(
    `Native Short27 ${kind}: installed UI stages, recovers and joins the original HTTP Run`,
    { skip: process.platform === "win32", timeout: 180_000 },
    async (t) => {
      const f = await nativeMediaFlowFixture(t, {
        kind,
        packageDirectory: resolve(
          process.env.CREWON_SHORT27_PACKAGE_DIRECTORY ??
            "output/extensions/installable-plugins/short-drama-media-generation-ui-20261007/short-drama/27.0.0",
        ),
      });
      const command = {
        ...f.body,
        projectId: f.query.projectId,
        idempotencyKey: "native-original-media-generation",
      };
      assert.equal(
        parseProjectMediaGenerationRecoveryResponse(
          await f.invoke(PROJECT_MEDIA_RECOVERY_UI_ACTION, null),
        ).intent,
        null,
      );
      const result = parseGenerateProjectMediaResponse(
        command,
        await f.invoke(PROJECT_MEDIA_GENERATE_UI_ACTION, command),
      );
      assert.equal(result.disposition, "committed");
      assert.equal(result.threadId, f.binding.threadId);
      assert.equal(f.provider.state.uploads, kind === "T10" ? 1 : 3);
      const before = { ...f.provider.state };
      const restored = parseProjectMediaGenerationRecoveryResponse(
        await f.invoke(PROJECT_MEDIA_RECOVERY_UI_ACTION, null),
      );
      assert.equal(restored.intent?.phase, "accepted");
      assert.deepEqual(restored.intent?.receipt, result);
      assert.deepEqual(restored.intent?.request.input, command);
      const httpRecovery = await f.app.inject({
        method: "GET",
        url: `/api/v1/creative-projects/${f.query.projectId}/threads/${f.binding.threadId}/media-generation-recovery`,
        headers: f.headers,
      });
      assert.equal(httpRecovery.statusCode, 200, httpRecovery.body);
      assert.deepEqual(httpRecovery.json(), restored);
      const response = await f.post();
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().runId, result.runId);
      assert.deepEqual(f.provider.state, before);
      const legacy = await f.runtime.ui.recoveryAuthenticatedRequest!(
        f.request(),
        f.actor,
        undefined,
        () =>
          f.runtime.ui.getRecovery!(f.actor, { mountRef: f.mount.mountRef }),
      );
      assert.ok(
        legacy.intents.every(
          (h) => h.request.action !== PROJECT_MEDIA_GENERATE_UI_ACTION,
        ),
      );
    },
  );
