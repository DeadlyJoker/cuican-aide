import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  CreativeProjectApplicationService,
  ProjectAssetApplicationService,
  ProjectAssetReferenceImageApplicationService,
  ProjectTextApplicationService,
  type ProjectAssetReferenceImageStore,
} from "@crewon/application";
import { extensionCanonicalJson, type ProjectAssetKind } from "@crewon/domain";
import {
  conceptSelectionFixture,
  selectionVerifier,
} from "./project-concept-selection.test-support.ts";
import {
  assetContent,
  assetTestOptions,
  hasAssetCause,
} from "./project-asset.test-support.ts";
import { extensionStoreDigester as digester } from "./extension-store-records.ts";
import {
  timestamp,
  configuration as configurationRecipe,
  receipt,
} from "./extension-store.test-support.ts";

/** Real ownership, immutable result, original admission/funding and selected reference.
 * Policy and provider decoding are named port fixtures; this is not media-I/O or App acceptance.
 */
async function fixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: ProjectAssetKind = "character",
) {
  const f = await conceptSelectionFixture(t, backend),
    parent = f.first.parent;
  await parent.projectTextStore().migrate();
  const store = parent.projectAssetStore({ verifier: selectionVerifier });
  await store.migrate();
  const policy = { allow: true };
  const common = {
    authorization: {
      authorize: async () =>
        policy.allow
          ? { outcome: "allow" as const }
          : {
              outcome: "deny" as const,
              reasonCode: "named_reference_policy_denied",
            },
    },
    clock: { now: () => timestamp },
    ids: { nextId: () => randomUUID() },
    digester,
  };
  const projects = new CreativeProjectApplicationService({
    ...common,
    store: parent.creativeProjectStore(),
  });
  const assets = new ProjectAssetApplicationService({
    ...common,
    store,
    projects: parent.creativeProjectStore(),
    texts: parent.projectTextStore(),
  });
  const selected = await f.selectionStore.commitConceptImageSelection(
      f.selectionInput,
      f.selectionCommitOptions,
    ),
    projectId = f.reference.projectId;
  const saved = await assets.saveCandidate(f.actor, {
    projectId,
    assetId: null,
    kind,
    expectedAssetRevision: 0,
    briefRevision: 1,
    script: null,
    content: assetContent,
    idempotencyKey: "reference-asset",
  });
  const assetId = saved.asset.assetId;
  await assets.selectRevision(f.actor, {
    projectId,
    assetId,
    expectedAssetRevision: 1,
    contentRevision: 1,
    idempotencyKey: "reference-content-selected",
  });
  await assets.saveReferenceCandidate(f.actor, {
    projectId,
    assetId,
    expectedAssetRevision: 2,
    assetContentRevision: 1,
    conceptAssetId: f.reference.assetId,
    selectionRevision: selected.pointer.selectionRevision,
    idempotencyKey: "reference-saved",
  });
  await assets.selectReference(f.actor, {
    projectId,
    assetId,
    expectedAssetRevision: 3,
    referenceRevision: 1,
    idempotencyKey: "reference-selected",
  });
  const query = {
    projectId,
    assetId,
    kind,
    expectedAssetRevision: 4,
    contentRevision: 1,
    referenceRevision: 1,
  };
  const resolver = (source: ProjectAssetReferenceImageStore = store) =>
    new ProjectAssetReferenceImageApplicationService({
      projects,
      assets,
      store: source,
      digester,
    });
  async function rows() {
    return {
      ...(await f.counts()),
      ...Object.fromEntries(
        await Promise.all(
          [
            "project_assets",
            "project_asset_revisions",
            "project_asset_reference_revisions",
            "project_asset_mutation_receipts",
            "creative_operation_result_links",
            "extension_external_operations",
          ].map(async (table) => [table, await f.count(table)]),
        ),
      ),
    };
  }
  return { ...f, store, assets, projects, policy, query, resolver, rows };
}

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["character", "scene", "prop"] as const) {
    test(
      `${backend} resolves adopted ${kind} through the original result, not the latest concept selection, without writes`,
      assetTestOptions(backend),
      async (t) => {
        const f = await fixture(t, backend, kind);
        await f.assets.setLocked(f.actor, {
          projectId: f.query.projectId,
          assetId: f.query.assetId,
          expectedAssetRevision: 4,
          locked: true,
          idempotencyKey: "lock-original",
        });
        await f.selectionStore.commitConceptImageSelection(
          f.secondSelectionInput,
          f.selectionCommitOptions,
        );
        const before = await f.rows(),
          q = { ...f.query, expectedAssetRevision: 5 };
        const source = await f.resolver().resolveSelectedReference(f.actor, q);
        assert.equal(source.asset.locked, true);
        assert.equal(source.resultLink.image.filename, "original-0.png");
        assert.equal(source.resultLink.image.resultIndex, 0);
        assert.equal(source.reference.source.sourceRunId, f.link.binding.runId);
        assert.equal(source.resultLink.operationId, f.operation.operationId);
        assert.equal(
          source.configuration.revision,
          f.link.binding.configurationRevision,
        );
        assert.equal(
          source.configuration.contentDigest,
          f.link.binding.configurationDigest,
        );
        assert.deepEqual(await f.rows(), before);
        assert.ok(Object.isFrozen(source));
        assert.deepEqual(
          await f.store.loadReferenceImageSource({ actor: f.actor, query: q }),
          source,
        );
        assert.deepEqual(await f.rows(), before);
      },
    );
  }

  test(
    `${backend} rejects wrong owner, project, kind, revisions and nonselected candidates at both ports`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows();
      for (const query of [
        { ...f.query, projectId: "other-project" },
        { ...f.query, assetId: "other-asset" },
        { ...f.query, kind: "scene" as const },
        { ...f.query, expectedAssetRevision: 3 },
        { ...f.query, contentRevision: 2 },
        { ...f.query, referenceRevision: 2 },
      ]) {
        await assert.rejects(
          f.resolver().resolveSelectedReference(f.actor, query),
        );
        await assert.rejects(
          f.store.loadReferenceImageSource({ actor: f.actor, query }),
        );
      }
      for (const outsider of [
        { ...f.actor, principalId: "other-owner" },
        { ...f.actor, tenantId: "other-tenant" },
        { ...f.actor, spaceId: "other-space" },
      ]) {
        await assert.rejects(
          f.resolver().resolveSelectedReference(outsider, f.query),
        );
        await assert.rejects(
          f.store.loadReferenceImageSource({ actor: outsider, query: f.query }),
        );
      }
      assert.deepEqual(await f.rows(), before);
    },
  );

  test(
    `${backend} missing image verifier fails closed while existing text reads remain usable`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        withoutVerifier = f.first.parent.projectAssetStore(),
        before = await f.rows();
      await assert.rejects(
        f.resolver(withoutVerifier).resolveSelectedReference(f.actor, f.query),
        hasAssetCause("project_asset_reference_verifier_unavailable"),
      );
      assert.equal(
        (
          await f.assets.getAsset(f.actor, {
            projectId: f.query.projectId,
            assetId: f.query.assetId,
          })
        )?.asset.assetId,
        f.query.assetId,
      );
      assert.deepEqual(await f.rows(), before);
    },
  );

  test(
    `${backend} rejects archived projects and changed brief sources without modifying frozen history`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.resolver().resolveSelectedReference(f.actor, f.query);
      const project = await f.projects.getProject(f.actor, {
        projectId: f.query.projectId,
      });
      const archived = await f.projects.setProjectState(f.actor, {
        projectId: f.query.projectId,
        expectedProjectRevision: project.revision,
        state: "archived",
        idempotencyKey: "archive",
      });
      await assert.rejects(
        f.resolver().resolveSelectedReference(f.actor, f.query),
        hasAssetCause("creative_project_archived"),
      );
      await assert.rejects(
        f.store.loadReferenceImageSource({ actor: f.actor, query: f.query }),
        hasAssetCause("creative_project_archived"),
      );
      const restored = await f.projects.setProjectState(f.actor, {
        projectId: f.query.projectId,
        expectedProjectRevision: archived.project.revision,
        state: "active",
        idempotencyKey: "restore",
      });
      await f.projects.appendBrief(f.actor, {
        projectId: f.query.projectId,
        expectedProjectRevision: restored.project.revision,
        text: "新创作需求",
        idempotencyKey: "new-brief",
      });
      const rows = await f.rows();
      await assert.rejects(
        f.resolver().resolveSelectedReference(f.actor, f.query),
        hasAssetCause("project_asset_source_stale"),
      );
      await assert.rejects(
        f.store.loadReferenceImageSource({ actor: f.actor, query: f.query }),
        hasAssetCause("project_asset_source_stale"),
      );
      assert.deepEqual(
        await f.assets.getReferenceRevision(f.actor, {
          projectId: f.query.projectId,
          assetId: f.query.assetId,
          referenceRevision: 1,
        }),
        before.reference,
      );
      assert.deepEqual(await f.rows(), rows);
    },
  );

  test(
    `${backend} reauthorizes after source read and ignores instance method overrides`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows();
      let overridden = 0;
      Object.defineProperty(f.projects, "getProject", {
        value: () => {
          overridden++;
          throw new Error("override-called");
        },
      });
      assert.throws(() =>
        Object.defineProperty(f.assets, "getAsset", {
          value: () => {
            overridden++;
          },
        }),
      );
      const source = {
        async loadReferenceImageSource(
          input: Parameters<
            ProjectAssetReferenceImageStore["loadReferenceImageSource"]
          >[0],
        ) {
          const result = await f.store.loadReferenceImageSource(input);
          f.policy.allow = false;
          return result;
        },
      };
      await assert.rejects(
        f.resolver(source).resolveSelectedReference(f.actor, f.query),
        (e) =>
          e instanceof Error &&
          "category" in e &&
          e.category === "authorization",
      );
      assert.equal(overridden, 0);
      assert.deepEqual(await f.rows(), before);
    },
  );

  test(
    `${backend} a current script reference resolves, then changing its adopted outline makes it stale at both ports`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        projectId = f.query.projectId,
        assetId = f.query.assetId;
      const texts = new ProjectTextApplicationService({
        store: f.first.parent.projectTextStore(),
        projects: f.first.parent.creativeProjectStore(),
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => timestamp },
        ids: { nextId: () => randomUUID() },
        digester,
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
        idempotencyKey: "script-source-outline",
      });
      await texts.selectRevision(f.actor, {
        projectId,
        artifactId: outline.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "script-source-outline-selected",
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
        idempotencyKey: "script-source",
      });
      await texts.selectRevision(f.actor, {
        projectId,
        artifactId: script.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "script-source-selected",
      });
      await f.assets.saveCandidate(f.actor, {
        projectId,
        assetId,
        kind: "character",
        expectedAssetRevision: 4,
        briefRevision: 1,
        script: { artifactId: script.artifact.artifactId, contentRevision: 1 },
        content: assetContent,
        idempotencyKey: "script-asset-source",
      });
      await f.assets.selectRevision(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 5,
        contentRevision: 2,
        idempotencyKey: "script-asset-selected",
      });
      await f.assets.saveReferenceCandidate(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 6,
        assetContentRevision: 2,
        conceptAssetId: f.reference.assetId,
        selectionRevision: 1,
        idempotencyKey: "script-reference",
      });
      await f.assets.selectReference(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 7,
        referenceRevision: 2,
        idempotencyKey: "script-reference-selected",
      });
      const q = {
        ...f.query,
        expectedAssetRevision: 8,
        contentRevision: 2,
        referenceRevision: 2,
      };
      assert.equal(
        (await f.resolver().resolveSelectedReference(f.actor, q)).content.script
          ?.artifactId,
        script.artifact.artifactId,
      );
      await texts.saveOutlineCandidate(f.actor, {
        projectId,
        expectedArtifactRevision: 2,
        briefRevision: 1,
        content: { ...outlineContent, logline: "新结局" },
        idempotencyKey: "new-outline",
      });
      await texts.selectRevision(f.actor, {
        projectId,
        artifactId: outline.artifact.artifactId,
        expectedArtifactRevision: 3,
        contentRevision: 2,
        idempotencyKey: "new-outline-selected",
      });
      const before = await f.rows();
      await assert.rejects(
        f.resolver().resolveSelectedReference(f.actor, q),
        hasAssetCause("project_asset_source_stale"),
      );
      await assert.rejects(
        f.store.loadReferenceImageSource({ actor: f.actor, query: q }),
        hasAssetCause("project_asset_source_stale"),
      );
      assert.deepEqual(await f.rows(), before);
    },
  );

  test(
    `${backend} concurrent adoption after provenance read fails instead of returning the old selected input`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const saved = await f.assets.saveCandidate(f.actor, {
        projectId: f.query.projectId,
        assetId: f.query.assetId,
        kind: "character",
        expectedAssetRevision: 4,
        briefRevision: 1,
        script: null,
        content: { ...assetContent, setting: "新服装" },
        idempotencyKey: "new-candidate",
      });
      const q = { ...f.query, expectedAssetRevision: saved.asset.revision };
      const source = {
        async loadReferenceImageSource(
          input: Parameters<
            ProjectAssetReferenceImageStore["loadReferenceImageSource"]
          >[0],
        ) {
          const result = await f.store.loadReferenceImageSource(input);
          await f.assets.selectRevision(f.actor, {
            projectId: q.projectId,
            assetId: q.assetId,
            expectedAssetRevision: q.expectedAssetRevision,
            contentRevision: 2,
            idempotencyKey: "concurrent-adoption",
          });
          return result;
        },
      };
      await assert.rejects(
        f.resolver(source).resolveSelectedReference(f.actor, q),
        hasAssetCause("project_asset_reference_image_changed"),
      );
      assert.equal(
        (
          await f.assets.getAsset(f.actor, {
            projectId: q.projectId,
            assetId: q.assetId,
          })
        )?.asset.selectedContentRevision,
        2,
      );
    },
  );

  test(
    `${backend} checks original operation instead of trusting the saved URL`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows();
      await f.sql(
        `UPDATE ${f.prefix}extension_external_operations SET record_json='{}'`,
      );
      await assert.rejects(
        f.resolver().resolveSelectedReference(f.actor, f.query),
      );
      assert.deepEqual(await f.rows(), before);
    },
  );

  test(
    `${backend} a well formed result with a recomputed digest cannot replace the frozen source`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows();
      const source: ProjectAssetReferenceImageStore = {
        async loadReferenceImageSource(input) {
          const original = await f.store.loadReferenceImageSource(input);
          const { contentDigest: _, ...body } = original.resultLink;
          const changed = {
            ...body,
            image: {
              ...body.image,
              url: "https://another-provider.example/forged.png",
            },
          };
          return {
            ...original,
            resultLink: {
              ...changed,
              contentDigest: digester.sha256(extensionCanonicalJson(changed)),
            },
          };
        },
      };
      await assert.rejects(
        f.resolver(source).resolveSelectedReference(f.actor, f.query),
        hasAssetCause("project_asset_reference_image_proof_invalid"),
      );
      assert.deepEqual(await f.rows(), before);
    },
  );

  test(
    `${backend} a project update during provenance resolution cannot silently become the current execution source`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const source: ProjectAssetReferenceImageStore = {
        async loadReferenceImageSource(input) {
          const result = await f.store.loadReferenceImageSource(input);
          const p = await f.projects.getProject(f.actor, {
            projectId: f.query.projectId,
          });
          await f.projects.renameProject(f.actor, {
            projectId: f.query.projectId,
            title: "新的项目名称",
            expectedProjectRevision: p.revision,
            idempotencyKey: "rename-during-read",
          });
          return result;
        },
      };
      await assert.rejects(
        f.resolver(source).resolveSelectedReference(f.actor, f.query),
        hasAssetCause("project_asset_reference_image_changed"),
      );
    },
  );

  test(
    `${backend} retains the historical configuration after a default change and rejects actual revocation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        original = await f
          .resolver()
          .resolveSelectedReference(f.actor, f.query);
      await f.first.store.saveExtensionConfiguration({
        configuration: configurationRecipe({
          revision: 2,
          parameters: { serviceUrl: "https://new-provider.example/" },
        }),
        expectedRevision: 1,
        receipt: receipt("new-default"),
      });
      assert.deepEqual(
        (await f.resolver().resolveSelectedReference(f.actor, f.query))
          .configuration,
        original.configuration,
      );
      const scope = {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          pluginId: f.link.binding.pluginId,
        },
        activation = await f.first.store.loadExtensionActivation(scope);
      assert.ok(activation);
      await f.first.store.saveExtensionActivation({
        activation: {
          ...activation,
          revision: activation.revision + 1,
          state: "revoked",
          target: null,
        },
        expectedRevision: activation.revision,
        receipt: receipt("source-revoked"),
      });
      const before = await f.rows();
      await assert.rejects(
        f.resolver().resolveSelectedReference(f.actor, f.query),
        hasAssetCause("extension_access_revoked"),
      );
      assert.deepEqual(await f.rows(), before);
    },
  );

  test(
    `${backend} immutable link cannot be rewritten and a corrupted historical configuration is rejected`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows();
      await assert.rejects(
        f.sql(
          `UPDATE ${f.prefix}creative_operation_result_links SET result_index=1`,
        ),
        /concept_selection_immutable/u,
      );
      assert.equal(
        (await f.resolver().resolveSelectedReference(f.actor, f.query))
          .resultLink.image.resultIndex,
        0,
      );
      await f.sql(
        `UPDATE ${f.prefix}extension_configurations SET configuration_json='{}'`,
      );
      await assert.rejects(
        f.resolver().resolveSelectedReference(f.actor, f.query),
      );
      assert.deepEqual(await f.rows(), before);
    },
  );

  test(
    `${backend} refuses arbitrary URLs and accessors without evaluating input getters`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows();
      let getters = 0;
      for (const query of [
        { ...f.query, url: "https://example.com/image.png" },
        { ...f.query, filename: "invented.png" },
        Object.defineProperty({ ...f.query }, "projectId", {
          enumerable: true,
          get() {
            getters++;
            return f.query.projectId;
          },
        }),
      ]) {
        await assert.rejects(
          f.resolver().resolveSelectedReference(f.actor, query as never),
        );
        await assert.rejects(
          f.store.loadReferenceImageSource({
            actor: f.actor,
            query: query as never,
          }),
        );
      }
      assert.equal(getters, 0);
      assert.deepEqual(await f.rows(), before);
    },
  );
}
