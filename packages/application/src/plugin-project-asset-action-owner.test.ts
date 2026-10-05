import assert from "node:assert/strict";
import test from "node:test";
import { projectAssetActionFixture } from "./plugin-project-asset-action.test-support.ts";
import {
  assetContent,
  assetTestOptions,
} from "../../store/src/project-asset.test-support.ts";
import { capturePluginProjectAssetInvocationCommitAuthority } from "./plugin-project-asset-invocation.ts";
import { capturePluginProjectAssetRecoveryInvocationCommitAuthority } from "./plugin-project-asset-recovery-invocation.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import { uiDeferred } from "./plugin-ui.test-support.ts";
import type { ProjectAssetMutationResponse } from "@crewon/contracts/project-assets";
import type { ProjectAssetRecoveryPendingResponse } from "@crewon/contracts/project-asset-recovery";
const candidate = (projectId: string, key = "candidate") => ({
  projectId,
  assetId: null,
  request: {
    kind: "character",
    expectedAssetRevision: 0,
    briefRevision: 1,
    script: null,
    content: assetContent,
  },
  idempotencyKey: key,
});
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} genuine confirmed mutation and terminal ACK remain confirmed after a late owner withdrawal`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetActionFixture(t, backend),
        input = candidate(f.project.project.projectId);
      f.state.afterResult = () => {
        f.state.allowed = false;
      };
      const saved = (await f.invoke(
        "saveCandidate",
        input,
      )) as unknown as ProjectAssetMutationResponse;
      assert.equal(saved.disposition, "committed");
      await assert.rejects(f.recover("getPending", {}));
      f.state.afterResult = null;
      f.state.allowed = true;
      const pending = (await f.recover(
        "getPending",
        {},
      )) as unknown as ProjectAssetRecoveryPendingResponse;
      f.state.afterResult = () => {
        f.state.allowed = false;
      };
      const ack = (await f.recover("acknowledge", {
        intentId: pending.intent!.intentId,
        expectedRevision: pending.intent!.revision,
      })) as unknown as { disposition: string };
      assert.equal(ack.disposition, "acknowledged");
      f.state.afterResult = null;
      f.state.allowed = true;
      assert.deepEqual(await f.recover("getPending", {}), { intent: null });
      assert.equal(
        (
          await f.assets.listAssets(f.actor, {
            projectId: input.projectId,
            kind: null,
            afterAssetId: null,
            limit: 16,
          })
        ).assets.length,
        1,
      );
    },
  );
  test(
    `${backend} genuine manual write stages/commits/reads/ACKs independent metadata with no Run qualification`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetActionFixture(t, backend),
        projectId = f.project.project.projectId,
        input = candidate(projectId);
      let captured = false;
      f.state.onContext = (context) => {
        if (context.action.endsWith("saveCandidate")) {
          const q = capturePluginProjectAssetInvocationCommitAuthority(context);
          assert.deepEqual(q.uiTransaction?.input, input);
          assert.equal(
            capturePluginUiInvocationCommitAuthority(context).transaction,
            undefined,
          );
          assert.equal("run" in q.uiTransaction!, false);
          assert.throws(() =>
            capturePluginProjectAssetInvocationCommitAuthority({ ...context }),
          );
          assert.throws(() =>
            capturePluginProjectAssetRecoveryInvocationCommitAuthority(context),
          );
          captured = true;
        }
      };
      const saved = (await f.invoke(
        "saveCandidate",
        input,
      )) as unknown as ProjectAssetMutationResponse;
      assert.equal(saved.disposition, "committed");
      assert.equal(captured, true);
      assert.equal(saved.asset.selectedContentRevision, null);
      const pending = (await f.recover(
        "getPending",
        {},
      )) as unknown as ProjectAssetRecoveryPendingResponse;
      assert.equal(pending.intent?.phase, "accepted");
      assert.deepEqual(pending.intent?.request.input, input);
      assert.equal(pending.intent?.confirmed?.assetId, saved.asset.assetId);
      const ack = {
        intentId: pending.intent!.intentId,
        expectedRevision: pending.intent!.revision,
      };
      assert.equal(
        (
          (await f.recover("acknowledge", ack)) as unknown as {
            disposition: string;
          }
        ).disposition,
        "acknowledged",
      );
      assert.deepEqual(await f.recover("getPending", {}), { intent: null });
      assert.equal(
        (
          (await f.recover("acknowledge", ack)) as unknown as {
            disposition: string;
          }
        ).disposition,
        "replayed",
      );
      f.policy.allow = false;
      await assert.rejects(f.recover("acknowledge", ack), {
        code: "creative_project_authorization_denied",
      });
    },
  );
  test(
    `${backend} lost ACK cold genuine mount recovers original request and same key returns one candidate`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetActionFixture(t, backend),
        input = candidate(f.project.project.projectId);
      f.state.dropReply = true;
      await assert.rejects(
        f.invoke("saveCandidate", input),
        (error) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "plugin_ui_unavailable" &&
          error.cause instanceof Error &&
          error.cause.message === "named_ack_lost_after_real_commit",
      );
      await f.close();
      f.state.dropReply = false;
      const cold = await f.createOwners(),
        pending = (await cold.recover(
          "getPending",
          {},
        )) as unknown as ProjectAssetRecoveryPendingResponse;
      assert.equal(pending.intent?.phase, "accepted");
      assert.deepEqual(pending.intent?.request.input, input);
      const result = (await cold.invoke(
        "saveCandidate",
        pending.intent!.request.input,
      )) as unknown as ProjectAssetMutationResponse;
      assert.equal(result.disposition, "replayed");
      assert.equal(result.asset.latestContentRevision, 1);
      const page = await f.assets.listAssets(f.actor, {
        projectId: input.projectId,
        kind: null,
        afterAssetId: null,
        limit: 16,
      });
      assert.equal(page.assets.length, 1);
      await cold.recover("acknowledge", {
        intentId: pending.intent!.intentId,
        expectedRevision: pending.intent!.revision,
      });
    },
  );
  test(
    `${backend} unresolved accepted slot blocks another project's key and true CAS refusal can be acknowledged`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetActionFixture(t, backend),
        input = candidate(f.project.project.projectId),
        saved = (await f.invoke(
          "saveCandidate",
          input,
        )) as unknown as ProjectAssetMutationResponse;
      const other = await f.projects.createProject(f.actor, {
        title: "第二项目",
        briefText: "原跨项目单槽",
        idempotencyKey: "other-project",
      });
      await assert.rejects(
        f.invoke(
          "saveCandidate",
          candidate(other.project.projectId, "second-key"),
        ),
        (error) =>
          error instanceof Error &&
          "code" in error &&
          [
            "project_asset_ui_intent_pending",
            "project_asset_ui_intent_unacknowledged",
          ].includes(error.code as string),
      );
      const pending = (await f.recover(
        "getPending",
        {},
      )) as unknown as ProjectAssetRecoveryPendingResponse;
      await f.recover("acknowledge", {
        intentId: pending.intent!.intentId,
        expectedRevision: pending.intent!.revision,
      });
      await assert.rejects(
        f.invoke("setLocked", {
          projectId: input.projectId,
          assetId: saved.asset.assetId,
          request: { expectedAssetRevision: 2, locked: true },
          idempotencyKey: "wrong-revision",
        }),
        { code: "project_asset_revision_conflict" },
      );
      const refused = (await f.recover(
        "getPending",
        {},
      )) as unknown as ProjectAssetRecoveryPendingResponse;
      assert.equal(refused.intent?.phase, "refused");
      assert.equal(
        refused.intent?.refusalCode,
        "project_asset_revision_conflict",
      );
      await f.recover("acknowledge", {
        intentId: refused.intent!.intentId,
        expectedRevision: refused.intent!.revision,
      });
    },
  );
  test(
    `${backend} owner close withdraws real invocation before Store work and physically joins pending authorization`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetActionFixture(t, backend),
        entered = uiDeferred(),
        release = uiDeferred();
      let closed = false;
      f.state.beforeHost = async () => {
        entered.resolve();
        await release.promise;
      };
      const read = f.invoke("listAssets", {
        projectId: f.project.project.projectId,
        afterAssetId: null,
        limit: 16,
      });
      await entered.promise;
      const close = f.owner.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      assert.equal(closed, false);
      release.resolve();
      await assert.rejects(read);
      await close;
      assert.equal(closed, true);
      assert.deepEqual(await f.recover("getPending", {}), { intent: null });
    },
  );
}
