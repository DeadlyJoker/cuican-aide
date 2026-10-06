import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createProjectConversationBinding } from "@crewon/domain";
import {
  mediaInputWorkerFixture,
  wakeMediaInputStage,
} from "./project-media-input-worker.test-support.ts";
import {
  mediaInputDiscoveryModel,
  mediaInputReadProbe,
} from "./project-media-input-discovery-model.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { deferred } from "./runtime-store-access.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: actual Agent discovers original text/assets and derives confirmed input from real adopted reference revisions`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaInputWorkerFixture(t, backend, kind, {
            transport: mediaInputDiscoveryModel(),
            maxToolRounds: 32,
          }),
          opened = await f.open();
        const result = await wakeMediaInputStage(
          opened.worker,
          f.locator.runId,
        );
        assert.equal(result.kind, "completed", JSON.stringify(result));
        const saved = f.state.observed.get("saveInput");
        assert.equal(saved.disposition, "committed");
        const original = await f.app.loadInput(f.actor, {
          projectId: f.binding.projectId,
          mediaInputId: saved.input.mediaInputId,
          inputRevision: 1,
        });
        assert.ok(original);
        assert.equal(
          original.input.workflow.workflowId,
          f.stage.stage.workflowId,
        );
        assert.equal(
          original.input.brief.briefRevision,
          f.stage.stage.briefRevision,
        );
        assert.equal(original.input.references.length, kind === "T10" ? 1 : 3);
        for (const r of original.input.references) {
          const q = r.preparation.source.query;
          const actual = f.state.observed.get(`asset-${q.assetId}`).view;
          assert.equal(q.projectId, f.binding.projectId);
          assert.equal(q.expectedAssetRevision, actual.asset.revision);
          assert.equal(q.contentRevision, actual.asset.selectedContentRevision);
          assert.equal(
            q.referenceRevision,
            actual.asset.selectedReferenceRevision,
          );
          assert.equal(actual.referenceState, "current");
        }
        assert.ok(f.state.observed.has("project"));
        assert.ok(f.state.observed.has("outline"));
        assert.ok(f.state.observed.has("brief-0"));
        assert.ok(
          f.state.observed.has("list-character-1"),
          "Actual pagination must be used",
        );
        assert.ok(f.state.observed.has("asset-history"));
        if (kind === "D18") {
          assert.ok(f.state.observed.has("script-text-0"));
          assert.ok(f.state.observed.has("text-history"));
          assert.ok(f.state.observed.has("list-scene-0"));
        }
        assert.ok(
          f.state.projectServiceCalls > 0 && f.state.assetServiceCalls > 0,
        );
        const events = await f.parent.listRunEvents(f.locator, 0, 400);
        assert.equal(
          events.filter((e) => e.type === "model.output.delta").length,
          2,
        );
        assert.ok(
          events.filter((e) => e.type === "tool.completed").length > 12,
        );
        for (const request of f.state.requests)
          for (const item of request.input.items)
            if (item.type === "tool_result")
              assert.ok(Buffer.byteLength(item.output) <= 8192);
        assert.equal(f.materialState.sourceGets, 0);
        assert.equal(f.materialState.uploads, 0);
        await opened.close();
      },
    );

  test(
    `${backend}: cold Worker resumes discovered input after lost save ACK and preserves manually appended revision`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputWorkerFixture(t, backend, "D18", {
        transport: mediaInputDiscoveryModel(),
        maxToolRounds: 32,
      });
      const first = await f.open(f, {
        afterToolProviderResolved: async (r) => {
          if ("result" in r && r.result?.callId === "saveInput")
            throw Error("named_discovery_save_ack_loss");
        },
      });
      const interrupted = await wakeMediaInputStage(
        first.worker,
        f.locator.runId,
      );
      assert.equal(interrupted.kind, "retried", JSON.stringify(interrupted));
      const list = await f.app.listInputs(f.actor, {
        projectId: f.request.projectId,
        afterMediaInputId: null,
        limit: 4,
      });
      assert.equal(list.inputs.length, 1);
      const id = list.inputs[0]!.mediaInputId;
      await first.close();
      await f.app.saveInput(f.actor, {
        ...f.d18Command,
        mediaInputId: id,
        expectedInputRevision: 1,
        prompt: "manual after discovered input",
        idempotencyKey: "manual-discovery-head",
      });
      const before = await f.countMedia(),
        cold = await f.cold(),
        second = await f.open({ ...f, ...cold });
      const resumed = await wakeMediaInputStage(second.worker, f.locator.runId);
      assert.equal(resumed.kind, "completed", JSON.stringify(resumed));
      assert.deepEqual(await f.countMedia(), before);
      assert.equal(f.state.observed.get("saveInput").disposition, "replayed");
      assert.equal(f.state.observed.get("saveInput").input.inputRevision, 1);
      assert.equal(
        f.state.observed.get("listInputs").inputs[0].latestInputRevision,
        2,
      );
      await second.close();
    },
  );

  for (const operation of [
    "project_read",
    "asset_list",
    "project_list",
    "asset_save",
    "asset_context_read",
  ])
    test(
      `${backend}: media-input discovery refuses out-of-scope ${operation} even when all ordinary services are deployed`,
      assetTestOptions(backend),
      async (t) => {
        const probe = mediaInputReadProbe(operation, (s) =>
          operation === "project_read"
            ? { projectId: "foreign-project" }
            : operation === "asset_list"
              ? {
                  projectId: "foreign-project",
                  kind: "character",
                  afterAssetId: null,
                  limit: 1,
                }
              : operation === "project_list"
                ? { state: "all", limit: 1 }
                : operation === "asset_save"
                  ? {
                      projectId: s.projectId,
                      assetId: null,
                      kind: "character",
                      expectedAssetRevision: 0,
                      briefRevision: s.briefRevision,
                      script: null,
                      contentJson: JSON.stringify({
                        name: "forbidden",
                        setting: "forbidden",
                        visualPrompt: "forbidden",
                      }),
                    }
                  : {},
        );
        const f = await mediaInputWorkerFixture(t, backend, "T10", {
            transport: probe,
          }),
          before = await f.countMedia(),
          assets = await f.count("project_assets"),
          opened = await f.open();
        const outcome = await opened.worker.wake();
        assert.notEqual(outcome.kind, "completed", JSON.stringify(outcome));
        assert.equal(f.state.observed.has("probe"), false);
        assert.deepEqual(await f.countMedia(), before);
        assert.equal(await f.count("project_assets"), assets);
        await opened.close();
      },
    );

  for (const grant of ["service", "projectRead", "assetRead"] as const)
    test(
      `${backend}: ${grant} withdrawal after context refuses the original bounded read`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaInputWorkerFixture(t, backend, "T10", {
          transport: mediaInputReadProbe("asset_list", (s) => ({
            projectId: s.projectId,
            kind: "character",
            afterAssetId: null,
            limit: 1,
          })),
        });
        const opened = await f.open(f, {
          afterToolProviderResolved: async (r) => {
            if ("result" in r && r.result?.callId === "getContext")
              f.state[grant] = false;
          },
        });
        const outcome = await opened.worker.wake();
        assert.notEqual(outcome.kind, "completed", JSON.stringify(outcome));
        assert.equal(f.state.observed.has("probe"), false);
        await opened.close();
      },
    );

  test(
    `${backend}: withdrawal of asset read grant after the application read suppresses its result`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputWorkerFixture(t, backend, "T10", {
        transport: mediaInputReadProbe("asset_list", (s) => ({
          projectId: s.projectId,
          kind: "character",
          afterAssetId: null,
          limit: 1,
        })),
      });
      f.state.beforeAssetService = async () => {
        if (f.state.assetServiceCalls === 3) f.state.assetRead = false;
      };
      const opened = await f.open(),
        outcome = await opened.worker.wake();
      assert.notEqual(outcome.kind, "completed", JSON.stringify(outcome));
      assert.equal(f.state.assetServiceCalls, 3);
      assert.equal(f.state.observed.has("probe"), false);
      await opened.close();
    },
  );

  test(
    `${backend}: native conversation revocation during a real read suppresses its late result`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputWorkerFixture(t, backend, "T10", {
        transport: mediaInputReadProbe("asset_list", (s) => ({
          projectId: s.projectId,
          kind: "character",
          afterAssetId: null,
          limit: 1,
        })),
      });
      f.state.beforeAssetService = async () => {
        f.state.beforeAssetService = null;
        const { schemaVersion: _s, contentDigest: _d, ...binding } = f.binding;
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
              idempotencyKey: "read-binding-revoke",
              requestDigest: f.digester.sha256("read-binding-revoke"),
            },
          },
          {
            authority: {
              version: "crewon.project-conversation-commit.v1",
              actor: f.actor,
              installation: f.materialTarget.installation,
              pin: f.pin,
              selection: f.materialTarget.selection,
              package: f.materialTarget.package,
              assertCurrent: f.current,
              assertTransactionCurrent: f.current,
              assertActive: f.active,
            },
          },
        );
      };
      const opened = await f.open(),
        outcome = await opened.worker.wake();
      assert.notEqual(outcome.kind, "completed", JSON.stringify(outcome));
      assert.equal(f.state.observed.has("probe"), false);
      assert.equal(
        (
          await f.conversations.loadBinding({
            actor: f.actor,
            profileId: f.pin.profileId,
            threadId: f.binding.threadId,
          })
        )?.state,
        "revoked",
      );
      await opened.close();
    },
  );

  test(
    `${backend}: composition shutdown joins both owners during an actual asset read`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputWorkerFixture(t, backend, "T10", {
        transport: mediaInputReadProbe("asset_list", (s) => ({
          projectId: s.projectId,
          kind: "character",
          afterAssetId: null,
          limit: 1,
        })),
      });
      const held = deferred(),
        entered = deferred();
      f.state.beforeAssetService = async () => {
        entered.resolve();
        await held.promise;
      };
      const opened = await f.open(),
        wake = opened.worker.wake();
      let closing: Promise<void> | undefined;
      try {
        await entered.promise;
        closing = opened.resolver.close!();
        let done = false;
        void closing.then(() => {
          done = true;
        });
        await setImmediate();
        assert.equal(done, false);
      } finally {
        held.resolve();
        await wake;
        await closing;
        await opened.close();
      }
      assert.equal(f.state.observed.has("probe"), false);
    },
  );
}
