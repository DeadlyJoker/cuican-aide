import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { observeMaterialPreparationSql } from "../../../packages/store/src/project-material-preparation.test-support.ts";
import { selectionRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import {
  parseSaveProjectMediaInputCommand,
  ProjectMediaInputApplicationService,
} from "@crewon/application";
import { projectMediaInputFixture as fixture } from "./project-media-input.test-support.ts";
import { materialSignal as signal } from "./project-material-preparer.test-support.ts";
import { ProjectMediaMaterialPreparer } from "./project-media-material-preparer.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} confirmed T10 logical input is immutable and performs no supplier I/O or Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows(),
        saved = await f.app.saveInput(f.actor, f.command);
      assert.equal(saved.disposition, "committed");
      assert.equal(saved.input.inputRevision, 1);
      assert.equal(saved.input.workflow.output.nodeId, "129");
      assert.equal(saved.input.references[0]!.role, "character");
      assert.equal(
        saved.input.references[0]!.preparation.source.query.assetId,
        f.query.assetId,
      );
      assert.equal(saved.input.prompt, f.command.prompt);
      assert.equal(f.state.sourceGets, 0);
      assert.equal(f.state.uploads, 0);
      assert.equal(f.state.targetGets, 0);
      assert.deepEqual(await f.rows(), before);
      const replay = await f.app.saveInput(f.actor, f.command);
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.input, saved.input);
      const loaded = await f.app.loadInput(f.actor, {
        projectId: f.query.projectId,
        mediaInputId: saved.input.mediaInputId,
        inputRevision: null,
      });
      assert.deepEqual(loaded?.input, saved.input);
      assert.equal(loaded?.latestInputRevision, 1);
      assert.deepEqual(await f.countMedia(), {
        project_media_inputs: 1,
        project_media_input_revisions: 1,
        project_media_input_receipts: 1,
      });
      assert.equal(
        (
          await f.app.qualifyInput(f.actor, {
            projectId: f.query.projectId,
            mediaInputId: saved.input.mediaInputId,
            inputRevision: 1,
            expectedInputRevision: 1,
          })
        ).contentDigest,
        saved.input.contentDigest,
      );
      await assert.rejects(
        f.app.saveInput(f.actor, {
          ...f.command,
          prompt: "changed under same key",
        }),
        /idempotency_conflict/u,
      );
    },
  );
  test(
    `${backend} actual D18 input fixes script, scene and ordered distinct character sources`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.d18Command);
      assert.deepEqual(
        saved.input.references.map((r) => r.role),
        ["scene", "characterOne", "characterTwo"],
      );
      assert.equal(
        saved.input.script?.artifactId,
        f.script.artifact.artifactId,
      );
      assert.equal(saved.input.workflow.output.nodeId, "17");
      assert.equal(saved.input.references[1]!.resultIndex, 0);
      assert.equal(saved.input.references[2]!.resultIndex, 1);
      assert.notEqual(
        saved.input.references[1]!.sourceDigest,
        saved.input.references[2]!.sourceDigest,
      );
      assert.equal(f.state.uploads, 0);
      assert.equal(f.state.sourceGets, 0);
      const bads = [
        { ...f.d18Command, script: null },
        {
          ...f.d18Command,
          references: { ...f.d18Command.references, characterTwo: f.query },
        },
        {
          ...f.d18Command,
          item: {
            kind: "storyboard-frame-exploration",
            episodeId: "wrong-episode",
          } as const,
        },
      ];
      for (const c of bads)
        await assert.rejects(
          f.app.saveInput(f.actor, {
            ...c,
            idempotencyKey: `bad-${bads.indexOf(c)}`,
          }),
        );
      const copied = await f.newReference("character", "复制原参考", 2);
      await assert.rejects(
        f.app.saveInput(f.actor, {
          ...f.d18Command,
          references: {
            ...f.d18Command.references,
            characterOne: f.characterTwo,
            characterTwo: copied,
          },
          idempotencyKey: "duplicate-actual-character",
        }),
        /characters_duplicated/u,
      );
      assert.deepEqual(await f.countMedia(), {
        project_media_inputs: 1,
        project_media_input_revisions: 1,
        project_media_input_receipts: 1,
      });
    },
  );
  test(
    `${backend} input revision CAS preserves old prompt and reuses exact preparation intent`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        first = await f.app.saveInput(f.actor, f.command),
        append = {
          ...f.command,
          mediaInputId: first.input.mediaInputId,
          expectedInputRevision: 1,
          prompt: "New confirmed framing",
          idempotencyKey: "append-media",
        };
      const second = await f.app.saveInput(f.actor, append);
      assert.equal(second.input.inputRevision, 2);
      assert.equal(second.input.prompt, append.prompt);
      assert.deepEqual(second.input.references, first.input.references);
      assert.deepEqual(
        (
          await f.app.loadInput(f.actor, {
            projectId: f.query.projectId,
            mediaInputId: first.input.mediaInputId,
            inputRevision: 1,
          })
        )?.input,
        first.input,
      );
      assert.deepEqual(
        (await f.app.saveInput(f.actor, f.command)).input,
        first.input,
      );
      await assert.rejects(
        f.app.saveInput(f.actor, { ...append, idempotencyKey: "stale-cas" }),
        /revision_conflict/u,
      );
      await assert.rejects(
        f.app.qualifyInput(f.actor, {
          projectId: f.query.projectId,
          mediaInputId: first.input.mediaInputId,
          inputRevision: 1,
          expectedInputRevision: 1,
        }),
        /revision_conflict/u,
      );
      assert.equal(
        (
          await f.app.qualifyInput(f.actor, {
            projectId: f.query.projectId,
            mediaInputId: first.input.mediaInputId,
            inputRevision: 1,
            expectedInputRevision: 2,
          })
        ).prompt,
        f.command.prompt,
      );
    },
  );
  test(
    `${backend} two database parents saving the same original command create one input and receipt`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        next = await f.cold();
      const results = await Promise.all([
        f.app.saveInput(f.actor, f.command),
        next.app.saveInput(f.actor, f.command),
      ]);
      assert.equal(
        results.filter((r) => r.disposition === "committed").length,
        1,
      );
      assert.deepEqual(results[0]!.input, results[1]!.input);
      assert.equal(f.state.uploads, 0);
      assert.deepEqual(await f.countMedia(), {
        project_media_inputs: 1,
        project_media_input_revisions: 1,
        project_media_input_receipts: 1,
      });
    },
  );
  test(
    `${backend} saving grants cannot imply prepare/qualify authority and revoked writes also reject replay`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.mediaPolicy.write = false;
      await assert.rejects(
        f.app.saveInput(f.actor, f.command),
        /media_input_denied/u,
      );
      f.mediaPolicy.write = true;
      const saved = await f.app.saveInput(f.actor, f.command);
      f.mediaPolicy.write = false;
      await assert.rejects(
        f.app.saveInput(f.actor, f.command),
        /media_input_denied/u,
      );
      f.mediaPolicy.qualify = false;
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
        /media_input_denied/u,
      );
      assert.equal(f.state.sourceGets, 0);
      assert.equal(f.state.uploads, 0);
      f.mediaPolicy.read = false;
      await assert.rejects(
        f.app.loadInput(f.actor, {
          projectId: f.query.projectId,
          mediaInputId: saved.input.mediaInputId,
          inputRevision: null,
        }),
        /media_input_denied/u,
      );
    },
  );
  test(
    `${backend} adopted source change preserves history but disqualifies new execution before I/O`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.command),
        query = {
          projectId: f.query.projectId,
          mediaInputId: saved.input.mediaInputId,
          inputRevision: 1,
          expectedInputRevision: 1,
        };
      await f.assets.setLocked(f.actor, {
        projectId: f.query.projectId,
        assetId: f.query.assetId,
        expectedAssetRevision: 4,
        locked: true,
        idempotencyKey: "source-head-changed",
      });
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
      await assert.rejects(
        f.media.prepareInput(f.actor, query, signal()),
        /reference_image_changed/u,
      );
      assert.equal(f.state.sourceGets, 0);
      assert.equal(f.state.uploads, 0);
    },
  );
  test(
    `${backend} changed adopted script or disabled target denies current use without deleting saved inputs`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.d18Command),
        query = {
          projectId: f.query.projectId,
          mediaInputId: saved.input.mediaInputId,
          inputRevision: 1,
          expectedInputRevision: 1,
        };
      const changed = await f.texts.saveScriptCandidate(f.actor, {
        projectId: f.query.projectId,
        episodeId: "episode-1",
        expectedArtifactRevision: 2,
        briefRevision: 1,
        outline: null,
        content: {
          title: "新剧本",
          scenes: [
            {
              sceneId: "scene-1",
              location: "旧站",
              timeOfDay: "雨夜",
              action: "许晟独自等待。",
              dialogue: [],
            },
          ],
        },
        idempotencyKey: "changed-script",
      });
      await f.texts.selectRevision(f.actor, {
        projectId: f.query.projectId,
        artifactId: changed.artifact.artifactId,
        expectedArtifactRevision: 3,
        contentRevision: 2,
        idempotencyKey: "new-script-selected",
      });
      await assert.rejects(
        f.media.prepareInput(f.actor, query, signal()),
        /source_stale/u,
      );
      assert.equal(f.state.uploads, 0);
      const other = await fixture(t, backend),
        image = await other.app.saveInput(other.actor, other.command);
      await other.installs.commitSelection(
        selectionRecipe(other.enabled.selection, "media-disable-target", {
          actor: other.actor,
          state: "disabled",
        }),
      );
      await assert.rejects(
        other.app.qualifyInput(other.actor, {
          projectId: other.query.projectId,
          mediaInputId: image.input.mediaInputId,
          inputRevision: 1,
          expectedInputRevision: 1,
        }),
      );
      assert.equal(
        (
          await other.app.loadInput(other.actor, {
            projectId: other.query.projectId,
            mediaInputId: image.input.mediaInputId,
            inputRevision: null,
          })
        )?.input.contentDigest,
        image.input.contentDigest,
      );
    },
  );
  test(
    `${backend} activity revoked after actual media SQL insertion rolls back all new archive rows`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        restore = observeMaterialPreparationSql(
          backend,
          /INSERT INTO .*project_media_input_revisions/u,
          () => {
            f.mediaPolicy.active = false;
          },
        );
      try {
        await assert.rejects(
          f.app.saveInput(f.actor, f.command),
          /owner_retired/u,
        );
      } finally {
        restore();
      }
      assert.deepEqual(await f.countMedia(), {
        project_media_inputs: 0,
        project_media_input_revisions: 0,
        project_media_input_receipts: 0,
      });
      assert.equal(f.state.uploads, 0);
    },
  );
  test(
    `${backend} media schema is explicit and immutable; missing marker does not silently repair`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend, { migrate: false });
      await assert.rejects(
        f.app.saveInput(f.actor, f.command),
        /schema_invalid/u,
      );
      await f.store.migrate();
      await f.store.migrate();
      await f.app.saveInput(f.actor, f.command);
      for (const sql of [
        `DELETE FROM ${f.prefix}project_media_input_revisions`,
        `UPDATE ${f.prefix}project_media_input_revisions SET content_digest='fake'`,
        `DELETE FROM ${f.prefix}project_media_input_receipts`,
        `UPDATE ${f.prefix}project_media_inputs SET latest_input_revision=4`,
      ])
        await assert.rejects(f.sql(sql));
      await f.sql(`DROP TABLE ${f.prefix}project_media_input_schema_version`);
      await assert.rejects(f.store.migrate(), /schema_invalid/u);
      assert.equal(await f.count("project_media_input_revisions"), 1);
    },
  );
  test(
    `${backend} caller hooks and arbitrary paths are rejected; original request snapshot survives mutation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      let hooks = 0;
      const invalid = {
        ...f.command,
        references: {
          character: {
            ...f.query,
            get assetId() {
              hooks++;
              return "fake";
            },
          },
        },
      };
      await assert.rejects(f.app.saveInput(f.actor, invalid));
      assert.equal(hooks, 0);
      assert.throws(() =>
        parseSaveProjectMediaInputCommand({
          ...f.command,
          url: "https://caller.example/",
        }),
      );
      const mutable = structuredClone(f.command),
        saving = f.app.saveInput(f.actor, mutable);
      Object.assign(mutable, { prompt: "late mutation" });
      Object.assign(mutable.references.character!, { assetId: "late-other" });
      assert.equal((await saving).input.prompt, f.command.prompt);
      await assert.rejects(
        f.app.saveInput({ ...f.actor, principalId: "other-owner" }, f.command),
      );
      assert.equal(f.state.uploads, 0);
    },
  );
  test(
    `${backend} T10 saved input composes actual preparation and cold query without another upload`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.command),
        before = await f.rows(),
        query = {
          projectId: f.query.projectId,
          mediaInputId: saved.input.mediaInputId,
          inputRevision: 1,
          expectedInputRevision: 1,
        };
      await assert.rejects(
        f.media.observeInput(f.actor, query, signal()),
        /not_found/u,
      );
      assert.equal(f.state.sourceGets, 0);
      const prepared = await f.media.prepareInput(f.actor, query, signal());
      assert.equal(prepared.disposition, "verified");
      assert.deepEqual(prepared.input, saved.input);
      assert.equal(prepared.materials[0]!.role, "character");
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
      assert.deepEqual(await f.rows(), before);
      f.archive.close();
      await f.parent.close();
      const next = await f.cold(),
        observed = await next.media.observeInput(f.actor, query, signal());
      assert.equal(observed.disposition, "verified");
      assert.deepEqual(observed.input, saved.input);
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
    },
  );
  test(
    `${backend} D18 prepares three independent role intents with distinct character bytes and no generation Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.d18Command),
        before = await f.rows(),
        query = {
          projectId: f.query.projectId,
          mediaInputId: saved.input.mediaInputId,
          inputRevision: 1,
          expectedInputRevision: 1,
        };
      const result = await f.media.prepareInput(f.actor, query, signal());
      assert.equal(result.disposition, "verified");
      assert.deepEqual(
        result.materials.map((x) => x.role),
        ["scene", "characterOne", "characterTwo"],
      );
      assert.equal(
        new Set(
          result.materials.map(
            (m) => m.preparation.state.initial.transfer.preparationId,
          ),
        ).size,
        3,
      );
      assert.notEqual(
        result.materials[1]!.preparation.state.initial.source.source.byteDigest,
        result.materials[2]!.preparation.state.initial.source.source.byteDigest,
      );
      assert.equal(f.state.uploads, 3);
      assert.equal(f.state.sourceGets, 3);
      assert.deepEqual(await f.rows(), before);
      await f.media.prepareInput(f.actor, query, signal());
      assert.equal(f.state.uploads, 3);
      assert.equal(f.state.sourceGets, 3);
    },
  );
  test(
    `${backend} real media store and original preparer methods are required; no fake DTO can claim prepared input`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.app.saveInput(f.actor, f.command);
      const wrongReview = new ProjectMediaInputApplicationService({
        store: f.store,
        sources: f.sources,
        targets: f.targets,
        reviews: [
          {
            ...f.reviews[0]!,
            targetIdentity: {
              ...f.reviews[0]!.targetIdentity,
              packageDigest: `sha256:${"f".repeat(64)}`,
            },
          },
        ],
        authorization: f.mediaAuthorization,
        ids: { nextMediaInputId: () => "unused" },
        clock: f.dependencies.clock,
      });
      for (const key of ["load", "qualify"] as const)
        Object.defineProperty(f.store, key, {
          get() {
            throw new Error("instance override evaluated");
          },
        });
      for (const key of [
        "prepareSelectedReference",
        "observePreparedReference",
      ] as const)
        Object.defineProperty(f.preparer, key, {
          get() {
            throw new Error("instance override evaluated");
          },
        });
      const actual = new ProjectMediaMaterialPreparer({
        store: f.store,
        preparer: f.preparer,
        reviews: f.reviews,
        authorization: f.mediaAuthorization,
      });
      assert.equal(
        (
          await actual.prepareInput(
            f.actor,
            {
              projectId: f.query.projectId,
              mediaInputId: saved.input.mediaInputId,
              inputRevision: 1,
              expectedInputRevision: 1,
            },
            signal(),
          )
        ).disposition,
        "verified",
      );
      assert.throws(
        () =>
          new ProjectMediaMaterialPreparer({
            store: {} as never,
            preparer: f.preparer,
            reviews: f.reviews,
            authorization: f.mediaAuthorization,
          }),
        /dependency_invalid/u,
      );
      await assert.rejects(
        wrongReview.saveInput(f.actor, {
          ...f.command,
          idempotencyKey: "unreviewed",
        }),
        /workflow_unreviewed/u,
      );
    },
  );
}
