import assert from "node:assert/strict";
import test from "node:test";
import * as application from "./index.ts";
import { ApplicationError } from "./application-error.ts";
import {
  assertPluginUiInvocationCurrent,
  capturePluginUiInvocationCommitAuthority,
  registerPluginUiInvocation,
} from "./plugin-ui-invocation-authority.ts";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";
import { taskActor, taskPin } from "./extension-plugin-task.test-support.ts";
import { uiDeferred } from "./plugin-ui.test-support.ts";

function unavailable(error: unknown) {
  return (
    error instanceof ApplicationError &&
    error.category === "authorization" &&
    error.code === "plugin_ui_invocation_unavailable"
  );
}

test("the package exposes trusted invocation checks, keeps registration private, and rejects copied context", async () => {
  assert.equal(
    application.assertPluginUiInvocationCurrent,
    assertPluginUiInvocationCurrent,
  );
  assert.equal("registerPluginUiInvocation" in application, false);
  assert.equal(
    application.capturePluginUiInvocationCommitAuthority,
    capturePluginUiInvocationCommitAuthority,
  );
  const f = committedUiFixture();
  const context = f.detachedContext();
  let reads = 0;
  const fake = Object.defineProperty({}, "actor", {
    get() {
      reads++;
      return taskActor;
    },
  });
  await assert.rejects(
    assertPluginUiInvocationCurrent(fake as typeof context),
    unavailable,
  );
  assert.equal(reads, 0);
  await assert.rejects(assertPluginUiInvocationCurrent(context), unavailable);
  const dispose = registerPluginUiInvocation(context, async () => {});
  try {
    await assertPluginUiInvocationCurrent(context);
    await assert.rejects(
      assertPluginUiInvocationCurrent({ ...context }),
      unavailable,
    );
  } finally {
    dispose();
  }
  await assert.rejects(assertPluginUiInvocationCurrent(context), unavailable);
});

test("registration is unique, disposal is idempotent, and an old disposer cannot revoke a new registration", async () => {
  const context = committedUiFixture().detachedContext();
  const dispose = registerPluginUiInvocation(context, async () => {});
  assert.throws(
    () => registerPluginUiInvocation(context, async () => {}),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "plugin_ui_invocation_registration_invalid",
  );
  dispose();
  dispose();
  await assert.rejects(assertPluginUiInvocationCurrent(context), unavailable);
  const currentDispose = registerPluginUiInvocation(context, async () => {});
  try {
    dispose();
    await assertPluginUiInvocationCurrent(context);
  } finally {
    currentDispose();
  }
});

test("ending an invocation during an awaited fence prevents its late success from retaining authority", async () => {
  const context = committedUiFixture().detachedContext();
  const entered = uiDeferred();
  const release = uiDeferred();
  const dispose = registerPluginUiInvocation(context, async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = assertPluginUiInvocationCurrent(context);
  await entered.promise;
  dispose();
  release.resolve();
  await assert.rejects(pending, unavailable);
});

test("callback failures preserve ApplicationError and bound unknown errors without leaking their message", async () => {
  for (const cause of [
    new ApplicationError("authorization", "fixture_denied"),
    new Error("private SQL connection"),
  ]) {
    const context = committedUiFixture().detachedContext();
    const dispose = registerPluginUiInvocation(context, async () => {
      throw cause;
    });
    try {
      await assert.rejects(
        assertPluginUiInvocationCurrent(context),
        (error: unknown) =>
          cause instanceof ApplicationError
            ? error === cause
            : unavailable(error) && (error as ApplicationError).cause === cause,
      );
    } finally {
      dispose();
    }
  }
});

test("a real active UI action passes the mount fence and loses invocation authority after JSON completion", async () => {
  const f = committedUiFixture();
  f.state.mode = "json";
  let checked = false;
  f.state.afterAction = async () => {
    await assertPluginUiInvocationCurrent(f.state.context!);
    checked = true;
  };
  const lease = await f.service.openMount(taskActor, f.openCommand);
  assert.deepEqual(
    await f.service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action: "read",
      input: null,
    }),
    f.state.json,
  );
  assert.equal(checked, true);
  await assert.rejects(
    assertPluginUiInvocationCurrent(f.state.context!),
    unavailable,
  );
});

test("accepted task completion also unregisters its exact context without changing the opaque outcome semantics", async () => {
  const f = committedUiFixture();
  const lease = await f.service.openMount(taskActor, f.openCommand);
  const output = await f.service.invoke(taskActor, {
    mountRef: lease.mountRef,
    action: taskPin.action,
    input: null,
  });
  assert.equal((output as { disposition: string }).disposition, "committed");
  assert.equal(f.tasks.state.commits.length, 1);
  await assert.rejects(
    assertPluginUiInvocationCurrent(f.state.context!),
    unavailable,
  );
});

test("action failures unregister the invocation in finally", async () => {
  const f = committedUiFixture();
  f.state.mode = "json";
  const cause = new ApplicationError("conflict", "fixture_action_failed");
  f.state.afterAction = async () => {
    await assertPluginUiInvocationCurrent(f.state.context!);
    throw cause;
  };
  const lease = await f.service.openMount(taskActor, f.openCommand);
  await assert.rejects(
    f.service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action: "read",
      input: null,
    }),
    (error: unknown) => error === cause,
  );
  await assert.rejects(
    assertPluginUiInvocationCurrent(f.state.context!),
    unavailable,
  );
});

test("actual closeMount during quote await prevents the final bridge gate from writing a Run or paid admission", async () => {
  const f = committedUiFixture();
  const entered = uiDeferred();
  const release = uiDeferred();
  f.tasks.state.onQuote = async () => {
    entered.resolve();
    await release.promise;
  };
  const lease = await f.service.openMount(taskActor, f.openCommand);
  const pending = f.service.invoke(taskActor, {
    mountRef: lease.mountRef,
    action: taskPin.action,
    input: null,
  });
  await entered.promise;
  await f.service.closeMount(taskActor, { mountRef: lease.mountRef });
  // The epoch and durable selection did not change: only the actual host mount was disposed.
  assert.equal(f.state.epoch, taskPin.authorityEpoch);
  assert.equal(f.state.selection?.revision, taskPin.selectionRevision);
  release.resolve();
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "plugin_ui_mount_unavailable",
  );
  assert.equal(f.tasks.state.commits.length, 0);
  assert.equal(f.tasks.state.receipts.size, 0);
  assert.equal(f.tasks.state.admissions.size, 0);
  await assert.rejects(
    assertPluginUiInvocationCurrent(f.state.context!),
    unavailable,
  );
});

test("the registered fence observes closeMount immediately while an ordinary action is still active", async () => {
  const f = committedUiFixture();
  f.state.mode = "json";
  const lease = await f.service.openMount(taskActor, f.openCommand);
  f.state.afterAction = async () => {
    await f.service.closeMount(taskActor, { mountRef: lease.mountRef });
    await assert.rejects(
      assertPluginUiInvocationCurrent(f.state.context!),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "plugin_ui_mount_unavailable",
    );
  };
  await assert.rejects(
    f.service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action: "read",
      input: null,
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "plugin_ui_mount_unavailable",
  );
  await assert.rejects(
    assertPluginUiInvocationCurrent(f.state.context!),
    unavailable,
  );
});
