import assert from "node:assert/strict";
import test from "node:test";
import { actor } from "../../control-api/src/desktop-native-plugin-task-runtime.test-support.ts";
import {
  nativeCompositionFixture,
  signal,
} from "./installed-plugin-native-composition.test-support.ts";

test(
  "real shared Core ports do not let the Worker instance redeem a live UI instance reference, and source close withdraws them",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await nativeCompositionFixture(t);
    const task = (await f.invoke()) as { runId: string };
    const run = await f.originalStore.loadRunInSpace({
      ...actor,
      runId: task.runId,
    });
    assert.ok(run);
    const worker = await f.openWorker();
    const lease = await worker.resolver.acquire({
      run,
      base: worker.base,
      purpose: "submit",
      signal: signal(),
    });
    assert.ok(lease);
    const workerPort = f.state.taskPorts.at(-1)!;
    assert.ok(workerPort);
    assert.notEqual(workerPort, f.state.taskPorts[0]);
    let release!: () => void;
    f.state.invocationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<string>((resolve) => {
      f.state.invocationEntered = resolve;
    });
    const replay = f.invoke();
    void replay.catch(() => {});
    try {
      const invocationRef = await entered;
      await assert.rejects(
        async () =>
          workerPort.createTask({ ...f.command.input, invocationRef }),
        /plugin_invocation_owner_mismatch/,
      );
      assert.equal(f.facts().runs, 1);
    } finally {
      release();
      f.state.invocationGate = null;
      f.state.invocationEntered = null;
      assert.equal(
        ((await replay) as { disposition: string }).disposition,
        "replayed",
      );
      lease.release();
    }
    await f.actual.close();
    await assert.rejects(
      async () => workerPort.createTask(f.command.input),
      /desktop_plugin_task_service_unavailable/,
    );
    assert.equal(f.facts().runs, 1);
    await worker.close();
  },
);

test(
  "the original graph still refuses metadata-only deployment without actual shared Core ports",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await nativeCompositionFixture(t);
    const task = (await f.invoke()) as { runId: string };
    const run = await f.originalStore.loadRunInSpace({
      ...actor,
      runId: task.runId,
    });
    assert.ok(run);
    const worker = await f.openWorker({ sharedTaskServices: false });
    const start = f.state.records.length;
    await assert.rejects(async () => {
      const lease = await worker.resolver.acquire({
        run,
        base: worker.base,
        purpose: "submit",
        signal: signal(),
      });
      lease?.release();
    }, /plugin_composition_host_service_conflict/);
    assert.equal(f.state.records.slice(start).includes("B:execute"), false);
    assert.equal(f.facts().runs, 1);
    await worker.close();
  },
);
