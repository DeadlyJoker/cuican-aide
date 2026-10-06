import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { projectMediaInputFixture as fixture } from "./project-media-input.test-support.ts";
import { materialSignal as signal } from "./project-material-preparer.test-support.ts";
import { ProjectMediaMaterialPreparer } from "./project-media-material-preparer.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} a write revoked during historical receipt read denies save replay without supplier I/O`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await f.app.saveInput(f.actor, f.command);
      let grants = 0;
      f.mediaPolicy.afterGrant = async () => {
        if (++grants === 2) f.mediaPolicy.write = false;
      };
      await assert.rejects(
        f.app.saveInput(f.actor, f.command),
        /media_input_denied/u,
      );
      assert.equal(f.state.sourceGets, 0);
      assert.equal(f.state.uploads, 0);
      assert.deepEqual(await f.countMedia(), {
        project_media_inputs: 1,
        project_media_input_revisions: 1,
        project_media_input_receipts: 1,
      });
    },
  );
  test(
    `${backend} distinct D18 logical results with identical actual character bytes cannot claim ready`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend, { sameCharacterBytes: true });
      const saved = await f.app.saveInput(f.actor, f.d18Command),
        before = await f.rows();
      const query = {
        projectId: f.query.projectId,
        mediaInputId: saved.input.mediaInputId,
        inputRevision: 1,
        expectedInputRevision: 1,
      };
      assert.notEqual(
        saved.input.references[1]!.resultIndex,
        saved.input.references[2]!.resultIndex,
      );
      await assert.rejects(
        f.media.prepareInput(f.actor, query, signal()),
        /characters_duplicated/u,
      );
      assert.equal(f.state.uploads, 3);
      await assert.rejects(
        f.media.observeInput(f.actor, query, signal()),
        /characters_duplicated/u,
      );
      assert.equal(f.state.uploads, 3);
      assert.deepEqual(await f.rows(), before);
      assert.deepEqual(
        (
          await f.app.loadInput(f.actor, {
            projectId: query.projectId,
            mediaInputId: query.mediaInputId,
            inputRevision: 1,
          })
        )?.input,
        saved.input,
      );
    },
  );

  test(
    `${backend} partial D18 unknown upload recovers all original paths after actual parents close`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.d18Command),
        before = await f.rows();
      const query = {
        projectId: f.query.projectId,
        mediaInputId: saved.input.mediaInputId,
        inputRevision: 1,
        expectedInputRevision: 1,
      };
      f.state.onPost = async () => {
        if (f.state.uploads === 1)
          throw new Error("named_connection_lost_after_original_bytes_saved");
      };
      const prepared = await f.media.prepareInput(f.actor, query, signal());
      assert.equal(prepared.disposition, "pending");
      assert.equal(
        prepared.materials[0]!.preparation.state.event.phase,
        "unknownOutcome",
      );
      assert.equal(prepared.materials[0]!.preparation.observation, null);
      assert.deepEqual(
        prepared.materials.slice(1).map((m) => m.preparation.disposition),
        ["verified", "verified"],
      );
      assert.equal(f.state.uploads, 3);
      assert.equal(f.state.sourceGets, 3);
      f.archive.close();
      await f.parent.close();
      const next = await f.cold(),
        recovered = await next.media.observeInput(f.actor, query, signal());
      assert.equal(recovered.disposition, "verified");
      assert.deepEqual(
        recovered.materials.map((m) => m.preparation.state.initial),
        prepared.materials.map((m) => m.preparation.state.initial),
      );
      assert.equal(f.state.uploads, 3);
      assert.equal(f.state.sourceGets, 3);
      assert.deepEqual(await f.rows(), before);
    },
  );

  test(
    `${backend} confirmed prompt change during first upload stops remaining roles until explicit revision selection`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.d18Command),
        before = await f.rows();
      const query = {
        projectId: f.query.projectId,
        mediaInputId: saved.input.mediaInputId,
        inputRevision: 1,
        expectedInputRevision: 1,
      };
      f.state.onPost = async () => {
        if (f.state.uploads === 1)
          await f.app.saveInput(f.actor, {
            ...f.d18Command,
            mediaInputId: query.mediaInputId,
            expectedInputRevision: 1,
            prompt: "New confirmed station framing",
            idempotencyKey: "edited-while-uploading",
          });
      };
      await assert.rejects(
        f.media.prepareInput(f.actor, query, signal()),
        /revision_conflict/u,
      );
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
      f.state.onPost = undefined;
      const next = await f.media.prepareInput(
        f.actor,
        { ...query, inputRevision: 2, expectedInputRevision: 2 },
        signal(),
      );
      assert.equal(next.disposition, "verified");
      assert.equal(next.input.prompt, "New confirmed station framing");
      assert.equal(f.state.uploads, 3);
      assert.equal(f.state.sourceGets, 3);
      assert.deepEqual(await f.rows(), before);
      assert.equal(
        (
          await f.app.loadInput(f.actor, {
            projectId: query.projectId,
            mediaInputId: query.mediaInputId,
            inputRevision: 1,
          })
        )?.input.prompt,
        saved.input.prompt,
      );
    },
  );

  test(
    `${backend} current source change during D18 upload prevents sending later roles`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.d18Command),
        before = await f.rows();
      f.state.onPost = async () => {
        await f.assets.setLocked(f.actor, {
          projectId: f.query.projectId,
          assetId: f.scene.assetId,
          expectedAssetRevision: 4,
          locked: true,
          idempotencyKey: "scene-changed-during-send",
        });
      };
      await assert.rejects(
        f.media.prepareInput(
          f.actor,
          {
            projectId: f.query.projectId,
            mediaInputId: saved.input.mediaInputId,
            inputRevision: 1,
            expectedInputRevision: 1,
          },
          signal(),
        ),
        /reference_image_changed/u,
      );
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
      assert.deepEqual(await f.rows(), {
        ...before,
        project_asset_mutation_receipts:
          before.project_asset_mutation_receipts! + 1,
      });
    },
  );

  test(
    `${backend} current brief change disqualifies saved media while historical metadata remains readable`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.command);
      const current = await f.projects.getProject(f.actor, {
        projectId: f.query.projectId,
      });
      await f.projects.appendBrief(f.actor, {
        projectId: f.query.projectId,
        expectedProjectRevision: current.revision,
        text: "The story now takes place during a sunny day.",
        idempotencyKey: "changed-media-brief",
      });
      await assert.rejects(
        f.media.prepareInput(
          f.actor,
          {
            projectId: f.query.projectId,
            mediaInputId: saved.input.mediaInputId,
            inputRevision: 1,
            expectedInputRevision: 1,
          },
          signal(),
        ),
        /brief_stale/u,
      );
      assert.equal(f.state.sourceGets, 0);
      assert.equal(f.state.uploads, 0);
      assert.equal(
        (
          await f.app.loadInput(f.actor, {
            projectId: f.query.projectId,
            mediaInputId: saved.input.mediaInputId,
            inputRevision: 1,
          })
        )?.input.contentDigest,
        saved.input.contentDigest,
      );
    },
  );

  test(
    `${backend} media qualification never grants upload and reserved material resumes without another source GET`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.command);
      const query = {
        projectId: f.query.projectId,
        mediaInputId: saved.input.mediaInputId,
        inputRevision: 1,
        expectedInputRevision: 1,
      };
      f.state.uploadAllowed = false;
      await assert.rejects(
        f.media.prepareInput(f.actor, query, signal()),
        /preparation_denied/u,
      );
      assert.equal(f.state.uploads, 0);
      assert.equal(f.state.sourceGets, 1);
      f.state.uploadAllowed = true;
      assert.equal(
        (await f.media.prepareInput(f.actor, query, signal())).disposition,
        "verified",
      );
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
    },
  );

  test(
    `${backend} media store reads reject root getters and runtime rejects proxy dependencies without evaluating traps`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      let hooks = 0;
      assert.throws(() =>
        f.store.loadReceipt(
          {
            get actor() {
              hooks++;
              return f.actor;
            },
            command: f.command,
          },
          f.mediaAuthority("read"),
        ),
      );
      assert.throws(() =>
        f.store.qualify(
          {
            get actor() {
              hooks++;
              return f.actor;
            },
            projectId: f.query.projectId,
            mediaInputId: "not-created",
            inputRevision: 1,
            expectedInputRevision: 1,
          },
          f.mediaAuthority("qualify"),
        ),
      );
      const trapped = new Proxy(f.store, {
        get() {
          hooks++;
          throw new Error("proxy_trap_evaluated");
        },
        getPrototypeOf() {
          hooks++;
          throw new Error("proxy_trap_evaluated");
        },
      });
      assert.throws(
        () =>
          new ProjectMediaMaterialPreparer({
            store: trapped,
            preparer: f.preparer,
            reviews: f.reviews,
            authorization: f.mediaAuthorization,
          }),
        /dependency_invalid/u,
      );
      assert.equal(hooks, 0);
      assert.equal(f.state.sourceGets, 0);
      assert.equal(f.state.uploads, 0);
    },
  );
}
