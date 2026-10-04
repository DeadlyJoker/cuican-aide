import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginSelection } from "@crewon/domain";
import {
  uiDeferred,
  uiFixture,
  uiRejects,
  uiTestActor,
  uiTestMountCommand,
  uiTestScope,
  uiTestSelection,
} from "./plugin-ui.test-support.ts";

test("validate stays read-only; explicit renewal preserves the owner and frozen publication", async () => {
  const f = uiFixture();
  const original = await f.service.openMount(uiTestActor, uiTestMountCommand);
  f.state.now = "2026-10-02T03:02:30.000Z";
  assert.equal(
    await f.service.validateMount(uiTestActor, { mountRef: original.mountRef }),
    original,
  );
  const renewed = await f.service.renewMount(uiTestActor, {
    mountRef: original.mountRef,
    expectedExpiresAt: original.expiresAt,
  });
  assert.equal(renewed.expiresAt, "2026-10-02T03:07:30.000Z");
  assert.deepEqual({ ...renewed, expiresAt: original.expiresAt }, original);
  assert.ok(Object.isFrozen(renewed));
  assert.ok(Object.isFrozen(renewed.descriptor.files));
  assert.equal(original.expiresAt, "2026-10-02T03:05:00.000Z");
  assert.equal(
    await f.service.validateMount(uiTestActor, { mountRef: original.mountRef }),
    renewed,
  );
  f.state.now = original.expiresAt;
  assert.equal(
    await f.service.validateMount(uiTestActor, { mountRef: original.mountRef }),
    renewed,
  );
  await uiRejects(
    () =>
      f.service.renewMount(uiTestActor, {
        mountRef: original.mountRef,
        expectedExpiresAt: original.expiresAt,
      }),
    "conflict",
    "plugin_ui_mount_lease_changed",
  );
});

test("renewal honors the configured lower TTL and rejects a non-extending clock", async () => {
  const f = uiFixture({ mounts: 1, ttlMs: 20, assetBytes: 1024 });
  const original = await f.service.openMount(uiTestActor, uiTestMountCommand);
  await uiRejects(
    () =>
      f.service.renewMount(uiTestActor, {
        mountRef: original.mountRef,
        expectedExpiresAt: original.expiresAt,
      }),
    "conflict",
    "plugin_ui_mount_renewal_not_due",
  );
  f.state.now = "2026-10-02T03:00:00.010Z";
  const renewed = await f.service.renewMount(uiTestActor, {
    mountRef: original.mountRef,
    expectedExpiresAt: original.expiresAt,
  });
  assert.equal(renewed.expiresAt, "2026-10-02T03:00:00.030Z");
});

test("foreign actors, strict input and stale expiry never verify or extend another owner", async () => {
  const f = uiFixture();
  const original = await f.service.openMount(uiTestActor, uiTestMountCommand);
  f.state.now = "2026-10-02T03:02:30.000Z";
  f.state.calls.length = 0;
  const command = {
    mountRef: original.mountRef,
    expectedExpiresAt: original.expiresAt,
  };
  for (const field of ["tenantId", "spaceId", "principalId", "actorId"])
    await uiRejects(
      () =>
        f.service.renewMount({ ...uiTestActor, [field]: "foreign" }, command),
      "notFound",
      "plugin_ui_mount_unavailable",
    );
  for (const invalid of [
    { ...command, actorId: "foreign" },
    { ...command, expectedExpiresAt: "invalid" },
  ])
    await uiRejects(
      () => f.service.renewMount(uiTestActor, invalid as never),
      "validation",
      "plugin_ui_input_invalid",
    );
  await uiRejects(
    () =>
      f.service.renewMount(uiTestActor, {
        ...command,
        expectedExpiresAt: "2026-10-02T03:04:59.999Z",
      }),
    "conflict",
    "plugin_ui_mount_lease_changed",
  );
  assert.deepEqual(f.state.calls, []);
  assert.equal(
    await f.service.validateMount(uiTestActor, { mountRef: original.mountRef }),
    original,
  );
});

test("expired and closed mounts remain dead even if the clock returns", async () => {
  for (const closed of [false, true]) {
    const f = uiFixture();
    const original = await f.service.openMount(uiTestActor, uiTestMountCommand);
    const command = {
      mountRef: original.mountRef,
      expectedExpiresAt: original.expiresAt,
    };
    if (closed)
      await f.service.closeMount(uiTestActor, { mountRef: original.mountRef });
    else f.state.now = original.expiresAt;
    await uiRejects(
      () => f.service.renewMount(uiTestActor, command),
      closed ? "notFound" : "conflict",
      closed ? "plugin_ui_mount_unavailable" : "plugin_ui_mount_expired",
    );
    f.state.now = "2026-10-02T03:02:30.000Z";
    await uiRejects(
      () => f.service.renewMount(uiTestActor, command),
      "notFound",
      "plugin_ui_mount_unavailable",
    );
  }
});

test("one concurrent renewal wins the old-expiry CAS without invalidating the stable mount", async () => {
  const f = uiFixture();
  const original = await f.service.openMount(uiTestActor, uiTestMountCommand);
  f.state.now = "2026-10-02T03:02:30.000Z";
  const entered = uiDeferred(),
    gate = uiDeferred();
  let first = true;
  f.state.beforeVerify = async () => {
    if (first) {
      first = false;
      entered.resolve();
      await gate.promise;
    }
  };
  const command = {
    mountRef: original.mountRef,
    expectedExpiresAt: original.expiresAt,
  };
  const pending = f.service.renewMount(uiTestActor, command);
  await entered.promise;
  const winner = await f.service.renewMount(uiTestActor, command);
  const rejected = uiRejects(
    () => pending,
    "conflict",
    "plugin_ui_mount_lease_changed",
  );
  gate.resolve();
  await rejected;
  assert.equal(
    await f.service.validateMount(uiTestActor, { mountRef: original.mountRef }),
    winner,
  );
});

test("late publication verification cannot renew an expired or closed binding", async () => {
  for (const closed of [false, true]) {
    const f = uiFixture();
    const original = await f.service.openMount(uiTestActor, uiTestMountCommand);
    f.state.now = "2026-10-02T03:02:30.000Z";
    const entered = uiDeferred(),
      gate = uiDeferred();
    f.state.beforeVerify = async () => {
      entered.resolve();
      await gate.promise;
    };
    const pending = f.service.renewMount(uiTestActor, {
      mountRef: original.mountRef,
      expectedExpiresAt: original.expiresAt,
    });
    await entered.promise;
    if (closed)
      await f.service.closeMount(uiTestActor, { mountRef: original.mountRef });
    else f.state.now = original.expiresAt;
    const rejected = uiRejects(
      () => pending,
      closed ? "notFound" : "conflict",
      closed ? "plugin_ui_mount_unavailable" : "plugin_ui_mount_expired",
    );
    gate.resolve();
    await rejected;
    f.state.now = "2026-10-02T03:02:30.000Z";
    await uiRejects(
      () =>
        f.service.validateMount(uiTestActor, { mountRef: original.mountRef }),
      "notFound",
      "plugin_ui_mount_unavailable",
    );
  }
});

test("renewal rechecks policy, profile, epoch and selection after verifying publication", async () => {
  for (const [change, category, code] of [
    [
      (f: ReturnType<typeof uiFixture>) => f.state.allowed.delete("mount"),
      "authorization",
      "plugin_ui_authorization_denied",
    ],
    [
      (f: ReturnType<typeof uiFixture>) => {
        f.state.epoch = "epoch-revoked";
      },
      "authorization",
      "plugin_ui_authority_changed",
    ],
    [
      (f: ReturnType<typeof uiFixture>) => {
        f.state.scope = { ...uiTestScope, profileId: "other-profile" };
      },
      "authorization",
      "plugin_ui_profile_changed",
    ],
    [
      (f: ReturnType<typeof uiFixture>) => {
        f.state.selection = parsePluginSelection({
          ...uiTestSelection,
          revision: 3,
          state: "disabled",
        });
      },
      "conflict",
      "plugin_ui_selection_changed",
    ],
  ] as const) {
    const f = uiFixture();
    const original = await f.service.openMount(uiTestActor, uiTestMountCommand);
    f.state.now = "2026-10-02T03:02:30.000Z";
    f.state.beforeVerify = async () => {
      change(f);
    };
    await uiRejects(
      () =>
        f.service.renewMount(uiTestActor, {
          mountRef: original.mountRef,
          expectedExpiresAt: original.expiresAt,
        }),
      category,
      code,
    );
    assert.equal(original.expiresAt, "2026-10-02T03:05:00.000Z");
  }
});

test("changed descriptor or public asset projection cannot acquire a longer lease", async () => {
  for (const change of [
    (f: ReturnType<typeof uiFixture>) => {
      f.state.descriptor = { ...f.state.descriptor, title: "Changed" };
    },
    (f: ReturnType<typeof uiFixture>) => {
      f.state.publicAssets = ["ui.mjs", "node.mjs"];
    },
  ]) {
    const f = uiFixture();
    const original = await f.service.openMount(uiTestActor, uiTestMountCommand);
    f.state.now = "2026-10-02T03:02:30.000Z";
    change(f);
    await uiRejects(
      () =>
        f.service.renewMount(uiTestActor, {
          mountRef: original.mountRef,
          expectedExpiresAt: original.expiresAt,
        }),
      "conflict",
      "plugin_ui_mount_publication_changed",
    );
    assert.equal(
      await f.service.validateMount(uiTestActor, {
        mountRef: original.mountRef,
      }),
      original,
    );
  }
});

test("renewing in place does not withdraw the owner captured by an in-flight action fence", async () => {
  const f = uiFixture();
  const original = await f.service.openMount(uiTestActor, uiTestMountCommand);
  const entered = uiDeferred(),
    gate = uiDeferred();
  f.state.beforeInvoke = async () => {
    entered.resolve();
    await gate.promise;
  };
  const pending = f.service.invoke(uiTestActor, {
    mountRef: original.mountRef,
    action: "echo",
    input: { draft: "preserved" },
  });
  await entered.promise;
  f.state.now = "2026-10-02T03:02:30.000Z";
  const renewed = await f.service.renewMount(uiTestActor, {
    mountRef: original.mountRef,
    expectedExpiresAt: original.expiresAt,
  });
  gate.resolve();
  assert.deepEqual(await pending, { draft: "preserved" });
  assert.equal(
    await f.service.validateMount(uiTestActor, { mountRef: original.mountRef }),
    renewed,
  );
});
