import assert from "node:assert/strict";
import test from "node:test";
import {
  capturePluginTaskCommitAuthority,
  type PluginTaskCommitAuthorityPort,
} from "./extension-plugin-task-support.ts";
import {
  assertPluginTaskCommitActive,
  isPreparedPluginTaskCommitAuthority,
  pluginTaskCommitOptions,
} from "./plugin-task-commit-authority.ts";
import {
  pluginTaskFixture,
  taskActor,
  taskCommand,
  taskPin,
} from "./extension-plugin-task.test-support.ts";

test("unchanged class-based Host callbacks remain bound and absent active creates no option", async () => {
  class Host {
    calls = 0;
    async assertCurrent() {
      this.calls++;
    }
  }
  const host = new Host();
  const authority = capturePluginTaskCommitAuthority(host)!;
  await authority.assertCurrent({ actor: taskActor, pin: taskPin });
  assert.equal(host.calls, 1);
  assert.equal(
    pluginTaskCommitOptions(authority, taskActor, taskPin, undefined),
    undefined,
  );
});
test("Host callback capture rejects accessors and nonfunctions without invoking a getter", () => {
  for (const field of ["assertCurrent", "assertActive"] as const) {
    let calls = 0;
    const raw = { async assertCurrent() {} };
    Object.defineProperty(raw, field, {
      enumerable: true,
      get() {
        calls++;
        return () => {};
      },
    });
    assert.throws(
      () => capturePluginTaskCommitAuthority(raw),
      /plugin_task_authority_unavailable/u,
    );
    assert.equal(calls, 0);
  }
  assert.throws(
    () =>
      capturePluginTaskCommitAuthority({
        async assertCurrent() {},
        assertActive: true,
      } as unknown as PluginTaskCommitAuthorityPort),
    /plugin_task_authority_unavailable/u,
  );
});
test("both callbacks require undefined and active cannot become asynchronous", async () => {
  const current = capturePluginTaskCommitAuthority({
    async assertCurrent() {
      return true;
    },
  } as unknown as PluginTaskCommitAuthorityPort)!;
  await assert.rejects(
    current.assertCurrent({ actor: taskActor, pin: taskPin }),
    /plugin_task_authority_unavailable/u,
  );
  for (const value of [
    true,
    Promise.resolve(),
    Promise.reject(new Error("ignored asynchronous callback")),
  ]) {
    const active = capturePluginTaskCommitAuthority({
      async assertCurrent() {},
      assertActive() {
        return value;
      },
    } as unknown as PluginTaskCommitAuthorityPort)!;
    assert.throws(
      () => active.assertActive!({ actor: taskActor, pin: taskPin }),
      /plugin_task_authority_unavailable/u,
    );
  }
});
test("opaque negative fence cannot be copied and must match the actual complete actor/pin/admission/binding", async () => {
  // Application double only: this test checks the opaque callback boundary, not a production grant.
  const f = pluginTaskFixture();
  const result = await f
    .create()
    .createTaskFromPlugin(taskActor, taskCommand, taskPin);
  const admission = f.state.commits[0]!.pluginAdmission!;
  let calls = 0;
  const authority = capturePluginTaskCommitAuthority({
    async assertCurrent() {},
    assertActive(input) {
      assert.deepEqual(input, { actor: taskActor, pin: taskPin });
      calls++;
    },
  })!;
  const options = pluginTaskCommitOptions(
    authority,
    taskActor,
    taskPin,
    undefined,
  )!;
  const prepared = options.pluginTaskCommitAuthority!;
  assert.equal(isPreparedPluginTaskCommitAuthority(prepared), true);
  assert.equal(isPreparedPluginTaskCommitAuthority({ ...prepared }), false);
  assertPluginTaskCommitActive(prepared, result.binding, admission);
  assert.equal(calls, 2);
  for (const key of Object.keys(taskPin) as (keyof typeof taskPin)[]) {
    const altered = {
      ...admission,
      [key]: typeof taskPin[key] === "number" ? 100 : "foreign",
    };
    assert.throws(
      () => assertPluginTaskCommitActive(prepared, result.binding, altered),
      /plugin_task_commit_authority_invalid/u,
    );
  }
  assert.throws(
    () => assertPluginTaskCommitActive(prepared, result.binding, undefined),
    /plugin_task_commit_authority_invalid/u,
  );
  assert.throws(
    () =>
      assertPluginTaskCommitActive({ ...prepared }, result.binding, admission),
    /plugin_task_commit_authority_invalid/u,
  );
  assert.throws(
    () =>
      assertPluginTaskCommitActive(
        prepared,
        { ...result.binding, runId: "another-run" },
        admission,
      ),
    /plugin_task_commit_authority_invalid/u,
  );
  assert.equal(calls, 2);
});
