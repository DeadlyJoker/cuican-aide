import assert from "node:assert/strict";
import test from "node:test";
import { parseProjectAssetReferenceRevision } from "@crewon/domain";
import {
  parseProjectAssetMediaAdoptionWrite,
  projectAssetMediaAdoptionRequestDigest,
} from "@crewon/application";
import { projectAssetPublicReference } from "../../../packages/application/src/plugin-project-asset-action-projection.ts";
import { observeMaterialPreparationSql } from "../../../packages/store/src/project-material-preparation.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { assetMediaAdoptionFixture as fixture } from "./project-asset-media-adoption.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: explicit adoption writes an immutable v2 reference and original head/receipt atomically without another generation or download`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend, { migrate: false }),
        before = await f.rows(),
        io = [f.state.gets, ...f.materialCounts()];
      await assert.rejects(f.adopt(), /unavailable/u);
      await f.store.migrateAssetAdoptions();
      await f.store.migrateAssetAdoptions();
      const result = await f.adopt();
      assert.equal(result.disposition, "committed");
      assert.equal(
        result.referenceRevision.schemaVersion,
        "crewon.project-asset-reference.v2",
      );
      assert.equal(
        result.referenceRevision.source.candidateId,
        f.candidate.candidateId,
      );
      assert.equal(result.asset.revision, f.old.asset.revision + 1);
      assert.equal(
        result.asset.selectedReferenceRevision,
        f.old.asset.latestReferenceRevision + 1,
      );
      assert.equal(
        result.asset.selectedContentRevision,
        f.old.asset.selectedContentRevision,
      );
      assert.deepEqual(
        parseProjectAssetReferenceRevision(
          result.referenceRevision,
          f.digester,
        ),
        result.referenceRevision,
      );
      const view = await f.assets.getAsset(f.actor, {
        projectId: f.query.projectId,
        assetId: f.old.asset.assetId,
      });
      assert.equal(view!.referenceState, "current");
      assert.deepEqual(view!.selectedReference, result.referenceRevision);
      const refs = await f.assets.listReferences(f.actor, {
        projectId: f.query.projectId,
        assetId: f.old.asset.assetId,
        afterReferenceRevision: 0,
        limit: 16,
      });
      assert.deepEqual(refs.references[0], f.old.reference);
      assert.deepEqual(
        projectAssetPublicReference(refs.references[0]!),
        projectAssetPublicReference(f.old.reference),
      );
      assert.throws(
        () => projectAssetPublicReference(result.referenceRevision),
        /api_version_required/u,
      );
      assert.equal(await f.receipts(), 1);
      const after = await f.rows();
      for (const [key, n] of Object.entries(before)) {
        assert.ok(typeof n === "number");
        assert.equal(
          after[key],
          n + (key === "project_asset_reference_revisions" ? 1 : 0),
          key,
        );
      }
      assert.deepEqual([f.state.gets, ...f.materialCounts()], io);
      assert.equal(
        f.adoptionState.transactionCalls,
        backend === "postgres" ? 1 : 0,
      );
    },
  );

  test(
    `${backend}: a lost adoption response and fresh original Store connection recover the same reference without changing later selections`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await assert.rejects(async () => {
        await f.adopt();
        throw new Error("named_lost_adoption_response");
      }, /named_lost/u);
      const original = await f.adopt();
      assert.equal(original.disposition, "replayed");
      await f.assets.selectReference(f.actor, {
        projectId: f.query.projectId,
        assetId: f.old.asset.assetId,
        expectedAssetRevision: original.asset.revision,
        referenceRevision: f.old.reference.referenceRevision,
        idempotencyKey: "select-old-concept-again",
      });
      const before = await f.assets.getAsset(f.actor, {
        projectId: f.query.projectId,
        assetId: f.old.asset.assetId,
      });
      const reopened = await f.cold();
      assert.notEqual(reopened.parent, f.parent);
      const cold = reopened.ext.projectMediaResults();
      await cold.migrateAssetAdoptions();
      const recovered = await cold.adoptAssetReference(
        { ...f.write, at: "2026-10-08T00:00:00.000Z" },
        f.adoptionAuthority(),
      );
      assert.deepEqual(recovered, original);
      assert.deepEqual(
        await f.assets.getAsset(f.actor, {
          projectId: f.query.projectId,
          assetId: f.old.asset.assetId,
        }),
        before,
      );
      assert.equal(await f.receipts(), 1);
      const project = await f.projects.getProject(f.actor, {
        projectId: f.query.projectId,
      });
      await f.projects.setProjectState(f.actor, {
        projectId: project.projectId,
        expectedProjectRevision: project.revision,
        state: "archived",
        idempotencyKey: "archive-after-adoption",
      });
      assert.deepEqual(
        await cold.adoptAssetReference(f.write, f.adoptionAuthority()),
        original,
      );
    },
  );

  test(
    `${backend}: adoption preflight can read the original project before borrowing its commit connection`,
    { ...assetTestOptions(backend), timeout: 30000 },
    async (t) => {
      const f = await fixture(t, backend),
        grant = f.adoptionAuthority();
      const result = await f.store.adoptAssetReference(f.write, {
        ...grant,
        assertCurrent: async () => {
          await grant.assertCurrent();
          const project = await f.projects.getProject(f.actor, {
            projectId: f.query.projectId,
          });
          assert.equal(project.projectId, f.query.projectId);
        },
      });
      assert.equal(result.disposition, "committed");
      assert.equal(f.adoptionState.currentCalls, 1);
      assert.equal(await f.receipts(), 1);
    },
  );

  test(
    `${backend}: identical concurrent keys replay once and different keys cannot bypass the original asset revision`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        second = f.ext.projectMediaResults();
      await second.migrateAssetAdoptions();
      const same = await Promise.all([
        f.adopt(),
        second.adoptAssetReference(f.write, f.adoptionAuthority()),
      ]);
      assert.deepEqual(same.map((r) => r.disposition).sort(), [
        "committed",
        "replayed",
      ]);
      assert.deepEqual(same[0]!.referenceRevision, same[1]!.referenceRevision);
      const different = {
        ...f.write,
        request: {
          ...f.write.request,
          query: {
            ...f.write.request.query,
            idempotencyKey: "different-key-old-revision",
          },
        },
      };
      await assert.rejects(
        second.adoptAssetReference(
          different,
          f.adoptionAuthority(different.request),
        ),
        /asset_changed/u,
      );
      const conflict = {
        ...f.write,
        request: {
          ...f.write.request,
          query: { ...f.write.request.query, resultIndex: 1 },
        },
      };
      await assert.rejects(
        second.adoptAssetReference(
          conflict,
          f.adoptionAuthority(conflict.request),
        ),
        /receipt_conflict/u,
      );
      assert.notEqual(
        projectAssetMediaAdoptionRequestDigest(conflict.request),
        projectAssetMediaAdoptionRequestDigest(f.write.request),
      );
      assert.equal(await f.receipts(), 1);
    },
  );

  for (const step of ["reference", "head", "receipt"] as const)
    test(
      `${backend}: withdrawal after ${step} SQL rolls back the entire adoption and original-key retry succeeds`,
      assetTestOptions(backend),
      async (t) => {
        const f = await fixture(t, backend),
          before = await f.rows(),
          pattern =
            step === "reference"
              ? /INSERT INTO .*project_asset_reference_revisions/u
              : step === "head"
                ? /UPDATE .*project_assets SET revision/u
                : /INSERT INTO .*project_asset_media_adoption_receipts/u,
          restore = observeMaterialPreparationSql(backend, pattern, () => {
            f.adoptionState.active = false;
          });
        try {
          await assert.rejects(f.adopt(), /named_adoption_inactive/u);
        } finally {
          restore();
        }
        assert.deepEqual(await f.rows(), before);
        assert.equal(await f.receipts(), 0);
        assert.deepEqual(
          (await f.assets.getAsset(f.actor, {
            projectId: f.query.projectId,
            assetId: f.old.asset.assetId,
          }))!.asset,
          f.old.asset,
        );
        f.adoptionState.active = true;
        assert.equal((await f.adopt()).disposition, "committed");
        assert.equal(await f.receipts(), 1);
      },
    );

  test(
    `${backend}: read grants, source injection, stale versions and antedated writes cannot produce adoption rows`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows();
      assert.throws(() =>
        f.store.adoptAssetReference(f.write, f.authority() as never),
      );
      assert.throws(() =>
        parseProjectAssetMediaAdoptionWrite({
          ...f.write,
          source: f.candidate,
        }),
      );
      assert.throws(() =>
        parseProjectAssetMediaAdoptionWrite({
          ...f.write,
          request: {
            ...f.write.request,
            query: {
              ...f.write.request.query,
              url: "https://caller.invalid/x.png",
            },
          },
        }),
      );
      await assert.rejects(
        f.store.adoptAssetReference(
          { ...f.write, at: "2020-01-01T00:00:00.000Z" },
          f.adoptionAuthority(),
        ),
        /timestamp_invalid/u,
      );
      for (const patch of [
        { assetId: f.characterTwo.assetId },
        { assetContentRevision: 2 },
        { expectedAssetRevision: f.old.asset.revision + 1 },
        { candidateDigest: "sha256:" + "f".repeat(64) },
      ]) {
        const write = {
          ...f.write,
          request: {
            ...f.write.request,
            query: { ...f.write.request.query, ...patch },
          },
        };
        await assert.rejects(
          f.store.adoptAssetReference(
            write,
            f.adoptionAuthority(write.request),
          ),
        );
      }
      assert.deepEqual(await f.rows(), before);
      assert.equal(await f.receipts(), 0);
    },
  );
}
