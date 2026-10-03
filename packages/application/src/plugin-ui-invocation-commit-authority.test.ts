import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import {
  capturePluginUiInvocationCommitAuthority,
  registerPluginUiInvocation,
} from "./plugin-ui-invocation-authority.ts";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";
import { taskActor } from "./extension-plugin-task.test-support.ts";

const unavailable = (error: unknown) =>
  error instanceof ApplicationError &&
  error.code === "plugin_ui_invocation_unavailable";

test("commit authority requires the exact live invocation with a synchronous activity check", () => {
  const context = committedUiFixture().detachedContext();
  assert.throws(
    () => capturePluginUiInvocationCommitAuthority(context),
    unavailable,
  );
  const legacyDispose = registerPluginUiInvocation(context, async () => {});
  assert.throws(
    () => capturePluginUiInvocationCommitAuthority(context),
    unavailable,
  );
  legacyDispose();
  const dispose = registerPluginUiInvocation(
    context,
    async () => {},
    () => {},
  );
  try {
    const guard = capturePluginUiInvocationCommitAuthority(context);
    assert.equal(Object.isFrozen(guard), true);
    assert.doesNotThrow(() => guard.assertActive());
    assert.throws(
      () => capturePluginUiInvocationCommitAuthority({ ...context }),
      unavailable,
    );
    let reads = 0;
    const fake = Object.defineProperty({}, "actor", {
      get() {
        reads++;
        return taskActor;
      },
    });
    assert.throws(
      () => capturePluginUiInvocationCommitAuthority(fake as typeof context),
      unavailable,
    );
    assert.equal(reads, 0);
  } finally {
    dispose();
  }
});

test("captured authority cannot adopt another registration of the same context", async () => {
  const context = committedUiFixture().detachedContext();
  const dispose = registerPluginUiInvocation(
    context,
    async () => {},
    () => {},
  );
  const guard = capturePluginUiInvocationCommitAuthority(context);
  dispose();
  const nextDispose = registerPluginUiInvocation(
    context,
    async () => {},
    () => {},
  );
  try {
    assert.throws(() => guard.assertActive(), unavailable);
    await assert.rejects(guard.assertCurrent(), unavailable);
    await capturePluginUiInvocationCommitAuthority(context).assertCurrent();
  } finally {
    nextDispose();
  }
});

test("the real UI mount closes synchronously while its action is still pending", async () => {
  const fixture = committedUiFixture();
  fixture.state.mode = "json";
  const lease = await fixture.service.openMount(taskActor, fixture.openCommand);
  fixture.state.afterAction = async () => {
    const guard = capturePluginUiInvocationCommitAuthority(
      fixture.state.context!,
    );
    await guard.assertCurrent();
    await fixture.service.closeMount(taskActor, { mountRef: lease.mountRef });
    assert.throws(() => guard.assertActive(), {
      code: "plugin_ui_mount_unavailable",
    });
    await assert.rejects(guard.assertCurrent(), {
      code: "plugin_ui_mount_unavailable",
    });
  };
  await assert.rejects(
    fixture.service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action: "read",
      input: null,
    }),
    { code: "plugin_ui_mount_unavailable" },
  );
});

test("expiry is checked synchronously without retaining the invocation until another HTTP call", async () => {
  const fixture = committedUiFixture();
  fixture.state.mode = "json";
  const lease = await fixture.service.openMount(taskActor, fixture.openCommand);
  fixture.state.afterAction = () => {
    const guard = capturePluginUiInvocationCommitAuthority(
      fixture.state.context!,
    );
    fixture.state.now = lease.expiresAt;
    assert.throws(() => guard.assertActive(), {
      code: "plugin_ui_mount_expired",
    });
  };
  await assert.rejects(
    fixture.service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action: "read",
      input: null,
    }),
    { code: "plugin_ui_mount_unavailable" },
  );
});

test("observed policy revocation withdraws both asynchronous and synchronous authority", async () => {
  const fixture = committedUiFixture();
  fixture.state.mode = "json";
  const lease = await fixture.service.openMount(taskActor, fixture.openCommand);
  fixture.state.afterAction = async () => {
    const guard = capturePluginUiInvocationCommitAuthority(
      fixture.state.context!,
    );
    fixture.state.epoch = "fixture-revoked-epoch";
    await assert.rejects(guard.assertCurrent(), {
      code: "plugin_ui_authority_changed",
    });
    assert.throws(() => guard.assertActive(), {
      code: "plugin_ui_mount_unavailable",
    });
  };
  await assert.rejects(
    fixture.service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action: "read",
      input: null,
    }),
    { code: "plugin_ui_mount_unavailable" },
  );
});

test("a Promise or thenable cannot masquerade as the synchronous COMMIT fence", () => {
  for (const result of [
    Promise.resolve(),
    Object.defineProperty({}, "then", {
      get() {
        throw new Error("then getter must remain unread");
      },
    }),
  ]) {
    const context = committedUiFixture().detachedContext();
    const dispose = registerPluginUiInvocation(
      context,
      async () => {},
      () => result as unknown as void,
    );
    try {
      assert.throws(() => capturePluginUiInvocationCommitAuthority(context), {
        code: "plugin_ui_invocation_active_check_invalid",
      });
    } finally {
      dispose();
    }
  }
});

test("a policy deny permanently withdraws the actual invocation's synchronous authority", async () => {
  const fixture = committedUiFixture();
  fixture.state.mode = "json";
  const lease = await fixture.service.openMount(taskActor, fixture.openCommand);
  fixture.state.afterAction = async () => {
    const guard = capturePluginUiInvocationCommitAuthority(
      fixture.state.context!,
    );
    fixture.state.allow = false;
    await assert.rejects(guard.assertCurrent(), {
      code: "plugin_ui_authorization_denied",
    });
    assert.throws(() => guard.assertActive(), {
      code: "plugin_ui_invocation_unavailable",
    });
    fixture.state.allow = true;
    assert.throws(() => guard.assertActive(), {
      code: "plugin_ui_invocation_unavailable",
    });
    assert.throws(
      () => capturePluginUiInvocationCommitAuthority(fixture.state.context!),
      { code: "plugin_ui_invocation_unavailable" },
    );
  };
  await fixture.service.invoke(taskActor, {
    mountRef: lease.mountRef,
    action: "read",
    input: null,
  });
  assert.equal(
    await fixture.service.validateMount(taskActor, {
      mountRef: lease.mountRef,
    }),
    lease,
  );
});
