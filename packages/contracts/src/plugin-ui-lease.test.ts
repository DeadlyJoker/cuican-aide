import assert from "node:assert/strict";
import test from "node:test";
import {
  PluginUiContractError,
  parsePluginUiJsonValue,
  parsePluginUiLease,
} from "@crewon/contracts/plugins";
import * as defaultContracts from "./index.ts";

function lease() {
  return {
    schemaVersion: "crewon.plugin-ui-lease.v1",
    mountRef: "host-issued-unique-reference-00001",
    expiresAt: "2026-10-02T10:00:00.000Z",
    selectionRevision: 3,
    packageDigest: `sha256:${"a".repeat(64)}`,
    descriptor: {
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId: "example.story",
      version: "1.0.0",
      title: "Story",
      description: "An independently built UI module.",
      publisherId: "example.publisher",
      entrypoints: {
        node: "node.mjs",
        ui: { mode: "trustedModule", path: "ui/entry.mjs" },
      },
      businessManifestPath: null,
      requires: [],
      provides: [],
      contributions: [
        { id: "studio", kind: "module", slot: "main.content", title: "Studio" },
        {
          id: "settings",
          kind: "settings",
          slot: "settings.section",
          title: "Settings",
        },
      ],
      files: [
        { path: "node.mjs", byteLength: 20, sha256: "b".repeat(64) },
        { path: "ui/entry.mjs", byteLength: 50, sha256: "c".repeat(64) },
        { path: "ui/helper.mjs", byteLength: 10, sha256: "d".repeat(64) },
      ],
    },
    contributionId: "studio",
    publicAssets: ["ui/entry.mjs", "ui/helper.mjs"],
  };
}

function rejected(operation: () => unknown, code: string) {
  assert.throws(
    operation,
    (error: unknown) =>
      error instanceof PluginUiContractError && error.code === code,
  );
}

test("UI lease is a detached strict metadata snapshot on the intentional plugins entrypoint", () => {
  const source = lease();
  const parsed = parsePluginUiLease(source);
  assert.deepEqual(parsed, source);
  source.publicAssets.pop();
  source.descriptor.files[0]!.path = "changed.mjs";
  assert.equal(parsed.publicAssets.length, 2);
  assert.equal(parsed.descriptor.files[0]!.path, "node.mjs");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.descriptor.files[0]));
  assert.ok(Object.isFrozen(parsed.publicAssets));
  assert.equal("parsePluginUiLease" in defaultContracts, false);
  assert.equal("scope" in parsed, false);
  assert.equal("actor" in parsed, false);
});

test("UI lease validates opaque references, revisions, exact digests and canonical expiration", () => {
  for (const ref of ["short", "/".repeat(32), "a".repeat(129)])
    rejected(
      () => parsePluginUiLease({ ...lease(), mountRef: ref }),
      "plugin_ui_mount_ref_invalid",
    );
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"])
    rejected(
      () => parsePluginUiLease({ ...lease(), selectionRevision: revision }),
      "plugin_ui_selection_revision_invalid",
    );
  for (const digest of [
    "a".repeat(64),
    `sha256:${"A".repeat(64)}`,
    "sha256:abc",
  ])
    rejected(
      () => parsePluginUiLease({ ...lease(), packageDigest: digest }),
      "plugin_ui_package_digest_invalid",
    );
  for (const expiresAt of [
    "2026-10-02",
    "2026-10-02T10:00:00Z",
    "2026-02-30T10:00:00.000Z",
  ])
    rejected(
      () => parsePluginUiLease({ ...lease(), expiresAt }),
      "plugin_ui_expiry_invalid",
    );
  // Clock freshness is deliberately a host authorization check, not metadata validation.
  assert.ok(parsePluginUiLease(lease()));
});

test("UI lease cannot silently downgrade isolated modes or mount a different slot", () => {
  const isolated = lease();
  isolated.descriptor.entrypoints.ui.mode = "isolatedWeb";
  isolated.descriptor.entrypoints.ui.path = "ui/index.html";
  isolated.descriptor.files[1]!.path = "ui/index.html";
  isolated.publicAssets[0] = "ui/index.html";
  rejected(() => parsePluginUiLease(isolated), "plugin_ui_mode_unsupported");
  for (const contributionId of ["unknown", "settings"])
    rejected(
      () => parsePluginUiLease({ ...lease(), contributionId }),
      "plugin_ui_contribution_unsupported",
    );
});

test("UI publication is an explicit inventory subset containing its entrypoint", () => {
  for (const path of ["../node.mjs", "https://other.test/ui.js", "missing.js"])
    rejected(
      () =>
        parsePluginUiLease({
          ...lease(),
          publicAssets: ["ui/entry.mjs", path],
        }),
      "plugin_ui_public_asset_undeclared",
    );
  rejected(
    () => parsePluginUiLease({ ...lease(), publicAssets: ["ui/helper.mjs"] }),
    "plugin_ui_public_entrypoint_missing",
  );
  rejected(
    () =>
      parsePluginUiLease({
        ...lease(),
        publicAssets: ["ui/entry.mjs", "ui/entry.mjs"],
      }),
    "plugin_ui_public_asset_duplicate",
  );
  rejected(
    () => parsePluginUiLease({ ...lease(), publicAssets: [] }),
    "plugin_ui_public_assets_invalid",
  );
  rejected(
    () => parsePluginUiLease({ ...lease(), publicAssets: new Array(2) }),
    "plugin_ui_public_assets_invalid",
  );
  assert.deepEqual(parsePluginUiLease(lease()).publicAssets, [
    "ui/entry.mjs",
    "ui/helper.mjs",
  ]);
});

test("UI lease rejects extra authority fields and getters without evaluating them", () => {
  for (const extra of [
    { actor: "forged" },
    { profileId: "forged" },
    { entryUrl: "https://other.test" },
  ])
    rejected(
      () => parsePluginUiLease({ ...lease(), ...extra }),
      "plugin_ui_fields_invalid",
    );
  let calls = 0;
  const source = lease();
  Object.defineProperty(source, "mountRef", {
    enumerable: true,
    get() {
      calls++;
      return "a".repeat(32);
    },
  });
  rejected(
    () => parsePluginUiLease(source),
    "plugin_ui_data_property_required",
  );
  assert.equal(calls, 0);
  const assets = ["ui/entry.mjs"];
  Object.defineProperty(assets, "0", {
    enumerable: true,
    get() {
      calls++;
      return "ui/entry.mjs";
    },
  });
  rejected(
    () => parsePluginUiLease({ ...lease(), publicAssets: assets }),
    "plugin_ui_data_property_required",
  );
  assert.equal(calls, 0);
});

test("UI JSON deep copies repeated references and freezes data without invoking hooks", () => {
  const shared = { title: "故事", lines: ["scene"] };
  const copied = parsePluginUiJsonValue({ first: shared, second: shared });
  assert.deepEqual(copied, { first: shared, second: shared });
  shared.lines.push("mutated");
  assert.deepEqual(copied, {
    first: { title: "故事", lines: ["scene"] },
    second: { title: "故事", lines: ["scene"] },
  });
  assert.ok(Object.isFrozen(copied));
  let calls = 0;
  const getter = {
    get data() {
      calls++;
      return "secret";
    },
  };
  rejected(
    () => parsePluginUiJsonValue(getter),
    "plugin_ui_data_property_required",
  );
  rejected(
    () =>
      parsePluginUiJsonValue({
        toJSON() {
          calls++;
          return "secret";
        },
      }),
    "plugin_ui_json_invalid",
  );
  assert.equal(calls, 0);
  const dictionary = Object.create(null) as Record<string, unknown>;
  dictionary.__proto__ = { safe: true };
  assert.deepEqual(
    parsePluginUiJsonValue(dictionary),
    JSON.parse('{"__proto__":{"safe":true}}'),
  );
  assert.equal(({} as Record<string, unknown>).safe, undefined);
});

test("UI JSON rejects non-JSON values, sparse arrays, cycles and malformed Unicode", () => {
  for (const input of [
    NaN,
    Infinity,
    undefined,
    1n,
    new Date(),
    new Map(),
    () => 1,
    "\ud800",
    "\udc00",
  ])
    rejected(() => parsePluginUiJsonValue(input), "plugin_ui_json_invalid");
  rejected(
    () => parsePluginUiJsonValue(new Array(2)),
    "plugin_ui_json_invalid",
  );
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  rejected(() => parsePluginUiJsonValue(cycle), "plugin_ui_json_cycle");
  const symbol = { [Symbol("hidden")]: "value" };
  rejected(() => parsePluginUiJsonValue(symbol), "plugin_ui_json_invalid");
  const hidden = Object.defineProperty({}, "value", { value: "secret" });
  rejected(
    () => parsePluginUiJsonValue(hidden),
    "plugin_ui_data_property_required",
  );
});

test("UI JSON bounds bytes, depth and nodes while preserving legitimate long briefs", () => {
  assert.equal(parsePluginUiJsonValue("👍", { maxBytes: 6 }), "👍");
  rejected(
    () => parsePluginUiJsonValue("👍", { maxBytes: 5 }),
    "plugin_ui_json_bytes_exceeded",
  );
  rejected(
    () => parsePluginUiJsonValue("中".repeat(24000)),
    "plugin_ui_json_bytes_exceeded",
  );
  assert.equal(
    parsePluginUiJsonValue("a\n".repeat(4096), { maxBytes: 24576 }),
    "a\n".repeat(4096),
  );
  let nested: unknown = null;
  for (let i = 0; i < 17; i++) nested = [nested];
  rejected(
    () => parsePluginUiJsonValue(nested),
    "plugin_ui_json_complexity_exceeded",
  );
  rejected(
    () => parsePluginUiJsonValue(Array.from({ length: 8192 }, () => null)),
    "plugin_ui_json_complexity_exceeded",
  );
  for (const maxBytes of [0, -1, 1.1, 65537])
    rejected(
      () => parsePluginUiJsonValue(null, { maxBytes }),
      "plugin_ui_json_limit_invalid",
    );
});

test("UI JSON counts UTF-8, escapes, numbers and container punctuation at the exact byte boundary", () => {
  const escaped = '"\\\b\t\n\f\r\u0000\u001f/';
  const unicode =
    "\u007f\u0080\u07ff\u0800\ud7ff\ue000中👍\u{10ffff}\u2028\u2029";
  for (const input of [
    null,
    true,
    false,
    -0,
    -12.25,
    1e21,
    1e-7,
    "",
    escaped,
    unicode,
    [],
    {},
    [null, false, escaped, unicode],
    { [escaped]: unicode, "键👍": [true, { nested: -0 }] },
  ]) {
    const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    assert.deepEqual(parsePluginUiJsonValue(input, { maxBytes: bytes }), input);
    if (bytes > 1)
      rejected(
        () => parsePluginUiJsonValue(input, { maxBytes: bytes - 1 }),
        "plugin_ui_json_bytes_exceeded",
      );
  }
  rejected(
    () => parsePluginUiJsonValue({ "\ud800": null }),
    "plugin_ui_json_invalid",
  );
});

test("UI JSON stops on aggregate excess before inspecting later array or object accessors", () => {
  let calls = 0;
  const repeated = "a".repeat(12);
  const array: unknown[] = [repeated, repeated, null];
  Object.defineProperty(array, "2", {
    enumerable: true,
    get() {
      calls++;
      return "unreachable";
    },
  });
  const object = { a: repeated, b: repeated };
  Object.defineProperty(object, "last", {
    enumerable: true,
    get() {
      calls++;
      return "unreachable";
    },
  });
  for (const input of [array, object])
    rejected(
      () => parsePluginUiJsonValue(input, { maxBytes: 30 }),
      "plugin_ui_json_bytes_exceeded",
    );
  assert.equal(calls, 0);
});

test("UI JSON rejects an oversized key before its accessor and bounds long strings without hooks", () => {
  let calls = 0;
  const object = Object.defineProperty({}, "a".repeat(40), {
    enumerable: true,
    get() {
      calls++;
      return "unreachable";
    },
  });
  rejected(
    () => parsePluginUiJsonValue(object, { maxBytes: 16 }),
    "plugin_ui_json_bytes_exceeded",
  );
  rejected(
    () => parsePluginUiJsonValue("a".repeat(16), { maxBytes: 16 }),
    "plugin_ui_json_bytes_exceeded",
  );
  rejected(
    () => parsePluginUiJsonValue("a".repeat(17), { maxBytes: 16 }),
    "plugin_ui_json_invalid",
  );
  assert.equal(calls, 0);
});
