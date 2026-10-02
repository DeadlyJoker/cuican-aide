import assert from "node:assert/strict";
import {
  access,
  chmod,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { LocalPluginUiPackageReader } from "./plugin-ui-package-reader.ts";
import {
  UI_PUBLIC_FILES,
  uiReaderFixture,
} from "./plugin-ui-package-reader.test-support.ts";

test("actual installed UI entry, dependency chunk, CSS, image and font bytes remain readable after developer source deletion", async (t) => {
  const f = await uiReaderFixture(t);
  await rm(f.source, { recursive: true });
  const verified = await f.reader.verify(f.context);
  assert.deepEqual(verified.publicAssets, [...UI_PUBLIC_FILES].sort());
  assert.ok(Object.isFrozen(verified));
  assert.ok(Object.isFrozen(verified.descriptor));
  assert.ok(Object.isFrozen(verified.publicAssets));
  const mime = new Map([
    ["ui/main.mjs", "text/javascript; charset=utf-8"],
    ["ui/chunk.mjs", "text/javascript; charset=utf-8"],
    ["ui/style.css", "text/css; charset=utf-8"],
    ["assets/photo.png", "image/png"],
    ["assets/font.woff2", "font/woff2"],
  ]);
  const lease = f.lease(verified.publicAssets);
  for (const path of verified.publicAssets) {
    const asset = await f.reader.readAsset({ ...f.context, lease, path });
    assert.deepEqual(Buffer.from(asset.bytes), f.files.get(path));
    assert.equal(asset.contentType, mime.get(path));
  }
  await assert.rejects(access(f.marker));
});

test("private Node/metadata and undeclared or URL paths are never implicitly browser-public", async (t) => {
  const f = await uiReaderFixture(t);
  const lease = f.lease();
  for (const path of [
    "private/server.mjs",
    "private/business.json",
    "ui/state.json",
    "assets/custom.bin",
    "crewon.plugin.json",
    "missing.mjs",
  ])
    await assert.rejects(f.reader.readAsset({ ...f.context, lease, path }), {
      code: "plugin_ui_asset_not_public",
    });
  for (const path of [
    "../ui/main.mjs",
    "/ui/main.mjs",
    "ui/%2e%2e/main.mjs",
    "https://example.test/ui/main.mjs",
    "ui/main.mjs?x",
    "ui//main.mjs",
    "ui/./main.mjs",
    "ui\\main.mjs",
    "ui/\u0085main.mjs",
  ])
    await assert.rejects(f.reader.readAsset({ ...f.context, lease, path }), {
      code: "plugin_ui_asset_path_invalid",
    });
  assert.equal(f.policy.calls, 0);
  await assert.rejects(access(f.marker));
});

test("only explicit publication allows JSON/custom bytes and omitting the entry fails closed", async (t) => {
  const f = await uiReaderFixture(t);
  f.policy.assets.push("ui/state.json", "assets/custom.bin");
  const verified = await f.reader.verify(f.context);
  const lease = f.lease(verified.publicAssets);
  assert.equal(
    (await f.reader.readAsset({ ...f.context, lease, path: "ui/state.json" }))
      .contentType,
    "application/json; charset=utf-8",
  );
  assert.equal(
    (
      await f.reader.readAsset({
        ...f.context,
        lease,
        path: "assets/custom.bin",
      })
    ).contentType,
    "application/octet-stream",
  );
  f.policy.assets = [];
  await assert.rejects(f.reader.verify(f.context), {
    code: "plugin_ui_publication_denied",
  });
});

test("fixed profile, actor tenancy, enabled state and installed identity reject forged contexts", async (t) => {
  const f = await uiReaderFixture(t);
  const variants = [
    { ...f.context, scope: { ...f.context.scope, profileId: "other-profile" } },
    { ...f.context, actor: { ...f.context.actor, tenantId: "other-tenant" } },
    { ...f.context, selection: { ...f.context.selection, state: "disabled" } },
    {
      ...f.context,
      selection: { ...f.context.selection, publisherId: "other.publisher" },
    },
    {
      ...f.context,
      package: { ...f.context.package, profileId: "other-profile" },
    },
    { ...f.context, package: { ...f.context.package, version: "2.0.0" } },
    {
      ...f.context,
      package: { ...f.context.package, publisherId: "other.publisher" },
    },
  ];
  for (const value of variants)
    await assert.rejects(f.reader.verify(value as typeof f.context));
  assert.equal(f.policy.calls, 0);
});

test("lease revision and exact descriptor pin cannot select another package or contribution", async (t) => {
  const f = await uiReaderFixture(t);
  const lease = f.lease();
  for (const altered of [
    { ...lease, selectionRevision: 3 },
    { ...lease, packageDigest: "sha256:" + "a".repeat(64) },
    { ...lease, descriptor: { ...lease.descriptor, version: "2.0.0" } },
    {
      ...lease,
      descriptor: { ...lease.descriptor, title: "Tampered metadata" },
    },
    { ...lease, contributionId: "another" },
  ])
    await assert.rejects(
      f.reader.readAsset({ ...f.context, lease: altered, path: "ui/main.mjs" }),
    );
  assert.equal(f.policy.calls, 0);
});

test("isolatedWeb and unsupported slots are refused before any publication callback", async (t) => {
  const isolated = await uiReaderFixture(t, { mode: "isolatedWeb" });
  await assert.rejects(isolated.reader.verify(isolated.context), {
    code: "plugin_ui_mode_unsupported",
  });
  assert.equal(isolated.policy.calls, 0);
  const settings = await uiReaderFixture(t, { noModule: true });
  await assert.rejects(settings.reader.verify(settings.context), {
    code: "plugin_ui_contribution_unsupported",
  });
  assert.equal(settings.policy.calls, 0);
});

test("changed dependency bytes and package/directory links reject the whole installed package", async (t) => {
  const f = await uiReaderFixture(t);
  const chunk = join(f.target, "ui/chunk.mjs");
  await chmod(chunk, 0o600);
  await writeFile(chunk, Buffer.alloc(f.files.get("ui/chunk.mjs")!.length, 1));
  await assert.rejects(
    f.reader.readAsset({ ...f.context, lease: f.lease(), path: "ui/main.mjs" }),
    { code: "plugin_package_file_digest_mismatch" },
  );
  await writeFile(chunk, f.files.get("ui/chunk.mjs")!);
  const ui = join(f.target, "ui");
  await chmod(f.target, 0o700);
  await chmod(ui, 0o700);
  await rename(ui, join(f.root, "linked-ui"));
  await symlink(join(f.root, "linked-ui"), ui);
  await assert.rejects(f.reader.verify(f.context), {
    code: "plugin_package_file_type_invalid",
  });
  await rm(ui);
  await rename(join(f.root, "linked-ui"), ui);
  await assert.rejects(access(f.marker));
});

test("publication revoked between actual read and final policy check cannot return bytes", async (t) => {
  const f = await uiReaderFixture(t);
  const lease = f.lease();
  f.policy.hook = () => {
    if (f.policy.calls === 2) f.policy.assets = ["ui/main.mjs"];
  };
  await assert.rejects(
    f.reader.readAsset({ ...f.context, lease, path: "assets/photo.png" }),
    { code: "plugin_ui_publication_changed" },
  );
  assert.equal(f.policy.calls, 2);
});

test("actual bytes are reverified after asynchronous publication instead of trusting an earlier hash", async (t) => {
  const f = await uiReaderFixture(t);
  f.policy.hook = async () => {
    const asset = join(f.target, "assets/photo.png");
    await chmod(asset, 0o600);
    await writeFile(
      asset,
      Buffer.alloc(f.files.get("assets/photo.png")!.length, 2),
    );
  };
  await assert.rejects(f.reader.verify(f.context), {
    code: "plugin_package_file_digest_mismatch",
  });
});

test("getter inputs/publication and mutable caller contexts cannot replace captured profile or identity", async (t) => {
  const f = await uiReaderFixture(t);
  let getters = 0;
  const accessor = Object.defineProperty({ ...f.context }, "actor", {
    enumerable: true,
    get() {
      getters++;
      return f.context.actor;
    },
  });
  await assert.rejects(f.reader.verify(accessor), {
    code: "plugin_ui_package_input_invalid",
  });
  assert.equal(getters, 0);
  const assets = [...UI_PUBLIC_FILES];
  Object.defineProperty(assets, "0", {
    enumerable: true,
    get() {
      getters++;
      return "ui/main.mjs";
    },
  });
  f.policy.result = assets;
  await assert.rejects(f.reader.verify(f.context), {
    code: "plugin_ui_publication_result_invalid",
  });
  assert.equal(getters, 0);
  f.policy.result = undefined;
  const mutable = {
    actor: { ...f.context.actor },
    scope: { ...f.context.scope },
    selection: { ...f.context.selection },
    package: { ...f.context.package },
  };
  f.policy.hook = (input) => {
    mutable.actor.principalId = "another";
    mutable.scope.profileId = "another";
    mutable.package.version = "2.0.0";
    assert.equal(input.actor.principalId, f.context.actor.principalId);
    assert.equal(input.scope.profileId, f.context.scope.profileId);
    assert.equal(input.package.version, "1.0.0");
    assert.ok(Object.isFrozen(input));
    assert.ok(Object.isFrozen(input.descriptor));
  };
  assert.equal((await f.reader.verify(mutable)).descriptor.version, "1.0.0");
});

test("unknown, duplicated or undeclared publication members are invalid rather than widening access", async (t) => {
  const f = await uiReaderFixture(t);
  for (const result of [
    ["ui/main.mjs", "unknown"],
    ["ui/main.mjs", "ui/main.mjs"],
    ["ui/main.mjs", "crewon.plugin.json"],
    new Array(2),
    { 0: "ui/main.mjs", length: 1 },
  ]) {
    f.policy.result = result;
    await assert.rejects(f.reader.verify(f.context), {
      code: "plugin_ui_publication_result_invalid",
    });
  }
});

test("a valid installed large artifact still exceeds this reader's independent 32MiB policy", async (t) => {
  const f = await uiReaderFixture(t, { largeAsset: true });
  f.policy.assets.push("assets/large.bin");
  await assert.rejects(f.reader.verify(f.context), {
    code: "plugin_package_file_limit",
  });
  assert.equal(f.policy.calls, 0);
});

test("publication authority is mandatory and writable host roots are refused", async (t) => {
  const f = await uiReaderFixture(t);
  assert.throws(
    () =>
      new LocalPluginUiPackageReader({
        profile: f.context.scope,
        installRoot: f.installRoot,
        authorizePublication: undefined!,
      }),
    { code: "plugin_ui_publication_policy_missing" },
  );
  await chmod(f.installRoot, 0o777);
  await assert.rejects(f.reader.verify(f.context), {
    code: "plugin_ui_install_root_invalid",
  });
  assert.equal(f.policy.calls, 0);
});
