import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { mediaInputToolsOwnerFixture } from "./project-media-input-tools-owner.test-support.ts";
import { observeMaterialPreparationSql } from "../../../packages/store/src/project-material-preparation.test-support.ts";
import { deferred } from "./plugin-tool-runtime-adapter.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: issued Worker service saves shared inputs, manual follow-up and cold replay preserve original prompt`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaInputToolsOwnerFixture(t, backend, kind),
          owner = f.owner(),
          s = f.service(owner);
        const context = await f.prepareTool("getContext", {});
        const scope = await f.invoke(owner, context, (command) =>
          s.getContext({ command, request: {} }),
        );
        assert.equal(scope.projectId, f.stage.projectId);
        assert.equal(scope.threadId, f.binding.threadId);
        assert.equal(scope.configurationRevision, 2);
        const request = { ...f.request, prompt: '\t🚀界"\\\n'.repeat(500) },
          op = await f.prepareTool("saveInput", request);
        const first = await f.invoke(owner, op, (command) =>
          s.saveInput({ command, request }),
        );
        assert.equal(first.disposition, "committed");
        assert.equal(Object.hasOwn(first.input, "prompt"), false);
        assert.ok(
          Buffer.byteLength(
            JSON.stringify({ resultJson: JSON.stringify(first) }),
          ) <= 8192,
        );
        const query = {
          projectId: first.input.projectId,
          mediaInputId: first.input.mediaInputId,
          inputRevision: null,
        };
        assert.equal(
          (await f.app.loadInput(f.actor, query))?.input.prompt,
          request.prompt,
        );
        const base = kind === "T10" ? f.command : f.d18Command;
        await f.app.saveInput(f.actor, {
          ...base,
          mediaInputId: first.input.mediaInputId,
          expectedInputRevision: 1,
          prompt: "Manual edit remains latest.",
          idempotencyKey: "owner-manual-followup",
        });
        await owner.close();
        const cold = f.owner({ inputs: (await f.cold()).app }),
          cs = f.service(cold);
        const replay = await f.invoke(cold, op, (command) =>
          cs.saveInput({ command, request }),
        );
        assert.equal(replay.disposition, "replayed");
        assert.deepEqual(replay.input, first.input);
        const read = await f.prepareTool("getInput", query),
          view = await f.invoke(cold, read, (command) =>
            cs.getInput({ command, request: query }),
          );
        assert.equal(view.state?.input.inputRevision, 2);
        let offset = 0,
          restored = "";
        for (let n = 0; n < 20; n++) {
          const q = { ...query, inputRevision: 1, offset },
            read = await f.prepareTool("readPrompt", q),
            page = await f.invoke(cold, read, (command) =>
              cs.readPrompt({ command, request: q }),
            );
          assert.ok(Buffer.byteLength(page.text) <= 2048);
          assert.ok(
            Buffer.byteLength(
              JSON.stringify({ resultJson: JSON.stringify(page) }),
            ) <= 8192,
          );
          restored += page.text;
          if (page.nextOffset === null) break;
          offset = page.nextOffset;
        }
        assert.equal(restored, request.prompt);
        const l = {
            projectId: query.projectId,
            afterMediaInputId: null,
            limit: 4,
          },
          list = await f.prepareTool("listInputs", l),
          page = await f.invoke(cold, list, (command) =>
            cs.listInputs({ command, request: l }),
          );
        assert.equal(page.inputs.length, 1);
        assert.equal(page.inputs[0]?.latestInputRevision, 2);
        assert.equal(f.state.sourceGets, 0);
        assert.equal(f.state.uploads, 0);
      },
    );
  test(
    `${backend} media input service refuses possession, copied dispatch, changed request, cross-project and missing independent grant`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputToolsOwnerFixture(t, backend),
        owner = f.owner(),
        s = f.service(owner),
        request = f.request,
        op = await f.prepareTool("saveInput", request),
        before = await f.countMedia();
      await assert.rejects(s.saveInput({ command: op.command, request }));
      await assert.rejects(
        f.invoke(owner, op, (command) => s.saveInput({ command, request }), {
          copied: true,
        }),
      );
      await assert.rejects(
        f.invoke(owner, op, (command) =>
          s.saveInput({
            command,
            request: { ...request, prompt: "substitution" },
          }),
        ),
      );
      f.ownerState.service = false;
      await assert.rejects(
        f.invoke(owner, op, (command) => s.saveInput({ command, request })),
      );
      f.ownerState.service = true;
      const q = {
          projectId: "foreign",
          mediaInputId: "foreign",
          inputRevision: null,
        },
        foreign = await f.prepareTool("getInput", q);
      let entered = false;
      await assert.rejects(
        f.invoke(owner, foreign, async () => {
          entered = true;
          return undefined;
        }),
      );
      assert.equal(entered, false);
      f.ownerState.actor = { ...f.actor, principalId: "foreign" };
      await assert.rejects(
        f.invoke(owner, op, (command) => s.saveInput({ command, request })),
      );
      assert.deepEqual(await f.countMedia(), before);
    },
  );
  test(
    `${backend} media input owner retirement joins physical SQL and rolls back before COMMIT`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputToolsOwnerFixture(t, backend),
        owner = f.owner(),
        s = f.service(owner),
        op = await f.prepareTool("saveInput", f.request),
        before = await f.countMedia();
      let observed = false,
        closing: Promise<void> | undefined;
      const restore = observeMaterialPreparationSql(
        backend,
        /INSERT INTO .*project_media_input_revisions/u,
        () => {
          observed = true;
          closing = owner.close();
        },
      );
      try {
        await assert.rejects(
          f.invoke(owner, op, (command) =>
            s.saveInput({ command, request: f.request }),
          ),
        );
      } finally {
        restore();
      }
      await closing;
      assert.equal(observed, true);
      assert.deepEqual(await f.countMedia(), before);
      assert.equal(owner.canRetire(), true);
    },
  );
  test(
    `${backend} closing media input owner waits for pending reads and rejects their late results`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputToolsOwnerFixture(t, backend),
        owner = f.owner(),
        s = f.service(owner),
        op = await f.prepareTool("getContext", {}),
        entered = deferred(),
        release = deferred();
      f.controls.beforeCurrent = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = f.invoke(owner, op, (command) =>
        s.getContext({ command, request: {} }),
      );
      const rejected = assert.rejects(pending);
      await entered.promise;
      let closed = false;
      const closing = owner.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      assert.equal(closed, false);
      release.resolve();
      await rejected;
      await closing;
      assert.equal(owner.canRetire(), true);
    },
  );
  test(
    `${backend} unknown original Tool result recovers with a new actual queue lease and rejects stale owner writes`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputToolsOwnerFixture(t, backend),
        owner = f.owner(),
        s = f.service(owner),
        op = await f.prepareTool("saveInput", f.request);
      const first = await f.invoke(owner, op, (command) =>
        s.saveInput({ command, request: f.request }),
      );
      const receipt = await f.parent.transitionToolExecution({
        ...f.locator,
        receiptId: op.receipt.receiptId,
        lease: f.lease,
        expectedRevision: op.receipt.revision,
        transition: {
          kind: "unknownOutcome",
          providerReceiptId: null,
          occurredAt: new Date().toISOString(),
        },
      });
      await f.parent.retryWorkItem({
        ...f.lease,
        retryAfterMs: 0,
        reasonCode: "named-media-input-owner-retired",
      });
      await owner.close();
      const cold = await f.cold();
      const claim = await cold.parent.claimNextWorkItem({
        ownerId: "new-media-input-worker",
        leaseId: "new-media-input-lease",
        leaseDurationMs: 300000,
      });
      assert.ok(claim);
      assert.equal(claim.workItem.runId, f.locator.runId);
      assert.ok(claim.lease.epoch > op.claim.lease.epoch);
      const lease = {
        workItemId: claim.workItem.workItemId,
        ownerId: claim.lease.ownerId,
        leaseId: claim.lease.leaseId,
        leaseEpoch: claim.lease.epoch,
      };
      await cold.parent.beginRunAttempt({
        ...f.locator,
        lease,
        stepId: receipt.stepId,
        attemptId: "new-media-input-attempt",
        kind: "tool",
        startedAt: new Date().toISOString(),
      });
      const next = f.owner({
          inputs: cold.app,
          runs: cold.parent,
          installations: cold.parent.pluginInstallationStore(),
          stages: cold.parent.projectMediaInputStageStore(),
          conversations: cold.parent.projectConversationStore(),
        }),
        ns = f.service(next),
        before = await f.countMedia();
      await assert.rejects(
        f.invoke(next, op, (command) =>
          ns.saveInput({ command, request: f.request }),
        ),
      );
      const recovered = {
        ...op,
        receipt,
        claim,
        command: {
          ...op.command,
          executionLease: {
            ...op.command.executionLease,
            leaseId: claim.lease.leaseId,
            leaseEpoch: claim.lease.epoch,
            expiresAt: claim.lease.expiresAt,
          },
        },
      };
      const result = await f.invoke(
        next,
        recovered,
        (command) => ns.saveInput({ command, request: f.request }),
        { method: "reconcile" },
      );
      assert.equal(result.disposition, "replayed");
      assert.deepEqual(result.input, first.input);
      assert.deepEqual(await f.countMedia(), before);
    },
  );
  test(
    `${backend} committed media input remains a known success when its owner is withdrawn just after native COMMIT`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputToolsOwnerFixture(t, backend),
        owner = f.owner(),
        s = f.service(owner),
        op = await f.prepareTool("saveInput", f.request);
      let inserted = false,
        observed = false,
        closing: Promise<void> | undefined;
      const restoreInsert = observeMaterialPreparationSql(
        backend,
        /INSERT INTO .*project_media_input_revisions/u,
        () => {
          inserted = true;
        },
      );
      const afterCommit = () => {
        if (inserted) {
          observed = true;
          closing = owner.close();
        }
      };
      const descriptor = Object.getOwnPropertyDescriptor(
        DatabaseSync.prototype,
        "exec",
      )!;
      const restoreCommit =
        backend === "postgres"
          ? observeMaterialPreparationSql(backend, /^COMMIT/u, afterCommit)
          : (() => {
              Object.defineProperty(DatabaseSync.prototype, "exec", {
                ...descriptor,
                value: function (this: DatabaseSync, sql: string) {
                  const result = Reflect.apply(descriptor.value, this, [sql]);
                  if (sql === "COMMIT") afterCommit();
                  return result;
                },
              });
              return () =>
                Object.defineProperty(
                  DatabaseSync.prototype,
                  "exec",
                  descriptor,
                );
            })();
      let result;
      try {
        result = await f.invoke(owner, op, (command) =>
          s.saveInput({ command, request: f.request }),
        );
      } finally {
        restoreCommit();
        restoreInsert();
      }
      await closing;
      assert.equal(observed, true);
      assert.equal(result.disposition, "committed");
      assert.equal(
        (
          await f.app.loadInput(f.actor, {
            projectId: result.input.projectId,
            mediaInputId: result.input.mediaInputId,
            inputRevision: 1,
          })
        )?.input.prompt,
        f.request.prompt,
      );
    },
  );
}
