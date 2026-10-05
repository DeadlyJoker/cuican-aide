import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  ProjectAssetApplicationService,
  ProjectTextApplicationService,
} from "@crewon/application";
import {
  conceptSelectionFixture,
  selectionVerifier,
} from "./project-concept-selection.test-support.ts";
import {
  assetContent,
  assetTestOptions,
  hasAssetCause,
} from "./project-asset.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { timestamp } from "./extension-store.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} reference pins the real succeeded image proof, keeps original-key result after concept changes and leaves stale history selected`,
    assetTestOptions(backend),
    async (t) => {
      const f = await conceptSelectionFixture(t, backend);
      await f.first.parent.projectTextStore().migrate();
      const store = f.first.parent.projectAssetStore({
        verifier: selectionVerifier,
      });
      await store.migrate();
      const assets = new ProjectAssetApplicationService({
        store,
        projects: f.first.parent.creativeProjectStore(),
        texts: f.first.parent.projectTextStore(),
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => timestamp },
        ids: { nextId: () => randomUUID() },
        digester: extensionStoreDigester,
      });
      const first = await f.selectionStore.commitConceptImageSelection(
          f.selectionInput,
          f.selectionCommitOptions,
        ),
        projectId = f.reference.projectId;
      const a = await assets.saveCandidate(f.actor, {
        projectId,
        assetId: null,
        kind: "character",
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: assetContent,
        idempotencyKey: "character",
      });
      const assetId = a.asset.assetId;
      await assets.selectRevision(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 1,
        contentRevision: 1,
        idempotencyKey: "content-selected",
      });
      const request = {
        projectId,
        assetId,
        expectedAssetRevision: 2,
        assetContentRevision: 1,
        conceptAssetId: f.reference.assetId,
        selectionRevision: first.pointer.selectionRevision,
        idempotencyKey: "reference-original",
      };
      const ref = await assets.saveReferenceCandidate(f.actor, request);
      assert.equal(
        ref.referenceRevision!.source.sourceRunId,
        f.link.binding.runId,
      );
      assert.equal(
        ref.referenceRevision!.source.operationId,
        f.operation.operationId,
      );
      assert.equal(ref.referenceRevision!.source.resultIndex, 0);
      await f.selectionStore.commitConceptImageSelection(
        f.secondSelectionInput,
        f.selectionCommitOptions,
      );
      const replay = await assets.saveReferenceCandidate(f.actor, request);
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.referenceRevision, ref.referenceRevision);
      await assert.rejects(
        assets.saveReferenceCandidate(f.actor, {
          ...request,
          expectedAssetRevision: 3,
          idempotencyKey: "old-selection-new-key",
        }),
        hasAssetCause("project_asset_concept_selection_changed"),
      );
      await assets.selectReference(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 3,
        referenceRevision: 1,
        idempotencyKey: "ref-selected",
      });
      await assets.setLocked(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 4,
        locked: true,
        idempotencyKey: "lock",
      });
      const later = await assets.saveCandidate(f.actor, {
        projectId,
        assetId,
        kind: "character",
        expectedAssetRevision: 5,
        briefRevision: 1,
        script: null,
        content: { ...assetContent, setting: "新衣服" },
        idempotencyKey: "new-content",
      });
      assert.equal(later.asset.selectedReferenceRevision, 1);
      await assets.setLocked(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 6,
        locked: false,
        idempotencyKey: "unlock",
      });
      await assets.selectRevision(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 7,
        contentRevision: 2,
        idempotencyKey: "new-content-select",
      });
      const view = await assets.getAsset(f.actor, { projectId, assetId });
      assert.equal(view!.referenceState, "stale");
      assert.equal(view!.asset.selectedReferenceRevision, 1);
      await assert.rejects(
        assets.selectReference(f.actor, {
          projectId,
          assetId,
          expectedAssetRevision: 8,
          referenceRevision: 1,
          idempotencyKey: "ref-stale",
        }),
        hasAssetCause("project_asset_reference_stale"),
      );
      assert.equal(
        (
          await assets.listReferences(f.actor, {
            projectId,
            assetId,
            afterReferenceRevision: 0,
            limit: 16,
          })
        ).references.length,
        1,
      );
    },
  );
  test(
    `${backend} missing verifier never blocks text; foreign project image and caller URL cannot become provenance`,
    assetTestOptions(backend),
    async (t) => {
      const f = await conceptSelectionFixture(t, backend);
      await f.first.parent.projectTextStore().migrate();
      const store = f.first.parent.projectAssetStore();
      await store.migrate();
      const assets = new ProjectAssetApplicationService({
        store,
        projects: f.first.parent.creativeProjectStore(),
        texts: f.first.parent.projectTextStore(),
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => timestamp },
        ids: { nextId: () => randomUUID() },
        digester: extensionStoreDigester,
      });
      const a = await assets.saveCandidate(f.actor, {
        projectId: f.reference.projectId,
        assetId: null,
        kind: "prop",
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: assetContent,
        idempotencyKey: "no-media",
      });
      await assert.rejects(
        assets.saveReferenceCandidate(f.actor, {
          projectId: a.asset.projectId,
          assetId: a.asset.assetId,
          expectedAssetRevision: 1,
          assetContentRevision: 1,
          conceptAssetId: f.reference.assetId,
          selectionRevision: 1,
          idempotencyKey: "no-verifier",
        }),
        hasAssetCause("project_asset_reference_verifier_unavailable"),
      );
      await assert.rejects(
        assets.saveReferenceCandidate(f.actor, {
          projectId: a.asset.projectId,
          assetId: a.asset.assetId,
          expectedAssetRevision: 1,
          assetContentRevision: 1,
          conceptAssetId: f.reference.assetId,
          selectionRevision: 1,
          idempotencyKey: "url",
          url: "https://fake.invalid/image.png",
        } as never),
      );
      assert.equal(
        (await assets.getAsset(f.actor, {
          projectId: a.asset.projectId,
          assetId: a.asset.assetId,
        }))!.asset.latestReferenceRevision,
        0,
      );
      await f.selectionStore.commitConceptImageSelection(
        f.selectionInput,
        f.selectionCommitOptions,
      );
      const withProof = f.first.parent.projectAssetStore({
        verifier: selectionVerifier,
      });
      const foreign = {
        projectId: "foreign-project",
        assetId: a.asset.assetId,
        expectedAssetRevision: 1,
        assetContentRevision: 1,
        conceptAssetId: f.reference.assetId,
        selectionRevision: 1,
        idempotencyKey: "foreign-project-image",
      };
      const receipt = (
        await import("@crewon/application")
      ).projectAssetMutationReceipt(
        f.actor,
        "save-reference",
        foreign,
        extensionStoreDigester,
      );
      await assert.rejects(
        withProof.commitMutation({
          actor: f.actor,
          kind: "save-reference",
          command: foreign,
          receipt,
          at: timestamp,
          createdAssetId: null,
        }),
      );
    },
  );
  test(
    `${backend} selecting a genuine reference rejects a selected script whose adopted outline changed`,
    assetTestOptions(backend),
    async (t) => {
      const f = await conceptSelectionFixture(t, backend),
        parent = f.first.parent,
        projectId = f.reference.projectId,
        textStore = parent.projectTextStore();
      await textStore.migrate();
      const common = {
        authorization: {
          authorize: async () => ({ outcome: "allow" as const }),
        },
        clock: { now: () => timestamp },
        ids: { nextId: () => randomUUID() },
        digester: extensionStoreDigester,
      };
      const texts = new ProjectTextApplicationService({
        ...common,
        store: textStore,
        projects: parent.creativeProjectStore(),
      });
      const outlineContent = {
        title: "来信",
        logline: "旧信",
        synopsis: "雨夜收到旧信",
        episodes: [{ episodeId: "ep-1", title: "来信", summary: "读信" }],
      };
      const outline = await texts.saveOutlineCandidate(f.actor, {
        projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: outlineContent,
        idempotencyKey: "outline",
      });
      await texts.selectRevision(f.actor, {
        projectId,
        artifactId: outline.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "outline-select",
      });
      const script = await texts.saveScriptCandidate(f.actor, {
        projectId,
        episodeId: "ep-1",
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: {
          artifactId: outline.artifact.artifactId,
          contentRevision: 1,
        },
        content: {
          title: "来信",
          scenes: [
            {
              sceneId: "scene-1",
              location: "工作室",
              timeOfDay: "夜",
              action: "读信",
              dialogue: [],
            },
          ],
        },
        idempotencyKey: "script",
      });
      await texts.selectRevision(f.actor, {
        projectId,
        artifactId: script.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "script-select",
      });
      const store = parent.projectAssetStore({ verifier: selectionVerifier });
      await store.migrate();
      const assets = new ProjectAssetApplicationService({
        ...common,
        store,
        projects: parent.creativeProjectStore(),
        texts: textStore,
      });
      const selection = await f.selectionStore.commitConceptImageSelection(
          f.selectionInput,
          f.selectionCommitOptions,
        ),
        saved = await assets.saveCandidate(f.actor, {
          projectId,
          assetId: null,
          kind: "character",
          expectedAssetRevision: 0,
          briefRevision: 1,
          script: {
            artifactId: script.artifact.artifactId,
            contentRevision: 1,
          },
          content: assetContent,
          idempotencyKey: "character",
        }),
        assetId = saved.asset.assetId;
      await assets.selectRevision(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 1,
        contentRevision: 1,
        idempotencyKey: "select-content",
      });
      const ref = await assets.saveReferenceCandidate(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 2,
        assetContentRevision: 1,
        conceptAssetId: f.reference.assetId,
        selectionRevision: selection.pointer.selectionRevision,
        idempotencyKey: "reference",
      });
      assert.equal(ref.asset.selectedReferenceRevision, null);
      await texts.saveOutlineCandidate(f.actor, {
        projectId,
        expectedArtifactRevision: 2,
        briefRevision: 1,
        content: { ...outlineContent, logline: "新大纲" },
        idempotencyKey: "outline-new",
      });
      await texts.selectRevision(f.actor, {
        projectId,
        artifactId: outline.artifact.artifactId,
        expectedArtifactRevision: 3,
        contentRevision: 2,
        idempotencyKey: "outline-select-new",
      });
      await assert.rejects(
        assets.selectReference(f.actor, {
          projectId,
          assetId,
          expectedAssetRevision: 3,
          referenceRevision: 1,
          idempotencyKey: "select-stale-reference",
        }),
        hasAssetCause("project_asset_source_stale"),
      );
      const view = await assets.getAsset(f.actor, { projectId, assetId });
      assert.equal(view!.asset.selectedReferenceRevision, null);
      assert.equal(view!.asset.revision, 3);
      assert.deepEqual(view!.staleReasons, ["script-source-stale"]);
      assert.equal(
        (
          await assets.getReferenceRevision(f.actor, {
            projectId,
            assetId,
            referenceRevision: 1,
          })
        ).source.operationId,
        f.operation.operationId,
      );
    },
  );
}
