import assert from "node:assert/strict";
import test from "node:test";
import {
  mediaInputWorkerFixture,
  wakeMediaInputStage,
} from "../../runtime-worker/src/project-media-input-worker.test-support.ts";
import { mediaInputDiscoveryModel } from "../../runtime-worker/src/project-media-input-discovery-model.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import {
  publicMediaStageFixture,
  mediaStageHeaders,
} from "./project-media-input-stage.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: public stage admission drives actual installed Agent discovery/stream and manual handoff`,
      assetTestOptions(backend),
      async (t) => {
        let route!: Awaited<ReturnType<typeof publicMediaStageFixture>>;
        const f = await mediaInputWorkerFixture(t, backend, kind, {
          transport: mediaInputDiscoveryModel(),
          maxToolRounds: 32,
          admitStage: async (input) => {
            route = await publicMediaStageFixture(t, input);
            const before = await input.fixture.countRuns();
            const availability = await route.get();
            assert.equal(availability.statusCode, 200, availability.body);
            assert.deepEqual(availability.json(), { available: true });
            assert.equal(route.state.prepares, 0);
            assert.deepEqual(await input.fixture.countRuns(), before);
            const first = await route.post();
            assert.equal(first.statusCode, 201, first.body);
            assert.equal(first.json().threadRevision, 2);
            const replay = await route.post();
            assert.equal(replay.statusCode, 200, replay.body);
            assert.equal(replay.json().runId, first.json().runId);
            assert.equal(route.state.wakes, 2);
            return route.admitted();
          },
        });
        const opened = await f.open();
        const done = await wakeMediaInputStage(opened.worker, f.locator.runId);
        assert.equal(done.kind, "completed", JSON.stringify(done));
        const saved = f.state.observed.get("saveInput");
        assert.equal(saved.disposition, "committed");
        const original = await f.app.loadInput(f.actor, {
          projectId: f.binding.projectId,
          mediaInputId: saved.input.mediaInputId,
          inputRevision: 1,
        });
        assert.ok(original);
        const manual = await f.app.saveInput(f.actor, {
          ...(kind === "T10" ? f.command : f.d18Command),
          mediaInputId: saved.input.mediaInputId,
          item: original.input.item,
          references: Object.fromEntries(
            original.input.references.map((r) => [
              r.role,
              r.preparation.source.query,
            ]),
          ),
          expectedInputRevision: 1,
          prompt: "工作台手动修改，留待后续生成",
          idempotencyKey: "manual-after-public-agent",
        });
        assert.equal(manual.input.inputRevision, 2);
        const events = await f.parent.listRunEvents(f.locator, 0, 400);
        assert.equal(
          events.filter((e) => e.type === "model.output.delta").length,
          2,
        );
        assert.equal(f.stage.threadId, route.request.threadId);
        assert.equal(f.stage.workspaceId, "media-original-workspace");
        const latest = await f.app.loadInput(f.actor, {
          projectId: route.request.projectId,
          mediaInputId: saved.input.mediaInputId,
          inputRevision: null,
        });
        assert.equal(latest?.input.inputRevision, 2);
        assert.equal(f.materialState.sourceGets, 0);
        assert.equal(f.materialState.uploads, 0);
        await opened.close();
      },
    );
  test(
    `${backend}: public stage rejects malformed/foreign/stale requests and independent authority withdrawal before committing`,
    assetTestOptions(backend),
    async (t) => {
      await mediaInputWorkerFixture(t, backend, "D18", {
        admitStage: async (input) => {
          const r = await publicMediaStageFixture(t, input),
            before = await input.fixture.countRuns();
          for (const field of [
            "project",
            "ui",
            "package",
            "identity",
          ] as const) {
            r.state[field] = false;
            const denied = await r.post();
            assert.equal(denied.statusCode, 403, denied.body);
            r.state[field] = true;
          }
          for (const [body, status] of [
            [{ ...r.request, threadId: "other" }, 400],
            [{ ...r.request, projectId: "foreign-project" }, 403],
            [
              { ...r.request, stage: { ...r.request.stage, script: null } },
              400,
            ],
            [
              {
                ...r.request,
                stage: { ...r.request.stage, configurationRevision: 1 },
              },
              409,
            ],
            [
              { ...r.request, stage: { ...r.request.stage, briefRevision: 2 } },
              409,
            ],
            [
              {
                ...r.request,
                stage: {
                  ...r.request.stage,
                  script: { ...r.request.stage.script!, contentRevision: 2 },
                },
              },
              409,
            ],
            [{ ...r.request, expectedBindingRevision: 2 }, 409],
            [{ ...r.request, actor: input.fixture.actor }, 400],
          ] as const) {
            const result = await r.post(body);
            assert.equal(result.statusCode, status, result.body);
          }
          const mismatch = await r.post(r.request, "wrong-key");
          assert.equal(mismatch.statusCode, 400, mismatch.body);
          const csrf = await r.app.inject({
            method: "POST",
            url: r.url,
            headers: { ...mediaStageHeaders(), "x-csrf-token": "wrong" },
            payload: r.request,
          });
          assert.equal(csrf.statusCode, 403, csrf.body);
          assert.deepEqual(await input.fixture.countRuns(), before);
          assert.equal(r.state.wakes, 0);
          const created = await r.post();
          assert.equal(created.statusCode, 201, created.body);
          const changed = await r.post({
            ...r.request,
            content: "新请求不能借用旧键",
          });
          assert.equal(changed.statusCode, 409, changed.body);
          assert.equal(r.state.wakes, 1);
          await r.owner.close();
          assert.equal((await r.post()).statusCode, 409);
          assert.equal(r.state.wakes, 1);
          return r.admitted();
        },
      });
    },
  );
  test(
    `${backend}: lost HTTP receipt replays original stage and cold Worker preserves manual revision after lost tool ACK`,
    assetTestOptions(backend),
    async (t) => {
      let r!: Awaited<ReturnType<typeof publicMediaStageFixture>>;
      const f = await mediaInputWorkerFixture(t, backend, "D18", {
        transport: mediaInputDiscoveryModel(),
        maxToolRounds: 32,
        admitStage: async (input) => {
          r = await publicMediaStageFixture(t, input);
          const result = await r.post();
          assert.equal(result.statusCode, 201, result.body);
          return r.admitted();
        },
      });
      const first = await f.open(f, {
        afterToolProviderResolved: async (value) => {
          if ("result" in value && value.result?.callId === "saveInput")
            throw Error("named_public_stage_save_ack_lost");
        },
      });
      assert.equal(
        (await wakeMediaInputStage(first.worker, f.locator.runId)).kind,
        "retried",
      );
      await first.close();
      const list = await f.app.listInputs(f.actor, {
        projectId: f.binding.projectId,
        afterMediaInputId: null,
        limit: 4,
      });
      assert.equal(list.inputs.length, 1);
      const id = list.inputs[0]!.mediaInputId;
      await f.app.saveInput(f.actor, {
        ...f.d18Command,
        mediaInputId: id,
        expectedInputRevision: 1,
        prompt: "手动的新版本",
        idempotencyKey: "public-recovery-manual",
      });
      const replay = await r.post();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().runId, f.locator.runId);
      assert.equal(replay.json().stageAdmissionDigest, f.stage.contentDigest);
      const before = await f.countMedia(),
        cold = await f.cold(),
        second = await f.open({ ...f, ...cold });
      assert.equal(
        (await wakeMediaInputStage(second.worker, f.locator.runId)).kind,
        "completed",
      );
      assert.deepEqual(await f.countMedia(), before);
      assert.equal(f.state.observed.get("saveInput").input.inputRevision, 1);
      assert.equal(f.state.observed.get("saveInput").disposition, "replayed");
      assert.equal(
        f.state.observed.get("listInputs").inputs[0].latestInputRevision,
        2,
      );
      await second.close();
    },
  );
}
