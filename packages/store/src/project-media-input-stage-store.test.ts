import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ExtensionTaskApplicationService } from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  assetTestOptions,
  hasAssetCause,
} from "./project-asset.test-support.ts";
import { mediaInputStageFixture } from "./project-media-input-stage.test-support.ts";
import { observeStageCommit } from "./project-conversation-store.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} media-input preparation requires original unmetered authority before quoting or writing a task`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputStageFixture(t, backend);
      const counts = await f.counts();
      const credits = await f.creditObjects();
      let quotes = 0;
      const tasks = new ExtensionTaskApplicationService({
        ...f.dependencies,
        store: f.parent,
        extensions: f.first.store,
        operations: f.operations,
        ids: { nextId: () => randomUUID() },
        host: { ...f.dependencies.host, taskAdmissionMode: () => "installed" },
        creditQuotes: {
          async quoteGeneration() {
            quotes++;
            throw new Error("unexpected_media_input_price_quote");
          },
        },
      });
      await assert.rejects(
        tasks.createProjectMediaInputStageTurnFromHost(
          f.actor,
          f.command,
          f.task,
        ),
        hasAssetCause("project_media_input_stage_unmetered_required"),
      );
      assert.equal(quotes, 0);
      assert.deepEqual(await f.counts(), counts);
      assert.deepEqual(await f.creditObjects(), credits);
    },
  );
  test(
    `${backend} withdrawal after confirmed media-input COMMIT returns the original success and never asks for a replacement Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputStageFixture(t, backend);
      let observed = false;
      const restore = observeStageCommit(
        backend,
        () => {
          observed = true;
          f.state.live = false;
        },
        { stage: "media-input" },
      );
      try {
        const result = await f.startStage();
        assert.equal(observed, true);
        assert.equal(result.result.run.disposition, "committed");
        assert.deepEqual(
          await f.stages.loadMediaInputStageAdmission({
            tenantId: result.result.binding.tenantId,
            spaceId: result.result.binding.spaceId,
            runId: result.result.binding.runId,
          }),
          result.mediaInputStageAdmission,
        );
      } finally {
        restore();
      }
      const counts = await f.counts();
      await assert.rejects(f.startStage());
      assert.deepEqual(await f.counts(), counts);
    },
  );
  test(
    `${backend} actual host media-input stage creation and original receipt recovery return one qualified Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputStageFixture(t, backend),
        before = await f.creditObjects();
      const first = await f.startStage();
      assert.equal(
        first.result.projectMediaInputStageAdmission?.contentDigest,
        first.mediaInputStageAdmission.contentDigest,
      );
      assert.equal(
        first.mediaInputStageAdmission.stage.workflowId,
        "krea2-reference-four-view",
      );
      assert.equal(
        first.result.turn.threadState.workspaceId,
        f.prepared.binding.workspaceId,
      );
      const counts = await f.counts();
      const replay = await f.startStage();
      assert.equal(replay.result.run.disposition, "replayed");
      assert.equal(replay.result.binding.runId, first.result.binding.runId);
      assert.deepEqual(
        replay.mediaInputStageAdmission,
        first.mediaInputStageAdmission,
      );
      assert.deepEqual(await f.counts(), counts);
      assert.deepEqual(await f.creditObjects(), before);
    },
  );
  test(
    `${backend} media-input scope commits with the original Turn and preserves workspace and replay across SQL connections`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputStageFixture(t, backend),
        before = await f.creditObjects();
      const first = await f.commit(f.input, f.options);
      assert.equal(
        first.turn.threadState.workspaceId,
        f.prepared.binding.workspaceId,
      );
      assert.equal(first.binding.runId, f.locator.runId);
      assert.deepEqual(first.projectMediaInputStageAdmission, f.admission);
      assert.equal(first.projectAssetStageAdmission, undefined);
      assert.deepEqual(
        await f.stages.loadMediaInputStageAdmission(f.locator),
        f.admission,
      );
      assert.equal(
        await f.stages.readRequiredMediaInputStageDigest(f.locator),
        f.admission.contentDigest,
      );
      assert.equal(await f.store.loadStageAdmission(f.locator), null);
      assert.equal(
        await f.parent
          .projectAssetStageStore()
          .loadAssetStageAdmission(f.locator),
        null,
      );
      assert.deepEqual(
        await f.second.parent
          .projectMediaInputStageStore()
          .loadMediaInputStageAdmission(f.locator),
        f.admission,
      );
      const frozenCounts = await f.counts();
      const replay = await f.second.store.commitExtensionTurn(
        f.input,
        f.options,
      );
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(replay.projectMediaInputStageAdmission, f.admission);
      assert.deepEqual(await f.counts(), frozenCounts);
      assert.deepEqual(await f.creditObjects(), before);
      const receipt = await f.second.store.loadExtensionTurnReceipt({
        ...f.input.binding,
        receipt: f.input.receipt,
      });
      assert.deepEqual(receipt?.projectMediaInputStageAdmission, f.admission);
      await assert.rejects(
        f.rows(
          `UPDATE ${f.prefix}project_media_input_stage_run_admissions SET binding_revision=binding_revision+1`,
        ),
      );
      await assert.rejects(
        f.rows(
          `DELETE FROM ${f.prefix}project_media_input_stage_run_admissions`,
        ),
      );
      await f.rows(
        `DROP TABLE ${f.prefix}project_media_input_stage_run_admissions`,
      );
      await assert.rejects(
        f.stages.loadMediaInputStageAdmission(f.locator),
        hasAssetCause("project_media_input_stage_schema_incomplete"),
      );
      await assert.rejects(
        f.second.store.loadExtensionTurnReceipt({
          ...f.input.binding,
          receipt: f.input.receipt,
        }),
      );
      await assert.rejects(f.commit(f.input, f.options));
    },
  );
  test(
    `${backend} media-input admission rejects mixed scopes, missing authority and changed workflow configuration without a Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputStageFixture(t, backend),
        before = await f.counts();
      await assert.rejects(
        f.commit(f.input, { unmeteredAuthority: f.options.unmeteredAuthority }),
      );
      await assert.rejects(
        f.commit(
          { ...f.input, projectAssetStageAdmission: f.admission as never },
          f.options,
        ),
      );
      await assert.rejects(
        f.commit(f.input, {
          ...f.options,
          projectMediaInputStageAuthority: {
            ...f.authority,
            version: "crewon.project-asset-stage-commit.v1",
          } as never,
        }),
      );
      const changed = {
        ...f.admission,
        stage: {
          ...f.admission.stage,
          configurationRevision: f.admission.stage.configurationRevision + 1,
        },
      };
      changed.taskInputDigest = f.digester.sha256(
        extensionCanonicalJson({
          stage: changed.stage,
          sources: changed.sources,
          userContentDigest: changed.userContentDigest,
        }),
      );
      const { contentDigest: _priorDigest, ...body } = changed;
      changed.contentDigest = f.digester.sha256(extensionCanonicalJson(body));
      await assert.rejects(
        f.commit(
          { ...f.input, projectMediaInputStageAdmission: changed },
          f.options,
        ),
      );
      assert.deepEqual(await f.counts(), before);
      assert.equal(
        await f.stages.loadMediaInputStageAdmission(f.locator),
        null,
      );
    },
  );
  test(
    `${backend} withdrawn media-input stage authority rolls back original Turn and immutable stage together`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputStageFixture(t, backend),
        before = await f.counts();
      f.state.transactionChecks = 0;
      f.state.withdrawAfterChecks = 1;
      await assert.rejects(f.commit(f.input, f.options));
      assert.deepEqual(await f.counts(), before);
      assert.equal(
        await f.stages.loadMediaInputStageAdmission(f.locator),
        null,
      );
    },
  );
  test(
    `${backend} media-input scope refuses a revoked original conversation binding`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputStageFixture(t, backend);
      await f.store.commitBinding(f.mutate(f.prepared.binding, "set-state"), {
        authority: {
          ...f.authority,
          version: "crewon.project-conversation-commit.v1",
        },
      });
      const before = await f.counts();
      await assert.rejects(
        f.commit(f.input, f.options),
        hasAssetCause("project_media_input_stage_binding_conflict"),
      );
      assert.deepEqual(await f.counts(), before);
    },
  );
}
