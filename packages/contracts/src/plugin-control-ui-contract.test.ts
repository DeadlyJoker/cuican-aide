import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PLUGIN_CONTROL_RESPONSE_BYTES,
  MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES,
  MAX_PLUGIN_UI_CATALOG_RESPONSE_BYTES,
  parsePluginControlAssetPath,
  parsePluginSelectionListQuery,
  parseInvokePluginUiActionRequest,
  parsePluginUiCatalogResponse,
  parseOpenPluginUiMountResponse,
  parseValidatePluginUiMountResponse,
  parseClosePluginUiMountResponse,
  parseInvokePluginUiActionResponse,
  parseGetPluginPackageResponse,
} from "./plugin-control-contract.ts";
import {
  ID,
  DIGEST,
  OTHER_DIGEST,
  pkg,
  openRequest,
  lease,
  catalogItem,
  rejected,
} from "./plugin-control-contract.test-support.ts";

test("mount responses reuse the strict lease contract and bind plugin/contribution/revision/digest/reference", () => {
  const source = lease();
  const parsed = parseOpenPluginUiMountResponse(source, openRequest());
  source.publicAssets.pop();
  assert.equal(parsed.publicAssets.length, 2);
  assert.ok(Object.isFrozen(parsed.descriptor.files));
  assert.ok(
    parseValidatePluginUiMountResponse(lease(), { mountRef: lease().mountRef }),
  );
  for (const context of [
    { ...openRequest(), pluginId: "other.plugin" },
    { ...openRequest(), contributionId: "other" },
    { ...openRequest(), expectedSelectionRevision: 2 },
    { ...openRequest(), expectedPackageDigest: OTHER_DIGEST },
  ])
    rejected(() => parseOpenPluginUiMountResponse(lease(), context));
  rejected(() =>
    parseValidatePluginUiMountResponse(lease(), { mountRef: "x".repeat(32) }),
  );
  rejected(() =>
    parseOpenPluginUiMountResponse(
      { ...lease(), profileId: "private" },
      openRequest(),
    ),
  );
  rejected(() =>
    parseOpenPluginUiMountResponse(
      { ...lease(), publicAssets: ["ui/entry.mjs", "private.js"] },
      openRequest(),
    ),
  );
});

test("catalog pagination accepts filtered empty pages but refuses duplicate or unsupported modules", () => {
  const query = parsePluginSelectionListQuery({ limit: "2" });
  assert.deepEqual(
    parsePluginUiCatalogResponse({ plugins: [], next: "z.disabled" }, query),
    { plugins: [], next: "z.disabled" },
  );
  const valid = { plugins: [catalogItem()], next: "z.unsupported" };
  assert.deepEqual(parsePluginUiCatalogResponse(valid, query), valid);
  rejected(() =>
    parsePluginUiCatalogResponse(
      { plugins: [catalogItem(), catalogItem()], next: null },
      query,
    ),
  );
  rejected(() =>
    parsePluginUiCatalogResponse(
      { plugins: [catalogItem()], next: "a.before" },
      query,
    ),
  );
  rejected(() =>
    parsePluginUiCatalogResponse(
      { plugins: [], next: ID },
      { ...query, afterPluginId: ID },
    ),
  );
  const isolated = catalogItem();
  isolated.descriptor.entrypoints.ui.mode = "isolatedWeb";
  isolated.descriptor.entrypoints.ui.path = "ui/entry.html";
  isolated.descriptor.files[1]!.path = "ui/entry.html";
  isolated.publicAssets[0] = "ui/entry.html";
  rejected(() =>
    parsePluginUiCatalogResponse({ plugins: [isolated], next: null }, query),
  );
  rejected(() =>
    parsePluginUiCatalogResponse(
      {
        plugins: [{ ...catalogItem(), publicAssets: ["node.mjs"] }],
        next: null,
      },
      query,
    ),
  );
});

test("asset paths preserve nested Unicode inventory paths and reject traversal or encoding aliases", () => {
  assert.equal(
    parsePluginControlAssetPath("ui/chunks/组件.mjs"),
    "ui/chunks/组件.mjs",
  );
  for (const path of [
    "/ui/entry.mjs",
    "ui/",
    "ui//entry.mjs",
    "../entry.mjs",
    "ui/./entry.mjs",
    "ui/../entry.mjs",
    "ui%2Fentry.mjs",
    "ui/%252e.mjs",
    "https://other.example/entry.js",
    "C:/entry.mjs",
    "ui\\entry.mjs",
    "ui/entry.mjs?token=secret",
    "ui/entry.mjs#hash",
    "ui/x\u0085.js",
    "ui/x\u200b.js",
    "ui/x\ud800.js",
    "中".repeat(86),
  ])
    rejected(() => parsePluginControlAssetPath(path));
  assert.equal(parsePluginControlAssetPath("a".repeat(256)).length, 256);
});

test("action JSON uses distinct input/output bounds and detaches without granting JSON identity fields", () => {
  const source = {
    action: "save",
    input: { actor: "ordinary-data-not-authority", nested: ["x"] },
  };
  const parsed = parseInvokePluginUiActionRequest(source);
  source.input.nested[0] = "changed";
  assert.deepEqual(parsed.input, {
    actor: "ordinary-data-not-authority",
    nested: ["x"],
  });
  assert.ok(Object.isFrozen(parsed.input));
  assert.ok(
    parseInvokePluginUiActionRequest({
      action: "save",
      input: "x".repeat(24574),
    }),
  );
  rejected(() =>
    parseInvokePluginUiActionRequest({
      action: "save",
      input: "x".repeat(24575),
    }),
  );
  assert.ok(parseInvokePluginUiActionResponse({ output: "x".repeat(65534) }));
  rejected(() =>
    parseInvokePluginUiActionResponse({ output: "x".repeat(65535) }),
  );
  const sparse = new Array(2);
  const cycle: unknown[] = [];
  cycle.push(cycle);
  for (const input of [
    sparse,
    cycle,
    { x: undefined },
    Object.create({ value: "inherited" }),
    "bad\ud800",
  ])
    rejected(() => parseInvokePluginUiActionRequest({ action: "save", input }));
  let reads = 0;
  const getter = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      reads++;
      return "unsafe";
    },
  });
  rejected(() =>
    parseInvokePluginUiActionRequest({ action: "save", input: getter }),
  );
  assert.equal(reads, 0);
  assert.deepEqual(parseClosePluginUiMountResponse({ closed: true }), {
    closed: true,
  });
  rejected(() => parseClosePluginUiMountResponse({ closed: false }));
  rejected(() =>
    parseClosePluginUiMountResponse({ closed: true, actor: "private" }),
  );
});

test("lease/catalog budgets exceed ordinary replies while all envelopes remain strictly bounded", () => {
  const big = lease();
  for (let i = 0; i < 300; i++) {
    const path = `ui/${String(i).padStart(3, "0")}-${"x".repeat(180)}.mjs`;
    big.descriptor.files.push({ path, byteLength: 1, sha256: "d".repeat(64) });
    big.publicAssets.push(path);
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(big)) > MAX_PLUGIN_CONTROL_RESPONSE_BYTES,
  );
  assert.ok(parseOpenPluginUiMountResponse(big, openRequest()));
  const { descriptor, publicAssets, selectionRevision, packageDigest } = big;
  assert.ok(
    parsePluginUiCatalogResponse(
      {
        plugins: [
          { descriptor, publicAssets, selectionRevision, packageDigest },
        ],
        next: null,
      },
      parsePluginSelectionListQuery({}),
    ),
  );
  rejected(
    () =>
      parseGetPluginPackageResponse(
        { package: pkg(), huge: "x".repeat(MAX_PLUGIN_CONTROL_RESPONSE_BYTES) },
        { packageDigest: DIGEST },
      ),
    "plugin_control_json_bytes_exceeded",
  );
  rejected(
    () =>
      parseOpenPluginUiMountResponse(
        { ...lease(), huge: "x".repeat(MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES) },
        openRequest(),
      ),
    "plugin_control_json_bytes_exceeded",
  );
  rejected(
    () =>
      parsePluginUiCatalogResponse(
        {
          plugins: [],
          next: null,
          huge: "x".repeat(MAX_PLUGIN_UI_CATALOG_RESPONSE_BYTES),
        },
        parsePluginSelectionListQuery({}),
      ),
    "plugin_control_json_bytes_exceeded",
  );
});
