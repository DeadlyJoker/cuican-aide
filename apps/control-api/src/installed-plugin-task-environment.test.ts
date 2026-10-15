import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  chmod,
  realpath,
  rm,
  symlink,
  link as hardlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import {
  assertInstalledPluginTaskConfiguration,
  loadInstalledPluginTaskEnvironment,
  parseInstalledPluginTaskConfiguration,
  INSTALLED_PLUGIN_TASK_CONFIG_ENV,
} from "./installed-plugin-task-environment.ts";
import { document, environment } from "./installed-plugin-task.test-support.ts";

test("unconfigured task entry has no file dependency; configured entry requires production", async () => {
  assert.equal(
    await loadInstalledPluginTaskEnvironment({}, "production"),
    undefined,
  );
  assert.equal(
    await loadInstalledPluginTaskEnvironment({}, "standalone"),
    undefined,
  );
  await assert.rejects(
    loadInstalledPluginTaskEnvironment(
      {
        [INSTALLED_PLUGIN_TASK_CONFIG_ENV]: "/nonexistent/private/config.json",
      },
      "standalone",
    ),
    /installed_plugin_task_configuration_invalid/,
  );
});
test("strict deployment captures environment secrets and redacts both inspect and JSON", () => {
  const mutable = structuredClone(document),
    mutableEnv = { ...environment };
  const result = parseInstalledPluginTaskConfiguration(mutable, mutableEnv);
  mutable.installRoot = "/changed";
  mutableEnv.FIXTURE_SERVICE_TOKEN = "changed";
  assertInstalledPluginTaskConfiguration(result);
  assert.equal(result.installRoot, document.installRoot);
  assert.equal(
    result.quoteAuthority!.serviceToken,
    environment.FIXTURE_SERVICE_TOKEN,
  );
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.peer));
  for (const text of [JSON.stringify(result), inspect(result)]) {
    assert.ok(!text.includes(environment.FIXTURE_SERVICE_TOKEN));
    assert.ok(!text.includes(environment.FIXTURE_PEER_TOKEN));
  }
  assert.throws(
    () => assertInstalledPluginTaskConfiguration({ ...result }),
    /configuration_invalid/,
  );
});
test("rejects missing quotes, unknown fields, unsafe transport and accessor credentials without executing hooks", () => {
  let getters = 0;
  for (const input of [
    { ...document, quoteAuthority: null },
    { ...document, quotedCredits: "1" },
    { ...document, principalId: "forged" },
    {
      ...document,
      peer: { ...document.peer, origin: "http://localhost:18442" },
    },
    {
      ...document,
      peer: { ...document.peer, origin: "http://[::1]:18442" },
    },
    {
      ...document,
      peer: { ...document.peer, origin: "http://127.0.0.1:0" },
    },
    {
      ...document,
      peer: { ...document.peer, origin: "http://127.0.0.1:18442/path" },
    },
    {
      ...document,
      quoteAuthority: {
        ...document.quoteAuthority,
        url: "http://fixture.example/",
      },
    },
    {
      ...document,
      quoteAuthority: {
        ...document.quoteAuthority,
        url: "https://user:password@fixture.example/",
      },
    },
    {
      ...document,
      quoteAuthority: {
        ...document.quoteAuthority,
        url: "https://fixture.example/?price=1",
      },
    },
    { ...document, maximumPackages: 33 },
    { ...document, timeoutMs: 0 },
    Object.defineProperty({ ...document }, "quoteAuthority", {
      get() {
        getters++;
        return document.quoteAuthority;
      },
      enumerable: true,
    }),
  ])
    assert.throws(
      () => parseInstalledPluginTaskConfiguration(input, environment),
      /configuration_invalid/,
    );
  const hostileEnv = Object.defineProperty(
    { ...environment },
    "FIXTURE_SERVICE_TOKEN",
    {
      get() {
        getters++;
        return environment.FIXTURE_SERVICE_TOKEN;
      },
      enumerable: true,
    },
  );
  assert.throws(
    () => parseInstalledPluginTaskConfiguration(document, hostileEnv),
    /configuration_invalid/,
  );
  assert.equal(getters, 0);
});
test("actual private file rejects links/public permissions and loads only verified bounded bytes", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-task-config-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json"),
    link = join(root, "link.json");
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  const result = await loadInstalledPluginTaskEnvironment(
    { ...environment, [INSTALLED_PLUGIN_TASK_CONFIG_ENV]: path },
    "production",
  );
  assert.equal(result?.installRoot, document.installRoot);
  await symlink(path, link);
  await assert.rejects(
    loadInstalledPluginTaskEnvironment(
      { ...environment, [INSTALLED_PLUGIN_TASK_CONFIG_ENV]: link },
      "production",
    ),
    /configuration_invalid/,
  );
  const alias = join(root, "hardlink.json");
  await hardlink(path, alias);
  for (const hardlinkedPath of [path, alias])
    await assert.rejects(
      loadInstalledPluginTaskEnvironment(
        { ...environment, [INSTALLED_PLUGIN_TASK_CONFIG_ENV]: hardlinkedPath },
        "production",
      ),
      /configuration_invalid/,
    );
  await rm(alias);
  assert.equal(
    (
      await loadInstalledPluginTaskEnvironment(
        { ...environment, [INSTALLED_PLUGIN_TASK_CONFIG_ENV]: path },
        "production",
      )
    )?.installRoot,
    document.installRoot,
  );
  await chmod(path, 0o644);
  await assert.rejects(
    loadInstalledPluginTaskEnvironment(
      { ...environment, [INSTALLED_PLUGIN_TASK_CONFIG_ENV]: path },
      "production",
    ),
    /configuration_invalid/,
  );
  await chmod(path, 0o600);
  await writeFile(path, "x".repeat(65537));
  await assert.rejects(
    loadInstalledPluginTaskEnvironment(
      { ...environment, [INSTALLED_PLUGIN_TASK_CONFIG_ENV]: path },
      "production",
    ),
    /configuration_invalid/,
  );
});

test("project conversation quotes require an explicit exact protocol; old deployment shape stays absent", () => {
  const legacy = parseInstalledPluginTaskConfiguration(document, environment);
  assert.equal(Object.hasOwn(legacy, "projectConversationQuotes"), false);
  const declaration = {
    version: "crewon.project-conversation-credit-quote.v1",
  };
  const enabled = parseInstalledPluginTaskConfiguration(
    { ...document, projectConversationQuotes: declaration },
    environment,
  );
  assert.deepEqual(enabled.projectConversationQuotes, declaration);
  assert.ok(Object.isFrozen(enabled.projectConversationQuotes));
  for (const value of [
    null,
    { version: "legacy" },
    { ...declaration, enabled: true },
  ])
    assert.throws(
      () =>
        parseInstalledPluginTaskConfiguration(
          { ...document, projectConversationQuotes: value },
          environment,
        ),
      /configuration_invalid/,
    );
});

test("unmetered policy is explicit, independently captured and redacted without changing existing metered deployment", () => {
  assert.equal(
    parseInstalledPluginTaskConfiguration(document, environment)
      .unmeteredAuthority,
    undefined,
  );
  const raw = {
    ...document,
    unmeteredAuthority: {
      ...document.quoteAuthority,
      url: "https://fixture-authority.example/unmetered",
    },
  };
  const captured = parseInstalledPluginTaskConfiguration(raw, environment);
  raw.unmeteredAuthority.url = "https://changed.example/";
  assert.equal(
    captured.unmeteredAuthority!.url,
    "https://fixture-authority.example/unmetered",
  );
  for (const text of [JSON.stringify(captured), inspect(captured)])
    assert.ok(!text.includes(environment.FIXTURE_SERVICE_TOKEN));
  for (const unmeteredAuthority of [
    null,
    { ...document.quoteAuthority, url: "http://fixture.example/free" },
    { ...document.quoteAuthority, defaultBalance: 100 },
  ])
    assert.throws(
      () =>
        parseInstalledPluginTaskConfiguration(
          { ...document, unmeteredAuthority },
          environment,
        ),
      /configuration_invalid/,
    );
});

test("explicit unmetered deployment needs no fabricated quote URL; missing both funding authorities remains invalid", () => {
  const { quoteAuthority: _, ...base } = document;
  assert.throws(
    () => parseInstalledPluginTaskConfiguration(base, environment),
    /configuration_invalid/,
  );
  const result = parseInstalledPluginTaskConfiguration(
    {
      ...base,
      unmeteredAuthority: {
        ...document.quoteAuthority,
        url: "https://fixture-authority.example/unmetered",
      },
    },
    environment,
  );
  assert.equal(result.quoteAuthority, undefined);
  assert.ok(result.unmeteredAuthority);
});
