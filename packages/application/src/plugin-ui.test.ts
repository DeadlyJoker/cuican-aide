import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginUiLease } from "@crewon/contracts/plugins";
import { parsePluginSelection } from "@crewon/domain";
import {
  uiDeferred,
  uiFixture,
  uiRejects,
  uiTestActor,
  uiTestBytes,
  uiTestDescriptor,
  uiTestDigest,
  uiTestMountCommand,
  uiTestSelection,
} from "./plugin-ui.test-support.ts";

test("opens a detached public lease only for the current enabled package and declared contribution", async () => {
  const f = uiFixture();
  const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
  assert.deepEqual(parsePluginUiLease(lease), lease);
  assert.deepEqual(lease.publicAssets, ["ui.mjs"]);
  assert.equal(lease.expiresAt, "2026-10-02T03:05:00.000Z");
  assert.ok(Object.isFrozen(lease));
  assert.ok(Object.isFrozen(lease.descriptor.files));
  assert.equal(
    await f.service.validateMount(uiTestActor, { mountRef: lease.mountRef }),
    lease,
  );
  assert.equal(Object.hasOwn(lease, "actor"), false);
  assert.equal(Object.hasOwn(lease, "scope"), false);
  assert.ok(f.state.contexts.every((context) => Object.isFrozen(context)));
});

test("catalog read permission never grants mount, asset or action permission", async () => {
  const f = uiFixture();
  f.state.allowed.delete("mount");
  const catalog = await f.service.catalog(uiTestActor, {
    afterPluginId: null,
    limit: 1,
  });
  assert.equal(catalog.plugins.length, 1);
  assert.ok(Object.isFrozen(catalog.plugins));
  await uiRejects(
    () => f.service.openMount(uiTestActor, uiTestMountCommand),
    "authorization",
    "plugin_ui_authorization_denied",
  );
  assert.equal(f.state.calls.filter((call) => call === "verify").length, 1);
});

test("stale, absent or disabled selection cannot issue a reference or read bytes", async () => {
  for (const selection of [
    null,
    parsePluginSelection({ ...uiTestSelection, state: "disabled" }),
    parsePluginSelection({ ...uiTestSelection, revision: 3 }),
  ]) {
    const f = uiFixture();
    f.state.selection = selection;
    await uiRejects(
      () => f.service.openMount(uiTestActor, uiTestMountCommand),
      selection === null ? "notFound" : "conflict",
      selection === null
        ? "plugin_ui_selection_unavailable"
        : "plugin_ui_selection_changed",
    );
    assert.equal(f.state.calls.includes("verify"), false);
  }
});

test("isolated, undeclared contributions, missing assets and wrong package identity fail closed", async () => {
  const cases = [
    {
      descriptor: {
        ...uiTestDescriptor,
        entrypoints: {
          node: "node.mjs",
          ui: { path: "ui.mjs", mode: "isolatedWeb" },
        },
      },
      publicAssets: ["ui.mjs"],
    },
    { descriptor: uiTestDescriptor, publicAssets: ["node.mjs"] },
    {
      descriptor: { ...uiTestDescriptor, version: "2.0.0" },
      publicAssets: ["ui.mjs"],
    },
  ];
  for (const projection of cases) {
    const f = uiFixture();
    f.state.verifyOverride = projection;
    await uiRejects(
      () => f.service.openMount(uiTestActor, uiTestMountCommand),
      "internal",
      "plugin_ui_output_invalid",
    );
  }
  const f = uiFixture();
  await uiRejects(
    () =>
      f.service.openMount(uiTestActor, {
        ...uiTestMountCommand,
        contributionId: "unknown",
      }),
    "internal",
    "plugin_ui_output_invalid",
  );
});

test("asset reads accept only the approved exact inventory path and detach host buffers", async () => {
  const f = uiFixture();
  const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
  for (const path of [
    "node.mjs",
    "crewon.plugin.json",
    "../ui.mjs",
    "https://example.test/ui.mjs",
    "/ui.mjs",
  ])
    await uiRejects(
      () =>
        f.service.readAsset(uiTestActor, { mountRef: lease.mountRef, path }),
      "notFound",
      "plugin_ui_asset_unavailable",
    );
  assert.equal(f.state.calls.includes("read"), false);
  const asset = await f.service.readAsset(uiTestActor, {
    mountRef: lease.mountRef,
    path: "ui.mjs",
  });
  assert.deepEqual(asset.bytes, uiTestBytes);
  assert.notEqual(asset.bytes, uiTestBytes);
  asset.bytes[0] = 0;
  assert.notEqual(uiTestBytes[0], 0);
});

test("references bind full actor identity and cannot close another actor's mount", async () => {
  const f = uiFixture();
  const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
  for (const actor of [
    { ...uiTestActor, principalId: "other" },
    { ...uiTestActor, actorId: "other-device" },
    { ...uiTestActor, tenantId: "other-tenant" },
  ]) {
    await uiRejects(
      () => f.service.validateMount(actor, { mountRef: lease.mountRef }),
      "notFound",
      "plugin_ui_mount_unavailable",
    );
    await uiRejects(
      () => f.service.closeMount(actor, { mountRef: lease.mountRef }),
      "notFound",
      "plugin_ui_mount_unavailable",
    );
  }
  await f.service.closeMount(uiTestActor, { mountRef: lease.mountRef });
  const next = await f.service.openMount(uiTestActor, uiTestMountCommand);
  assert.notEqual(next.mountRef, lease.mountRef);
  await uiRejects(
    () => f.service.validateMount(uiTestActor, { mountRef: lease.mountRef }),
    "notFound",
    "plugin_ui_mount_unavailable",
  );
});

test("expired references stay invalid when time returns and new mounts reuse released capacity", async () => {
  const f = uiFixture({ mounts: 1, ttlMs: 1, assetBytes: 1024 });
  const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
  f.state.now = lease.expiresAt;
  await uiRejects(
    () => f.service.validateMount(uiTestActor, { mountRef: lease.mountRef }),
    "conflict",
    "plugin_ui_mount_expired",
  );
  f.state.now = "2026-10-02T03:00:00.000Z";
  const next = await f.service.openMount(uiTestActor, uiTestMountCommand);
  assert.notEqual(next.mountRef, lease.mountRef);
  await uiRejects(
    () => f.service.validateMount(uiTestActor, { mountRef: lease.mountRef }),
    "notFound",
    "plugin_ui_mount_unavailable",
  );
});

test("concurrent opens reserve bounded capacity before asynchronous verification", async () => {
  const f = uiFixture({ mounts: 1, ttlMs: 1000, assetBytes: 1024 });
  const entered = uiDeferred();
  const release = uiDeferred();
  f.state.beforeVerify = async () => {
    entered.resolve();
    await release.promise;
  };
  const opening = f.service.openMount(uiTestActor, uiTestMountCommand);
  await entered.promise;
  await uiRejects(
    () => f.service.openMount(uiTestActor, uiTestMountCommand),
    "conflict",
    "plugin_ui_mount_limit",
  );
  release.resolve();
  const lease = await opening;
  await f.service.closeMount(uiTestActor, { mountRef: lease.mountRef });
  f.state.beforeVerify = null;
  assert.ok(await f.service.openMount(uiTestActor, uiTestMountCommand));
});

test("revocation or selection changes during verification prevent reference publication", async () => {
  for (const change of ["epoch", "selection", "profile"] as const) {
    const f = uiFixture();
    f.state.beforeVerify = async () => {
      if (change === "epoch") f.state.epoch = "epoch-b";
      else if (change === "selection")
        f.state.selection = parsePluginSelection({
          ...uiTestSelection,
          revision: 3,
        });
      else f.state.scope = { ...f.state.scope, profileId: "profile-b" };
    };
    await uiRejects(
      () => f.service.openMount(uiTestActor, uiTestMountCommand),
      change === "selection" ? "conflict" : "authorization",
      change === "epoch"
        ? "plugin_ui_authority_changed"
        : change === "selection"
          ? "plugin_ui_selection_changed"
          : "plugin_ui_profile_changed",
    );
    f.state.beforeVerify = null;
    f.state.epoch = "epoch-a";
    f.state.selection = uiTestSelection;
    f.state.scope = { ...f.state.scope, profileId: "profile-a" };
    assert.ok(await f.service.openMount(uiTestActor, uiTestMountCommand));
  }
});

test("post-read fences reject changed authority, state, expiration and local disposal", async () => {
  for (const change of ["epoch", "selection", "expiry", "close"] as const) {
    const f = uiFixture();
    const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
    f.state.beforeRead = async () => {
      if (change === "epoch") f.state.epoch = "epoch-b";
      else if (change === "selection")
        f.state.selection = parsePluginSelection({
          ...uiTestSelection,
          revision: 3,
          state: "disabled",
        });
      else if (change === "expiry") f.state.now = lease.expiresAt;
      else
        await f.service.closeMount(uiTestActor, { mountRef: lease.mountRef });
    };
    await uiRejects(
      () =>
        f.service.readAsset(uiTestActor, {
          mountRef: lease.mountRef,
          path: "ui.mjs",
        }),
      change === "epoch"
        ? "authorization"
        : change === "close"
          ? "notFound"
          : "conflict",
      change === "epoch"
        ? "plugin_ui_authority_changed"
        : change === "selection"
          ? "plugin_ui_selection_changed"
          : change === "expiry"
            ? "plugin_ui_mount_expired"
            : "plugin_ui_mount_unavailable",
    );
  }
});

test("required action allowlist performs detached JSON bridge and rejects arbitrary names", async () => {
  const f = uiFixture();
  const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
  await uiRejects(
    () =>
      f.service.invoke(uiTestActor, {
        mountRef: lease.mountRef,
        action: "node.service.anything",
        input: null,
      }),
    "authorization",
    "plugin_ui_action_unavailable",
  );
  const entered = uiDeferred();
  const release = uiDeferred();
  f.state.beforeInvoke = async () => {
    entered.resolve();
    await release.promise;
  };
  const input = { caption: "old", nested: ["value"] };
  const running = f.service.invoke(uiTestActor, {
    mountRef: lease.mountRef,
    action: "echo",
    input,
  });
  await entered.promise;
  input.caption = "new";
  input.nested.push("changed");
  release.resolve();
  const result = await running;
  assert.deepEqual(result, { caption: "old", nested: ["value"] });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(f.state.actionInputs.at(-1)));
});

test("host action dispatch itself fences an authority change while awaiting execution", async () => {
  const f = uiFixture();
  const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
  f.state.beforeInvoke = async () => {
    f.state.selection = parsePluginSelection({
      ...uiTestSelection,
      revision: 3,
    });
  };
  await uiRejects(
    () =>
      f.service.invoke(uiTestActor, {
        mountRef: lease.mountRef,
        action: "echo",
        input: null,
      }),
    "conflict",
    "fixture_dispatch_fenced",
  );
});

test("strict input, JSON, profile and authorization outputs fail closed without getter execution", async () => {
  const f = uiFixture();
  let getterCalls = 0;
  const getter = { ...uiTestMountCommand };
  Object.defineProperty(getter, "pluginId", {
    enumerable: true,
    get() {
      getterCalls++;
      return "example.story";
    },
  });
  await uiRejects(
    () => f.service.openMount(uiTestActor, getter),
    "validation",
    "plugin_ui_input_invalid",
  );
  assert.equal(getterCalls, 0);
  assert.equal(f.state.calls.length, 0);
  f.state.authorizationOverride = { outcome: "allow" };
  await uiRejects(
    () => f.service.openMount(uiTestActor, uiTestMountCommand),
    "authorization",
    "plugin_ui_authorization_unavailable",
  );
  f.state.authorizationOverride = undefined;
  f.state.scope = { ...f.state.scope, tenantId: "foreign" };
  await uiRejects(
    () => f.service.openMount(uiTestActor, uiTestMountCommand),
    "internal",
    "plugin_installation_profile_invalid",
  );
  f.state.scope = { ...f.state.scope, tenantId: "tenant-a" };
  const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
  await uiRejects(
    () =>
      f.service.invoke(uiTestActor, {
        mountRef: lease.mountRef,
        action: "echo",
        input: "x".repeat(24 * 1024),
      }),
    "validation",
    "plugin_ui_input_invalid",
  );
});

test("malformed bytes, response JSON and stored identity cannot enter public results", async () => {
  const f = uiFixture();
  const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
  f.state.readOverride = {
    bytes: new Uint8Array(1),
    contentType: "text/javascript",
  };
  await uiRejects(
    () =>
      f.service.readAsset(uiTestActor, {
        mountRef: lease.mountRef,
        path: "ui.mjs",
      }),
    "internal",
    "plugin_ui_output_invalid",
  );
  f.state.actionOverride = { value: Infinity };
  await uiRejects(
    () =>
      f.service.invoke(uiTestActor, {
        mountRef: lease.mountRef,
        action: "echo",
        input: null,
      }),
    "internal",
    "plugin_ui_output_invalid",
  );
  f.state.package = {
    ...f.state.package,
    packageDigest: `sha256:${"b".repeat(64)}`,
  };
  await uiRejects(
    () => f.service.validateMount(uiTestActor, { mountRef: lease.mountRef }),
    "internal",
    "plugin_ui_output_invalid",
  );
});

test("catalog validates owner scope, bounded ordered pages and publication identities", async () => {
  const f = uiFixture();
  for (const page of [
    { selections: [{ ...uiTestSelection, profileId: "other" }], next: null },
    { selections: [uiTestSelection, uiTestSelection], next: null },
    { selections: [uiTestSelection], next: "wrong" },
  ]) {
    f.state.pageOverride = page;
    await uiRejects(
      () => f.service.catalog(uiTestActor, { afterPluginId: null, limit: 1 }),
      "internal",
      "plugin_ui_output_invalid",
    );
  }
  f.state.pageOverride = undefined;
  f.state.verifyOverride = {
    descriptor: { ...uiTestDescriptor, pluginId: "other.plugin" },
    publicAssets: ["ui.mjs"],
  };
  await uiRejects(
    () => f.service.catalog(uiTestActor, { afterPluginId: null, limit: 1 }),
    "internal",
    "plugin_ui_output_invalid",
  );
  f.state.verifyOverride = undefined;
  f.state.selection = parsePluginSelection({
    ...uiTestSelection,
    state: "disabled",
  });
  assert.deepEqual(
    (await f.service.catalog(uiTestActor, { afterPluginId: null, limit: 1 }))
      .plugins,
    [],
  );
  assert.equal(uiTestDigest, uiTestSelection.selectedPackageDigest);
});

test("actor and command snapshots cannot change while the trusted profile resolves", async () => {
  const f = uiFixture();
  const entered = uiDeferred();
  const release = uiDeferred();
  f.state.beforeProfile = async () => {
    entered.resolve();
    await release.promise;
  };
  const actor = { ...uiTestActor };
  const command: {
    pluginId: string;
    contributionId: string;
    expectedSelectionRevision: number;
    expectedPackageDigest: string;
  } = { ...uiTestMountCommand };
  const opening = f.service.openMount(actor, command);
  await entered.promise;
  actor.principalId = "other-principal";
  actor.tenantId = "foreign";
  command.pluginId = "other.plugin";
  command.expectedSelectionRevision = 99;
  f.state.beforeProfile = null;
  release.resolve();
  const lease = await opening;
  assert.equal(lease.descriptor.pluginId, "example.story");
  assert.ok(
    f.state.contexts.every(
      (context) => context.actor.principalId === uiTestActor.principalId,
    ),
  );
  assert.equal(
    await f.service.validateMount(uiTestActor, { mountRef: lease.mountRef }),
    lease,
  );
});

test("a profile change while the final authorization awaits is rejected", async () => {
  const f = uiFixture();
  const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
  f.state.beforeAuthorize = async () => {
    f.state.scope = { ...f.state.scope, profileId: "other-profile" };
  };
  await uiRejects(
    () => f.service.validateMount(uiTestActor, { mountRef: lease.mountRef }),
    "authorization",
    "plugin_ui_profile_changed",
  );
  f.state.beforeAuthorize = null;
  f.state.scope = { ...f.state.scope, profileId: "profile-a" };
  await uiRejects(
    () => f.service.validateMount(uiTestActor, { mountRef: lease.mountRef }),
    "notFound",
    "plugin_ui_mount_unavailable",
  );
});

test("asset and invoke policies are evaluated separately without replacing mount authority", async () => {
  const f = uiFixture();
  const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
  f.state.allowed.delete("asset");
  f.state.allowed.delete("invoke");
  await uiRejects(
    () =>
      f.service.readAsset(uiTestActor, {
        mountRef: lease.mountRef,
        path: "ui.mjs",
      }),
    "authorization",
    "plugin_ui_authorization_denied",
  );
  await uiRejects(
    () =>
      f.service.invoke(uiTestActor, {
        mountRef: lease.mountRef,
        action: "echo",
        input: null,
      }),
    "authorization",
    "plugin_ui_authorization_denied",
  );
  assert.equal(f.state.calls.includes("read"), false);
  assert.equal(f.state.calls.includes("invoke"), false);
  assert.equal(
    await f.service.validateMount(uiTestActor, { mountRef: lease.mountRef }),
    lease,
  );
});

test("byte limits reject the declared asset before host IO and copied bytes survive later awaits", async () => {
  const limited = uiFixture({ mounts: 1, ttlMs: 1000, assetBytes: 1 });
  const limitedLease = await limited.service.openMount(
    uiTestActor,
    uiTestMountCommand,
  );
  await uiRejects(
    () =>
      limited.service.readAsset(uiTestActor, {
        mountRef: limitedLease.mountRef,
        path: "ui.mjs",
      }),
    "validation",
    "plugin_ui_asset_limit",
  );
  assert.equal(limited.state.calls.includes("read"), false);
  const f = uiFixture();
  const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
  const bytes = Uint8Array.from(uiTestBytes);
  f.state.readOverride = { bytes, contentType: "text/javascript" };
  f.state.beforeAuthorize = async () => {
    if (f.state.calls.includes("read")) bytes.fill(0);
  };
  const result = await f.service.readAsset(uiTestActor, {
    mountRef: lease.mountRef,
    path: "ui.mjs",
  });
  assert.deepEqual(result.bytes, uiTestBytes);
  assert.ok(bytes.every((value) => value === 0));
});

test("host output getters and malformed content types are rejected without evaluation", async () => {
  const f = uiFixture();
  const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
  let getters = 0;
  const result = { contentType: "text/javascript" };
  Object.defineProperty(result, "bytes", {
    enumerable: true,
    get() {
      getters++;
      return uiTestBytes;
    },
  });
  f.state.readOverride = result;
  await uiRejects(
    () =>
      f.service.readAsset(uiTestActor, {
        mountRef: lease.mountRef,
        path: "ui.mjs",
      }),
    "internal",
    "plugin_ui_output_invalid",
  );
  assert.equal(getters, 0);
  f.state.readOverride = {
    bytes: uiTestBytes,
    contentType: "text/javascript\r\nx-injected: yes",
  };
  await uiRejects(
    () =>
      f.service.readAsset(uiTestActor, {
        mountRef: lease.mountRef,
        path: "ui.mjs",
      }),
    "internal",
    "plugin_ui_output_invalid",
  );
});
