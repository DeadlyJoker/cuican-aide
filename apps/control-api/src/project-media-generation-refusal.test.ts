import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { mediaGenerationUiFixture } from "./project-media-generation-plugin-ui.test-support.ts";
import {
  mediaGenerationRuntimeFixture,
  barrier,
} from "./project-media-generation-runtime.test-support.ts";
import { InstalledProjectMediaGenerationRuntime } from "./installed-project-media-generation-runtime.ts";
import { parseProjectMediaGenerationRecoveryResponse } from "@crewon/contracts/project-media-generation-recovery";
import {
  PROJECT_MEDIA_RECOVERY_UI_ACTION,
  PROJECT_MEDIA_RECOVERY_V2_UI_ACTION,
} from "@crewon/contracts/project-media-generations";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: first pre-admission refusal survives runtime reopen and frees a new explicit request`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationRuntimeFixture(t, backend);
      const before = await f.countRuns();
      f.generation.allowed = false;
      const failed = await f.post();
      assert.equal(failed.statusCode, 403, failed.body);
      assert.equal(f.state.uploads, 0);
      assert.deepEqual(await f.countRuns(), before);
      await f.owner.close();
      const next = await InstalledProjectMediaGenerationRuntime.prepare({
        core: f.core,
        configuration: f.configuration,
      });
      t.after(() => next.close());
      const restored = await next.getRecovery(
        { ...f.request, method: "GET" },
        f.actor,
        { projectId: f.command.projectId, threadId: f.command.threadId },
      );
      assert.equal(restored.intent?.phase, "refused");
      assert.equal(
        restored.intent?.reasonCode,
        "project_media_generation_not_admitted",
      );
      assert.equal(restored.intent?.retryable, false);
      assert.equal(restored.intent?.receipt, null);
      f.generation.allowed = true;
      await assert.rejects(
        next.generate(f.request, f.actor, f.command),
        /project_media_generation_not_admitted/u,
      );
      const accepted = await next.generate(f.request, f.actor, {
        ...f.command,
        executionId: "new-explicit-execution",
        idempotencyKey: "new-explicit-key",
      });
      assert.equal(accepted.disposition, "committed");
      assert.equal(
        (await f.countRuns()).run_snapshots,
        before.run_snapshots! + 1,
      );
      assert.equal(f.state.uploads, 1);
    },
  );
  test(
    `${backend}: recovery-aware UI reports v2 refusal while v1 projection stays compatible`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend, {
        recovery: true,
        mediaApiVersion: "2",
      });
      await f.stage();
      f.generation.allowed = false;
      await assert.rejects(f.invoke());
      const restored = parseProjectMediaGenerationRecoveryResponse(
        await f.recover(),
      );
      assert.equal(restored.intent?.phase, "refused");
      assert.equal(restored.intent?.dispatchAttemptCount, 1);
      const legacy = await f.requests.run(
        { request: f.request, actor: f.actor },
        () =>
          f.ui.invoke(f.actor, {
            mountRef: f.mount.mountRef,
            action: PROJECT_MEDIA_RECOVERY_UI_ACTION,
            input: null,
          }),
      );
      assert.deepEqual(legacy, { intent: null });
      await assert.rejects(f.stage(), /project_media_generation_not_admitted/u);
      f.generation.allowed = true;
      const fresh = {
        ...f.command,
        executionId: "fixed-execution",
        idempotencyKey: "fixed-input-key",
      };
      await f.stage(fresh);
      const accepted = await f.invoke(fresh);
      assert.equal(accepted.disposition, "committed");
      assert.equal(f.state.uploads, 1);
    },
  );
  test(
    `${backend}: v1-only UI cannot request the v2 refusal projection`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend, { recovery: true });
      await assert.rejects(
        f.requests.run({ request: f.request, actor: f.actor }, () =>
          f.ui.invoke(f.actor, {
            mountRef: f.mount.mountRef,
            action: PROJECT_MEDIA_RECOVERY_V2_UI_ACTION,
            input: null,
          }),
        ),
      );
      assert.equal(f.state.uploads, 0);
    },
  );
  test(
    `${backend}: once TaskCore is called its error remains unresolved and cannot free another key`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationRuntimeFixture(t, backend);
      const before = await f.countRuns();
      const failed = await f.post({
        body: { ...f.body, expectedThreadRevision: 99 },
      });
      assert.equal(failed.statusCode, 409, failed.body);
      assert.equal(f.state.uploads, 1, "preparation reached the real TaskCore");
      assert.deepEqual(await f.countRuns(), before);
      const restored = await f.owner.getRecovery(
        { ...f.request, method: "GET" },
        f.actor,
        { projectId: f.command.projectId, threadId: f.command.threadId },
      );
      assert.equal(restored.intent?.phase, "dispatched");
      assert.equal(restored.intent?.reasonCode, null);
      const changed = await f.post({
        headers: { ...f.headers, "idempotency-key": "another-key" },
        body: { ...f.body, executionId: "new-execution" },
      });
      assert.equal(changed.statusCode, 409, changed.body);
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend}: an earlier cancelled attempt survives a later known preparation failure`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationRuntimeFixture(t, backend);
      const entered = barrier(),
        release = barrier(),
        controller = new AbortController();
      f.state.onAuthorize = async (p) => {
        if (p.action === "projectMaterial:upload") {
          entered.resolve();
          await release.promise;
        }
      };
      const pending = assert.rejects(
        f.owner.generate(f.request, f.actor, f.command, controller.signal),
      );
      await entered.promise;
      controller.abort();
      release.resolve();
      await pending;
      f.state.onAuthorize = undefined;
      f.generation.allowed = false;
      assert.equal((await f.post()).statusCode, 403);
      const restored = await f.owner.getRecovery(
        { ...f.request, method: "GET" },
        f.actor,
        { projectId: f.command.projectId, threadId: f.command.threadId },
      );
      assert.equal(restored.intent?.phase, "dispatched");
      assert.equal(restored.intent?.dispatchAttemptCount, 2);
      assert.equal(f.state.uploads, 0);
    },
  );
  test(
    `${backend}: legacy UI also journals before preparation and shares the original HTTP receipt`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend);
      const accepted = await f.invoke();
      const restored = await f.owner.getRecovery(
        { ...f.request, method: "GET" },
        f.actor,
        { projectId: f.command.projectId, threadId: f.command.threadId },
      );
      assert.equal(restored.intent?.phase, "accepted");
      assert.equal(restored.intent?.receipt?.runId, accepted.runId);
      const replay = await f.post();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().runId, accepted.runId);
      assert.equal(f.state.uploads, 1);
    },
  );
}
