import assert from "node:assert/strict";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import {
  parseDesktopPluginConfiguration,
  loadDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import {
  createStandaloneControlApi,
  createStandaloneControlApiWithPlugins,
} from "./standalone-composition.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";

const actor = Object.freeze({
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
});
const scope = Object.freeze({
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "native-persisted-profile-fixture",
});
const headers = Object.freeze({
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "crewon://desktop",
  "x-csrf-token": "c".repeat(32),
});
const disabledScans = {
  heartbeatIntervalMs: null,
  outboxScanIntervalMs: null,
  outboxRetention: null,
  artifactRetention: null,
  automationScanIntervalMs: null,
};
function baseConfig(databasePath: string) {
  return {
    databasePath,
    actor,
    defaultAgentVersionId: "unavailable-real-model",
    sessionToken: "s".repeat(32),
    csrfToken: "c".repeat(32),
    allowedOrigins: ["crewon://desktop"],
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "fixture-key",
    ...disabledScans,
  };
}
function configuration(
  installRoot: string,
  sources: readonly {
    sourceId: string;
    directory: string;
    pluginId: string;
    publisherId: string;
    version: string;
    packageDigest: string;
    descriptor?: unknown;
  }[],
  publications: DesktopPluginConfiguration["publications"] = [],
): DesktopPluginConfiguration {
  return parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor,
    scope,
    authorityEpoch: "native-immutable-approved-epoch-fixture-01",
    installRoot,
    sources: sources.map(({ descriptor: _descriptor, ...source }) => source),
    publications,
  });
}

test("desktop default preserves absent plugin schema and existing identity while model readiness remains unavailable", async (t) => {
  let runtime: ReturnType<typeof createStandaloneControlApi> | undefined;
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.app.close();
    },
  });
  const path = join(f.root, "default.sqlite");
  runtime = createStandaloneControlApi(baseConfig(path));
  const unavailable = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/plugins/sources",
    headers,
  });
  assert.equal(unavailable.statusCode, 404, unavailable.body);
  const database = new DatabaseSync(path);
  try {
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'plugin_%' OR name LIKE 'installed_plugin_%'",
        )
        .get()!.n,
      0,
    );
  } finally {
    database.close();
  }
  assert.equal(
    (await runtime.app.inject({ method: "GET", url: "/api/v1/health/ready" }))
      .statusCode,
    503,
  );
});

test("native-approved SQLite installs actual UI bytes, switches versions, reopens original receipts and keeps task/credit admission unavailable", async (t) => {
  let runtime:
    | Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    | undefined;
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.app.close();
    },
  });
  const v1 = await f.source("ui-v1", { pluginId: "test.ui", uiOnly: true });
  const v2 = await f.source("ui-v2", {
    pluginId: "test.ui",
    uiOnly: true,
    version: "2.0.0",
  });
  const blocked = await f.source("requires-tasks", {
    pluginId: "test.tasks",
    validNode: true,
    requiredService: "crewon.tasks",
  });
  const config = configuration(
    f.installRoot,
    [v1, v2, blocked],
    [v1, v2].map((pkg) => ({
      pluginId: pkg.pluginId,
      publisherId: pkg.publisherId,
      packageDigest: pkg.packageDigest,
      publicAssets: ["ui.mjs"],
    })),
  );
  const path = join(f.root, "desktop.sqlite");
  const open = () =>
    createStandaloneControlApiWithPlugins({
      ...baseConfig(path),
      desktopPlugins: config,
    });
  runtime = await open();
  const request = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: object,
    key?: string,
  ) =>
    runtime!.app.inject({
      method,
      url,
      headers: {
        ...headers,
        ...(key === undefined ? {} : { "idempotency-key": key }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const install = async (
    pkg: typeof v1,
    revision: number | null,
    key: string,
  ) => {
    const response = await request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: pkg.sourceId,
        expectedPluginId: pkg.pluginId,
        expectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: revision,
      },
      key,
    );
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const select = async (
    pkg: typeof v1,
    revision: number,
    state: "enabled" | "disabled" | "uninstalled",
    key: string,
  ) => {
    const response = await request(
      "PUT",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
      {
        expectedSelectionRevision: revision,
        state,
        selectedPackageDigest:
          state === "uninstalled" ? null : pkg.packageDigest,
      },
      key,
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().projection.outcome, "applied");
    return response.json().mutation.selection;
  };
  const sources = await request("GET", "/api/v1/plugins/sources?limit=2");
  assert.equal(sources.statusCode, 200, sources.body);
  assert.equal(sources.json().sources.length, 2);
  assert.ok(!sources.body.includes(f.root));
  assert.equal(
    (await install(v1, null, "install-ui-v1")).selection.state,
    "disabled",
  );
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  await select(v1, 1, "enabled", "enable-ui-v1");
  const catalog = await request("GET", "/api/v1/plugins/ui/catalog");
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.equal(catalog.json().plugins.length, 1);
  const mounted = await request("POST", "/api/v1/plugins/ui/mounts", {
    pluginId: v1.pluginId,
    contributionId: "workbench",
    expectedSelectionRevision: 2,
    expectedPackageDigest: v1.packageDigest,
  });
  assert.equal(mounted.statusCode, 200, mounted.body);
  const lease = mounted.json();
  const asset = await request(
    "GET",
    `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/ui.mjs`,
  );
  assert.equal(asset.statusCode, 200, asset.body);
  assert.equal(
    asset.body,
    await readFile(join(v1.directory, "ui.mjs"), "utf8"),
  );
  const invoked = await request(
    "POST",
    `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
    { action: "image.generate", input: {} },
  );
  assert.equal(invoked.statusCode, 403, invoked.body);
  await install(v2, 2, "install-ui-v2");
  await select(v2, 2, "enabled", "upgrade-ui-v2");
  await select(v1, 3, "enabled", "rollback-ui-v1");
  assert.equal(
    (
      await request(
        "GET",
        `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/ui.mjs`,
      )
    ).statusCode,
    409,
  );
  const observer = new DatabaseSync(path);
  const before = observer
    .prepare("SELECT count(*) AS n FROM plugin_installation_receipts")
    .get()!.n;
  observer.close();
  await runtime.app.close();
  runtime = await open();
  const replay = await request(
    "PUT",
    `/api/v1/plugins/selections/${v2.pluginId}`,
    {
      expectedSelectionRevision: 2,
      state: "enabled",
      selectedPackageDigest: v2.packageDigest,
    },
    "upgrade-ui-v2",
  );
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().mutation.disposition, "replayed");
  const current = await request(
    "GET",
    `/api/v1/plugins/selections/${v1.pluginId}`,
  );
  assert.equal(current.statusCode, 200, current.body);
  assert.equal(
    current.json().selection.selectedPackageDigest,
    v1.packageDigest,
  );
  assert.equal(
    (await request("GET", "/api/v1/plugins/ui/catalog")).json().plugins.length,
    1,
  );
  const after = new DatabaseSync(path);
  try {
    assert.equal(
      after
        .prepare("SELECT count(*) AS n FROM plugin_installation_receipts")
        .get()!.n,
      before,
    );
  } finally {
    after.close();
  }
  await select(v1, 4, "disabled", "disable-ui");
  assert.equal(
    (await request("GET", "/api/v1/plugins/ui/catalog")).json().plugins.length,
    0,
  );
  await select(v1, 5, "uninstalled", "uninstall-ui");
  const history = await request(
    "GET",
    "/api/v1/plugins/packages?pluginId=test.ui&limit=50",
  );
  assert.equal(history.json().packages.length, 2);
  await install(blocked, null, "install-blocked");
  const unavailable = await request(
    "PUT",
    `/api/v1/plugins/selections/${blocked.pluginId}`,
    {
      expectedSelectionRevision: 1,
      state: "enabled",
      selectedPackageDigest: blocked.packageDigest,
    },
    "enable-blocked",
  );
  assert.equal(unavailable.statusCode, 409, unavailable.body);
  assert.equal(unavailable.json().error.code, "plugin_dependency_unavailable");
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  const final = new DatabaseSync(path);
  try {
    assert.equal(
      final.prepare("SELECT count(*) AS n FROM run_snapshots").get()!.n,
      0,
    );
    assert.equal(
      final
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'plugin_credit_%'",
        )
        .get()!.n,
      0,
    );
  } finally {
    final.close();
  }
});

test("local Node lifecycle installs without executing, upgrades and cold replay never resurrects an old version", async (t) => {
  let runtime:
    | Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    | undefined;
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.app.close();
    },
  });
  const v1 = await f.source("node-v1", { validNode: true });
  const v2 = await f.source("node-v2", { validNode: true, version: "2.0.0" });
  const path = join(f.root, "node.sqlite");
  const config = configuration(f.installRoot, [v1, v2]);
  const open = () =>
    createStandaloneControlApiWithPlugins({
      ...baseConfig(path),
      desktopPlugins: config,
    });
  runtime = await open();
  const mutate = async (
    pkg: typeof v1,
    kind: "install" | "select",
    revision: number | null,
    key: string,
  ) => {
    const response = await runtime!.app.inject({
      method: kind === "install" ? "POST" : "PUT",
      url:
        kind === "install"
          ? "/api/v1/plugins/installations"
          : `/api/v1/plugins/selections/${pkg.pluginId}`,
      headers: { ...headers, "idempotency-key": key },
      payload:
        kind === "install"
          ? {
              sourceId: pkg.sourceId,
              expectedPluginId: pkg.pluginId,
              expectedPackageDigest: pkg.packageDigest,
              expectedSelectionRevision: revision,
            }
          : {
              expectedSelectionRevision: revision,
              state: "enabled",
              selectedPackageDigest: pkg.packageDigest,
            },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  await mutate(v1, "install", null, "ninstall1");
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  await mutate(v1, "select", 1, "nenable1");
  await mutate(v2, "install", 2, "ninstall2");
  await mutate(v2, "select", 2, "nupgrade2");
  await runtime.app.close();
  const closedEvents = await readFile(f.marker, "utf8");
  runtime = await open();
  const replay = await mutate(v1, "select", 1, "nenable1");
  assert.equal(replay.mutation.disposition, "replayed");
  assert.equal(await readFile(f.marker, "utf8"), closedEvents);
  await mutate(v2, "select", 3, "ncold-enable2");
  const events = await readFile(f.marker, "utf8");
  assert.equal(events.split("node-v1:setup").length - 1, 1);
  assert.equal(events.split("node-v2:setup").length - 1, 2);
  assert.match(events, /node-v1:dispose/u);
  assert.match(events, /node-v2:dispose/u);
});

test("desktop source installation retains loopback/session/Origin/CSRF gates and never exposes native paths", async (t) => {
  let runtime:
    | Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    | undefined;
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.app.close();
    },
  });
  const pkg = await f.source("safe-ui", { uiOnly: true });
  runtime = await createStandaloneControlApiWithPlugins({
    ...baseConfig(join(f.root, "gated.sqlite")),
    desktopPlugins: configuration(f.installRoot, [pkg]),
  });
  const payload = {
    sourceId: pkg.sourceId,
    expectedPluginId: pkg.pluginId,
    expectedPackageDigest: pkg.packageDigest,
    expectedSelectionRevision: null,
  };
  for (const changed of [
    { authorization: "Bearer wrong" },
    { origin: "https://foreign.example" },
    { "x-csrf-token": "wrong" },
  ]) {
    const response = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/plugins/installations",
      headers: { ...headers, ...changed, "idempotency-key": "denied" },
      payload,
    });
    assert.ok(
      response.statusCode === 401 || response.statusCode === 403,
      response.body,
    );
  }
  const remote = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/plugins/sources",
    remoteAddress: "192.0.2.1",
    headers,
  });
  assert.equal(remote.statusCode, 403, remote.body);
  const forbiddenPath = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/plugins/installations",
    headers: { ...headers, "idempotency-key": "path" },
    payload: { ...payload, sourceId: pkg.directory },
  });
  assert.notEqual(forbiddenPath.statusCode, 200);
  const state = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/plugins/selections?limit=50",
    headers,
  });
  assert.equal(state.statusCode, 200, state.body);
  assert.equal(state.json().selections.length, 0);
  assert.ok(!state.body.includes(f.root));
});

test("native bootstrap requires private no-link bytes and exact actor; copied getters and cross-profile data fail without execution", async (t) => {
  const f = await productionSourceFixture(t);
  const pkg = await f.source("bootstrap-ui", { uiOnly: true });
  const config = configuration(f.installRoot, [pkg]);
  const path = join(f.root, "bootstrap.json");
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(
    await loadDesktopPluginConfiguration(path, { actor }),
    config,
  );
  await assert.rejects(
    loadDesktopPluginConfiguration(path, {
      actor: { ...actor, principalId: "foreign" },
    }),
    /desktop_plugin_configuration_invalid/u,
  );
  const alias = join(f.root, "alias.json");
  await symlink(path, alias);
  await assert.rejects(loadDesktopPluginConfiguration(alias, { actor }));
  await chmod(path, 0o644);
  await assert.rejects(
    loadDesktopPluginConfiguration(path, { actor }),
    /desktop_plugin_configuration_invalid/u,
  );
  let reads = 0;
  const input = { ...config };
  Object.defineProperty(input, "sources", {
    enumerable: true,
    get() {
      reads++;
      return config.sources;
    },
  });
  assert.throws(
    () => parseDesktopPluginConfiguration(input),
    /desktop_plugin_configuration_invalid/u,
  );
  assert.equal(reads, 0);
  assert.throws(
    () =>
      parseDesktopPluginConfiguration({
        ...config,
        scope: { ...scope, tenantId: "foreign" },
      }),
    /desktop_plugin_configuration_invalid/u,
  );
  assert.throws(
    () =>
      parseDesktopPluginConfiguration({
        ...config,
        publications: [
          {
            pluginId: pkg.pluginId,
            publisherId: pkg.publisherId,
            packageDigest: "sha256:" + "0".repeat(64),
            publicAssets: ["ui.mjs"],
          },
        ],
      }),
    /desktop_plugin_configuration_invalid/u,
  );
});

test("desktop startup claims a real file-backed profile and competing Control cannot publish; close releases the owner for cold reopen", async (t) => {
  let runtime:
    | Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    | undefined;
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.app.close();
    },
  });
  const pkg = await f.source("owner-ui", { uiOnly: true });
  const config = configuration(f.installRoot, [pkg]);
  const path = join(f.root, "owned.sqlite");
  const open = () =>
    createStandaloneControlApiWithPlugins({
      ...baseConfig(path),
      desktopPlugins: config,
    });
  runtime = await open();
  await assert.rejects(open(), /plugin_profile_owner_busy/u);
  const response = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/plugins/sources",
    headers,
  });
  assert.equal(response.statusCode, 200, response.body);
  await runtime.app.close();
  runtime = await open();
  assert.equal(
    (
      await runtime.app.inject({
        method: "GET",
        url: "/api/v1/plugins/sources",
        headers,
      })
    ).statusCode,
    200,
  );
  await assert.rejects(
    createStandaloneControlApiWithPlugins({
      ...baseConfig(":memory:"),
      desktopPlugins: config,
    }),
    /plugin_profile_owner_requires_file/u,
  );
});

test("desktop identity drift removes delivery availability without blocking metadata management or importing changed code", async (t) => {
  let runtime:
    | Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    | undefined;
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.app.close();
    },
  });
  const pkg = await f.source("drift-node", { validNode: true });
  const path = join(f.root, "drift.sqlite");
  runtime = await createStandaloneControlApiWithPlugins({
    ...baseConfig(path),
    desktopPlugins: configuration(f.installRoot, [
      { ...pkg, version: "9.0.0" },
    ]),
  });
  const sources = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/plugins/sources?limit=50",
    headers,
  });
  assert.equal(sources.statusCode, 200, sources.body);
  assert.deepEqual(sources.json().sources, []);
  const selections = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/plugins/selections?limit=50",
    headers,
  });
  assert.equal(selections.statusCode, 200, selections.body);
  assert.deepEqual(selections.json().selections, []);
  const install = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/plugins/installations",
    headers: { ...headers, "idempotency-key": "drifting-source" },
    payload: {
      sourceId: pkg.sourceId,
      expectedPluginId: pkg.pluginId,
      expectedPackageDigest: pkg.packageDigest,
      expectedSelectionRevision: null,
    },
  });
  assert.notEqual(install.statusCode, 200, install.body);
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  const database = new DatabaseSync(path);
  try {
    assert.equal(
      database
        .prepare("SELECT count(*) AS n FROM installed_plugin_packages")
        .get()!.n,
      0,
    );
  } finally {
    database.close();
  }
});
