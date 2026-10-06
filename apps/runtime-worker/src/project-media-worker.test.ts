import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { deferred } from "./runtime-store-access.test-support.ts";
import { mediaWorkerFixture } from "./project-media-worker.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import {
  captureInstalledPluginExecutionConfig,
  composeInstalledPluginRuntimeResolver,
} from "./plugins/installed-plugin-runtime-composition.ts";
import {
  captureInstalledPluginProjectMediaConfig,
  prepareInstalledPluginProjectMedia,
  preparedInstalledPluginMediaOwner,
} from "./plugins/installed-plugin-project-media-composition.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: genuine installed Agent factory and actual Worker execute admitted media and publish original project candidate`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaWorkerFixture(t, backend, kind),
          opened = await f.open(),
          before = await f.ext.loadProjectMediaGenerationContext({
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            runId: f.accepted.binding.runId,
          });
        const outcome = await opened.worker.wake();
        assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
        assert.equal(
          (await f.parent.loadRun(f.accepted.binding))?.status,
          "completed",
        );
        assert.equal(f.state.posts, 1);
        assert.equal(f.state.gets, 1);
        assert.deepEqual(
          await f.ext.loadProjectMediaGenerationContext({
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            runId: f.accepted.binding.runId,
          }),
          before,
        );
        const events = await f.parent.listRunEvents(f.accepted.binding, 0, 200);
        assert.ok(events.some((e) => e.type === "run.completed"));
        assert.equal(
          events.filter((e) => e.type === "tool.completed").length,
          2,
        );
        assert.ok(f.state.requests.length >= 3);
        const { result } = await f.publish();
        assert.equal(result.disposition, "created");
        assert.equal(
          result.candidate.frozen.source.projection.reference.executionId,
          f.task.reference.executionId,
        );
        assert.equal(
          result.candidate.frozen.source.projection.workflow.output.nodeId,
          kind === "T10" ? "129" : "17",
        );
        assert.equal(
          result.candidate.frozen.source.projection.request.query.runId,
          f.accepted.binding.runId,
        );
        await opened.close();
        assert.equal(f.state.materialFactories, f.state.materialCloses);
      },
    );
  test(
    `${backend}: actual Worker resumes a dispatched media Tool receipt after all old owners close without another POST or material preparation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaWorkerFixture(t, backend),
        first = await f.open(
          { ...f },
          {
            afterToolProviderResolved: async () => {
              throw new Error("named_after_actual_media_provider");
            },
          },
        );
      const interrupted = await first.worker.wake();
      assert.equal(interrupted.kind, "retried", JSON.stringify(interrupted));
      assert.equal(f.state.posts, 1, JSON.stringify(interrupted));
      assert.equal(
        (await f.parent.loadRun(f.accepted.binding))?.status,
        "running",
      );
      const before = [f.state.posts, f.state.gets, f.state.materialFactories],
        materialBefore = [
          f.materialState.sourceGets,
          f.materialState.uploads,
          f.materialState.targetGets,
        ];
      await first.close();
      await f.app.saveInput(f.actor, {
        ...f.command,
        mediaInputId: f.task.reference.mediaInputId,
        expectedInputRevision: 1,
        prompt: "new manual input after old supplier acceptance",
        idempotencyKey: "new-manual-media-head",
      });
      const cold = await f.cold();
      f.state.submit = false;
      const second = await f.open({ ...f, ...cold });
      assert.equal((await second.worker.wake()).kind, "completed");
      assert.equal(f.state.posts, before[0]);
      assert.equal(f.state.gets, before[1]! + 1);
      assert.deepEqual(
        [
          f.materialState.sourceGets,
          f.materialState.uploads,
          f.materialState.targetGets,
        ],
        materialBefore,
      );
      assert.equal(
        (await cold.parent.loadRun(f.accepted.binding))?.status,
        "completed",
      );
      const { result } = await f.publish({ ...f, ...cold });
      assert.equal(
        result.candidate.frozen.source.projection.reference.inputRevision,
        1,
      );
      await second.close();
      assert.equal(f.state.materialFactories, f.state.materialCloses);
    },
  );
  test(
    `${backend}: media resolver shutdown joins the actual held provider request before releasing its material owner`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaWorkerFixture(t, backend),
        opened = await f.open(),
        entered = deferred(),
        held = deferred();
      f.state.onHttp = async (r) => {
        if (r.method === "POST") {
          entered.resolve();
          await held.promise;
        }
      };
      const wake = opened.worker.wake();
      let closing: Promise<void> | undefined;
      try {
        await entered.promise;
        closing = opened.resolver.close!();
        assert.equal(opened.resolver.close!(), closing);
        let finished = false;
        void closing.then(() => {
          finished = true;
        });
        await setImmediate();
        assert.equal(finished, false);
        assert.equal(f.state.materialCloses, 0);
      } finally {
        held.resolve();
        await wake;
        await closing;
        await opened.close();
      }
      assert.equal(f.state.posts, 1);
      assert.equal(f.state.materialCloses, 1);
    },
  );
  test(
    `${backend}: invalid factory output and cancellation after asynchronous material preparation close only their owned resources`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaWorkerFixture(t, backend),
        opened = await f.open(),
        raw = opened.config.projectMedia!,
        controller = new AbortController();
      let releases = 0;
      await assert.rejects(
        prepareInstalledPluginProjectMedia({
          store: f.parent,
          extensions: f.ext,
          config: {
            ...raw,
            createMaterials: async () => ({
              materials: {} as never,
              close: async () => {
                releases++;
              },
            }),
          },
          signal: new AbortController().signal,
        }),
        /materials_invalid/u,
      );
      await assert.rejects(
        prepareInstalledPluginProjectMedia({
          store: f.parent,
          extensions: f.ext,
          config: {
            ...raw,
            createMaterials: async ({ store, signal }) => {
              assert.equal(store, f.parent);
              assert.equal(signal, controller.signal);
              controller.abort(new Error("named_preparation_aborted"));
              return {
                materials: f.materials,
                close: async () => {
                  releases++;
                },
              };
            },
          },
          signal: controller.signal,
        }),
        /named_preparation_aborted/u,
      );
      assert.equal(releases, 2);
      assert.ok(await f.parent.loadRun(f.accepted.binding));
      assert.equal(f.state.posts, 0);
      await opened.close();
    },
  );
  test(
    `${backend}: composition requires its exact prepared native owner and an explicit media IO/config opt-in`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaWorkerFixture(t, backend),
        opened = await f.open(),
        config = opened.config;
      let getterReads = 0;
      const accessor = { ...config.projectMedia! };
      Object.defineProperty(accessor, "createMaterials", {
        enumerable: true,
        get: () => {
          getterReads++;
          return config.projectMedia!.createMaterials;
        },
      });
      assert.throws(
        () => captureInstalledPluginProjectMediaConfig(accessor),
        /fields_invalid/u,
      );
      assert.equal(getterReads, 0);
      assert.throws(() =>
        captureInstalledPluginProjectMediaConfig(
          new Proxy(config.projectMedia!, {}),
        ),
      );
      assert.throws(
        () =>
          captureInstalledPluginExecutionConfig({
            ...config,
            executionIo: undefined,
          }),
        /media_io_unavailable/u,
      );
      assert.throws(
        () =>
          composeInstalledPluginRuntimeResolver({
            store: f.parent,
            extensions: f.ext,
            config,
          }),
        /preparation_required/u,
      );
      const prepared = await prepareInstalledPluginProjectMedia({
        store: f.parent,
        extensions: f.ext,
        config: captureInstalledPluginProjectMediaConfig(config.projectMedia!),
        signal: new AbortController().signal,
      });
      try {
        assert.throws(
          () =>
            preparedInstalledPluginMediaOwner({
              prepared: { ...prepared },
              store: f.parent,
              extensions: f.ext,
              config: config.projectMedia!,
            }),
          /preparation_required/u,
        );
        assert.throws(
          () =>
            preparedInstalledPluginMediaOwner({
              prepared,
              store: f.parent,
              extensions: f.parent.extensionStore(),
              config: config.projectMedia!,
            }),
          /preparation_required/u,
        );
        assert.throws(
          () =>
            preparedInstalledPluginMediaOwner({
              prepared,
              store: f.parent,
              extensions: f.ext,
              config: {
                ...config.projectMedia!,
                version: "crewon.project-media-worker.v1",
              },
            }),
          /preparation_required/u,
        );
      } finally {
        await prepared.close();
      }
      assert.throws(
        () =>
          preparedInstalledPluginMediaOwner({
            prepared,
            store: f.parent,
            extensions: f.ext,
            config: captureInstalledPluginProjectMediaConfig(
              config.projectMedia!,
            ),
          }),
        /closed/u,
      );
      await opened.close();
      assert.equal(f.state.posts, 0);
      assert.equal(f.state.materialFactories, f.state.materialCloses);
    },
  );
}
