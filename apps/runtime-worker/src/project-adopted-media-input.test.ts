import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectMediaInputRevision,
  mediaInputDigest,
  projectMediaGenerationTaskInput,
} from "@crewon/application";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { adoptedMediaInputFixture as fixture } from "./project-adopted-media-input.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: adopted T10 plus legacy scene/character save V2, prepare mixed D18 and join original Turn exactly once`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        gets = f.state.gets,
        beforeIo = f.materialCounts(),
        saved = await f.app.saveInput(f.actor, f.mixedCommand);
      assert.equal(saved.disposition, "committed");
      assert.equal(saved.input.schemaVersion, "crewon.project-media-input.v2");
      assert.deepEqual(
        saved.input.references.map((r) => "media" in r),
        [false, true, false],
      );
      assert.deepEqual(
        parseProjectMediaInputRevision(saved.input),
        saved.input,
      );
      assert.equal(f.inputPolicy.legacyReads, 0);
      assert.deepEqual(f.materialCounts(), beforeIo);
      const query = f.mediaQuery(saved.input),
        prepared = await f.runtime.materials.prepareInput(
          f.actor,
          query,
          f.signal(),
        );
      assert.equal(prepared.disposition, "verified");
      assert.deepEqual(
        prepared.materials.map((m) => m.role),
        ["scene", "characterOne", "characterTwo"],
      );
      assert.deepEqual(
        prepared.materials.map(
          (m) => m.preparation.state.initial.schemaVersion,
        ),
        [
          "crewon.project-material-preparation.v1",
          "crewon.project-material-preparation.v2",
          "crewon.project-material-preparation.v1",
        ],
      );
      const adopted = prepared.materials[1]!.preparation.state.initial.source;
      assert.equal(
        adopted.schemaVersion,
        "crewon.project-reference-frozen-material.v2",
      );
      assert.deepEqual(
        adopted.source.media,
        f.adopted.referenceRevision.source,
      );
      assert.equal(f.state.gets, gets);
      assert.equal(f.inputPolicy.legacyReads, 2);
      assert.equal(f.materialCounts()[0], beforeIo[0]! + 3);
      const task = await f.issuer.qualifyTask(
          f.actor,
          { ...query, executionId: "mixed-d18-intent" },
          f.signal(),
        ),
        before = await f.countRuns(),
        io = f.materialCounts(),
        accepted = await f.create(task, "mixed-d18-turn");
      assert.equal(accepted.run.disposition, "committed");
      const afterCommitIo = f.materialCounts();
      assert.equal(
        (await f.create(task, "mixed-d18-turn")).run.disposition,
        "replayed",
      );
      assert.deepEqual(f.materialCounts(), afterCommitIo);
      const after = await f.countRuns();
      for (const key of [
        "run_snapshots",
        "messages",
        "model_history_items",
        "extension_run_bindings",
        "plugin_task_admissions",
        "work_items",
        "outbox",
        "project_media_generation_links",
      ])
        assert.equal(after[key], before[key]! + 1, key);
      assert.equal(
        after.project_media_generation_materials,
        before.project_media_generation_materials! + 3,
      );
      assert.deepEqual(f.materialCounts().slice(0, 2), io.slice(0, 2));
      const link = await f.ext.loadProjectMediaGenerationLink({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: accepted.binding.runId,
      });
      assert.deepEqual(link?.reference, task.reference);
      assert.equal(
        JSON.stringify(
          projectMediaGenerationTaskInput(task.reference),
        ).includes("filename"),
        false,
      );
      assert.equal(
        JSON.stringify(
          projectMediaGenerationTaskInput(task.reference),
        ).includes("prompt"),
        false,
      );
      assert.equal(
        (await f.app.saveInput(f.actor, f.mixedCommand)).disposition,
        "replayed",
      );
    },
  );
  test(
    `${backend}: cold original stores recover mixed preparation and accepted receipt without another source read or upload`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.mixedCommand),
        query = f.mediaQuery(saved.input);
      await f.runtime.materials.prepareInput(f.actor, query, f.signal());
      const task = await f.issuer.qualifyTask(
          f.actor,
          { ...query, executionId: "cold-mixed-intent" },
          f.signal(),
        ),
        accepted = await f.create(task, "cold-mixed-turn"),
        before = await f.countRuns(),
        io = f.materialCounts(),
        gets = f.state.gets,
        legacyReads = f.inputPolicy.legacyReads,
        cold = await f.cold(),
        results = await f.open(cold.ext.projectMediaResults()),
        next = await f.openRuntime(
          cold.parent,
          cold.configurations,
          results.publisher,
          cold.targets,
        );
      f.state.bytes = Buffer.from("supplier changed");
      const observed = await next.runtime.materials.observeInput(
        f.actor,
        query,
        f.signal(),
      );
      assert.equal(observed.disposition, "verified");
      assert.deepEqual(observed.input, saved.input);
      assert.equal(f.materialCounts()[0], io[0]);
      assert.equal(f.state.gets, gets);
      assert.equal(f.inputPolicy.legacyReads, legacyReads);
      const restored = await next.issuer.restoreAcceptedTask(
        f.actor,
        {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: accepted.binding.runId,
        },
        f.signal(),
      );
      assert.equal(
        (await f.create(restored, "cold-mixed-turn", cold.service)).run
          .disposition,
        "replayed",
      );
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend}: current source and result permissions are required; no fallback to the previous concept reader`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.countRuns();
      f.state.read = false;
      await assert.rejects(f.app.saveInput(f.actor, f.mixedCommand));
      assert.equal(f.inputPolicy.legacyReads, 0);
      f.state.read = true;
      const saved = await f.app.saveInput(f.actor, f.mixedCommand);
      const legacy = await f.openRuntime(
        f.parent,
        f.configurations,
        f.publisher,
        f.targets,
        false,
      );
      const beforeMissingSource = f.materialCounts();
      await assert.rejects(
        legacy.runtime.materials.prepareInput(
          f.actor,
          f.mediaQuery(saved.input),
          f.signal(),
        ),
        /media_source_unavailable/u,
      );
      assert.deepEqual(f.materialCounts(), beforeMissingSource);
      assert.equal(f.inputPolicy.legacyReads, 0);
      await f.assets.setLocked(f.actor, {
        projectId: f.referenceQuery.projectId,
        assetId: f.referenceQuery.assetId,
        expectedAssetRevision: f.referenceQuery.expectedAssetRevision,
        locked: true,
        idempotencyKey: "mixed-input-changed-asset",
      });
      const io = f.materialCounts();
      await assert.rejects(
        f.runtime.materials.prepareInput(
          f.actor,
          f.mediaQuery(saved.input),
          f.signal(),
        ),
      );
      assert.deepEqual(f.materialCounts(), io);
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend}: V2 origin cannot be relabeled V1 or grafted onto a different source Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.mixedCommand);
      const rehash = (input: unknown) => {
        const { contentDigest: _, ...body } = input as typeof saved.input;
        return { ...body, contentDigest: mediaInputDigest(body) };
      };
      assert.throws(() =>
        parseProjectMediaInputRevision(
          rehash({
            ...saved.input,
            schemaVersion: "crewon.project-media-input.v1",
          }),
        ),
      );
      assert.throws(() =>
        parseProjectMediaInputRevision(
          rehash({
            ...saved.input,
            references: saved.input.references.map((r) =>
              "media" in r ? { ...r, sourceRunId: "another-run" } : r,
            ),
          }),
        ),
      );
      assert.throws(() =>
        parseProjectMediaInputRevision(
          rehash({
            ...saved.input,
            references: saved.input.references.map((r) =>
              "media" in r ? { ...r, resultLinkDigest: r.referenceDigest } : r,
            ),
          }),
        ),
      );
      assert.equal(f.inputPolicy.legacyReads, 0);
    },
  );
}
