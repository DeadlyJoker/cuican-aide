import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { mediaRunContextFixture as fixture } from "./project-media-run-context.test-support.ts";
import { ProjectMediaRunContext } from "./project-media-run-context.ts";
import { materialPng } from "./project-material-png.test-support.ts";
import {
  installedRunContextFixture,
  actor as legacyActor,
} from "./installed-plugin-run-context.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { extensionCanonicalJson } from "@crewon/domain";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: admitted Run resolves confirmed prompt and real original target paths`,
      assetTestOptions(backend),
      async (t) => {
        const f = await fixture(t, backend),
          { task, saved, materials } = await f.prepare(kind),
          accepted = await f.create(task),
          before = await f.countRuns(),
          io = [f.state.sourceGets, f.state.uploads, f.state.targetGets],
          { snapshot, media } = await f.load(accepted.binding);
        assert.deepEqual(media.reference, task.reference);
        assert.equal(JSON.stringify(media).includes(saved.input.prompt), false);
        assert.deepEqual(
          [f.state.sourceGets, f.state.uploads, f.state.targetGets],
          io,
        );
        const projected = await f.reader.prepareSubmit(media, f.signal());
        assert.equal(projected.prompt, saved.input.prompt);
        assert.deepEqual(projected.workflow, saved.input.workflow);
        assert.deepEqual(
          Object.keys(projected.images),
          materials.materials.map((m) => m.role),
        );
        for (const m of materials.materials)
          assert.deepEqual(
            projected.images[m.role],
            m.preparation.state.initial.transfer.output,
          );
        assert.equal(
          projected.targetServiceOrigin,
          materials.materials[0]!.preparation.state.initial.transfer.origin,
        );
        assert.equal(f.state.targetGets, io[2]! + (kind === "T10" ? 1 : 3));
        assert.deepEqual([f.state.sourceGets, f.state.uploads], io.slice(0, 2));
        assert.deepEqual(await f.countRuns(), before);
        assert.deepEqual(
          f.installed.verifiedTaskAdmission(snapshot),
          await f.ext.loadPluginTaskAdmission(accepted.binding),
        );
      },
    );
  test(
    `${backend}: source change and cold reopen preserve observation without upstream IO`,
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
        idempotencyKey: "media-run-cold-source-change",
      });
      const cold = await f.cold(),
        io = [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        before = await f.countRuns(),
        { media } = await cold.load(accepted.binding, "observe");
      const observation = await cold.reader.readObservation(media, f.signal());
      assert.deepEqual(observation.reference, task.reference);
      assert.deepEqual(
        [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        io,
      );
      await assert.rejects(
        cold.reader.prepareSubmit(media, f.signal()),
        (error) =>
          specific(error, [
            "project_asset_revision_conflict",
            "project_asset_reference_image_changed",
          ]),
      );
      assert.deepEqual(await f.countRuns(), before);
      assert.deepEqual(
        [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        io,
      );
    },
  );
  test(
    `${backend}: changed confirmed head denies new submit while original observation remains`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task, saved } = await f.prepare(),
        accepted = await f.create(task),
        { media } = await f.load(accepted.binding);
      await f.app.saveInput(f.actor, {
        ...f.command,
        mediaInputId: saved.input.mediaInputId,
        expectedInputRevision: 1,
        prompt: "Explicit new confirmed prompt",
        idempotencyKey: "worker-new-input-head",
      });
      const io = [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        before = await f.countRuns();
      await assert.rejects(f.reader.prepareSubmit(media, f.signal()), (error) =>
        specific(error, ["project_media_input_revision_conflict"]),
      );
      assert.equal(
        (await f.reader.readObservation(media, f.signal())).reference
          .inputRevision,
        1,
      );
      assert.deepEqual(
        [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        io,
      );
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend}: original target byte change is denied immediately before submit`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        accepted = await f.create(task),
        { media } = await f.load(accepted.binding);
      for (const key of f.state.files.keys())
        f.state.files.set(key, materialPng(5, 2));
      const io = [f.state.sourceGets, f.state.uploads, f.state.targetGets];
      await assert.rejects(
        f.reader.prepareSubmit(media, f.signal()),
        /project_media_generation_materials_unavailable/u,
      );
      assert.equal(f.state.targetGets, io[2]! + 1);
      const gets = f.state.targetGets;
      assert.deepEqual(
        (await f.reader.readObservation(media, f.signal())).reference,
        task.reference,
      );
      assert.equal(f.state.targetGets, gets);
      assert.deepEqual([f.state.sourceGets, f.state.uploads], io.slice(0, 2));
    },
  );
  test(
    `${backend}: submit and observation require independent purposes and preserve original Run checks`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        accepted = await f.create(task),
        { media } = await f.load(accepted.binding),
        gets = f.state.targetGets;
      f.policy.submit = false;
      await assert.rejects(
        f.reader.prepareSubmit(media, f.signal()),
        /project_media_generation_denied/u,
      );
      assert.equal(f.state.targetGets, gets);
      await f.reader.readObservation(media, f.signal());
      f.policy.observe = false;
      await assert.rejects(
        f.reader.readObservation(media, f.signal()),
        /project_media_generation_denied/u,
      );
      f.policy.observe = true;
      f.policy.extensionRun = false;
      await assert.rejects(
        f.reader.readObservation(media, f.signal()),
        /installed_plugin_execution_access_denied/u,
      );
      assert.equal(f.state.targetGets, gets);
    },
  );
  test(
    `${backend}: metadata read revocation and owner withdrawal prevent projections without IO`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        accepted = await f.create(task),
        { media } = await f.load(accepted.binding),
        io = [f.state.sourceGets, f.state.uploads, f.state.targetGets];
      f.mediaPolicy.read = false;
      await assert.rejects(
        f.reader.readObservation(media, f.signal()),
        /project_media_input_denied/u,
      );
      f.mediaPolicy.read = true;
      f.policy.active = false;
      await assert.rejects(
        f.reader.prepareSubmit(media, f.signal()),
        /named_media_run_owner_retired/u,
      );
      f.policy.active = true;
      f.policy.actor = false;
      await assert.rejects(
        f.reader.readObservation(media, f.signal()),
        /installed_plugin_execution_identity_unavailable/u,
      );
      assert.deepEqual(
        [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        io,
      );
    },
  );
  test(
    `${backend}: a purpose revoked after the byte observation never returns executable input`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        accepted = await f.create(task),
        { media } = await f.load(accepted.binding),
        gets = f.state.targetGets;
      f.policy.hook = async () => {
        if (f.state.targetGets > gets) f.policy.submit = false;
      };
      await assert.rejects(
        f.reader.prepareSubmit(media, f.signal()),
        /project_media_generation_denied/u,
      );
      assert.equal(f.state.targetGets, gets + 1);
      assert.equal(f.state.uploads, 1);
    },
  );
  test(
    `${backend}: copied snapshots, DTO dependencies and accessors cannot manufacture host authority`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        accepted = await f.create(task),
        { snapshot, media } = await f.load(accepted.binding),
        io = [f.state.sourceGets, f.state.uploads, f.state.targetGets];
      await assert.rejects(
        f.reader.load({ ...snapshot }, { purpose: "submit", ...f.signal() }),
        /installed_plugin_context_snapshot_invalid/u,
      );
      await assert.rejects(
        f.reader.prepareSubmit({ ...media }, f.signal()),
        /project_media_generation_snapshot_invalid/u,
      );
      let getters = 0;
      const options = Object.defineProperty({}, "signal", {
        enumerable: true,
        get() {
          getters++;
          return f.signal().signal;
        },
      });
      await assert.rejects(f.reader.readObservation(media, options as never));
      assert.equal(getters, 0);
      assert.throws(
        () =>
          new ProjectMediaRunContext({
            installed: f.installed,
            extensions: {} as never,
            materials: f.materials,
            metadataAuthorization: f.mediaAuthorization,
            authorization: f.authorization,
          }),
        /project_media_generation_dependency_invalid/u,
      );
      assert.deepEqual(
        [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        io,
      );
    },
  );
  test(
    `${backend}: instance method overrides do not replace original SQL or Run/byte checks`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        accepted = await f.create(task);
      Object.defineProperty(f.ext, "loadProjectMediaGenerationContext", {
        value: () => Promise.resolve(null),
      });
      Object.defineProperty(f.materials, "observeInput", {
        value: () => Promise.resolve(null),
      });
      Object.defineProperty(f.installed, "assertCurrent", {
        value: () => Promise.resolve(),
      });
      const reader = new ProjectMediaRunContext({
        installed: f.installed,
        extensions: f.ext,
        materials: f.materials,
        metadataAuthorization: f.mediaAuthorization,
        authorization: f.authorization,
      });
      const original = await f.installed.load({
        locator: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: accepted.binding.runId,
        },
        expectedTarget: accepted.binding.target,
        purpose: "submit",
        ...f.signal(),
      });
      assert.ok(original);
      const media = await reader.load(original, {
        purpose: "submit",
        ...f.signal(),
      });
      assert.ok(media);
      assert.equal(
        (await reader.prepareSubmit(media, f.signal())).prompt,
        f.command.prompt,
      );
      f.policy.extensionRun = false;
      await assert.rejects(
        reader.prepareSubmit(media, f.signal()),
        /installed_plugin_execution_access_denied/u,
      );
    },
  );
  test(
    `${backend}: three genuine bounded material records can exceed 64KiB as a combined context`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend, { configurationFixture: "large" }),
        { task } = await f.prepare("D18"),
        accepted = await f.create(task);
      const context = await f.ext.loadProjectMediaGenerationContext({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: accepted.binding.runId,
      });
      assert.ok(context);
      assert.ok(Buffer.byteLength(JSON.stringify(context)) > 65_536);
      assert.throws(
        () => extensionCanonicalJson(context),
        /extension_json_limit/u,
      );
      for (const m of context.materials)
        assert.ok(
          Buffer.byteLength(JSON.stringify(m.preparation.initial)) < 65_536,
        );
      const { media } = await f.load(accepted.binding),
        projected = await f.reader.prepareSubmit(media, f.signal());
      assert.equal(projected.prompt, f.d18Command.prompt);
      assert.equal(Object.keys(projected.images).length, 3);
      const cold = await f.cold(),
        gets = f.state.targetGets,
        { media: restored } = await cold.load(accepted.binding, "observe");
      assert.deepEqual(
        (await cold.reader.readObservation(restored, f.signal())).reference,
        task.reference,
      );
      assert.equal(f.state.targetGets, gets);
    },
  );
  test(
    `${backend}: disabling the actual activation preserves original observation and blocks submit`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        accepted = await f.create(task),
        { media } = await f.load(accepted.binding);
      const scope = {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          pluginId: f.pin.pluginId,
        },
        current = await f.ext.loadExtensionActivation(scope);
      assert.ok(current);
      await f.ext.saveExtensionActivation({
        expectedRevision: current.revision,
        activation: {
          ...current,
          revision: current.revision + 1,
          state: "disabled",
          updatedAt: f.dependencies.clock.now(),
        },
        receipt: {
          actorId: f.actor.actorId,
          idempotencyKey: "disable-media-worker-activation",
          requestDigest: f.digester.sha256("disable-media-worker-activation"),
        },
      });
      const gets = f.state.targetGets;
      await f.reader.readObservation(media, f.signal());
      await assert.rejects(
        f.reader.prepareSubmit(media, f.signal()),
        /installed_plugin_generation_disabled/u,
      );
      assert.equal(f.state.targetGets, gets);
    },
  );
  test(
    `${backend}: native cancellation and an asynchronous activity callback never yield input`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        { task } = await f.prepare(),
        accepted = await f.create(task),
        { snapshot, media } = await f.load(accepted.binding),
        gets = f.state.targetGets;
      const aborted = new AbortController();
      aborted.abort(new Error("named_media_context_cancelled"));
      await assert.rejects(
        f.reader.prepareSubmit(media, { signal: aborted.signal }),
        /named_media_context_cancelled/u,
      );
      const reader = new ProjectMediaRunContext({
        installed: f.installed,
        extensions: f.ext,
        materials: f.materials,
        metadataAuthorization: f.mediaAuthorization,
        authorization: {
          ...f.authorization,
          assertActive: (() => Promise.resolve()) as never,
        },
      });
      await assert.rejects(
        reader.load(snapshot, { purpose: "submit", ...f.signal() }),
        /project_media_generation_authority_invalid/u,
      );
      assert.equal(f.state.targetGets, gets);
    },
  );
}
test("legacy and another plugin's media action retain their original route without a short-drama schema", async (t) => {
  const f = await fixture(t, "sqlite"),
    old = await installedRunContextFixture(t);
  assert.notEqual(old.pin.pluginId, "crewon.short-drama");
  const reader = new ProjectMediaRunContext({
    installed: old.reader,
    extensions: old.first.store,
    materials: f.materials,
    metadataAuthorization: f.mediaAuthorization,
    authorization: f.authorization,
  });
  const first = await old.load();
  assert.ok(first);
  assert.equal(
    await reader.load(first, { purpose: "submit", ...f.signal() }),
    null,
  );
  await seedThread(old.first.parent, {
    ...legacyActor,
    threadId: "other-plugin-media-thread",
  });
  const other = await old.tasks.createTaskFromPlugin(
    legacyActor,
    {
      pluginId: old.pin.pluginId,
      threadId: "other-plugin-media-thread",
      expectedThreadRevision: 1,
      idempotencyKey: "other-plugin-media-task",
      intent: {
        kind: "generate",
        input: { prompt: "Another plugin's own media action" },
      },
    },
    { ...old.pin, action: "media.generate" },
  );
  const second = await old.reader.load({
    locator: {
      tenantId: legacyActor.tenantId,
      spaceId: legacyActor.spaceId,
      runId: other.binding.runId,
    },
    expectedTarget: other.binding.target,
    purpose: "submit",
    ...f.signal(),
  });
  assert.ok(second);
  assert.equal(
    await reader.load(second, { purpose: "submit", ...f.signal() }),
    null,
  );
  assert.equal(f.state.uploads, 0);
  assert.equal(f.state.targetGets, 0);
  assert.equal(old.first.store.projectMediaGenerationVersion, undefined);
});
function specific(error: unknown, codes: readonly string[]) {
  let value: unknown = error;
  for (let i = 0; i < 5 && value instanceof Error; i++, value = value.cause)
    if (codes.includes(value.message)) return true;
  return false;
}
