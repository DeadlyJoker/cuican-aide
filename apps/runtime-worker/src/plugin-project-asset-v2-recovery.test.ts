import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_ASSET_V2_ACTIONS } from "@crewon/contracts/project-assets-v2";
import type { ProjectAssetV2RecoveryStore } from "@crewon/application";
import { assetV2UiFixture as fixture } from "./plugin-project-asset-v2.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { observeMaterialPreparationSql } from "../../../packages/store/src/project-material-preparation.test-support.ts";
type Ui = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["createUi"]>>;
async function pending(ui: Ui) {
  const r = await ui.recover("getPending");
  assert.ok("intent" in r);
  return r.intent;
}
async function ack(ui: Ui) {
  const r = await pending(ui);
  assert.ok(r && r.phase !== "pending");
  const q = { intentId: r.intentId, expectedRevision: r.revision };
  const accepted = await ui.recover("acknowledge", q);
  assert.ok("disposition" in accepted);
  assert.equal(accepted.disposition, "acknowledged");
  assert.deepEqual(await ui.recover("acknowledge", q), {
    ...accepted,
    disposition: "replayed",
  });
  assert.equal(await pending(ui), null);
}
function crashingJournal(journal: ProjectAssetV2RecoveryStore) {
  return {
    migrate: () => journal.migrate(),
    getPending: journal.getPending.bind(journal),
    loadIntent: journal.loadIntent.bind(journal),
    cancelPending: journal.cancelPending.bind(journal),
    acknowledge: journal.acknowledge.bind(journal),
    stage: async (
      ...args: Parameters<ProjectAssetV2RecoveryStore["stage"]>
    ) => {
      await journal.stage(...args);
      throw new Error("named_crash_after_durable_stage");
    },
  };
}
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: actual V2 UI journals all six writes and recovers a lost adoption reply without media IO`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      let ui = await f.createUi({ recovery: true });
      const io = [f.state.gets, ...f.materialCounts()],
        runs = await f.countRuns();
      f.uiState.dropReply = true;
      await assert.rejects(
        ui.invoke("adoptMediaReference", f.write.request.query),
        (e) =>
          e instanceof Error &&
          e.cause instanceof Error &&
          e.cause.message === "named_v2_reply_lost",
      );
      f.uiState.dropReply = false;
      await ui.owner.close();
      const cold = await f.cold();
      ui = await f.createUi({
        recovery: true,
        journal: cold.parent.projectAssetV2RecoveryStore(),
      });
      const recovered = await pending(ui);
      assert.equal(recovered?.phase, "accepted");
      assert.equal(
        recovered.request.action,
        PROJECT_ASSET_V2_ACTIONS.adoptMediaReference,
      );
      const replay = await ui.invoke(
        "adoptMediaReference",
        f.write.request.query,
      );
      assert.ok("disposition" in replay);
      assert.equal(replay.disposition, "replayed");
      assert.equal(await f.receipts(), 1);
      await ack(ui);
      const scope = {
        projectId: f.query.projectId,
        assetId: f.old.asset.assetId,
      };
      let revision = replay.asset.revision;
      const mutate = async (
        method:
          | "saveCandidate"
          | "selectRevision"
          | "setLocked"
          | "saveReferenceCandidate"
          | "selectReference",
        request: object,
      ) => {
        const input = {
          ...scope,
          request: { expectedAssetRevision: revision, ...request },
          idempotencyKey: `recover-${method}-${revision}`,
        };
        const r = await ui.invoke(method, input);
        assert.ok("kind" in r);
        revision = r.asset.revision;
        const saved = await pending(ui);
        assert.equal(saved?.phase, "accepted");
        assert.deepEqual(saved.request, {
          action: PROJECT_ASSET_V2_ACTIONS[method],
          input,
        });
        assert.equal(saved.confirmed.assetRevision, revision);
        const cancel = await ui.recover("cancelPending", {
          intentId: saved.intentId,
          expectedRevision: 1,
        });
        assert.ok("intent" in cancel);
        assert.deepEqual(cancel.intent, saved);
        await ack(ui);
        return r;
      };
      await mutate("setLocked", { locked: false });
      await mutate("selectReference", {
        referenceRevision: f.old.reference.referenceRevision,
      });
      await mutate("saveCandidate", {
        kind: "character",
        briefRevision: f.old.content.brief.briefRevision,
        script: null,
        content: {
          ...f.old.content.content,
          setting: "Recovery character update",
        },
      });
      await mutate("selectRevision", {
        contentRevision: f.old.content.contentRevision,
      });
      const origin = f.old.reference.source;
      assert.ok("conceptAssetId" in origin);
      const selection = await f.selectionStore.loadCurrentConceptSelection({
        owner: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        },
        projectId: scope.projectId,
        assetId: origin.conceptAssetId,
      });
      assert.ok(selection);
      await mutate("saveReferenceCandidate", {
        assetContentRevision: f.old.content.contentRevision,
        conceptAssetId: origin.conceptAssetId,
        selectionRevision: selection.selectionRevision,
      });
      assert.deepEqual([f.state.gets, ...f.materialCounts()], io);
      assert.deepEqual(await f.countRuns(), runs);
    },
  );
  test(
    `${backend}: durable staged request survives remount, blocks bypass, cancels permanently, and frees its slot only after ACK`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        j = f.parent.projectAssetV2RecoveryStore(),
        crash = await f.createUi({
          recovery: true,
          journal: crashingJournal(j),
        });
      const scope = {
        projectId: f.query.projectId,
        assetId: f.old.asset.assetId,
      };
      const input = {
        ...scope,
        request: { expectedAssetRevision: f.old.asset.revision, locked: true },
        idempotencyKey: "cancel-pending-lock",
      };
      await assert.rejects(
        crash.invoke("setLocked", input),
        (e) =>
          e instanceof Error &&
          e.cause instanceof Error &&
          e.cause.message === "named_crash_after_durable_stage",
      );
      await crash.owner.close();
      const cold = await f.cold(),
        ui = await f.createUi({
          recovery: true,
          journal: cold.parent.projectAssetV2RecoveryStore(),
        });
      const staged = await pending(ui);
      assert.equal(staged?.phase, "pending");
      await assert.rejects(
        f.assets.setLocked(f.actor, {
          ...input.request,
          ...scope,
          idempotencyKey: input.idempotencyKey,
        }),
      );
      await assert.rejects(
        ui.recover("acknowledge", {
          intentId: staged.intentId,
          expectedRevision: 1,
        }),
      );
      await assert.rejects(
        ui.invoke("setLocked", { ...input, idempotencyKey: "another-write" }),
      );
      f.uiState.recoveryAllowed = false;
      await assert.rejects(ui.recover("getPending"));
      await assert.rejects(
        ui.recover("cancelPending", {
          intentId: staged.intentId,
          expectedRevision: 1,
        }),
      );
      f.uiState.recoveryAllowed = true;
      const cancelled = await ui.recover("cancelPending", {
        intentId: staged.intentId,
        expectedRevision: 1,
      });
      assert.ok("intent" in cancelled);
      assert.equal(cancelled.intent?.phase, "cancelled");
      await assert.rejects(ui.invoke("setLocked", input));
      await ack(ui);
      await assert.rejects(ui.invoke("setLocked", input));
      assert.equal(
        (await f.assets.getAsset(f.actor, scope))!.asset.revision,
        f.old.asset.revision,
      );
      await ui.invoke("setLocked", {
        ...input,
        idempotencyKey: "next-independent-write",
      });
      await ack(ui);
      assert.ok(f.uiState.recoveryProjects.every((p) => p === scope.projectId));
    },
  );
  test(
    `${backend}: adoption cancellation blocks unqualified replay and metadata+journal rollback is atomic`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        j = f.parent.projectAssetV2RecoveryStore(),
        crash = await f.createUi({
          recovery: true,
          journal: crashingJournal(j),
        });
      await assert.rejects(
        crash.invoke("adoptMediaReference", f.write.request.query),
      );
      await crash.owner.close();
      const ui = await f.createUi({ recovery: true }),
        staged = await pending(ui);
      assert.equal(staged?.phase, "pending");
      await assert.rejects(f.adopt());
      await ui.recover("cancelPending", {
        intentId: staged.intentId,
        expectedRevision: 1,
      });
      await ack(ui);
      await assert.rejects(f.adopt());
      assert.equal(await f.receipts(), 0);
      const input = {
        ...f.write.request.query,
        idempotencyKey: "adopt-atomic",
      };
      let injected = false;
      const restore = observeMaterialPreparationSql(
        backend,
        /UPDATE .*project_asset_versioned_intents SET revision/u,
        () => {
          injected = true;
          throw new Error("named_crash_before_journal_commit");
        },
      );
      try {
        await assert.rejects(ui.invoke("adoptMediaReference", input));
      } finally {
        restore();
      }
      assert.equal(injected, true);
      assert.equal(await f.receipts(), 0);
      assert.equal((await pending(ui))?.phase, "pending");
      const result = await ui.invoke("adoptMediaReference", input);
      assert.ok("disposition" in result);
      assert.equal(result.disposition, "committed");
      assert.equal(await f.receipts(), 1);
      await ack(ui);
    },
  );
}
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: cancel wins against an in-flight staged write and terminal metadata survives late permission withdrawal`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        j = f.parent.projectAssetV2RecoveryStore();
      let staged!: () => void, release!: () => void;
      const reached = new Promise<void>((r) => {
          staged = r;
        }),
        gate = new Promise<void>((r) => {
          release = r;
        });
      const journal: ProjectAssetV2RecoveryStore = {
        ...crashingJournal(j),
        stage: async (...args) => {
          const r = await j.stage(...args);
          staged();
          await gate;
          return r;
        },
      };
      const writing = await f.createUi({ recovery: true, journal }),
        recovering = await f.createUi({ recovery: true });
      const input = {
        projectId: f.query.projectId,
        assetId: f.old.asset.assetId,
        request: { expectedAssetRevision: f.old.asset.revision, locked: true },
        idempotencyKey: "in-flight-cancellation",
      };
      const operation = writing.invoke("setLocked", input);
      const failed = assert.rejects(operation);
      try {
        await reached;
        const intent = await pending(recovering);
        assert.equal(intent?.phase, "pending");
        f.uiState.afterResult = () => {
          f.uiState.allowed = false;
        };
        const cancelled = await recovering.recover("cancelPending", {
          intentId: intent.intentId,
          expectedRevision: 1,
        });
        assert.ok("intent" in cancelled);
        assert.equal(cancelled.intent?.phase, "cancelled");
        f.uiState.afterResult = null;
        f.uiState.allowed = true;
      } finally {
        release();
      }
      await failed;
      assert.equal(
        (await f.assets.getAsset(f.actor, {
          projectId: input.projectId,
          assetId: input.assetId,
        }))!.asset.revision,
        f.old.asset.revision,
      );
      await ack(recovering);
    },
  );
}
