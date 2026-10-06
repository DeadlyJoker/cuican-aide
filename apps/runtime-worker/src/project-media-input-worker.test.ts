import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { mediaInputWorkerFixture } from "./project-media-input-worker.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { deferred } from "./runtime-store-access.test-support.ts";
import { captureInstalledPluginProjectMediaInputToolsConfig } from "./plugins/installed-plugin-project-media-input-tools.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: actual Short23 Agent/Worker prepares shared media input through all six methods and streams the original Run`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaInputWorkerFixture(t, backend, kind),
          opened = await f.open();
        const outcome = await opened.worker.wake();
        assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
        assert.equal((await f.parent.loadRun(f.locator))?.status, "completed");
        const context = f.state.observed.get("getContext"),
          save = f.state.observed.get("saveInput");
        assert.equal(context.projectId, f.binding.projectId);
        assert.equal(context.threadId, f.binding.threadId);
        assert.equal(context.workspaceId, f.binding.workspaceId);
        assert.equal(context.bindingRevision, f.binding.revision);
        assert.equal(save.disposition, "committed");
        assert.equal(
          f.state.observed.get("getInput").state.input.inputRevision,
          1,
        );
        assert.equal(f.state.observed.get("readPrompt").text, f.request.prompt);
        assert.equal(f.state.observed.get("listInputs").inputs.length, 1);
        assert.deepEqual(
          await f.stages.loadMediaInputStageAdmission(f.locator),
          f.stage,
        );
        const events = await f.parent.listRunEvents(f.locator, 0, 200);
        assert.equal(
          events.filter((e) => e.type === "tool.completed").length,
          6,
        );
        assert.equal(
          events.filter((e) => e.type === "model.output.delta").length,
          2,
        );
        const manual = await f.app.saveInput(f.actor, {
          ...(kind === "T10" ? f.command : f.d18Command),
          mediaInputId: save.input.mediaInputId,
          expectedInputRevision: 1,
          prompt: "手动调整后的输入",
          idempotencyKey: "manual-after-actual-agent",
        });
        assert.equal(manual.input.inputRevision, 2);
        assert.equal(f.state.factories, 1);
        assert.equal(f.state.projectServiceCalls, 0);
        assert.equal(f.state.requests.length, 7);
        assert.equal(f.materialState.sourceGets, 0);
        assert.equal(f.materialState.uploads, 0);
        assert.equal(f.state.mode, "normal");
        await opened.close();
      },
    );

  test(
    `${backend}: a cold genuine Worker reconciles a committed input after lost Tool ACK without overwriting later manual input`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputWorkerFixture(t, backend),
        first = await f.open(f, {
          afterToolProviderResolved: async (resolution) => {
            if (
              "result" in resolution &&
              resolution.result?.callId === "saveInput"
            )
              throw Error("named_after_input_commit");
          },
        });
      const interrupted = await first.worker.wake();
      assert.equal(interrupted.kind, "retried", JSON.stringify(interrupted));
      const inputs = await f.app.listInputs(f.actor, {
        projectId: f.request.projectId,
        afterMediaInputId: null,
        limit: 4,
      });
      assert.equal(inputs.inputs.length, 1);
      const id = inputs.inputs[0]!.mediaInputId;
      await first.close();
      await f.app.saveInput(f.actor, {
        ...f.command,
        mediaInputId: id,
        expectedInputRevision: 1,
        prompt: "manual newer head",
        idempotencyKey: "manual-after-lost-ack",
      });
      const before = await f.countMedia(),
        cold = await f.cold(),
        second = await f.open({ ...f, ...cold });
      const resumed = await second.worker.wake();
      assert.equal(resumed.kind, "completed", JSON.stringify(resumed));
      assert.deepEqual(await f.countMedia(), before);
      assert.equal(f.state.observed.get("saveInput").disposition, "replayed");
      assert.equal(f.state.observed.get("saveInput").input.inputRevision, 1);
      assert.equal(
        f.state.observed.get("listInputs").inputs[0].latestInputRevision,
        2,
      );
      assert.equal((await cold.parent.loadRun(f.locator))?.status, "completed");
      await second.close();
    },
  );

  for (const mode of [
    "absent",
    "denied",
    "foreign",
    "generation",
    "unscoped-write",
  ] as const)
    test(
      `${backend}: actual media-input Worker denies ${mode} without project input writes`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaInputWorkerFixture(t, backend);
        if (mode === "denied") f.state.service = false;
        if (mode !== "absent" && mode !== "denied") f.state.mode = mode;
        const before = await f.countMedia(),
          projects = await f.count("creative_projects");
        const opened = await f.open(
          f,
          {},
          mode === "absent" ? "absent" : "enabled",
        );
        const outcome = await opened.worker.wake();
        assert.notEqual(outcome.kind, "completed", JSON.stringify(outcome));
        assert.deepEqual(await f.countMedia(), before);
        assert.equal(await f.count("creative_projects"), projects);
        assert.equal(f.state.projectServiceCalls, 0);
        await opened.close();
      },
    );

  test(
    `${backend}: resolver shutdown withdraws and drains an actual held media-input host call`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputWorkerFixture(t, backend),
        opened = await f.open(),
        entered = deferred(),
        held = deferred();
      f.state.beforeService = async () => {
        entered.resolve();
        await held.promise;
      };
      const wake = opened.worker.wake();
      let closing: Promise<void> | undefined;
      try {
        await entered.promise;
        closing = opened.resolver.close!();
        let finished = false;
        void closing.then(() => {
          finished = true;
        });
        await setImmediate();
        assert.equal(finished, false);
      } finally {
        held.resolve();
        await wake;
        await closing;
        await opened.close();
      }
      assert.equal(
        (
          await f.app.listInputs(f.actor, {
            projectId: f.request.projectId,
            afterMediaInputId: null,
            limit: 4,
          })
        ).inputs.length,
        0,
      );
    },
  );
}

test("media-input deployment captures data properties and independent service authorization", () => {
  let reads = 0;
  const raw = {
    version: "crewon.project-media-input-tools.v1",
    createInputs: () => ({}),
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    authorizeService: async () => {},
  };
  Object.defineProperty(raw, "createInputs", {
    enumerable: true,
    get: () => {
      reads++;
      return () => ({});
    },
  });
  assert.throws(() =>
    captureInstalledPluginProjectMediaInputToolsConfig(raw as never),
  );
  assert.equal(reads, 0);
  assert.throws(() =>
    captureInstalledPluginProjectMediaInputToolsConfig(
      new Proxy(raw, {}) as never,
    ),
  );
});
