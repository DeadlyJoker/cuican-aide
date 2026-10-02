import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import {
  parseProductionPluginUiConfiguration,
  resolveProductionPluginUiEnvironment,
} from "./production-plugin-ui-environment.ts";

const publication = {
  packageDigest: `sha256:${"a".repeat(64)}`,
  pluginId: "test.counter",
  publisherId: "test.publisher",
  publicAssets: ["ui/entry.mjs", "ui/chunk.mjs"],
};
const config = () => ({
  installRoot: "/private/plugins",
  profileAuthority: {
    url: "https://authority.example/profile",
    serviceToken: "profile-secret-" + "p".repeat(32),
  },
  policyAuthority: {
    url: "https://authority.example/policy",
    serviceToken: "policy-secret-" + "s".repeat(32),
  },
  publications: [structuredClone(publication)],
  timeoutMs: 2000,
});
const env = (): NodeJS.ProcessEnv => {
  const value = config();
  return {
    CREWON_PLUGIN_UI_ENABLED: "1",
    CREWON_PLUGIN_UI_INSTALL_ROOT: value.installRoot,
    CREWON_PLUGIN_UI_PROFILE_AUTHORITY_URL: value.profileAuthority.url,
    CREWON_PLUGIN_UI_PROFILE_AUTHORITY_TOKEN:
      value.profileAuthority.serviceToken,
    CREWON_PLUGIN_UI_POLICY_AUTHORITY_URL: value.policyAuthority.url,
    CREWON_PLUGIN_UI_POLICY_AUTHORITY_TOKEN: value.policyAuthority.serviceToken,
    CREWON_PLUGIN_UI_PUBLICATIONS_JSON: JSON.stringify(value.publications),
  };
};

test("production UI remains absent without opt-in and rejects partial or standalone settings", () => {
  assert.equal(
    resolveProductionPluginUiEnvironment({}, "production"),
    undefined,
  );
  assert.equal(
    resolveProductionPluginUiEnvironment(
      { CREWON_PLUGIN_UI_ENABLED: "0" },
      "production",
    ),
    undefined,
  );
  assert.equal(
    resolveProductionPluginUiEnvironment({}, "standalone"),
    undefined,
  );
  for (const settings of [
    { CREWON_PLUGIN_UI_ENABLED: "true" },
    { CREWON_PLUGIN_UI_ENABLED: "1 " },
    { CREWON_PLUGIN_UI_ENABLED: "1" },
    { CREWON_PLUGIN_UI_INSTALL_ROOT: "/private/plugins" },
    { ...env(), CREWON_PLUGIN_UI_PROFILE_ID: "invented-profile" },
    { ...env(), CREWON_PLUGIN_UI_ENABLED: "0" },
  ])
    assert.throws(
      () => resolveProductionPluginUiEnvironment(settings, "production"),
      /production_plugin_ui_configuration_invalid/u,
    );
  assert.throws(
    () => resolveProductionPluginUiEnvironment(env(), "standalone"),
    /production_plugin_ui_configuration_invalid/u,
  );
  for (const name of Object.keys(env()).filter(
    (key) => key !== "CREWON_PLUGIN_UI_ENABLED",
  )) {
    const settings = env();
    delete settings[name];
    assert.throws(() =>
      resolveProductionPluginUiEnvironment(settings, "production"),
    );
  }
});

test("captures and freezes settings and redacts service tokens without substituting their runtime values", () => {
  const source = config();
  const parsed = parseProductionPluginUiConfiguration(source);
  source.publications[0]!.publicAssets[0] = "node.mjs";
  source.profileAuthority.serviceToken = "changed";
  assert.deepEqual(
    parsed.publications[0]!.publicAssets,
    publication.publicAssets,
  );
  assert.equal(
    parsed.profileAuthority.serviceToken,
    config().profileAuthority.serviceToken,
  );
  for (const value of [
    parsed,
    parsed.profileAuthority,
    parsed.policyAuthority,
    parsed.publications,
    parsed.publications[0]!,
    parsed.publications[0]!.publicAssets,
  ])
    assert.ok(Object.isFrozen(value));
  for (const text of [
    JSON.stringify(parsed),
    inspect(parsed, { depth: null }),
  ]) {
    assert.ok(!text.includes(config().profileAuthority.serviceToken));
    assert.ok(!text.includes(config().policyAuthority.serviceToken));
    assert.ok(text.includes("[REDACTED]"));
  }
  assert.equal(parseProductionPluginUiConfiguration(parsed), parsed);
  assert.equal(
    resolveProductionPluginUiEnvironment(env(), "production")!.timeoutMs,
    2000,
  );
});

test("strictly bounds HTTPS authorities, roots, deadlines and publication JSON", () => {
  for (const url of [
    "http://authority.example/policy",
    "https://user:password@authority.example",
    "https://authority.example/?token=secret",
    "https://authority.example/#secret",
    " https://authority.example",
    "not a URL",
    "https://authority.example/" + "界".repeat(700),
  ]) {
    assert.throws(() =>
      parseProductionPluginUiConfiguration({
        ...config(),
        profileAuthority: { ...config().profileAuthority, url },
      }),
    );
  }
  for (const serviceToken of [
    "short",
    "a".repeat(8193),
    "b".repeat(31) + "\n",
    "界".repeat(32),
  ])
    assert.throws(() =>
      parseProductionPluginUiConfiguration({
        ...config(),
        policyAuthority: { ...config().policyAuthority, serviceToken },
      }),
    );
  for (const installRoot of [
    "relative",
    "/private/../plugins",
    "/private/plugins/",
    "/private/\u0000plugins",
  ])
    assert.throws(() =>
      parseProductionPluginUiConfiguration({ ...config(), installRoot }),
    );
  for (const timeoutMs of [0, 30_001, 1.5, "2000"])
    assert.throws(() =>
      parseProductionPluginUiConfiguration({ ...config(), timeoutMs }),
    );
  for (const timeout of ["0", "030", "30001", "2e3", "1 "])
    assert.throws(() =>
      resolveProductionPluginUiEnvironment(
        { ...env(), CREWON_PLUGIN_UI_AUTHORITY_TIMEOUT_MS: timeout },
        "production",
      ),
    );
  assert.throws(() =>
    resolveProductionPluginUiEnvironment(
      {
        ...env(),
        CREWON_PLUGIN_UI_PUBLICATIONS_JSON: " ".repeat(128 * 1024 + 1),
      },
      "production",
    ),
  );
  assert.throws(() =>
    resolveProductionPluginUiEnvironment(
      { ...env(), CREWON_PLUGIN_UI_PUBLICATIONS_JSON: "{" },
      "production",
    ),
  );
});

test("publication approval is exact, bounded and rejects duplicate or unsafe assets", () => {
  for (const publications of [
    [publication, publication],
    Array.from({ length: 33 }, (_, i) => ({
      ...publication,
      packageDigest: `sha256:${i.toString(16).padStart(64, "0")}`,
    })),
    [{ ...publication, publicAssets: [] }],
    [{ ...publication, publicAssets: ["ui/entry.mjs", "ui/entry.mjs"] }],
    [
      {
        ...publication,
        publicAssets: Array.from({ length: 257 }, (_, i) => `ui/${i}.mjs`),
      },
    ],
    [{ ...publication, publicAssets: ["../node.mjs"] }],
    [{ ...publication, publicAssets: ["https://external.example/entry.mjs"] }],
    [{ ...publication, unknown: true }],
    [{ ...publication, packageDigest: "unknown" }],
    [{ ...publication, pluginId: "" }],
  ])
    assert.throws(() =>
      parseProductionPluginUiConfiguration({ ...config(), publications }),
    );
  assert.deepEqual(
    parseProductionPluginUiConfiguration({ ...config(), publications: [] })
      .publications,
    [],
  );
});

test("plain data parser never invokes getters or serialization hooks and rejects sparse arrays", () => {
  let calls = 0;
  const getter = { ...config() };
  Object.defineProperty(getter, "installRoot", {
    enumerable: true,
    get: () => {
      calls++;
      return "/private/plugins";
    },
  });
  const unsafe = [
    getter,
    { ...config(), publications: new Array(1) },
    {
      ...config(),
      publications: [{ ...publication, publicAssets: new Array(1) }],
    },
    {
      ...config(),
      toJSON: () => {
        calls++;
        return config();
      },
    },
    { ...config(), [Symbol("unknown")]: true },
    Object.assign(Object.create({ unknown: true }), config()),
  ];
  for (const input of unsafe)
    assert.throws(() => parseProductionPluginUiConfiguration(input));
  assert.equal(calls, 0);
});
