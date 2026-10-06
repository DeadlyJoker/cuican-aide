import assert from "node:assert/strict";
import test from "node:test";
import type { PluginUiActionContext } from "@crewon/application";
import { PROJECT_MEDIA_INPUT_UI_ACTIONS } from "@crewon/contracts/project-media-inputs-ui";
import {
  parseSaveMediaInputResponse,
  type SaveMediaInputResponse,
  type LoadMediaInputResponse,
} from "@crewon/contracts/project-media-inputs";
import { observeMaterialPreparationSql } from "../../../packages/store/src/project-material-preparation.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { mediaInputUiFixture } from "./project-media-input-plugin-ui.test-support.ts";
import { composeDesktopProjectPluginUiDispatch } from "./desktop-project-plugin-ui-dispatch.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: UI owner retirement withdraws availability and joins real pending metadata work`,
    assetTestOptions(backend),
    async (t) => {
      const x = await mediaInputUiFixture(t, backend),
        entered = deferred(),
        release = deferred();
      let blocked = false;
      x.controlState.beforeMetadata = async (p) => {
        if (p.action === "projectMediaInput:write" && !blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
      };
      const pending = x.saveUi();
      const rejected = assert.rejects(pending);
      await entered.promise;
      let joined = false;
      const closing = x.owner.close().then(() => {
        joined = true;
      });
      await Promise.resolve();
      assert.equal(joined, false);
      release.resolve();
      await rejected;
      await closing;
      assert.equal(joined, true);
      assert.deepEqual(await x.countMedia(), {
        project_media_inputs: 0,
        project_media_input_revisions: 0,
        project_media_input_receipts: 0,
      });
      const services = x.owner.hostUiServices();
      assert.equal(
        services.isAvailable({
          scope: x.target.selection,
          candidate: {
            descriptor: x.descriptor,
            packageDigest: x.target.package.packageDigest,
          },
          requirement: {
            service: "crewon.project-media-inputs",
            apiVersion: "1",
            optional: false,
          },
        }),
        false,
      );
      await x.noExecution();
    },
  );
  test(
    `${backend}: actual Core withdrawal removes media UI availability while preserving original parent`,
    assetTestOptions(backend),
    async (t) => {
      const x = await mediaInputUiFixture(t, backend),
        services = x.owner.hostUiServices();
      const request = {
        scope: x.target.selection,
        candidate: {
          descriptor: x.descriptor,
          packageDigest: x.target.package.packageDigest,
        },
        requirement: {
          service: "crewon.project-media-inputs",
          apiVersion: "1",
          optional: false,
        },
      };
      assert.equal(services.isAvailable(request), true);
      await x.core.close();
      assert.equal(services.isAvailable(request), false);
      assert.ok(
        await x.parent
          .creativeProjectStore()
          .loadProject({
            owner: {
              tenantId: x.actor.tenantId,
              spaceId: x.actor.spaceId,
              principalId: x.actor.principalId,
            },
            projectId: x.query.projectId,
          }),
      );
      await x.noExecution();
    },
  );
  test(
    `${backend}: real UI save/edit/history and HTTP share original media input revisions and receipt`,
    assetTestOptions(backend),
    async (t) => {
      const x = await mediaInputUiFixture(t, backend),
        command = x.command();
      const saved = (await x.saveUi()) as SaveMediaInputResponse;
      assert.equal(saved.disposition, "committed");
      const replay = await x.save();
      assert.equal(replay.statusCode, 200);
      assert.deepEqual(parseSaveMediaInputResponse(command, replay.json()), {
        ...saved,
        disposition: "replayed",
      });
      const edited = (await x.saveUi({
        ...command,
        mediaInputId: saved.input.mediaInputId,
        expectedInputRevision: 1,
        prompt: "保持五官，正面和侧面。",
        idempotencyKey: "manual-revise",
      })) as SaveMediaInputResponse;
      assert.equal(edited.input.inputRevision, 2);
      const latest = (await x.loadUi(
        saved.input.mediaInputId,
      )) as LoadMediaInputResponse;
      assert.equal(latest.state!.latestInputRevision, 2);
      assert.equal(latest.state!.input.prompt, edited.input.prompt);
      assert.deepEqual(
        (
          (await x.loadUi(
            saved.input.mediaInputId,
            1,
          )) as LoadMediaInputResponse
        ).state!.input,
        saved.input,
      );
      await assert.rejects(() =>
        x.saveUi({
          ...command,
          mediaInputId: saved.input.mediaInputId,
          expectedInputRevision: 1,
          idempotencyKey: "stale-edit",
        }),
      );
      const d18 = (await x.saveUi(x.command("D18"))) as SaveMediaInputResponse;
      assert.equal(d18.input.workflowId, "flux2-three-reference-storyboard");
      assert.deepEqual(await x.countMedia(), {
        project_media_inputs: 2,
        project_media_input_revisions: 3,
        project_media_input_receipts: 3,
      });
      assert.equal(
        x.owner.committedMetadata.isOutcome(x.stateUi.outcomes[0]),
        false,
      );
      assert.throws(
        () =>
          x.owner.committedMetadata.verify(
            x.stateUi.contexts[0]!,
            x.stateUi.outcomes[0]!,
          ),
        { code: "plugin_ui_committed_metadata_invalid" },
      );
      await x.noExecution();
    },
  );
  test(
    `${backend}: copied/expired UI contexts and mismatched publications never reach original metadata`,
    assetTestOptions(backend),
    async (t) => {
      const x = await mediaInputUiFixture(t, backend);
      let getters = 0;
      await assert.rejects(
        async () =>
          x.owner.actions.invoke({
            get actor() {
              getters++;
              throw new Error("must not read");
            },
          } as unknown as PluginUiActionContext),
        { code: "plugin_project_media_input_invocation_unavailable" },
      );
      assert.equal(getters, 0);
      await x.saveUi();
      const context = x.stateUi.contexts[0]!;
      await assert.rejects(async () => x.owner.actions.invoke({ ...context }), {
        code: "plugin_project_media_input_invocation_unavailable",
      });
      await assert.rejects(
        async () =>
          x.core.projectMediaInputs!.saveInputFromPluginUi(
            context,
            new AbortController().signal,
          ),
        { code: "plugin_project_media_input_invocation_unavailable" },
      );
      const y = await mediaInputUiFixture(t, backend, {
        publication: `sha256:${"e".repeat(64)}`,
      });
      await assert.rejects(() => y.saveUi(), {
        code: "project_media_input_ui_unavailable",
      });
      assert.equal(y.controlState.metadata.length, 0);
      const z = await mediaInputUiFixture(t, backend, { declared: false });
      await assert.rejects(() => z.saveUi(), {
        code: "project_media_input_ui_unavailable",
      });
      assert.equal(z.controlState.metadata.length, 0);
      assert.deepEqual(await z.countMedia(), {
        project_media_inputs: 0,
        project_media_input_revisions: 0,
        project_media_input_receipts: 0,
      });
      await x.noExecution();
      await y.noExecution();
      await z.noExecution();
    },
  );
  test(
    `${backend}: actual mount disposal after receipt INSERT rolls back every media row`,
    assetTestOptions(backend),
    async (t) => {
      const x = await mediaInputUiFixture(t, backend);
      let observed = 0;
      const restore = observeMaterialPreparationSql(
        backend,
        /INSERT INTO .*project_media_input_receipts/u,
        () => {
          observed++;
          void x.ui.closeMount(x.actor, { mountRef: x.mount.mountRef });
        },
      );
      try {
        await assert.rejects(() => x.saveUi());
      } finally {
        restore();
      }
      assert.equal(observed, 1);
      assert.deepEqual(await x.countMedia(), {
        project_media_inputs: 0,
        project_media_input_revisions: 0,
        project_media_input_receipts: 0,
      });
      await x.noExecution();
    },
  );
  test(
    `${backend}: committed original receipt survives late mount/owner/permission withdrawal`,
    assetTestOptions(backend),
    async (t) => {
      const x = await mediaInputUiFixture(t, backend);
      x.stateUi.afterOutcome = () => {
        x.stateUi.allowed = false;
        void x.owner.close();
        void x.ui.closeMount(x.actor, { mountRef: x.mount.mountRef });
      };
      const saved = (await x.saveUi()) as SaveMediaInputResponse;
      assert.equal(saved.disposition, "committed");
      assert.deepEqual(await x.countMedia(), {
        project_media_inputs: 1,
        project_media_input_revisions: 1,
        project_media_input_receipts: 1,
      });
      await x.owner.close();
      assert.equal((await x.save()).json().disposition, "replayed");
      await x.noExecution();
    },
  );
  test(
    `${backend}: missing metadata write grant and changed original profile prevent UI writes`,
    assetTestOptions(backend),
    async (t) => {
      const x = await mediaInputUiFixture(t, backend);
      x.mediaPolicy.write = false;
      await assert.rejects(() => x.saveUi(), {
        code: "project_media_input_denied",
      });
      x.mediaPolicy.write = true;
      x.controlState.profileId = "withdrawn-original-profile";
      await assert.rejects(() => x.saveUi());
      assert.deepEqual(await x.countMedia(), {
        project_media_inputs: 0,
        project_media_input_revisions: 0,
        project_media_input_receipts: 0,
      });
      await x.noExecution();
    },
  );
}

test("missing/unknown media namespace refuses before task execution fallback", async () => {
  let taskCalls = 0;
  const dispatch = composeDesktopProjectPluginUiDispatch({
    projects: undefined,
    texts: undefined,
    history: undefined,
    tasks: {
      owner: {
        actions: {
          invoke: async () => {
            taskCalls++;
            return null;
          },
        },
      },
    } as never,
  });
  for (const action of [
    PROJECT_MEDIA_INPUT_UI_ACTIONS.saveInput,
    "crewon.project-media-inputs.v2.saveInput",
  ])
    await assert.rejects(
      () => dispatch.actions.invoke({ action } as PluginUiActionContext),
      { code: "project_media_input_ui_unavailable" },
    );
  assert.equal(taskCalls, 0);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
