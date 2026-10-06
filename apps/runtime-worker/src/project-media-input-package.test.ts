import assert from "node:assert/strict";
import test from "node:test";
import { mediaInputPackageFixture } from "./project-media-input-package.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { deferred } from "./plugin-tool-runtime-adapter.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind} real installed Short23 Node entry saves and reads shared inputs, retains the ACK, and cold reconciliation preserves manual edits`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaInputPackageFixture(t, backend, kind),
          p = await f.activate();
        assert.equal(p.runtime.definitions().length, 24);
        const context = await p.call("getContext", {});
        assert.equal(context.value.projectId, f.binding.projectId);
        assert.equal(context.value.threadId, f.binding.threadId);
        const options = await p.call("getOptions", {
          projectId: f.binding.projectId,
        });
        assert.deepEqual(options.value.configuration, {
          revision: 2,
          workflows: [f.request.workflowId],
        });
        const request = { ...f.request, prompt: '雨夜🚀"\\\n'.repeat(450) };
        const saved = await p.call("saveInput", request);
        assert.equal(saved.value.disposition, "committed");
        const before = await f.countMedia();
        const held = await p.run(saved.op);
        assert.deepEqual(held, saved.result);
        assert.deepEqual(await f.countMedia(), before);
        const inputId = saved.value.input.mediaInputId;
        const base = kind === "T10" ? f.command : f.d18Command;
        await f.app.saveInput(f.actor, {
          ...base,
          mediaInputId: inputId,
          expectedInputRevision: 1,
          idempotencyKey: "manual-after-node",
          prompt: "Latest manual prompt",
        });
        await p.runtime.close?.();
        await p.host.close();
        const cold = await f.cold(),
          next = await f.activate({ overrides: { inputs: cold.app } });
        const replay = await next.run(saved.op, "reconcile");
        assert.equal(replay.status, "completed");
        if (replay.status !== "completed") assert.fail();
        const value = JSON.parse(JSON.parse(replay.result.output).resultJson);
        assert.equal(value.disposition, "replayed");
        assert.deepEqual(value.input, saved.value.input);
        const query = {
          projectId: f.request.projectId,
          mediaInputId: inputId,
          inputRevision: null,
        };
        const latest = await next.call("getInput", query);
        assert.equal(latest.value.state?.input.inputRevision, 2);
        assert.equal(Object.hasOwn(latest.value.state!.input, "prompt"), false);
        let offset = 0,
          text = "";
        for (let n = 0; n < 20; n++) {
          const read = await next.call("readPrompt", {
            ...query,
            inputRevision: 1,
            offset,
          });
          text += read.value.text;
          if (read.value.nextOffset === null) break;
          offset = read.value.nextOffset;
        }
        assert.equal(text, request.prompt);
        const list = await next.call("listInputs", {
          projectId: f.request.projectId,
          afterMediaInputId: null,
          limit: 4,
        });
        assert.equal(list.value.inputs.length, 1);
        assert.equal(list.value.inputs[0]!.latestInputRevision, 2);
        assert.equal(f.state.sourceGets, 0);
        assert.equal(f.state.uploads, 0);
      },
    );
  test(
    `${backend} installed media-input tool requires its optional service and original command; cold cancellation cannot save input`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputPackageFixture(t, backend),
        absent = await f.activate({ service: "absent" }),
        op = await absent.prepare("saveInput", f.request),
        before = await f.countMedia();
      await assert.rejects(absent.run(op), /media_input_tools_unavailable/);
      const live = await f.activate();
      await assert.rejects(
        live.runtime.execute(op.command, new AbortController().signal),
        /authority_denied/,
      );
      const canceled = await live.run(op, "cancel");
      assert.equal(canceled.status, "unknownOutcome");
      assert.deepEqual(await f.countMedia(), before);
      const bad = await live.prepare("getContext", {
        projectId: "foreign",
      } as never);
      await assert.rejects(live.run(bad));
      assert.deepEqual(await f.countMedia(), before);
      const valid = await live.call("saveInput", f.request);
      assert.equal(valid.value.disposition, "committed");
    },
  );
  test(
    `${backend} real installed Node close waits for pending host input save and preserves its committed acknowledgement`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputPackageFixture(t, backend),
        p = await f.activate(),
        op = await p.prepare("saveInput", f.request),
        entered = deferred(),
        release = deferred();
      f.controls.beforeCurrent = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = p.run(op);
      await entered.promise;
      let closed = false;
      const close = Promise.resolve(p.runtime.close?.()).then(() => {
        closed = true;
      });
      await Promise.resolve();
      assert.equal(closed, false);
      release.resolve();
      const result = await pending;
      assert.equal(result.status, "completed");
      await close;
      const inputs = await f.app.listInputs(f.actor, {
        projectId: f.request.projectId,
        afterMediaInputId: null,
        limit: 4,
      });
      assert.equal(inputs.inputs.length, 1);
    },
  );
  test(
    `${backend} installed Node close drains a pending scope read and rejects the late read result`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputPackageFixture(t, backend),
        p = await f.activate(),
        op = await p.prepare("getContext", {}),
        entered = deferred(),
        release = deferred();
      f.controls.beforeCurrent = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = p.run(op),
        rejected = assert.rejects(pending, /runtime_closed/);
      await entered.promise;
      let closed = false;
      const closing = Promise.resolve(p.runtime.close?.()).then(() => {
        closed = true;
      });
      await Promise.resolve();
      assert.equal(closed, false);
      release.resolve();
      await rejected;
      await closing;
      assert.equal(closed, true);
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
