import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test, { type TestContext } from "node:test";
import {
  candidateActor,
  candidateScope,
  candidateIdentity,
  candidateConfiguration,
  candidateTarget,
} from "./installed-plugin-peer-candidate.test-support.ts";
import {
  DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_ENV as ENV,
  assertDesktopInstalledPluginActivationConfig,
  assertDesktopInstalledPluginActivationConfigCurrent,
  loadDesktopInstalledPluginActivationEnvironment,
  parseDesktopInstalledPluginActivationConfig,
} from "./desktop-installed-plugin-activation-environment.ts";

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-activation-file-")),
  );
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "activation.json");
  const value = {
    schemaVersion: "crewon.desktop-installed-plugin-activation.v1",
    actor: candidateActor,
    scope: candidateScope,
    installRoot: join(root, "installed"),
    peer: {
      origin: "http://127.0.0.1:3288",
      tokenEnvironmentVariable: "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
    },
    authority: {
      url: "https://activation-fixture.example/policy",
      serviceTokenEnvironmentVariable: "TEST_POLICY_TOKEN",
    },
    timeoutMs: 1000,
    entries: [
      {
        identity: candidateIdentity,
        configuration: candidateConfiguration,
        target: candidateTarget,
      },
    ],
  };
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const environment = {
    [ENV]: path,
    CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN: "p".repeat(32),
    TEST_POLICY_TOKEN: "a".repeat(32),
  };
  const input = {
    securityMode: "standalone" as const,
    desktopBootstrapPath: join(root, "bootstrap.json"),
  };
  return { root, path, value, environment, input };
}

test("Native activation absence leaves files and secrets unread; own environment token data is mandatory", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await loadDesktopInstalledPluginActivationEnvironment({}, f.input),
    undefined,
  );
  let getterCalls = 0;
  const getter = Object.defineProperty(
    { TEST_POLICY_TOKEN: "a".repeat(32) },
    "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
    {
      enumerable: true,
      get() {
        getterCalls++;
        return "p".repeat(32);
      },
    },
  );
  assert.throws(
    () => parseDesktopInstalledPluginActivationConfig(f.value, getter),
    /activation_configuration_invalid/u,
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () =>
      parseDesktopInstalledPluginActivationConfig(
        f.value,
        Object.create(f.environment),
      ),
    /activation_configuration_invalid/u,
  );
});

test("Native activation loader binds actual private file and redacts captured service secrets", async (t) => {
  const f = await fixture(t);
  const loaded = await loadDesktopInstalledPluginActivationEnvironment(
    f.environment,
    f.input,
  );
  assert.ok(loaded);
  assert.deepEqual(loaded.publication, f.value);
  assert.equal(loaded.peerToken, "p".repeat(32));
  assert.equal(loaded.authorityToken, "a".repeat(32));
  assertDesktopInstalledPluginActivationConfigCurrent(loaded);
  for (const output of [JSON.stringify(loaded), inspect(loaded)]) {
    assert.ok(!output.includes(loaded.peerToken));
    assert.ok(!output.includes(loaded.authorityToken));
    assert.ok(output.includes("REDACTED"));
  }
  assert.throws(
    () => assertDesktopInstalledPluginActivationConfig({ ...loaded }),
    /activation_configuration_invalid/u,
  );
  await rename(f.path, join(f.root, "previous.json"));
  await writeFile(f.path, JSON.stringify(f.value), { mode: 0o600 });
  assert.throws(
    () => assertDesktopInstalledPluginActivationConfigCurrent(loaded),
    /activation_configuration_invalid/u,
  );
});

test("Native activation rejects production, absent bootstrap, public leaf and real hard links", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    loadDesktopInstalledPluginActivationEnvironment(f.environment, {
      ...f.input,
      securityMode: "production",
    }),
    /activation_configuration_invalid/u,
  );
  await assert.rejects(
    loadDesktopInstalledPluginActivationEnvironment(f.environment, {
      securityMode: "standalone",
    }),
    /activation_configuration_invalid/u,
  );
  await chmod(f.path, 0o644);
  await assert.rejects(
    loadDesktopInstalledPluginActivationEnvironment(f.environment, f.input),
    /activation_configuration_invalid/u,
  );
  await chmod(f.path, 0o600);
  await link(f.path, join(f.root, "linked.json"));
  await assert.rejects(
    loadDesktopInstalledPluginActivationEnvironment(f.environment, f.input),
    /activation_configuration_invalid/u,
  );
});

test("Native activation rejects a real ancestor symlink and invalid service token without following getters", async (t) => {
  const f = await fixture(t),
    alias = f.root + "-alias";
  t.after(() => rm(alias, { force: true }));
  await symlink(f.root, alias);
  await assert.rejects(
    loadDesktopInstalledPluginActivationEnvironment(
      { ...f.environment, [ENV]: join(alias, "activation.json") },
      f.input,
    ),
    /activation_configuration_invalid/u,
  );
  await assert.rejects(
    loadDesktopInstalledPluginActivationEnvironment(
      { ...f.environment, TEST_POLICY_TOKEN: "short" },
      f.input,
    ),
    /activation_configuration_invalid/u,
  );
});
