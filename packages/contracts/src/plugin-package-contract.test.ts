import assert from "node:assert/strict";
import test from "node:test";
import {
  PLUGIN_PACKAGE_DESCRIPTOR_PATH,
  PLUGIN_PACKAGE_HOST_API,
  PLUGIN_PACKAGE_LIMITS,
  PLUGIN_PACKAGE_SCHEMA_VERSION,
  PluginPackageContractError,
  parsePluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import * as defaultContracts from "./index.ts";

function fixture() {
  return {
    schemaVersion: PLUGIN_PACKAGE_SCHEMA_VERSION,
    hostApi: PLUGIN_PACKAGE_HOST_API,
    pluginId: "example.short-drama",
    version: "1.2.3-beta.1+build.007",
    title: "AI 短剧工作台",
    description: "需求和概念图的业务模块。\n产物与外部生成服务分开声明。",
    publisherId: "example.publisher",
    entrypoints: {
      node: "dist/node.mjs" as string | null,
      ui: { path: "dist/ui.js", mode: "trustedModule" },
    },
    businessManifestPath: "business/manifest.json" as string | null,
    requires: [
      { service: "crewon.task", apiVersion: "crewon.task.v1", optional: false },
    ],
    provides: [{ service: "example.story-brief", apiVersion: "1" }],
    contributions: [
      {
        id: "workbench",
        kind: "module",
        slot: "main.content",
        title: "AI 短剧",
      },
      {
        id: "service-settings",
        kind: "settings",
        slot: "settings.section",
        title: "生成服务",
      },
      { id: "concept", kind: "result", slot: "result.view", title: "概念图" },
    ],
    files: [
      { path: "dist/node.mjs", byteLength: 10, sha256: "a".repeat(64) },
      { path: "dist/ui.js", byteLength: 20, sha256: "b".repeat(64) },
      {
        path: "business/manifest.json",
        byteLength: 30,
        sha256: "c".repeat(64),
      },
      { path: "assets/封面.png", byteLength: 0, sha256: "d".repeat(64) },
    ],
  };
}
function rejected(input: unknown, code?: string) {
  assert.throws(
    () => parsePluginPackageDescriptor(input),
    (error: unknown) =>
      error instanceof PluginPackageContractError &&
      (!code || error.code === code),
  );
}

test("the intentional plugins entrypoint exposes metadata without changing the default API", () => {
  assert.equal(PLUGIN_PACKAGE_SCHEMA_VERSION, "crewon.plugin-package.v1");
  assert.equal(PLUGIN_PACKAGE_HOST_API, "crewon.plugin-host.v1");
  assert.equal(PLUGIN_PACKAGE_DESCRIPTOR_PATH, "crewon.plugin.json");
  assert.equal("parsePluginPackageDescriptor" in defaultContracts, false);
  assert.equal("PLUGIN_PACKAGE_HOST_API" in defaultContracts, false);
});

test("parses a detached deeply immutable declaration and never claims actual byte verification", () => {
  const input = fixture();
  const parsed = parsePluginPackageDescriptor(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.files, input.files);
  for (const value of [
    parsed,
    parsed.entrypoints,
    parsed.entrypoints.ui,
    parsed.files,
    ...parsed.files,
    parsed.requires,
    ...parsed.requires,
    parsed.provides,
    ...parsed.provides,
    parsed.contributions,
    ...parsed.contributions,
  ])
    assert.ok(Object.isFrozen(value));
  input.files[0]!.sha256 = "f".repeat(64);
  input.requires[0]!.apiVersion = "unavailable.v9";
  input.title = "被调用者修改";
  assert.equal(parsed.title, "AI 短剧工作台");
  assert.equal(parsed.files[0]!.sha256, "a".repeat(64));
  assert.equal(parsed.requires[0]!.apiVersion, "crewon.task.v1");
  // An arbitrary well-formed checksum is accepted: this parser has no artifact bytes.
  assert.equal(
    parsePluginPackageDescriptor(fixture()).files[0]!.sha256,
    "a".repeat(64),
  );
});

test("accepts Node-only, isolated UI and shared isomorphic entry artifacts", () => {
  const nodeOnly = fixture();
  assert.equal(
    parsePluginPackageDescriptor({
      ...nodeOnly,
      entrypoints: { node: "dist/node.mjs", ui: null },
      contributions: [],
      businessManifestPath: null,
    }).entrypoints.ui,
    null,
  );
  const isolated = fixture();
  isolated.files.push({
    path: "ui/index.html",
    byteLength: 4,
    sha256: "e".repeat(64),
  });
  assert.equal(
    parsePluginPackageDescriptor({
      ...isolated,
      entrypoints: {
        node: null,
        ui: { path: "ui/index.html", mode: "isolatedWeb" },
      },
    }).entrypoints.ui?.mode,
    "isolatedWeb",
  );
  const shared = fixture();
  assert.equal(
    parsePluginPackageDescriptor({
      ...shared,
      entrypoints: {
        node: "dist/ui.js",
        ui: { path: "dist/ui.js", mode: "trustedModule" },
      },
    }).entrypoints.node,
    "dist/ui.js",
  );
});

test("requires explicit nullable branches and at least one usable entrypoint declaration", () => {
  for (const entrypoints of [
    null,
    {},
    { node: null, ui: null },
    { node: "dist/node.mjs" },
    { node: "dist/node.mjs", ui: undefined },
    { node: null, ui: { path: "dist/ui.js", mode: "remote" } },
  ])
    rejected({ ...fixture(), entrypoints });
  rejected(
    { ...fixture(), entrypoints: { node: "dist/node.mjs", ui: null } },
    "plugin_package_ui_entrypoint_missing",
  );
  rejected(
    { ...fixture(), contributions: [] },
    "plugin_package_ui_contribution_missing",
  );
  rejected(
    {
      ...fixture(),
      entrypoints: { node: "dist/node.cjs", ui: null },
      contributions: [],
    },
    "plugin_package_module_path_invalid",
  );
  rejected(
    {
      ...fixture(),
      entrypoints: {
        node: null,
        ui: { path: "dist/ui.js", mode: "isolatedWeb" },
      },
    },
    "plugin_package_ui_path_invalid",
  );
  rejected(
    { ...fixture(), businessManifestPath: "business/manifest.yaml" },
    "plugin_package_business_manifest_path_invalid",
  );
});

test("accepts exact SemVer including prerelease and build, rejecting ranges and numeric zero aliases", () => {
  for (const version of [
    "0.0.0",
    "1.2.3",
    "1.2.3-0",
    "1.2.3-alpha.0",
    "1.2.3-01a",
    "1.2.3+001.a",
    "1.2.3-rc.10+release-1",
  ])
    assert.equal(
      parsePluginPackageDescriptor({ ...fixture(), version }).version,
      version,
    );
  for (const version of [
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3-a.00",
    "1.2",
    "v1.2.3",
    "^1.2.3",
    "*",
    "1.2.3-",
    "1.2.3+",
    "1.2.3-a..b",
    "1.2.3+a..b",
    "1.2.3+ab_cd",
    "1.2.3 ",
  ])
    rejected({ ...fixture(), version });
});

test("rejects version drift and unknown fields at every fixed boundary", () => {
  rejected(
    { ...fixture(), schemaVersion: "crewon.plugin-package.v2" },
    "plugin_package_schema_unsupported",
  );
  rejected(
    { ...fixture(), hostApi: "crewon.plugin-host.v0" },
    "plugin_package_host_api_unsupported",
  );
  const input = fixture();
  for (const patch of [
    { permission: "execute" },
    {
      entrypoints: {
        ...input.entrypoints,
        remoteUrl: "https://example.invalid/",
      },
    },
    {
      entrypoints: {
        ...input.entrypoints,
        ui: { ...input.entrypoints.ui, sandbox: false },
      },
    },
    { requires: [{ ...input.requires[0], granted: true }] },
    { provides: [{ ...input.provides[0], implementation: "fake" }] },
    { contributions: [{ ...input.contributions[0], replaceHost: true }] },
    { files: [{ ...input.files[0], actualVerified: true }] },
  ])
    rejected({ ...input, ...patch }, "plugin_package_fields_invalid");
  for (const field of Object.keys(input)) {
    const missing: Record<string, unknown> = { ...input };
    delete missing[field];
    rejected(missing, "plugin_package_fields_invalid");
  }
});

test("rejects path traversal, absolute URLs and encoded escapes wherever package paths occur", () => {
  for (const path of [
    "/dist/ui.js",
    "//host/ui.js",
    "./ui.js",
    "dist/../ui.js",
    "dist//ui.js",
    "dist/./ui.js",
    "dist/ui.js/",
    "C:/dist/ui.js",
    "C:\\dist\\ui.js",
    "https://example.invalid/ui.js",
    "dist/%2e%2e/ui.js",
    "dist/%252e/ui.js",
    "dist/ui.js?x=1",
    "dist/ui.js#fragment",
    "dist/ui file.js",
    "dist/\nui.js",
    "dist/\u0000ui.js",
    "dist/\u0080ui.js",
    "dist/\u009fui.js",
    "dist/\u202eui.js",
  ])
    for (const patch of [
      { entrypoints: { ...fixture().entrypoints, node: path } },
      { entrypoints: { node: null, ui: { path, mode: "trustedModule" } } },
      { businessManifestPath: path },
      { files: [{ path, byteLength: 1, sha256: "a".repeat(64) }] },
    ])
      rejected({ ...fixture(), ...patch });
});

test("requires inventory coverage, rejects duplicate artifacts and excludes descriptor self-reference", () => {
  const input = fixture();
  for (const missing of [
    "dist/node.mjs",
    "dist/ui.js",
    "business/manifest.json",
  ])
    rejected(
      { ...input, files: input.files.filter((file) => file.path !== missing) },
      "plugin_package_artifact_missing",
    );
  rejected(
    { ...input, files: [...input.files, input.files[0]] },
    "plugin_package_file_conflict",
  );
  rejected(
    {
      ...input,
      files: [
        ...input.files,
        {
          path: PLUGIN_PACKAGE_DESCRIPTOR_PATH,
          byteLength: 100,
          sha256: "a".repeat(64),
        },
      ],
    },
    "plugin_package_descriptor_self_reference",
  );
  for (const entry of ["dist/node.mjs", "dist/ui.js"])
    rejected(
      {
        ...input,
        files: input.files.map((file) =>
          file.path === entry ? { ...file, byteLength: 0 } : file,
        ),
      },
      "plugin_package_entrypoint_empty",
    );
});

test("bounds artifact sizes and declared total, accepting no fabricated checksum encodings", () => {
  const input = fixture();
  for (const byteLength of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1, "10"])
    rejected(
      {
        ...input,
        files: input.files.map((file, index) =>
          index ? file : { ...file, byteLength },
        ),
      },
      "plugin_package_file_size_invalid",
    );
  for (const byteLength of [NaN, Infinity])
    rejected(
      {
        ...input,
        files: input.files.map((file, index) =>
          index ? file : { ...file, byteLength },
        ),
      },
      "plugin_package_json_invalid",
    );
  rejected(
    {
      ...input,
      files: input.files.map((file, index) =>
        index ? file : { ...file, byteLength: Number.MAX_SAFE_INTEGER },
      ),
    },
    "plugin_package_file_size_overflow",
  );
  for (const sha256 of [
    "a".repeat(63),
    "A".repeat(64),
    "g".repeat(64),
    `sha256:${"a".repeat(64)}`,
    "",
  ])
    rejected(
      {
        ...input,
        files: input.files.map((file, index) =>
          index ? file : { ...file, sha256 },
        ),
      },
      "plugin_package_file_digest_invalid",
    );
});

test("rejects artifact files used as parent directories, including the fixed descriptor", () => {
  const input = fixture();
  const parentFile = { path: "dist", byteLength: 1, sha256: "f".repeat(64) };
  for (const files of [
    [parentFile, ...input.files],
    [...input.files, parentFile],
  ])
    rejected({ ...input, files }, "plugin_package_file_conflict");
  const descriptorChild = `${PLUGIN_PACKAGE_DESCRIPTOR_PATH}/node.mjs`;
  rejected(
    {
      ...input,
      entrypoints: { node: descriptorChild, ui: null },
      contributions: [],
      businessManifestPath: null,
      files: [{ path: descriptorChild, byteLength: 1, sha256: "f".repeat(64) }],
    },
    "plugin_package_file_conflict",
  );
  const nestedFile = {
    path: "assets/nested",
    byteLength: 0,
    sha256: "f".repeat(64),
  };
  rejected(
    {
      ...input,
      files: [
        ...input.files,
        nestedFile,
        { ...nestedFile, path: "assets/nested/deeper/image.png" },
      ],
    },
    "plugin_package_file_conflict",
  );
  assert.equal(
    parsePluginPackageDescriptor({
      ...input,
      files: [
        ...input.files,
        { ...parentFile, path: "dist-backup" },
        { ...parentFile, path: "dist-extra/file.bin" },
      ],
    }).files.length,
    input.files.length + 2,
  );
});

test("keeps service negotiation opaque and rejects local service or contribution conflicts", () => {
  const input = fixture();
  for (const apiVersion of ["1", "v1", "Vendor.Protocol.02", "crewon.task.v1"])
    assert.equal(
      parsePluginPackageDescriptor({
        ...input,
        requires: [{ ...input.requires[0], apiVersion }],
      }).requires[0]?.apiVersion,
      apiVersion,
    );
  rejected(
    {
      ...input,
      requires: [
        ...input.requires,
        { ...input.requires[0], apiVersion: "different.v2", optional: true },
      ],
    },
    "plugin_package_service_conflict",
  );
  rejected(
    {
      ...input,
      provides: [...input.provides, { ...input.provides[0], apiVersion: "2" }],
    },
    "plugin_package_service_conflict",
  );
  for (const optional of [true, false])
    rejected(
      {
        ...input,
        requires: [
          {
            service: input.provides[0]!.service,
            apiVersion: "unrelated.v9",
            optional,
          },
        ],
      },
      "plugin_package_service_self_dependency",
    );
  rejected(
    { ...input, requires: [{ ...input.requires[0], optional: "false" }] },
    "plugin_package_requirement_invalid",
  );
  rejected(
    {
      ...input,
      contributions: [
        ...input.contributions,
        {
          ...input.contributions[0],
          kind: "settings",
          slot: "settings.section",
        },
      ],
    },
    "plugin_package_contribution_conflict",
  );
  for (const contribution of [
    { ...input.contributions[0], slot: "settings.section" },
    { ...input.contributions[0], kind: "shell" },
    { ...input.contributions[0], slot: "global.sidebar" },
  ])
    rejected(
      { ...input, contributions: [contribution] },
      "plugin_package_contribution_invalid",
    );
  assert.equal(
    parsePluginPackageDescriptor({
      ...input,
      contributions: [
        ...input.contributions,
        {
          id: "second-module",
          kind: "module",
          slot: "main.content",
          title: "第二模块",
        },
      ],
    }).contributions.length,
    4,
  );
});

test("bounds Unicode titles by scalars and all identifiers, descriptions, arrays and paths", () => {
  const input = fixture();
  assert.equal(
    parsePluginPackageDescriptor({ ...input, title: "😀".repeat(160) }).title
      .length,
    320,
  );
  rejected({ ...input, title: "😀".repeat(161) });
  rejected(
    { ...input, description: "汉".repeat(2731) },
    "plugin_package_text_invalid",
  );
  for (const title of ["", " title ", "a\nb", "a\tb"])
    rejected({ ...input, title });
  for (const pluginId of ["", "UPPER.plugin", "bad id", "a".repeat(129)])
    rejected({ ...input, pluginId });
  rejected(
    {
      ...input,
      requires: Array.from({ length: 65 }, (_, index) => ({
        service: `service${index}`,
        apiVersion: "v1",
        optional: false,
      })),
    },
    "plugin_package_collection_invalid",
  );
  rejected(
    {
      ...input,
      provides: Array.from({ length: 65 }, (_, index) => ({
        service: `provided${index}`,
        apiVersion: "v1",
      })),
    },
    "plugin_package_collection_invalid",
  );
  rejected(
    {
      ...input,
      contributions: Array.from({ length: 65 }, (_, index) => ({
        id: `item${index}`,
        kind: "module",
        slot: "main.content",
        title: "模块",
      })),
    },
    "plugin_package_collection_invalid",
  );
  rejected(
    {
      ...input,
      files: Array.from({ length: 513 }, (_, index) => ({
        path: `files/${index}.bin`,
        byteLength: 0,
        sha256: "a".repeat(64),
      })),
    },
    "plugin_package_collection_invalid",
  );
  rejected(
    {
      ...input,
      files: [
        ...input.files,
        {
          path: `${"a".repeat(253)}.bin`,
          byteLength: 0,
          sha256: "a".repeat(64),
        },
      ],
    },
    "plugin_package_text_invalid",
  );
});

test("accepts inclusive declared limits without imposing a fabricated installation size policy", () => {
  const input = fixture();
  const maximum = {
    ...input,
    title: "😀".repeat(PLUGIN_PACKAGE_LIMITS.titleScalars),
    description: "a".repeat(PLUGIN_PACKAGE_LIMITS.descriptionBytes),
    requires: Array.from(
      { length: PLUGIN_PACKAGE_LIMITS.requirements },
      (_, index) => ({
        service: `required${index}`,
        apiVersion: "v1",
        optional: false,
      }),
    ),
    provides: Array.from(
      { length: PLUGIN_PACKAGE_LIMITS.provisions },
      (_, index) => ({
        service: `provided${index}`,
        apiVersion: "v1",
      }),
    ),
    contributions: Array.from(
      { length: PLUGIN_PACKAGE_LIMITS.contributions },
      (_, index) => ({
        id: `contribution${index}`,
        kind: "module",
        slot: "main.content",
        title: "模块",
      }),
    ),
    files: [
      ...input.files.slice(0, 3),
      ...Array.from(
        { length: PLUGIN_PACKAGE_LIMITS.files - 3 },
        (_, index) => ({
          path: `assets/${index}.bin`,
          byteLength: 0,
          sha256: "f".repeat(64),
        }),
      ),
    ],
  };
  maximum.files.at(-1)!.path =
    `${"a".repeat(PLUGIN_PACKAGE_LIMITS.pathBytes - 4)}.bin`;
  const parsed = parsePluginPackageDescriptor(maximum);
  assert.equal(parsed.files.length, PLUGIN_PACKAGE_LIMITS.files);
  assert.equal(parsed.requires.length, PLUGIN_PACKAGE_LIMITS.requirements);
  assert.equal(parsed.provides.length, PLUGIN_PACKAGE_LIMITS.provisions);
  assert.equal(
    parsed.contributions.length,
    PLUGIN_PACKAGE_LIMITS.contributions,
  );
  assert.equal(
    parsePluginPackageDescriptor({
      ...input,
      entrypoints: { node: "dist/node.mjs", ui: null },
      contributions: [],
      businessManifestPath: null,
      files: [{ ...input.files[0], byteLength: Number.MAX_SAFE_INTEGER }],
    }).files[0]!.byteLength,
    Number.MAX_SAFE_INTEGER,
  );
});

test("rejects executable accessors, hidden fields, custom prototypes and malformed Unicode without invoking hooks", () => {
  let calls = 0;
  const hook = () => {
    calls++;
    throw new Error("must not execute");
  };
  const root = fixture();
  Object.defineProperty(root, "pluginId", { enumerable: true, get: hook });
  rejected(root, "plugin_package_json_invalid");
  const nested = fixture();
  Object.defineProperty(nested.files[0], "sha256", {
    enumerable: true,
    get: hook,
  });
  rejected(nested, "plugin_package_json_invalid");
  const array = fixture();
  Object.defineProperty(array.files, "0", { enumerable: true, get: hook });
  rejected(array, "plugin_package_json_invalid");
  const hidden = fixture();
  Object.defineProperty(hidden, "hiddenAuthority", { value: true });
  rejected(hidden, "plugin_package_json_invalid");
  rejected({ ...fixture(), toJSON: hook }, "plugin_package_json_invalid");
  const symbol = fixture();
  Object.defineProperty(symbol, Symbol.iterator, { value: hook });
  rejected(symbol, "plugin_package_json_invalid");
  rejected(
    Object.assign(Object.create({ inheritedAuthority: true }), fixture()),
    "plugin_package_json_invalid",
  );
  const customArray = fixture();
  Object.setPrototypeOf(customArray.files, { [Symbol.iterator]: hook });
  rejected(customArray, "plugin_package_json_invalid");
  for (const invalid of ["\ud800", "\udfff", "valid\ud800suffix"])
    rejected({ ...fixture(), title: invalid }, "plugin_package_json_invalid");
  assert.equal(calls, 0);
  assert.equal(
    parsePluginPackageDescriptor(Object.assign(Object.create(null), fixture()))
      .pluginId,
    "example.short-drama",
  );
});

test("bounds traversal before serializing and rejects cycles, sparse arrays and non-JSON inputs", () => {
  const cyclic = fixture();
  Object.assign(cyclic, { extra: cyclic });
  rejected(cyclic, "plugin_package_json_invalid");
  let deep: unknown = null;
  for (let index = 0; index <= PLUGIN_PACKAGE_LIMITS.jsonDepth; index++)
    deep = { nested: deep };
  rejected({ ...fixture(), extra: deep }, "plugin_package_json_limit");
  rejected(
    {
      ...fixture(),
      extra: "a".repeat(PLUGIN_PACKAGE_LIMITS.descriptorBytes + 1),
    },
    "plugin_package_json_limit",
  );
  rejected(
    {
      ...fixture(),
      extra: '"'.repeat(PLUGIN_PACKAGE_LIMITS.descriptorBytes / 2 + 1),
    },
    "plugin_package_json_limit",
  );
  rejected(
    {
      ...fixture(),
      extra: Array.from(
        { length: PLUGIN_PACKAGE_LIMITS.jsonNodes + 1 },
        () => null,
      ),
    },
    "plugin_package_json_limit",
  );
  rejected(
    { ...fixture(), files: new Array(3) },
    "plugin_package_json_invalid",
  );
  for (const extra of [undefined, 1n, () => undefined, new Date(), Number.NaN])
    rejected({ ...fixture(), extra }, "plugin_package_json_invalid");
});
