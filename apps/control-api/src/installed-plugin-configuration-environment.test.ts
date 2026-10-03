import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import {
  assertInstalledPluginConfigurationConfig,
  INSTALLED_PLUGIN_CONFIGURATION_CONFIG_ENV,
  loadInstalledPluginConfigurationEnvironment,
  parseInstalledPluginConfigurationConfig,
} from "./installed-plugin-configuration-environment.ts";
import {
  configDocument,
  environment,
} from "./installed-plugin-configuration.test-support.ts";
test("metadata opt-in captures only explicit authority configuration, without peer or pricing, and redacts private tokens", async () => {
  assert.equal(
    await loadInstalledPluginConfigurationEnvironment({}, "production"),
    undefined,
  );
  assert.equal(
    await loadInstalledPluginConfigurationEnvironment({}, "standalone"),
    undefined,
  );
  const mutable = structuredClone(configDocument),
    env = { ...environment };
  const result = parseInstalledPluginConfigurationConfig(mutable, env);
  mutable.installRoot = "/changed";
  env.FIXTURE_SERVICE_TOKEN = "changed";
  assertInstalledPluginConfigurationConfig(result);
  assert.equal(result.installRoot, configDocument.installRoot);
  assert.equal(
    result.packageAuthority.serviceToken,
    environment.FIXTURE_SERVICE_TOKEN,
  );
  for (const encoded of [JSON.stringify(result), inspect(result)])
    assert.ok(!encoded.includes(environment.FIXTURE_SERVICE_TOKEN));
  assert.throws(() => assertInstalledPluginConfigurationConfig({ ...result }));
  await assert.rejects(
    loadInstalledPluginConfigurationEnvironment(
      { [INSTALLED_PLUGIN_CONFIGURATION_CONFIG_ENV]: "/nonexistent" },
      "standalone",
    ),
    /configuration_invalid/,
  );
});
test("metadata deployment rejects price/peer/identity injection, unsafe endpoints and getters without executing them", () => {
  let hooks = 0;
  for (const value of [
    { ...configDocument, peer: { origin: "http://127.0.0.1:1" } },
    { ...configDocument, quotedCredits: "1" },
    { ...configDocument, principalId: "forged" },
    {
      ...configDocument,
      profileAuthority: {
        ...configDocument.profileAuthority,
        url: "http://fixture.example/",
      },
    },
    {
      ...configDocument,
      packageAuthority: {
        ...configDocument.packageAuthority,
        url: "https://user:password@fixture.example/",
      },
    },
    {
      ...configDocument,
      packageAuthority: {
        ...configDocument.packageAuthority,
        url: "https://fixture.example/?allow=true",
      },
    },
    { ...configDocument, timeoutMs: 0 },
    { ...configDocument, maximumPackages: 33 },
    Object.defineProperty({ ...configDocument }, "profileAuthority", {
      enumerable: true,
      get() {
        hooks++;
        return configDocument.profileAuthority;
      },
    }),
  ])
    assert.throws(
      () => parseInstalledPluginConfigurationConfig(value, environment),
      /configuration_invalid/,
    );
  const env = Object.defineProperty(
    { ...environment },
    "FIXTURE_SERVICE_TOKEN",
    {
      enumerable: true,
      get() {
        hooks++;
        return environment.FIXTURE_SERVICE_TOKEN;
      },
    },
  );
  assert.throws(() =>
    parseInstalledPluginConfigurationConfig(configDocument, env),
  );
  assert.equal(hooks, 0);
});
test("metadata private file enforces actual owner file identity, no links, permissions and bounded UTF8 bytes", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-metadata-config-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "configuration.json"),
    alias = join(root, "alias.json");
  await writeFile(path, JSON.stringify(configDocument), { mode: 0o600 });
  const load = (file = path) =>
    loadInstalledPluginConfigurationEnvironment(
      { ...environment, [INSTALLED_PLUGIN_CONFIGURATION_CONFIG_ENV]: file },
      "production",
    );
  assert.equal((await load())?.maximumPackages, 8);
  await symlink(path, alias);
  await assert.rejects(load(alias));
  await rm(alias);
  await link(path, alias);
  await assert.rejects(load(path));
  await assert.rejects(load(alias));
  await rm(alias);
  await chmod(path, 0o644);
  await assert.rejects(load());
  await chmod(path, 0o600);
  await writeFile(path, Buffer.from([0xff]));
  await assert.rejects(load());
  await writeFile(path, "x".repeat(65537));
  await assert.rejects(load());
});
