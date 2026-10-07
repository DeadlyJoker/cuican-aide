import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_ASSET_V2_ACTIONS as actions,
  parseProjectAssetV2Response,
} from "@crewon/contracts/project-assets-v2";
import { parsePublicProjectAssetReferenceRevision } from "@crewon/contracts/project-assets";
import { projectAssetPublicReference } from "@crewon/application";
import { mediaAdoptionServiceFixture as fixture } from "./project-asset-media-adoption-service.test-support.ts";
import { observeMaterialPreparationSql } from "../../../packages/store/src/project-material-preparation.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: actual adoption service returns readable V2 references while original concept API stays compatible`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        query = { projectId: f.query.projectId, assetId: f.old.asset.assetId },
        io = [f.state.gets, ...f.materialCounts()],
        runs = await f.countRuns();
      const before = await f.publicService.query(f.actor, {
        action: actions.getAsset,
        input: query,
      });
      assert.ok("view" in before && before.view);
      assert.equal(
        before.view.selectedReferenceRevision?.source.kind,
        "concept-selection",
      );
      const adopted = await f.adoptPublic();
      assert.ok("disposition" in adopted);
      assert.equal(adopted.disposition, "committed");
      assert.equal(adopted.referenceRevision.source.kind, "media-result");
      assert.equal(
        adopted.referenceRevision.source.candidateId,
        f.candidate.candidateId,
      );
      const after = await f.publicService.query(f.actor, {
        action: actions.getAsset,
        input: query,
      });
      assert.ok("view" in after && after.view);
      assert.equal(after.view.referenceState, "current");
      assert.deepEqual(
        after.view.selectedReferenceRevision,
        adopted.referenceRevision,
      );
      const pageRequest = {
        action: actions.listReferences,
        input: { ...query, afterReferenceRevision: 0, limit: 1 },
      };
      const first = await f.publicService.query(f.actor, pageRequest);
      assert.ok("references" in first);
      assert.equal(first.references[0]?.source.kind, "concept-selection");
      assert.equal(
        first.nextReferenceRevision,
        f.old.reference.referenceRevision,
      );
      const second = await f.publicService.query(f.actor, {
        ...pageRequest,
        input: {
          ...pageRequest.input,
          afterReferenceRevision: first.nextReferenceRevision!,
        },
      });
      assert.ok("references" in second);
      assert.deepEqual(second.references, [adopted.referenceRevision]);
      assert.equal(second.nextReferenceRevision, null);
      const legacy = projectAssetPublicReference(f.old.reference);
      assert.deepEqual(
        parsePublicProjectAssetReferenceRevision(legacy),
        legacy,
      );
      assert.throws(() =>
        parsePublicProjectAssetReferenceRevision(adopted.referenceRevision),
      );
      const serialized = JSON.stringify(after);
      for (const key of [
        "tenantId",
        "principalId",
        "actorId",
        "archiveId",
        "filename",
        "url",
        "parameters",
        "sourceBindingDigest",
      ])
        assert.equal(serialized.includes('"' + key + '"'), false, key);
      assert.deepEqual([f.state.gets, ...f.materialCounts()], io);
      assert.deepEqual(await f.countRuns(), runs);
      assert.equal(await f.receipts(), 1);
      assert.equal(
        f.policy.transactionChecks.length,
        backend === "postgres" ? 3 : 0,
      );
    },
  );
  test(
    `${backend}: project write, result read and adoption permission are independent, including receipt replay`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows(),
        io = [f.state.gets, ...f.materialCounts()];
      for (const action of [
        "creativeProject:write",
        "projectMediaResult:read",
        "projectAsset:adoptMediaReference",
      ] as const) {
        f.policy.denied = action;
        await assert.rejects(f.adoptPublic(), /adoption_denied/u);
        assert.equal(await f.receipts(), 0);
        assert.deepEqual(await f.rows(), before);
      }
      f.policy.denied = null;
      await f.adoptPublic();
      f.policy.denied = "projectAsset:adoptMediaReference";
      await assert.rejects(f.adoptPublic(), /adoption_denied/u);
      f.policy.denied = null;
      const replay = await f.adoptPublic();
      assert.ok("disposition" in replay);
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual([f.state.gets, ...f.materialCounts()], io);
      for (const p of f.policy.checks) {
        assert.deepEqual(p.actor, f.actor);
        assert.equal(p.resource.assetId, f.old.asset.assetId);
        assert.equal(p.resource.candidateDigest, f.candidate.contentDigest);
        assert.equal(Object.hasOwn(p.resource, "idempotencyKey"), false);
      }
    },
  );
  test(
    `${backend}: retirement during original SQL rolls back adoption and cancellation cannot create a reference`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows();
      const restore = observeMaterialPreparationSql(
        backend,
        /INSERT INTO .*project_asset_reference_revisions/u,
        () => {
          f.policy.active = false;
        },
      );
      try {
        await assert.rejects(f.adoptPublic(), /named_adoption_policy_retired/u);
      } finally {
        restore();
      }
      assert.equal(await f.receipts(), 0);
      assert.deepEqual(await f.rows(), before);
      f.policy.active = true;
      const controller = new AbortController();
      controller.abort(new Error("named_adoption_cancelled"));
      await assert.rejects(
        f.publicService.adoptReference(f.actor, f.write.request.query, {
          ...f.options(),
          signal: controller.signal,
        }),
        /named_adoption_cancelled/u,
      );
      assert.equal(await f.receipts(), 0);
      await assert.rejects(
        f.publicService.adoptReference(f.actor, f.write.request.query, {
          ...f.options(),
          authority: f.authority() as never,
        }),
        /project_asset_fields_invalid/u,
      );
      assert.equal(await f.receipts(), 0);
      assert.ok("disposition" in (await f.adoptPublic()));
    },
  );
  test(
    `${backend}: fresh original Store replays public adoption after a later selection without selecting it again`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        first = await f.adoptPublic();
      assert.ok("disposition" in first);
      await f.assets.selectReference(f.actor, {
        projectId: f.query.projectId,
        assetId: f.old.asset.assetId,
        expectedAssetRevision: first.asset.revision,
        referenceRevision: f.old.reference.referenceRevision,
        idempotencyKey: "public-select-original-again",
      });
      const query = {
          projectId: f.query.projectId,
          assetId: f.old.asset.assetId,
        },
        current = await f.assets.getAsset(f.actor, query),
        cold = await f.cold(),
        store = cold.ext.projectMediaResults();
      await store.migrateAssetAdoptions();
      const next = f.openService(store),
        replay = await next.publicService.adoptReference(
          f.actor,
          f.write.request.query,
          f.options(),
        );
      assert.ok("disposition" in replay);
      assert.deepEqual(replay, { ...first, disposition: "replayed" });
      assert.deepEqual(
        (await f.assets.getAsset(f.actor, query))?.asset,
        current?.asset,
      );
      assert.equal(await f.receipts(), 1);
      assert.throws(() =>
        parseProjectAssetV2Response(
          { action: actions.adoptMediaReference, input: f.write.request.query },
          {
            ...replay,
            asset: { ...replay.asset, revision: replay.asset.revision + 1 },
          },
        ),
      );
    },
  );
}
