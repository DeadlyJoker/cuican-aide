import assert from "node:assert/strict";
import test from "node:test";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import {
  mediaGenerationFixture as fixture,
  observeMediaLinkInsert,
} from "./project-media-generation.test-support.ts";
import { materialPng } from "./project-material-png.test-support.ts";
import {
  parseProjectMediaGenerationReference,
  projectMediaGenerationTaskInput,
} from "@crewon/application";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} real ${kind} preparation joins original TaskCore Turn and stable receipt`,
      assetTestOptions(backend),
      async (t) => {
        const f = await fixture(t, backend),
          { task, materials } = await f.prepare(kind),
          before = await f.countRuns(),
          uploads = f.state.uploads,
          sourceGets = f.state.sourceGets;
        const results = await Promise.all([f.create(task), f.create(task)]);
        assert.deepEqual(results.map((r) => r.run.disposition).sort(), [
          "committed",
          "replayed",
        ]);
        assert.deepEqual(results[0]!.binding, results[1]!.binding);
        const link = await f.ext.loadProjectMediaGenerationLink({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: results[0]!.binding.runId,
        });
        assert.ok(link);
        assert.deepEqual(link.reference, task.reference);
        assert.equal(link.admission.action, "media.generate");
        assert.equal(link.admission.packageDigest, f.pin.packageDigest);
        assert.equal(link.binding.configurationRevision, 2);
        const after = await f.countRuns();
        for (const key of [
          "run_snapshots",
          "messages",
          "model_history_items",
          "extension_run_bindings",
          "plugin_task_admissions",
          "plugin_credit_reservations",
          "extension_credit_admissions",
          "work_items",
          "outbox",
        ]) {
          assert.equal(after[key], before[key]! + 1, key);
        }
        assert.equal(after.project_media_generation_links, 1);
        assert.equal(
          after.project_media_generation_materials,
          kind === "T10" ? 1 : 3,
        );
        assert.equal(f.state.uploads, uploads);
        assert.equal(f.state.sourceGets, sourceGets);
        assert.ok(f.generation.quotes >= 1 && f.generation.quotes <= 2); // Quotes precede the shared commit; exactly one hold is stored.
        const message = (
          await f.parent.listMessages(
            {
              tenantId: f.actor.tenantId,
              threadId: results[0]!.binding.threadId,
            },
            0,
            10,
          )
        )[0]!;
        assert.deepEqual(
          JSON.parse(message.content),
          projectMediaGenerationTaskInput(task.reference),
        );
        assert.equal(message.content.includes("filename"), false);
        assert.equal(message.content.includes("prompt"), false);
        assert.equal(
          task.reference.materials[0]!.initialDigest,
          materials.materials[0]!.preparation.state.initial.contentDigest,
        );
        const gets = f.state.targetGets,
          quotes = f.generation.quotes;
        assert.equal((await f.create(task)).run.disposition, "replayed");
        assert.equal(f.state.targetGets, gets);
        assert.equal(f.generation.quotes, quotes);
      },
    );
  test(
    `${backend} accepted cold receipt keeps original materials after source changes without I/O`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        accepted = await f.create(task);
      await f.assets.setLocked(f.actor, {
        projectId: f.query.projectId,
        assetId: f.query.assetId,
        expectedAssetRevision: 4,
        locked: true,
        idempotencyKey: "changed-source-head",
      });
      await assert.rejects(
        f.issuer.qualifyTask(
          f.actor,
          {
            projectId: task.reference.projectId,
            mediaInputId: task.reference.mediaInputId,
            inputRevision: task.reference.inputRevision,
            expectedInputRevision: task.reference.expectedInputRevision,
            executionId: "other",
          },
          f.signal(),
        ),
      );
      const cold = await f.cold(),
        before = await f.countRuns(),
        io = [f.state.sourceGets, f.state.uploads, f.state.targetGets];
      const restored = await cold.issuer.restoreAcceptedTask(
        f.actor,
        {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: accepted.binding.runId,
        },
        f.signal(),
      );
      const replay = await f.create(restored, "media-run", cold.service);
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(replay.binding, accepted.binding);
      assert.deepEqual(await f.countRuns(), before);
      assert.deepEqual(
        [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        io,
      );
    },
  );
  test(
    `${backend} distinct intent makes another candidate while same intent cannot create another Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task, saved } = await f.prepare();
      await f.create(task);
      await seedThread(f.parent, {
        ...f.actor,
        threadId: "explicit-candidate-thread",
      });
      const before = await f.countRuns();
      await assert.rejects(
        f.service.createProjectMediaTaskFromHost({
          actor: f.actor,
          command: {
            ...f.taskCommand(task, "different-command-key"),
            threadId: "explicit-candidate-thread",
          },
          pin: f.pin,
          task,
        }),
        /execution_occupied/,
      );
      assert.deepEqual(await f.countRuns(), before);
      const next = await f.issuer.qualifyTask(
        f.actor,
        {
          ...f.mediaQuery(saved.input),
          executionId: "explicit-second-candidate",
        },
        f.signal(),
      );
      const command = {
        ...f.taskCommand(next, "second-candidate"),
        threadId: "explicit-candidate-thread",
        expectedThreadRevision: 1,
      };
      const result = await f.service.createProjectMediaTaskFromHost({
        actor: f.actor,
        command,
        pin: f.pin,
        task: next,
      });
      assert.equal(result.run.disposition, "committed");
      assert.equal(await f.count("project_media_generation_links"), 2);
      assert.equal(f.state.uploads, 1);
    },
  );
  test(
    `${backend} revoked generation purpose before dispatch leaves no partial Run or hold`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        before = await f.countRuns();
      f.generation.afterQuote = async () => {
        f.generation.allowed = false;
      };
      await assert.rejects(f.create(task), /denied/);
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend} target bytes changed during quote are checked before original Run commit`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        before = await f.countRuns();
      f.generation.afterQuote = async () => {
        for (const key of f.state.files.keys())
          f.state.files.set(key, materialPng(7, 1));
      };
      await assert.rejects(
        f.create(task),
        mediaFailure(/^project_media_generation_materials_unavailable$/u),
      );
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend} actual link INSERT retirement rolls back Turn, funding, receipts and linkage`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        before = await f.countRuns(),
        restore = observeMediaLinkInsert(backend, () => {
          f.generation.active = false;
        });
      t.after(restore);
      await assert.rejects(f.create(task), mediaFailure(/retired/));
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend} forged preparation revision or digest never binds a real generation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        before = await f.countRuns();
      const reference = parseProjectMediaGenerationReference({
        ...task.reference,
        materials: task.reference.materials.map((m) => ({
          ...m,
          eventDigest: f.digester.sha256("forged-event"),
        })),
      });
      const forged = {
        ...task,
        reference,
        authority: { ...task.authority, reference },
        preflight: {
          assertNewInput: async () => {},
          assertDispatchCurrent: async () => {},
        },
      };
      await assert.rejects(f.create(forged), /material_changed/);
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend} plain plugin task cannot use reserved media action or business selectors`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        before = await f.countRuns();
      await assert.rejects(
        f.service.createTaskFromPlugin(f.actor, f.taskCommand(task), f.pin),
        /authority_required/,
      );
      await assert.rejects(
        f.service.createTaskFromPlugin(f.actor, f.taskCommand(task), {
          ...f.pin,
          action: "image.generate",
        }),
        /authority_required/,
      );
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend} denied generation purpose stops qualification before target I/O`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { saved } = await f.prepare(),
        before = await f.countRuns(),
        io = [f.state.uploads, f.state.sourceGets, f.state.targetGets];
      f.generation.allowed = false;
      await assert.rejects(
        f.issuer.qualifyTask(
          f.actor,
          { ...f.mediaQuery(saved.input), executionId: "denied-new-intent" },
          f.signal(),
        ),
        /project_media_generation_denied/,
      );
      assert.deepEqual(
        [f.state.uploads, f.state.sourceGets, f.state.targetGets],
        io,
      );
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend} confirmed input changed during quote preserves edit and rejects old Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task, saved } = await f.prepare(),
        before = await f.countRuns();
      f.generation.afterQuote = async () => {
        await f.app.saveInput(f.actor, {
          ...f.command,
          mediaInputId: saved.input.mediaInputId,
          expectedInputRevision: 1,
          prompt: "User's confirmed new prompt",
          idempotencyKey: "concurrent-input-edit",
        });
      };
      await assert.rejects(
        f.create(task),
        mediaFailure(/revision_conflict|input_changed/),
      );
      assert.deepEqual(await f.countRuns(), before);
      assert.equal(
        (
          await f.app.loadInput(f.actor, {
            projectId: saved.input.projectId,
            mediaInputId: saved.input.mediaInputId,
            inputRevision: null,
          })
        )?.latestInputRevision,
        2,
      );
    },
  );
  test(
    `${backend} bypassed preflight cannot bypass actual source qualification inside Turn`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        before = await f.countRuns(),
        io = [f.state.uploads, f.state.sourceGets, f.state.targetGets];
      await f.assets.setLocked(f.actor, {
        projectId: f.query.projectId,
        assetId: f.query.assetId,
        expectedAssetRevision: 4,
        locked: true,
        idempotencyKey: "source-mutated-before-turn",
      });
      const forged = {
        ...task,
        preflight: {
          assertNewInput: async () => {},
          assertDispatchCurrent: async () => {},
        },
      };
      await assert.rejects(
        f.create(forged),
        mediaFailure(/^project_asset_reference_image_changed$/u),
      );
      assert.deepEqual(await f.countRuns(), before);
      assert.deepEqual(
        [f.state.uploads, f.state.sourceGets, f.state.targetGets],
        io,
      );
    },
  );
  test(
    `${backend} accepted media link and role pins are physically immutable`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        accepted = await f.create(task);
      await assert.rejects(
        f.sql(
          `UPDATE ${f.prefix}project_media_generation_links SET execution_id='replacement'`,
        ),
        /immutable/,
      );
      await assert.rejects(
        f.sql(`DELETE FROM ${f.prefix}project_media_generation_materials`),
        /immutable/,
      );
      assert.deepEqual(
        (
          await f.ext.loadProjectMediaGenerationLink({
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            runId: accepted.binding.runId,
          })
        )?.reference,
        task.reference,
      );
    },
  );
  test(
    `${backend} media Run opt-in is explicit and missing schema is never auto-created`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend, { migrate: false }),
        { task } = await f.prepare();
      assert.equal(f.ext.projectMediaGenerationVersion, undefined);
      const before = await f.count("run_snapshots");
      await assert.rejects(f.create(task), /unavailable/);
      assert.equal(await f.count("run_snapshots"), before);
      await f.ext.migrateProjectMediaGenerations();
      assert.equal((await f.create(task)).run.disposition, "committed");
    },
  );
  test(
    `${backend} explicit unmetered host mode admits media and cold replay without new holds or quotes`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend, { unmetered: true }),
        { task } = await f.prepare(),
        before = await f.countRuns();
      const accepted = await f.create(task);
      assert.equal(accepted.creditAdmission, undefined);
      assert.ok(accepted.unmeteredAdmission);
      const after = await f.countRuns();
      assert.equal(after.run_snapshots, before.run_snapshots! + 1);
      assert.equal(
        after.plugin_credit_reservations,
        before.plugin_credit_reservations,
      );
      assert.equal(
        after.extension_credit_admissions,
        before.extension_credit_admissions,
      );
      assert.equal(f.generation.quotes, 0);
      assert.equal(await f.count("plugin_task_unmetered_admissions"), 1);
      const cold = await f.cold(),
        io = [f.state.uploads, f.state.sourceGets, f.state.targetGets];
      const restored = await cold.issuer.restoreAcceptedTask(
        f.actor,
        {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: accepted.binding.runId,
        },
        f.signal(),
      );
      const replay = await f.create(restored, "media-run", cold.service);
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(replay.unmeteredAdmission, accepted.unmeteredAdmission);
      assert.deepEqual(await f.countRuns(), after);
      assert.deepEqual(
        [f.state.uploads, f.state.sourceGets, f.state.targetGets],
        io,
      );
      assert.equal(f.generation.quotes, 0);
    },
  );
  test(
    `${backend} qualification and accepted restore reject accessors without invoking them`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { saved } = await f.prepare(),
        before = await f.countRuns(),
        io = [f.state.uploads, f.state.sourceGets, f.state.targetGets];
      let getters = 0;
      const badQuery = {
        ...f.mediaQuery(saved.input),
        executionId: "malformed",
      };
      Object.defineProperty(badQuery, "mediaInputId", {
        enumerable: true,
        get() {
          getters++;
          throw new Error("accessor_executed");
        },
      });
      await assert.rejects(f.issuer.qualifyTask(f.actor, badQuery, f.signal()));
      const locator = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: "malformed",
      };
      Object.defineProperty(locator, "runId", {
        enumerable: true,
        get() {
          getters++;
          throw new Error("accessor_executed");
        },
      });
      await assert.rejects(
        f.issuer.restoreAcceptedTask(f.actor, locator, f.signal()),
      );
      assert.equal(getters, 0);
      assert.deepEqual(await f.countRuns(), before);
      assert.deepEqual(
        [f.state.uploads, f.state.sourceGets, f.state.targetGets],
        io,
      );
    },
  );
  test(
    `${backend} host task envelope rejects callback accessors before quotes or Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        before = await f.countRuns(),
        quotes = f.generation.quotes;
      let getters = 0;
      const malformed = { ...task };
      Object.defineProperty(malformed, "preflight", {
        enumerable: true,
        get() {
          getters++;
          throw new Error("callback_accessor_executed");
        },
      });
      await assert.rejects(f.create(malformed));
      assert.equal(getters, 0);
      assert.equal(f.generation.quotes, quotes);
      assert.deepEqual(await f.countRuns(), before);
    },
  );
}

/** Inspect the bounded original cause chain; never accept a generic unavailable error as the expected failure. */
function mediaFailure(pattern: RegExp) {
  return (error: unknown) => {
    let current = error;
    for (
      let depth = 0;
      depth < 5 && current instanceof Error;
      depth++, current = current.cause
    ) {
      if (pattern.test(current.message)) return true;
    }
    return false;
  };
}
