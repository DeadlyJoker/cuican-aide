import assert from "node:assert/strict";
import test from "node:test";
import { captureProjectAssetUiCommitTransaction } from "@crewon/application";
import { capturePluginProjectAssetV2Invocation } from "../../../packages/application/src/plugin-project-asset-v2-invocation.ts";
import { capturePluginProjectAssetInvocationCommitAuthority } from "../../../packages/application/src/plugin-project-asset-invocation.ts";
import { capturePluginUiInvocationCommitAuthority } from "../../../packages/application/src/plugin-ui-invocation-authority.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { observeMaterialPreparationSql } from "../../../packages/store/src/project-material-preparation.test-support.ts";
import { assetV2UiFixture as fixture } from "./plugin-project-asset-v2.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: genuine V2 UI preserves all asset edits and switches between concept and generated history`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        scope = { projectId: f.query.projectId, assetId: f.old.asset.assetId };
      const runs = await f.countRuns(),
        io = [f.state.gets, ...f.materialCounts()];
      const seen = new Set<string>();
      f.uiState.onContext = (context) => {
        seen.add(context.action);
        const original = capturePluginProjectAssetV2Invocation(context);
        assert.throws(() =>
          capturePluginProjectAssetV2Invocation({ ...context }),
        );
        assert.throws(() =>
          capturePluginProjectAssetInvocationCommitAuthority(context),
        );
        assert.equal(
          capturePluginUiInvocationCommitAuthority(context).transaction,
          undefined,
        );
        if (original.uiTransaction) {
          assert.equal(
            original.uiTransaction.version,
            "crewon.project-asset-plugin-commit.v2",
          );
          assert.equal(original.uiTransaction.actionId, context.action);
          assert.deepEqual(original.uiTransaction.input, context.input);
          assert.throws(() =>
            captureProjectAssetUiCommitTransaction({
              ...original.uiTransaction,
              version: "crewon.project-asset-plugin-commit.v1",
            }),
          );
          assert.throws(() =>
            captureProjectAssetUiCommitTransaction({
              ...original.uiTransaction,
              intentRef: {
                intentId: "legacy",
                requestDigest: "sha256:" + "a".repeat(64),
              },
            }),
          );
        }
      };
      const adopted = await f.invoke(
        "adoptMediaReference",
        f.write.request.query,
      );
      assert.ok("disposition" in adopted && adopted.referenceRevision);
      assert.equal(adopted.referenceRevision.source.kind, "media-result");
      let revision = adopted.asset.revision;
      const mutate = async (
        method:
          | "setLocked"
          | "selectReference"
          | "saveCandidate"
          | "selectRevision"
          | "saveReferenceCandidate",
        request: object,
        key: string,
      ) => {
        const response = await f.invoke(method, {
          ...scope,
          request: { expectedAssetRevision: revision, ...request },
          idempotencyKey: key,
        });
        assert.ok("kind" in response);
        revision = response.asset.revision;
        return response;
      };
      await mutate("setLocked", { locked: true }, "lock");
      await assert.rejects(
        mutate("selectReference", { referenceRevision: 1 }, "locked-selection"),
      );
      await mutate("setLocked", { locked: false }, "unlock");
      const concept = await mutate(
        "selectReference",
        { referenceRevision: f.old.reference.referenceRevision },
        "select-old",
      );
      assert.equal(concept.referenceRevision?.source.kind, "concept-selection");
      const legacyUi = await f.createUi({ ownerProtocol: "v1" });
      const beforeLegacy = (await f.assets.getAsset(f.actor, scope))!.asset;
      const inspectContext = f.uiState.onContext;
      f.uiState.onContext = null;
      await assert.rejects(
        legacyUi.invokeLegacy("selectReference", {
          ...scope,
          request: {
            expectedAssetRevision: revision,
            referenceRevision: adopted.referenceRevision.referenceRevision,
          },
          idempotencyKey: "legacy-must-not-select-media",
        }),
        (error) =>
          error instanceof Error &&
          error.cause instanceof Error &&
          error.cause.message ===
            "project_asset_media_reference_reader_required",
      );
      assert.deepEqual(
        (await f.assets.getAsset(f.actor, scope))?.asset,
        beforeLegacy,
      );
      f.uiState.onContext = inspectContext;
      const generatedRevision = revision;
      const generated = await mutate(
        "selectReference",
        { referenceRevision: adopted.referenceRevision.referenceRevision },
        "select-generated",
      );
      assert.deepEqual(generated.referenceRevision, adopted.referenceRevision);
      assert.deepEqual(
        await f.invoke("selectReference", {
          ...scope,
          request: {
            expectedAssetRevision: generatedRevision,
            referenceRevision: adopted.referenceRevision.referenceRevision,
          },
          idempotencyKey: "select-generated",
        }),
        { ...generated, disposition: "replayed" },
      );
      await assert.rejects(
        f.invoke("selectReference", {
          ...scope,
          request: {
            expectedAssetRevision: generatedRevision,
            referenceRevision: adopted.referenceRevision.referenceRevision,
          },
          idempotencyKey: "stale-new-selection",
        }),
      );
      const current = await f.invoke("getAsset", scope);
      assert.ok("view" in current && current.view);
      assert.equal(current.view.referenceState, "current");
      const refs = await f.invoke("listReferences", {
        ...scope,
        afterReferenceRevision: 0,
        limit: 16,
      });
      assert.ok("references" in refs);
      assert.equal(refs.references.length, 2);
      assert.deepEqual(
        await f.invoke("getReferenceRevision", {
          ...scope,
          referenceRevision: adopted.referenceRevision.referenceRevision,
        }),
        { referenceRevision: adopted.referenceRevision },
      );
      const contents = await f.invoke("listRevisions", {
        ...scope,
        afterContentRevision: 0,
        limit: 16,
      });
      assert.ok("revisions" in contents);
      assert.equal(contents.revisions.length, 1);
      assert.deepEqual(
        await f.invoke("getRevision", { ...scope, contentRevision: 1 }),
        { contentRevision: contents.revisions[0] },
      );
      const assets = await f.invoke("listAssets", {
        projectId: scope.projectId,
        afterAssetId: null,
        limit: 16,
      });
      assert.ok("assets" in assets);
      assert.ok(assets.assets.some((a) => a.assetId === scope.assetId));
      const edited = await mutate(
        "saveCandidate",
        {
          kind: "character",
          briefRevision: f.old.content.brief.briefRevision,
          script: null,
          content: {
            ...f.old.content.content,
            setting: "Updated character setting",
          },
        },
        "edit",
      );
      assert.ok(edited.contentRevision);
      await mutate(
        "selectRevision",
        { contentRevision: edited.contentRevision.contentRevision },
        "select-edit",
      );
      const stale = await f.invoke("getAsset", scope);
      assert.ok("view" in stale && stale.view);
      assert.notEqual(stale.view.referenceState, "current");
      await mutate("selectRevision", { contentRevision: 1 }, "restore-content");
      const origin = f.old.reference.source;
      assert.ok("conceptAssetId" in origin);
      const currentConcept = await f.selectionStore.loadCurrentConceptSelection(
        {
          owner: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          },
          projectId: scope.projectId,
          assetId: origin.conceptAssetId,
        },
      );
      const saved = await mutate(
        "saveReferenceCandidate",
        {
          assetContentRevision: 1,
          conceptAssetId: origin.conceptAssetId,
          selectionRevision: currentConcept.selectionRevision,
        },
        "save-concept-again",
      );
      assert.equal(saved.referenceRevision?.source.kind, "concept-selection");
      const replay = await f.invoke(
        "adoptMediaReference",
        f.write.request.query,
      );
      assert.deepEqual(replay, { ...adopted, disposition: "replayed" });
      assert.equal(
        (await f.assets.getAsset(f.actor, scope))?.asset.revision,
        revision,
      );
      assert.equal(seen.size, 12);
      assert.equal(await f.receipts(), 1);
      assert.deepEqual(await f.countRuns(), runs);
      assert.deepEqual([f.state.gets, ...f.materialCounts()], io);
      assert.throws(() => f.owner.actions.invoke(f.uiState.context!));
    },
  );
  test(
    `${backend}: lost V2 reply replays original metadata and post-commit retirement preserves acknowledgement`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.uiState.dropReply = true;
      await assert.rejects(
        f.invoke("adoptMediaReference", f.write.request.query),
      );
      assert.equal(await f.receipts(), 1);
      f.uiState.dropReply = false;
      const cold = await f.createUi();
      const replay = await cold.invoke(
        "adoptMediaReference",
        f.write.request.query,
      );
      assert.ok("disposition" in replay);
      assert.equal(replay.disposition, "replayed");
      const input = {
        projectId: f.query.projectId,
        assetId: f.old.asset.assetId,
        request: { expectedAssetRevision: replay.asset.revision, locked: true },
        idempotencyKey: "lock-with-lost-reply",
      };
      f.uiState.dropReply = true;
      await assert.rejects(cold.invoke("setLocked", input));
      f.uiState.dropReply = false;
      f.uiState.afterResult = () => {
        f.uiState.allowed = false;
      };
      const locked = await cold.invoke("setLocked", input);
      assert.ok("kind" in locked);
      assert.equal(locked.disposition, "replayed");
      f.uiState.afterResult = null;
      await assert.rejects(
        cold.invoke("getAsset", {
          projectId: input.projectId,
          assetId: input.assetId,
        }),
      );
      f.uiState.allowed = true;
      f.uiState.afterResult = () => {
        f.uiState.allowed = false;
      };
      await assert.rejects(
        cold.invoke("getAsset", {
          projectId: input.projectId,
          assetId: input.assetId,
        }),
      );
    },
  );
  test(
    `${backend}: V2 owner denies wrong publication/version and rolls back when retired during SQL`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows();
      const v1 = await f.createUi({ descriptorVersion: "1" }),
        foreign = await f.createUi({ publication: "foreign" });
      for (const ui of [v1, foreign])
        await assert.rejects(
          ui.invoke("adoptMediaReference", f.write.request.query),
          { code: "plugin_project_asset_v2_publication_unavailable" },
        );
      assert.deepEqual(await f.rows(), before);
      assert.equal(await f.receipts(), 0);
      const restore = observeMaterialPreparationSql(
        backend,
        /INSERT INTO .*project_asset_reference_revisions/u,
        () => {
          void f.owner.close();
        },
      );
      try {
        await assert.rejects(
          f.invoke("adoptMediaReference", f.write.request.query),
        );
      } finally {
        restore();
      }
      assert.deepEqual(await f.rows(), before);
      assert.equal(await f.receipts(), 0);
      const next = await f.createUi();
      const scope = {
        projectId: f.query.projectId,
        assetId: f.old.asset.assetId,
      };
      const restoreMutation = observeMaterialPreparationSql(
        backend,
        /UPDATE .*project_assets/u,
        () => {
          void next.owner.close();
        },
      );
      try {
        await assert.rejects(
          next.invoke("setLocked", {
            ...scope,
            request: {
              expectedAssetRevision: f.old.asset.revision,
              locked: true,
            },
            idempotencyKey: "retired-lock",
          }),
        );
      } finally {
        restoreMutation();
      }
      assert.deepEqual(
        (await f.assets.getAsset(f.actor, scope))?.asset,
        f.old.asset,
      );
    },
  );
}
