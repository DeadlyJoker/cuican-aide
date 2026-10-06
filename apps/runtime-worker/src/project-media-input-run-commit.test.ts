import assert from "node:assert/strict";
import test from "node:test";
import { projectMediaInputRunCommand } from "@crewon/application";
import { mediaInputToolFixture } from "./project-media-input-tools.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { observeMaterialPreparationSql } from "../../../packages/store/src/project-material-preparation.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: actual dispatched media-input command saves the shared input and replay never replaces later manual edits`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaInputToolFixture(t, backend, kind),
          operation = await f.prepareTool("saveInput", f.request);
        const first = await f.write(operation);
        assert.equal(first.disposition, "committed");
        const query = {
          projectId: first.input.projectId,
          mediaInputId: first.input.mediaInputId,
          inputRevision: null,
        };
        assert.deepEqual(
          (await f.app.loadInput(f.actor, query))?.input,
          first.input,
        );
        const current = await f.app.saveInput(f.actor, {
          ...(kind === "T10" ? f.command : f.d18Command),
          mediaInputId: first.input.mediaInputId,
          expectedInputRevision: 1,
          prompt: "Hand edited exact shared input.",
          idempotencyKey: "manual-followup",
        });
        assert.equal(current.input.inputRevision, 2);
        const before = await f.countMedia();
        const cold = await f.cold();
        const replay = await f.write(operation, cold.app);
        assert.equal(replay.disposition, "replayed");
        assert.deepEqual(replay.input, first.input);
        assert.deepEqual(
          (await cold.app.loadInput(f.actor, query))?.input,
          current.input,
        );
        assert.deepEqual(await f.countMedia(), before);
        assert.equal(f.state.sourceGets, 0);
        assert.equal(f.state.uploads, 0);
      },
    );
  test(
    `${backend} dispatched media input refuses replacement content, target, key and current conversation revocation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputToolFixture(t, backend),
        operation = await f.prepareTool("saveInput", f.request),
        q = f.transaction(operation);
      const command = projectMediaInputRunCommand(q, f.digester),
        before = await f.countMedia();
      for (const patch of [
        { prompt: "replacement" },
        { idempotencyKey: "model-key" },
        { target: { ...command.target, configurationRevision: 1 } },
      ])
        await assert.rejects(
          f.app.saveInput(
            f.actor,
            { ...command, ...patch },
            { runTransaction: q },
          ),
        );
      assert.deepEqual(await f.countMedia(), before);
      const {
        schemaVersion: _schema,
        contentDigest: _digest,
        ...binding
      } = f.binding;
      const { createProjectConversationBinding } = await import(
        "@crewon/domain"
      );
      await f.conversations.commitBinding(
        {
          kind: "set-state",
          binding: createProjectConversationBinding(
            {
              ...binding,
              state: "revoked",
              revision: 2,
              updatedAt: new Date().toISOString(),
            },
            f.digester,
          ),
          expectedRevision: 1,
          receipt: {
            actor: f.actor,
            idempotencyKey: "revoke-media-binding",
            requestDigest: f.digester.sha256("revoke-media-binding"),
          },
        },
        {
          authority: {
            version: "crewon.project-conversation-commit.v1",
            actor: f.actor,
            installation: f.target.installation,
            pin: f.pin,
            selection: f.target.selection,
            package: f.target.package,
            assertCurrent: f.current,
            assertTransactionCurrent: f.current,
            assertActive: f.active,
          },
        },
      );
      await assert.rejects(f.write(operation));
      assert.deepEqual(await f.countMedia(), before);
    },
  );
  test(
    `${backend} withdrawal after actual media input INSERT rolls back input, revision and receipt together`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputToolFixture(t, backend),
        operation = await f.prepareTool("saveInput", f.request),
        before = await f.countMedia();
      let observed = false;
      const restore = observeMaterialPreparationSql(
        backend,
        /INSERT INTO .*project_media_input_revisions/u,
        () => {
          observed = true;
          f.controls.live = false;
        },
      );
      try {
        await assert.rejects(f.write(operation));
      } finally {
        restore();
      }
      assert.equal(observed, true);
      assert.deepEqual(await f.countMedia(), before);
    },
  );
}
