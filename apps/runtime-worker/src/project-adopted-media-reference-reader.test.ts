import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  parseProjectAssetMediaReferenceImageRequest,
  parseProjectAssetMediaReferenceImageSource,
} from "@crewon/application";
import { ProjectAdoptedMediaReferenceReader } from "@crewon/media-runtime";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { adoptedMediaReaderFixture as fixture } from "./project-adopted-media-reference-reader.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: adopted media reads exact encrypted candidate bytes through original project and reference history with zero provider I/O or writes`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        rows = await f.rows(),
        io = [f.state.gets, f.state.dns, ...f.materialCounts()],
        read = await f.read();
      assert.deepEqual(read.bytes, f.state.bytes);
      assert.deepEqual(read.source.reference, f.adopted.referenceRevision);
      assert.deepEqual(read.source.candidate, f.candidate);
      assert.deepEqual(read.source.asset, f.adopted.asset);
      assert.equal(
        read.source.generationInput.contentDigest,
        f.candidate.frozen.source.projection.reference.mediaInputDigest,
      );
      assert.deepEqual(
        parseProjectAssetMediaReferenceImageSource(read.source, {
          actor: f.actor,
          query: f.referenceQuery,
        }),
        read.source,
      );
      assert.deepEqual(await f.rows(), rows);
      assert.equal(await f.receipts(), 1);
      assert.deepEqual([f.state.gets, f.state.dns, ...f.materialCounts()], io);
      // Independent same-owner caller keeps the producer's actual immutable identity.
      const sameOwner = await f.reader.readSelectedReferenceBytes(
        { ...f.actor, actorId: "another-current-reader" },
        f.referenceQuery,
        { signal: new AbortController().signal },
      );
      assert.deepEqual(sameOwner.source.candidate, f.candidate);
      assert.deepEqual(sameOwner.bytes, read.bytes);
    },
  );

  test(
    `${backend}: fresh parent connection and archive instance recover original adopted bytes after supplier bytes change`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        original = await f.read(),
        io = [f.state.gets, f.state.dns, ...f.materialCounts()];
      f.state.bytes = Buffer.from("supplier no longer has the saved image");
      const reopened = await f.cold();
      assert.notEqual(reopened.parent, f.parent);
      const store = reopened.ext.projectMediaResults();
      await store.enableResultReads();
      const { publisher } = await f.open(store),
        next = f.readers(store, reopened.parent, publisher);
      assert.deepEqual(
        await next.reader.readSelectedReferenceBytes(
          f.actor,
          f.referenceQuery,
          { signal: new AbortController().signal },
        ),
        original,
      );
      assert.deepEqual([f.state.gets, f.state.dns, ...f.materialCounts()], io);
    },
  );

  test(
    `${backend}: current project and result policy, owner, pointer versions and read purpose are required`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        rows = await f.rows(),
        io = f.state.gets;
      f.policy.allow = false;
      await assert.rejects(f.read());
      f.policy.allow = true;
      f.state.read = false;
      await assert.rejects(f.read());
      f.state.read = true;
      f.state.active = false;
      await assert.rejects(f.read());
      f.state.active = true;
      for (const actor of [
        { ...f.actor, principalId: "someone-else" },
        { ...f.actor, tenantId: "another-tenant" },
        { ...f.actor, spaceId: "another-space" },
      ])
        await assert.rejects(
          f.reader.readSelectedReferenceBytes(actor, f.referenceQuery, {
            signal: new AbortController().signal,
          }),
        );
      for (const patch of [
        { expectedAssetRevision: f.referenceQuery.expectedAssetRevision + 1 },
        { referenceRevision: f.old.reference.referenceRevision },
        { contentRevision: 2 },
        { assetId: f.characterTwo.assetId },
        { kind: "scene" as const },
      ])
        await assert.rejects(
          f.reader.readSelectedReferenceBytes(
            f.actor,
            { ...f.referenceQuery, ...patch },
            { signal: new AbortController().signal },
          ),
        );
      assert.throws(() =>
        f.store.loadAdoptedAssetReference(
          { actor: f.actor, query: f.referenceQuery },
          f.authority("publish"),
        ),
      );
      await assert.rejects(
        f.store.loadAdoptedAssetReference(
          { actor: f.actor, query: f.referenceQuery },
          {
            ...f.authority(),
            request: { ...f.request, query: { ...f.query, resultIndex: 1 } },
          },
        ),
        /authority_mismatch/u,
      );
      assert.deepEqual(await f.rows(), rows);
      assert.equal(f.state.gets, io);
    },
  );

  for (const late of ["selection", "policy", "cancel"] as const)
    test(
      `${backend}: ${late} changes after archive bytes were read reject the entire read`,
      assetTestOptions(backend),
      async (t) => {
        const f = await fixture(t, backend),
          controller = new AbortController();
        let calls = 0;
        const { reader } = f.readers({
          loadAdoptedAssetReference: async (request, authority) => {
            const source = await f.store.loadAdoptedAssetReference(
              request,
              authority,
            );
            if (++calls === 2) {
              if (late === "policy") f.policy.allow = false;
              else if (late === "cancel")
                controller.abort(new Error("named_late_cancel"));
              else
                await f.assets.selectReference(f.actor, {
                  projectId: f.query.projectId,
                  assetId: f.adopted.asset.assetId,
                  expectedAssetRevision: f.adopted.asset.revision,
                  referenceRevision: f.old.reference.referenceRevision,
                  idempotencyKey: "late-reference-change",
                });
            }
            return source;
          },
        });
        await assert.rejects(
          reader.readSelectedReferenceBytes(f.actor, f.referenceQuery, {
            signal: controller.signal,
          }),
        );
        assert.equal(
          calls,
          2,
          "second source resolution follows the actual encrypted archive read",
        );
        assert.equal(
          f.state.gets,
          1,
          "only the fixture's initial candidate publication contacted the provider",
        );
      },
    );

  test(
    `${backend}: missing or corrupted encrypted output cannot trigger a replacement download`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        file = join(
          f.archiveConfig.rootDirectory,
          f.candidate.frozen.materialId + ".crwpr",
        ),
        original = readFileSync(file),
        corrupted = Buffer.from(original),
        io = [f.state.gets, f.state.dns, ...f.materialCounts()];
      corrupted[corrupted.length - 1] ^= 1;
      writeFileSync(file, corrupted);
      await assert.rejects(f.read());
      writeFileSync(file, original);
      assert.deepEqual((await f.read()).bytes, f.state.bytes);
      unlinkSync(file);
      await assert.rejects(f.read());
      assert.deepEqual([f.state.gets, f.state.dns, ...f.materialCounts()], io);
    },
  );

  test(
    `${backend}: locked references stay readable at their new version and reverting to legacy concept keeps the original reader`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const locked = await f.assets.setLocked(f.actor, {
        projectId: f.query.projectId,
        assetId: f.adopted.asset.assetId,
        expectedAssetRevision: f.adopted.asset.revision,
        locked: true,
        idempotencyKey: "lock-adopted-reference",
      });
      await assert.rejects(f.read());
      const query = {
        ...f.referenceQuery,
        expectedAssetRevision: locked.asset.revision,
      };
      assert.deepEqual(
        (
          await f.reader.readSelectedReferenceBytes(f.actor, query, {
            signal: new AbortController().signal,
          })
        ).bytes,
        f.state.bytes,
      );
      const unlocked = await f.assets.setLocked(f.actor, {
        projectId: f.query.projectId,
        assetId: f.adopted.asset.assetId,
        expectedAssetRevision: locked.asset.revision,
        locked: false,
        idempotencyKey: "unlock-adopted-reference",
      });
      const old = await f.assets.selectReference(f.actor, {
        projectId: f.query.projectId,
        assetId: f.adopted.asset.assetId,
        expectedAssetRevision: unlocked.asset.revision,
        referenceRevision: f.old.reference.referenceRevision,
        idempotencyKey: "restore-original-concept",
      });
      const legacy = {
        ...query,
        expectedAssetRevision: old.asset.revision,
        referenceRevision: f.old.reference.referenceRevision,
      };
      await assert.rejects(
        f.reader.readSelectedReferenceBytes(f.actor, legacy, {
          signal: new AbortController().signal,
        }),
        /source_kind_mismatch/u,
      );
      assert.deepEqual(
        (await f.resolver().resolveSelectedReference(f.actor, legacy))
          .reference,
        f.old.reference,
      );
      const project = await f.projects.getProject(f.actor, {
        projectId: f.query.projectId,
      });
      await f.projects.setProjectState(f.actor, {
        projectId: project.projectId,
        expectedProjectRevision: project.revision,
        state: "archived",
        idempotencyKey: "archive-after-reading",
      });
      await assert.rejects(
        f.reader.readSelectedReferenceBytes(f.actor, legacy, {
          signal: new AbortController().signal,
        }),
        /project_archived/u,
      );
    },
  );

  test(
    `${backend}: strict selectors and original class methods reject injected sources, URLs and instance replacements`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        source = (await f.read()).source,
        request = { actor: f.actor, query: f.referenceQuery };
      assert.throws(() =>
        parseProjectAssetMediaReferenceImageRequest({
          ...request,
          query: { ...request.query, url: "https://caller.invalid/image.png" },
        }),
      );
      assert.throws(() =>
        parseProjectAssetMediaReferenceImageSource(
          { ...source, bytes: Buffer.from("caller") },
          request,
        ),
      );
      assert.throws(() =>
        parseProjectAssetMediaReferenceImageSource(
          { ...source, reference: f.old.reference },
          request,
        ),
      );
      assert.throws(() =>
        parseProjectAssetMediaReferenceImageSource(
          {
            ...source,
            generationInput: {
              ...source.generationInput,
              prompt: "unrecorded",
            },
          },
          request,
        ),
      );
      Object.defineProperty(f.sources, "resolveSelectedReference", {
        value: () => {
          throw new Error("instance_override_must_not_run");
        },
      });
      Object.defineProperty(f.publisher, "readCandidate", {
        value: () => {
          throw new Error("instance_override_must_not_run");
        },
      });
      const reader = new ProjectAdoptedMediaReferenceReader({
        sources: f.sources,
        results: f.publisher,
      });
      assert.deepEqual(
        (
          await reader.readSelectedReferenceBytes(f.actor, f.referenceQuery, {
            signal: new AbortController().signal,
          })
        ).bytes,
        f.state.bytes,
      );
      assert.throws(
        () =>
          new ProjectAdoptedMediaReferenceReader({
            sources: new Proxy(f.sources, {}),
            results: f.publisher,
          }),
        /dependency_invalid/u,
      );
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(f.read(controller.signal));
    },
  );
}
