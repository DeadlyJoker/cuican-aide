import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import {
  parseProductionPluginInstallationConfiguration,
  resolveProductionPluginInstallationEnvironment,
} from "./production-plugin-installation-environment.ts";

const source = {
  sourceId: "source-v1",
  directory: "/private/sources/report",
  pluginId: "test.report",
  publisherId: "test.publisher",
  version: "1.0.0",
  packageDigest: `sha256:${"a".repeat(64)}`,
};
const configuration = () => ({
  installRoot: "/private/installed",
  sources: [{ ...source }],
  profileAuthority: {
    url: "https://authority.example/profile",
    serviceToken: "profile-secret-" + "p".repeat(32),
  },
  policyAuthority: {
    url: "https://authority.example/policy",
    serviceToken: "policy-secret-" + "s".repeat(32),
  },
  timeoutMs: 2000,
});
const environment = () => {
  const config = configuration();
  return {
    CREWON_PLUGIN_INSTALLATION_ENABLED: "1",
    CREWON_PLUGIN_INSTALLATION_INSTALL_ROOT: config.installRoot,
    CREWON_PLUGIN_INSTALLATION_SOURCES_JSON: JSON.stringify(config.sources),
    CREWON_PLUGIN_INSTALLATION_PROFILE_AUTHORITY_URL:
      config.profileAuthority.url,
    CREWON_PLUGIN_INSTALLATION_PROFILE_AUTHORITY_TOKEN:
      config.profileAuthority.serviceToken,
    CREWON_PLUGIN_INSTALLATION_POLICY_AUTHORITY_URL: config.policyAuthority.url,
    CREWON_PLUGIN_INSTALLATION_POLICY_AUTHORITY_TOKEN:
      config.policyAuthority.serviceToken,
  };
};
test("installation is opt-in, production-only and rejects partial or unknown authority/source settings", () => {
  assert.equal(
    resolveProductionPluginInstallationEnvironment({}, "production"),
    undefined,
  );
  assert.equal(
    resolveProductionPluginInstallationEnvironment(
      { CREWON_PLUGIN_INSTALLATION_ENABLED: "0" },
      "production",
    ),
    undefined,
  );
  assert.equal(
    resolveProductionPluginInstallationEnvironment({}, "standalone"),
    undefined,
  );
  assert.equal(
    resolveProductionPluginInstallationEnvironment(environment(), "production")
      ?.timeoutMs,
    2000,
  );
  for (const env of [
    { CREWON_PLUGIN_INSTALLATION_ENABLED: "true" },
    { CREWON_PLUGIN_INSTALLATION_INSTALL_ROOT: "/private/installed" },
    { ...environment(), CREWON_PLUGIN_INSTALLATION_ENABLED: "0" },
    { ...environment(), CREWON_PLUGIN_INSTALLATION_ACTOR: "fake" },
    { ...environment(), CREWON_PLUGIN_INSTALLATION_SOURCES_JSON: "[" },
    {
      ...environment(),
      CREWON_PLUGIN_INSTALLATION_AUTHORITY_TIMEOUT_MS: "30001",
    },
  ])
    assert.throws(
      () => resolveProductionPluginInstallationEnvironment(env, "production"),
      /production_plugin_installation_configuration_invalid/u,
    );
  assert.throws(() =>
    resolveProductionPluginInstallationEnvironment(environment(), "standalone"),
  );
  for (const name of Object.keys(environment()).filter(
    (name) => name !== "CREWON_PLUGIN_INSTALLATION_ENABLED",
  )) {
    const env: NodeJS.ProcessEnv = environment();
    delete env[name];
    assert.throws(() =>
      resolveProductionPluginInstallationEnvironment(env, "production"),
    );
  }
});
test("captures exact source identities without accessor calls, freezes snapshot and redacts credentials", () => {
  const input = configuration();
  const parsed = parseProductionPluginInstallationConfiguration(input);
  input.sources[0]!.directory = "/changed";
  input.profileAuthority.serviceToken = "changed";
  assert.equal(parsed.sources[0]!.directory, source.directory);
  assert.equal(
    parsed.profileAuthority.serviceToken,
    configuration().profileAuthority.serviceToken,
  );
  assert.equal(parseProductionPluginInstallationConfiguration(parsed), parsed);
  for (const object of [
    parsed,
    parsed.sources,
    parsed.sources[0],
    parsed.profileAuthority,
    parsed.policyAuthority,
  ])
    assert.ok(Object.isFrozen(object));
  for (const text of [
    JSON.stringify(parsed),
    inspect(parsed, { depth: null }),
  ]) {
    assert.ok(!text.includes(configuration().profileAuthority.serviceToken));
    assert.ok(!text.includes(configuration().policyAuthority.serviceToken));
  }
  let calls = 0;
  const getter = configuration();
  Object.defineProperty(getter.sources[0], "directory", {
    enumerable: true,
    get() {
      calls++;
      return source.directory;
    },
  });
  assert.throws(() => parseProductionPluginInstallationConfiguration(getter));
  assert.equal(calls, 0);
});
test("source approval rejects path ambiguity, aliases, namespace takeover, excess entries and non-HTTPS authority", () => {
  const variants = [
    { ...configuration(), installRoot: "relative" },
    { ...configuration(), installRoot: "/private/invalid\ud800" },
    { ...configuration(), installRoot: "/private/../installed" },
    {
      ...configuration(),
      sources: [{ ...source, directory: "/private/unsafe\u0085" }],
    },
    {
      ...configuration(),
      sources: [
        source,
        { ...source, sourceId: "alias", directory: "/private/other" },
      ],
    },
    {
      ...configuration(),
      sources: [
        source,
        {
          ...source,
          sourceId: "other",
          directory: "/private/other",
          packageDigest: `sha256:${"b".repeat(64)}`,
        },
      ],
    },
    {
      ...configuration(),
      sources: [
        source,
        {
          ...source,
          sourceId: "other",
          directory: "/private/other",
          version: "2.0.0",
          publisherId: "other.publisher",
          packageDigest: `sha256:${"b".repeat(64)}`,
        },
      ],
    },
    { ...configuration(), sources: Array.from({ length: 33 }, () => source) },
    { ...configuration(), sources: [{ ...source, version: "v1" }] },
    {
      ...configuration(),
      profileAuthority: {
        ...configuration().profileAuthority,
        url: "http://authority.example",
      },
    },
    {
      ...configuration(),
      policyAuthority: {
        ...configuration().policyAuthority,
        url: "https://user:pass@authority.example",
      },
    },
    {
      ...configuration(),
      sources: [{ ...source, ownerPrincipalId: "caller" }],
    },
  ];
  for (const variant of variants)
    assert.throws(() =>
      parseProductionPluginInstallationConfiguration(variant),
    );
});
