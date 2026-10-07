import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectAssetMediaImageSource,
  parseProjectAssetImageSource,
} from "@crewon/domain";
import {
  ProjectAssetMediaReferenceApplicationService,
  parseProjectAssetMediaReferenceQualificationRequest,
  projectAssetMediaReferenceResultRequest,
  projectAssetMediaImageSourceFromResult,
} from "@crewon/application";
import { mediaResultFixture } from "./project-media-result-publisher.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";

async function fixture(
  t: Parameters<typeof mediaResultFixture>[0],
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
) {
  const f = await mediaResultFixture(t, backend, kind),
    old = await f.referenceSource(),
    saved = await f.publisher.publish(f.actor, f.query, {
      signal: new AbortController().signal,
    }),
    request = {
      actor: f.actor,
      query: {
        ...f.query,
        candidateId: saved.candidate.candidateId,
        candidateDigest: saved.candidate.contentDigest,
        assetId: old.asset.assetId,
        expectedAssetRevision: old.asset.revision,
        assetContentRevision: old.content.contentRevision,
      },
    };
  return {
    ...f,
    old,
    saved,
    request,
    qualify: () => f.store.qualifyAssetReference(request, f.authority()),
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: application reauthorizes original project and asset reads, checks the stored target and rejects a late pointer change`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      let calls = 0;
      let effect: "none" | "deny" | "wrong-target" | "lock" = "none";
      const service = new ProjectAssetMediaReferenceApplicationService({
        projects: f.projects,
        assets: f.assets,
        digester: f.digester,
        store: {
          async qualifyAssetReference(request, authority) {
            calls++;
            const result = await f.store.qualifyAssetReference(
              request,
              authority,
            );
            if (effect === "deny") f.policy.allow = false;
            if (effect === "wrong-target")
              return {
                ...result,
                source: {
                  ...result.source,
                  candidateId: "result-" + "0".repeat(64),
                },
              };
            if (effect === "lock")
              await f.assets.setLocked(f.actor, {
                projectId: f.query.projectId,
                assetId: f.old.asset.assetId,
                expectedAssetRevision: f.old.asset.revision,
                locked: true,
                idempotencyKey: "qualify-late-lock",
              });
            return result;
          },
        },
      });
      const invoke = () =>
        service.qualifyReference(f.actor, f.request.query, {
          authority: f.authority(),
        });
      assert.deepEqual(await invoke(), await f.qualify());
      assert.equal(calls, 1);
      f.policy.allow = false;
      await assert.rejects(invoke());
      assert.equal(calls, 1);
      f.policy.allow = true;
      effect = "wrong-target";
      await assert.rejects(invoke(), /proof_invalid/u);
      effect = "deny";
      await assert.rejects(invoke());
      f.policy.allow = true;
      effect = "lock";
      await assert.rejects(invoke(), /asset_locked/u);
    },
  );
  test(
    `${backend}: saved T10 qualifies its original character/input/reference and cold reads without changing adopted pointers or contacting provider`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows(),
        io = [f.state.gets, ...f.materialCounts()],
        qualified = await f.qualify();
      assert.deepEqual(qualified.asset, f.old.asset);
      assert.deepEqual(qualified.content, f.old.content);
      assert.deepEqual(qualified.source.generatedFor, {
        assetId: f.old.asset.assetId,
        contentRevision: f.old.content.contentRevision,
        contentDigest: f.old.content.contentDigest,
        referenceRevision: f.old.reference.referenceRevision,
        referenceDigest: f.old.reference.contentDigest,
      });
      assert.equal(qualified.source.candidateId, f.saved.candidate.candidateId);
      assert.equal(qualified.source.sourceRunId, f.query.runId);
      assert.equal(
        qualified.source.mediaInputId,
        f.saved.candidate.frozen.source.projection.reference.mediaInputId,
      );
      assert.equal(
        qualified.source.operationDigest,
        f.saved.candidate.frozen.source.projection.operation.contentDigest,
      );
      assert.equal(qualified.source.kind, "media-result");
      assert.ok(Object.isFrozen(qualified.source.generatedFor));
      assert.deepEqual(
        parseProjectAssetMediaImageSource(qualified.source),
        qualified.source,
      );
      assert.throws(() => parseProjectAssetImageSource(qualified.source));
      assert.deepEqual(await f.rows(), before);
      const reopened = f.ext.projectMediaResults();
      await reopened.enableResultReads();
      assert.deepEqual(
        await reopened.qualifyAssetReference(f.request, f.authority()),
        qualified,
      );
      assert.deepEqual([f.state.gets, ...f.materialCounts()], io);
      for (const field of [
        "url",
        "filename",
        "archiveId",
        "materialId",
        "bytes",
        "byteDigest",
      ]) {
        assert.equal(field in qualified.source, false);
      }
    },
  );

  test(
    `${backend}: candidate pins, exact target, ownership, read authority and cancellation are rechecked before qualification`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows();
      for (const patch of [
        { candidateId: "result-" + "0".repeat(64) },
        { candidateDigest: "sha256:" + "0".repeat(64) },
        { expectedAssetRevision: f.request.query.expectedAssetRevision + 1 },
        { assetContentRevision: f.request.query.assetContentRevision + 1 },
        { assetId: f.characterTwo.assetId },
        { assetId: f.scene.assetId },
      ])
        await assert.rejects(
          f.store.qualifyAssetReference(
            { ...f.request, query: { ...f.request.query, ...patch } },
            f.authority(),
          ),
        );
      const unsaved = {
        ...f.request,
        query: { ...f.request.query, resultIndex: 1 },
      };
      await assert.rejects(
        f.store.qualifyAssetReference(unsaved, {
          ...f.authority(),
          request: projectAssetMediaReferenceResultRequest(unsaved),
        }),
        /candidate_not_found/u,
      );
      const foreign = {
        ...f.request,
        actor: { ...f.actor, principalId: "different-owner" },
      };
      await assert.rejects(
        f.store.qualifyAssetReference(foreign, {
          ...f.authority(),
          request: projectAssetMediaReferenceResultRequest(foreign),
        }),
      );
      assert.throws(() =>
        f.store.qualifyAssetReference(f.request, f.authority("publish")),
      );
      f.state.active = false;
      await assert.rejects(f.qualify(), /named_result_transaction_inactive/u);
      f.state.active = true;
      assert.deepEqual(await f.rows(), before);
      await f.assets.setLocked(f.actor, {
        projectId: f.query.projectId,
        assetId: f.old.asset.assetId,
        expectedAssetRevision: f.old.asset.revision,
        locked: true,
        idempotencyKey: "media-reference-lock",
      });
      await assert.rejects(
        f.store.qualifyAssetReference(
          {
            ...f.request,
            query: {
              ...f.request.query,
              expectedAssetRevision: f.old.asset.revision + 1,
            },
          },
          f.authority(),
        ),
        /asset_locked/u,
      );
    },
  );

  test(
    `${backend}: editing the adopted character prevents attaching an old result even with the new asset revision`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        changed = await f.assets.saveCandidate(f.actor, {
          projectId: f.query.projectId,
          assetId: f.old.asset.assetId,
          kind: "character",
          expectedAssetRevision: f.old.asset.revision,
          briefRevision: f.old.content.brief.briefRevision,
          script: null,
          content: {
            ...f.old.content.content,
            setting: "A different character setting",
          },
          idempotencyKey: "media-reference-new-content",
        });
      const selected = await f.assets.selectRevision(f.actor, {
        projectId: f.query.projectId,
        assetId: f.old.asset.assetId,
        expectedAssetRevision: changed.asset.revision,
        contentRevision: changed.contentRevision!.contentRevision,
        idempotencyKey: "media-reference-select-new-content",
      });
      await assert.rejects(f.qualify(), /asset_changed/u);
      await assert.rejects(
        f.store.qualifyAssetReference(
          {
            ...f.request,
            query: {
              ...f.request.query,
              expectedAssetRevision: selected.asset.revision,
              assetContentRevision: selected.contentRevision!.contentRevision,
            },
          },
          f.authority(),
        ),
        /source_stale/u,
      );
      assert.equal(
        (await f.assets.getAsset(f.actor, {
          projectId: f.query.projectId,
          assetId: f.old.asset.assetId,
        }))!.asset.selectedReferenceRevision,
        f.old.asset.selectedReferenceRevision,
      );
    },
  );

  test(
    `${backend}: a new input prompt never rewrites the original candidate's input or anchor`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        first = await f.qualify(),
        before = f.saved.candidate.frozen.source.projection.reference;
      await f.app.saveInput(f.actor, {
        ...f.command,
        mediaInputId: before.mediaInputId,
        expectedInputRevision: before.inputRevision,
        prompt: "Later prompt for the same character",
        idempotencyKey: "media-reference-later-input",
      });
      assert.deepEqual(await f.qualify(), first);
      const project = await f.projects.getProject(f.actor, {
        projectId: f.query.projectId,
      });
      await f.projects.appendBrief(f.actor, {
        projectId: project.projectId,
        expectedProjectRevision: project.revision,
        text: "The project has a new brief",
        idempotencyKey: "media-reference-new-brief",
      });
      await assert.rejects(f.qualify(), /source_stale/u);
    },
  );

  test(
    `${backend}: D18 episode frames cannot be misrepresented as character references`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend, "D18");
      await assert.rejects(f.qualify(), /purpose_mismatch/u);
    },
  );

  test(
    `${backend}: source codecs reject caller paths, execution-shaped substitutions and accessors without weakening concept v1`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        q = await f.qualify();
      const history = await f.ext.loadProjectMediaGenerationContext({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: f.query.runId,
      });
      assert.ok(history);
      assert.deepEqual(
        projectAssetMediaImageSourceFromResult(
          f.saved.candidate,
          history.input,
        ),
        q.source,
      );
      assert.throws(() =>
        projectAssetMediaImageSourceFromResult(f.saved.candidate, {
          ...history.input,
          mediaInputId: "wrong-input",
        }),
      );
      for (const patch of [
        { url: "https://caller.invalid/x.png" },
        { resultIndex: 16 },
        { resultIndex: -1 },
        { workflowId: "flux2-three-reference-storyboard" },
        { conceptAssetId: f.old.reference.source.conceptAssetId },
      ]) {
        assert.throws(() =>
          parseProjectAssetMediaImageSource({ ...q.source, ...patch }),
        );
      }
      assert.throws(() =>
        parseProjectAssetMediaReferenceQualificationRequest({
          ...f.request,
          query: { ...f.request.query, url: "https://caller.invalid/x.png" },
        }),
      );
      let executed = false;
      const bad = { ...q.source };
      Object.defineProperty(bad, "candidateId", {
        enumerable: true,
        get() {
          executed = true;
          return q.source.candidateId;
        },
      });
      assert.throws(() => parseProjectAssetMediaImageSource(bad));
      assert.equal(executed, false);
      assert.deepEqual(
        parseProjectAssetImageSource(f.old.reference.source),
        f.old.reference.source,
      );
    },
  );
}
