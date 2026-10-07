import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  parseFrozenProjectReferenceMaterial,
  parseProjectMaterialPreparationInitial,
  materialPreparationDigester,
} from "@crewon/application";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { adoptedMediaMaterialFixture as fixture } from "./project-adopted-media-material.test-support.ts";
const options = () => ({ signal: new AbortController().signal });

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: simultaneous media freezes retain one immutable receipt and cancellation after publication never returns it as current`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        second = f.openFreezer(),
        gets = f.state.gets;
      const outcomes = await Promise.all([
        f.freeze(),
        second.freezer.freezeSelectedReference(
          f.actor,
          f.input.source,
          options(),
        ),
      ]);
      assert.deepEqual(outcomes.map((x) => x.disposition).sort(), [
        "created",
        "replayed",
      ]);
      assert.deepEqual(outcomes[0]!.record, outcomes[1]!.record);
      assert.equal(f.state.gets, gets);
      const controller = new AbortController(),
        nextInput = {
          ...f.input.source,
          idempotencyKey: "cancel-after-media-freeze",
        };
      const interrupted = f.openFreezer(f.sources, f.reader, {
        archiveId: f.archive.archiveId,
        load: (request) => f.archive.load(request),
        save: async (content) => {
          const saved = await f.archive.save(content);
          controller.abort(new Error("named_after_freeze_cancel"));
          return saved;
        },
      });
      await assert.rejects(
        interrupted.freezer.freezeSelectedReference(f.actor, nextInput, {
          signal: controller.signal,
        }),
        /named_after_freeze_cancel/u,
      );
      const recovered = await second.freezer.freezeSelectedReference(
        f.actor,
        nextInput,
        options(),
      );
      assert.equal(recovered.disposition, "replayed");
      assert.equal(f.state.gets, gets);
    },
  );
  test(
    `${backend}: adopted image freezes as media provenance and the original preparer uploads/verifies exact bytes once`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = f.materialCounts(),
        gets = f.state.gets;
      const result = await f.prepare();
      assert.equal(result.disposition, "verified");
      assert.equal(
        result.state.initial.schemaVersion,
        "crewon.project-material-preparation.v2",
      );
      const record = result.state.initial.source;
      assert.equal(
        record.schemaVersion,
        "crewon.project-reference-frozen-material.v2",
      );
      assert.deepEqual(record.source.media, f.adopted.referenceRevision.source);
      assert.equal(Object.hasOwn(record.source, "resultLinkDigest"), false);
      assert.equal(Object.hasOwn(record.source, "sourceBindingDigest"), false);
      assert.equal(Object.hasOwn(record.source, "origin"), false);
      assert.deepEqual(
        (await f.archive.load(record.request))?.bytes,
        f.state.bytes,
      );
      assert.equal(f.state.gets, gets);
      assert.equal(f.materialCounts()[0], before[0]! + 1);
      assert.equal(f.materialCounts()[1], before[1]);
      assert.equal(f.grants[0]!.resource.sourceKind, "media-result");
      const replay = await f.prepare();
      assert.equal(replay.disposition, "verified");
      assert.deepEqual(replay.state.initial, result.state.initial);
      assert.equal(f.materialCounts()[0], before[0]! + 1);
      assert.equal((await f.freeze()).disposition, "replayed");
      assert.equal(
        readFileSync(
          join(
            f.archiveConfiguration.rootDirectory,
            `${record.materialId}.crwpm`,
          ),
        ).includes(f.state.bytes),
        false,
      );
    },
  );

  test(
    `${backend}: fresh original connection/archive observes the same preparation after supplier source changes without another upload`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        first = await f.prepare(),
        counts = f.materialCounts(),
        gets = f.state.gets,
        bytes = Buffer.from(f.state.bytes);
      f.state.bytes = Buffer.from("supplier changed");
      const cold = await f.cold(),
        store = cold.ext.projectMediaResults();
      await store.enableResultReads();
      const results = await f.open(store),
        readers = f.readers(store, cold.parent, results.publisher),
        next = f.openFreezer(readers.sources, readers.reader),
        preparer = f.makePreparer(next.freezer, cold.journal, cold.targets);
      const observed = await preparer.observePreparedReference(
        f.actor,
        f.input,
        options(),
      );
      assert.equal(observed.disposition, "verified");
      assert.deepEqual(observed.state.initial, first.state.initial);
      assert.deepEqual(
        (
          await next.freezer.readFrozenReference(
            f.actor,
            f.input.source,
            options(),
          )
        ).bytes,
        bytes,
      );
      assert.equal(f.materialCounts()[0], counts[0]);
      assert.equal(f.materialCounts()[1], counts[1]);
      assert.equal(f.state.gets, gets);
    },
  );

  test(
    `${backend}: freeze, prepare and upload permissions remain separate and a denied upload retains its single reservation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        counts = f.materialCounts();
      f.policy.freeze = false;
      await assert.rejects(f.prepare(), /freeze_denied/u);
      assert.equal(f.materialCounts()[0], counts[0]);
      f.policy.freeze = true;
      f.policy.prepare = false;
      await assert.rejects(f.prepare(), /preparation_denied/u);
      f.policy.prepare = true;
      f.policy.upload = false;
      await assert.rejects(f.prepare(), /preparation_denied/u);
      assert.equal(f.materialCounts()[0], counts[0]);
      f.policy.upload = true;
      assert.equal((await f.prepare()).disposition, "verified");
      assert.equal(f.materialCounts()[0], counts[0]! + 1);
      f.policy.active = false;
      await assert.rejects(f.prepare(), /retired/u);
      assert.equal(f.materialCounts()[0], counts[0]! + 1);
    },
  );

  test(
    `${backend}: damaged or missing frozen material never re-fetches the original result or reuploads a known preparation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        first = await f.prepare(),
        counts = f.materialCounts(),
        gets = f.state.gets,
        path = join(
          f.archiveConfiguration.rootDirectory,
          `${first.state.initial.source.materialId}.crwpm`,
        ),
        raw = readFileSync(path),
        changed = Buffer.from(raw);
      changed[changed.length - 1] ^= 1;
      writeFileSync(path, changed);
      await assert.rejects(f.prepare());
      writeFileSync(path, raw);
      assert.equal((await f.prepare()).disposition, "verified");
      unlinkSync(path);
      await assert.rejects(f.prepare());
      assert.equal(f.materialCounts()[0], counts[0]);
      assert.equal(f.materialCounts()[1], counts[1]);
      assert.equal(f.state.gets, gets);
    },
  );

  test(
    `${backend}: current pointer changes and forged media provenance cannot prepare or reinterpret the image as legacy`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        first = await f.prepare(),
        record = first.state.initial.source,
        counts = f.materialCounts();
      assert.equal(
        record.schemaVersion,
        "crewon.project-reference-frozen-material.v2",
      );
      assert.throws(() =>
        parseFrozenProjectReferenceMaterial(
          {
            ...record,
            schemaVersion: "crewon.project-reference-frozen-material.v1",
          },
          materialPreparationDigester,
        ),
      );
      assert.throws(() =>
        parseFrozenProjectReferenceMaterial(
          {
            ...record,
            source: {
              ...record.source,
              resultLinkDigest: f.digester.sha256("fake"),
            },
          },
          materialPreparationDigester,
        ),
      );
      assert.throws(() =>
        parseProjectMaterialPreparationInitial({
          ...first.state.initial,
          schemaVersion: "crewon.project-material-preparation.v1",
        }),
      );
      const forged = {
        ...record,
        source: {
          ...record.source,
          media: {
            ...record.source.media,
            candidateDigest: f.digester.sha256("another"),
          },
        },
      };
      const next = f.openFreezer(f.sources, f.reader, {
        archiveId: f.archive.archiveId,
        load: async () => ({ record: forged, bytes: f.state.bytes }),
        save: async () => {
          throw new Error("must not save");
        },
      });
      await assert.rejects(
        next.freezer.readFrozenReference(f.actor, f.input.source, options()),
        /frozen_material_invalid/u,
      );
      await f.assets.selectReference(f.actor, {
        projectId: f.query.projectId,
        assetId: f.adopted.asset.assetId,
        expectedAssetRevision: f.adopted.asset.revision,
        referenceRevision: f.old.reference.referenceRevision,
        idempotencyKey: "change-after-adopted-prepare",
      });
      await assert.rejects(f.prepare());
      assert.equal(f.materialCounts()[0], counts[0]);
    },
  );
}
