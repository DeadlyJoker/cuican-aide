import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { PluginNodeHost } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import { PLUGIN_COMPOSITION_STATUS_SCHEMA } from "@crewon/contracts";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { createDesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import {
  createDesktopPluginInstallationRuntime,
  type DesktopPluginInstallationRuntime,
} from "./desktop-plugin-installation-runtime.ts";
import { errorResponse } from "./control-api-errors.ts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  createStandaloneControlApi,
  createStandaloneControlApiWithPlugins,
} from "./standalone-composition.ts";
import {
  PRODUCTION_BFF_AUTHORIZATION_HEADER,
  ProductionControlApiIdentity,
  StaticTrustedBffRequestVerifier,
} from "./production-security-adapters.ts";

const actor = Object.freeze({
  principalId: "status-native-owner",
  actorId: "status-native-user",
  tenantId: "status-native-tenant",
  spaceId: "status-native-space",
});
const scope = Object.freeze({
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "status-native-profile",
});
const headers = Object.freeze({
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "crewon://desktop",
  "x-csrf-token": "c".repeat(32),
});
const url = "/api/v1/plugins/composition/status";
const firstPage = Object.freeze({ afterPluginId: null, limit: 20 });
type HttpRuntime = ReturnType<typeof createStandaloneControlApi>;
type Source = Awaited<
  ReturnType<Awaited<ReturnType<typeof productionSourceFixture>>["source"]>
>;

async function fixture(
  t: TestContext,
  specs: readonly Readonly<{
    sourceId: string;
    pluginId?: string;
    uiOnly?: boolean;
  }>[] = [{ sourceId: "node" }],
) {
  let control: HttpRuntime | undefined;
  let installation: DesktopPluginInstallationRuntime | undefined;
  let store: SqliteRunStore | undefined;
  let authority: DesktopPluginAuthority | undefined;
  const files = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await control?.app.close();
      await installation?.close();
      await store?.close();
    },
  });
  const sources = await Promise.all(
    specs.map((spec) =>
      files.source(spec.sourceId, {
        ...(spec.pluginId === undefined ? {} : { pluginId: spec.pluginId }),
        ...(spec.uiOnly ? { uiOnly: true } : { validNode: true }),
      }),
    ),
  );
  const configuration = parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor,
    scope,
    authorityEpoch: "native-status-observation-fixture-epoch-01",
    installRoot: files.installRoot,
    sources: sources.map(({ descriptor: _descriptor, ...source }) => source),
    publications: [],
  });
  const databasePath = join(files.root, "status.sqlite");
  const base = () => ({
    databasePath,
    actor,
    defaultAgentVersionId: "no-model-used-status-test",
    sessionToken: "s".repeat(32),
    csrfToken: "c".repeat(32),
    allowedOrigins: ["crewon://desktop"],
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "status-fixture-key",
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    outboxRetention: null,
    artifactRetention: null,
    automationScanIntervalMs: null,
  });
  let sequence = 0;
  const request = (
    method: "GET" | "POST" | "PUT",
    requestUrl: string,
    payload?: object,
  ) => {
    assert.ok(control);
    return control.app.inject({
      method,
      url: requestUrl,
      headers: {
        ...headers,
        ...(method === "GET"
          ? {}
          : { "idempotency-key": `status-request-${++sequence}` }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  };
  const install = async (source: Source) => {
    if (installation)
      return installation.service.install(actor, {
        sourceId: source.sourceId,
        expectedPluginId: source.pluginId,
        expectedPackageDigest: source.packageDigest,
        expectedSelectionRevision: null,
        idempotencyKey: `status-install-${++sequence}`,
      });
    const result = await request("POST", "/api/v1/plugins/installations", {
      sourceId: source.sourceId,
      expectedPluginId: source.pluginId,
      expectedPackageDigest: source.packageDigest,
      expectedSelectionRevision: null,
    });
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  };
  const select = async (
    source: Source,
    revision: number,
    state: "enabled" | "disabled" | "uninstalled" = "enabled",
  ) => {
    const command = {
      pluginId: source.pluginId,
      state,
      selectedPackageDigest:
        state === "uninstalled" ? null : source.packageDigest,
      expectedSelectionRevision: revision,
    };
    if (installation)
      return installation.service.select(actor, {
        ...command,
        idempotencyKey: `status-select-${++sequence}`,
      });
    const { pluginId: _pluginId, ...payload } = command;
    const result = await request(
      "PUT",
      `/api/v1/plugins/selections/${source.pluginId}`,
      payload,
    );
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  };
  return {
    ...files,
    sources,
    configuration,
    databasePath,
    request,
    install,
    select,
    get installation() {
      assert.ok(installation);
      return installation;
    },
    get authority() {
      assert.ok(authority);
      return authority;
    },
    async openControl(plugins = true) {
      assert.equal(control, undefined);
      assert.equal(installation, undefined);
      control = plugins
        ? await createStandaloneControlApiWithPlugins({
            ...base(),
            desktopPlugins: configuration,
          })
        : createStandaloneControlApi(base());
      return control;
    },
    async closeControl() {
      await control?.app.close();
      control = undefined;
    },
    async openInstallation() {
      assert.equal(control, undefined);
      assert.equal(installation, undefined);
      store = new SqliteRunStore(databasePath);
      const ledger = store.pluginInstallationStore();
      await ledger.migrate();
      await ledger.compositionStore().migrate();
      authority = new DesktopPluginAuthority(configuration);
      installation = await createDesktopPluginInstallationRuntime(
        {
          configuration,
          authority,
          registry: await createDesktopPluginSourceRegistry(configuration),
        },
        {
          store,
          clock: { now: () => "2026-10-11T00:00:00.000Z" },
          digester: {
            sha256: (value) =>
              `sha256:${createHash("sha256").update(value).digest("hex")}`,
          },
        },
      );
    },
    async marker() {
      try {
        return await readFile(files.marker, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return "";
      }
    },
  };
}

test("actual standalone Control opts into status only with its real native owner and never restores Node code on a read", async (t) => {
  const f = await fixture(t);
  await f.openControl(false);
  const unavailable = await f.request("GET", url);
  assert.equal(unavailable.statusCode, 404);
  assert.equal(unavailable.json().error.code, "route_not_found");
  assert.equal(await f.marker(), "");
  await f.closeControl();
  await f.openControl();
  const empty = await f.request("GET", url);
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json(), {
    schemaVersion: PLUGIN_COMPOSITION_STATUS_SCHEMA,
    metadata: { state: "unobserved" },
    plugins: [],
    next: null,
  });
  const source = f.sources[0]!;
  await f.install(source);
  assert.equal(await f.marker(), "");
  const installed = await f.request("GET", url);
  assert.equal(installed.json().plugins[0].selection.state, "disabled");
  assert.equal(installed.json().plugins[0].node.state, "inactive");
  assert.equal((await f.select(source, 1)).projection.outcome, "applied");
  const ready = await f.request("GET", url);
  assert.equal(ready.statusCode, 200, ready.body);
  assert.equal(ready.json().plugins[0].node.state, "ready");
  assert.equal(ready.json().metadata.state, "published");
  assert.equal(ready.headers["cache-control"], "no-store");
  const marker = await f.marker();
  await f.request("GET", url);
  assert.equal(await f.marker(), marker);
  for (const privateText of [
    f.root,
    scope.profileId,
    actor.actorId,
    actor.principalId,
    "borrowers",
    "authorityEpoch",
    "services",
  ])
    assert.equal(ready.body.includes(privateText), false);

  await f.closeControl();
  const closedMarker = await f.marker();
  await f.openControl();
  for (let attempt = 0; attempt < 2; attempt++) {
    const cold = await f.request("GET", url);
    assert.equal(cold.statusCode, 200, cold.body);
    assert.equal(cold.json().plugins[0].selection.state, "enabled");
    assert.equal(cold.json().plugins[0].node.state, "unobserved");
    assert.equal(await f.marker(), closedMarker);
  }
  await f.select(source, 2, "disabled");
  assert.equal(
    (await f.request("GET", url)).json().plugins[0].node.state,
    "inactive",
  );
  await f.select(source, 3, "uninstalled");
  const removed = await f.request("GET", url);
  assert.equal(removed.json().plugins[0].selection.selectedPackageDigest, null);
  assert.equal(removed.json().plugins[0].node.state, "inactive");
  assert.equal(await f.marker(), closedMarker);
});

test("an actual enabled UI-only package is never claimed ready by its published graph", async (t) => {
  const f = await fixture(t, [{ sourceId: "ui", uiOnly: true }]);
  await f.openControl();
  const source = f.sources[0]!;
  await f.install(source);
  await f.select(source, 1);
  const result = await f.request("GET", url);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().plugins[0].selection.state, "enabled");
  assert.equal(result.json().plugins[0].node.state, "unobserved");
  assert.equal(await f.marker(), "");
});

test(
  "status waits behind real selection preparation and cannot observe a mixed pending projection",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.openControl();
    const source = f.sources[0]!;
    await f.install(source);
    const entered = deferred(),
      release = deferred();
    t.after(() => release.resolve());
    const prepare = PluginNodeHost.prototype.prepare;
    t.mock.method(
      PluginNodeHost.prototype,
      "prepare",
      async function (
        this: PluginNodeHost,
        input: Parameters<PluginNodeHost["prepare"]>[0],
      ) {
        const actual = await prepare.call(this, input);
        entered.resolve();
        await release.promise;
        return actual;
      },
    );
    const selecting = f.select(source, 1);
    await entered.promise;
    const observer = new DatabaseSync(f.databasePath, { readOnly: true });
    try {
      assert.equal(
        observer.prepare("SELECT state FROM plugin_profile_selections").get()
          ?.state,
        "disabled",
      );
    } finally {
      observer.close();
    }
    let settled = false;
    const reading = f.request("GET", url).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(
      settled,
      false,
      "the actual status request must join the original profile queue",
    );
    release.resolve();
    await selecting;
    const result = await reading;
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().plugins[0].selection.revision, 2);
    assert.equal(result.json().plugins[0].node.state, "ready");
    assert.equal((await f.marker()).match(/node:setup/g)?.length, 1);
  },
);

test("real native status authority rejects different verified principals, actors and tenant scope before observing inventory", async (t) => {
  const f = await fixture(t);
  await f.openInstallation();
  const source = f.sources[0]!;
  await f.install(source);
  await f.select(source, 1);
  const app = productionStatusApp(f.installation);
  t.after(() => app.close());
  const trusted = {
    ...headers,
    [PRODUCTION_BFF_AUTHORIZATION_HEADER]: `Bearer ${"b".repeat(32)}`,
  };
  const own = await app.inject({ method: "GET", url, headers: trusted });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().plugins[0].node.state, "ready");
  const before = await f.marker();
  for (const token of [
    "foreign-principal",
    "foreign-actor",
    "foreign-tenant",
    "foreign-space",
  ]) {
    const foreign = await app.inject({
      method: "GET",
      url,
      headers: { ...trusted, authorization: `Bearer ${token}` },
    });
    assert.equal(foreign.statusCode, 403, foreign.body);
    assert.equal(foreign.json().error.code, "desktop_plugin_owner_mismatch");
    assert.equal(foreign.body.includes(source.pluginId), false);
  }
  assert.equal(await f.marker(), before);
  f.authority.withdraw();
  const revoked = await app.inject({ method: "GET", url, headers: trusted });
  assert.equal(revoked.statusCode, 403, revoked.body);
  assert.equal(revoked.json().error.code, "desktop_plugin_authority_closed");
  assert.equal(revoked.body.includes(source.pluginId), false);
  await f.installation.close();
  assert.equal(await f.marker(), `${before}node:dispose\n`);
});

test("actual post-COMMIT authority withdrawal leaves a pending receipt and prevents stale ready status", async (t) => {
  const f = await fixture(t);
  await f.openInstallation();
  const source = f.sources[0]!;
  await f.install(source);
  const prepare = PluginNodeHost.prototype.prepare;
  t.mock.method(
    PluginNodeHost.prototype,
    "prepare",
    async function (
      this: PluginNodeHost,
      input: Parameters<PluginNodeHost["prepare"]>[0],
    ) {
      const actual = await prepare.call(this, input);
      return Object.freeze({
        ...actual,
        commit(value: Parameters<typeof actual.commit>[0]) {
          const observer = new DatabaseSync(f.databasePath, { readOnly: true });
          try {
            assert.deepEqual(
              {
                ...observer
                  .prepare(
                    "SELECT state,revision FROM plugin_profile_selections",
                  )
                  .get(),
              },
              { state: "enabled", revision: 2 },
            );
          } finally {
            observer.close();
          }
          f.authority.withdraw();
          return actual.commit(value);
        },
      });
    },
  );
  const selected = await f.select(source, 1);
  assert.equal(selected.mutation.disposition, "committed");
  assert.equal(selected.projection.outcome, "pending");
  const app = productionStatusApp(f.installation);
  t.after(() => app.close());
  const result = await app.inject({
    method: "GET",
    url,
    headers: {
      ...headers,
      [PRODUCTION_BFF_AUTHORIZATION_HEADER]: `Bearer ${"b".repeat(32)}`,
    },
  });
  assert.equal(result.statusCode, 403, result.body);
  assert.equal(result.body.includes("ready"), false);
  assert.equal(result.body.includes(source.pluginId), false);
});

test("loss of the actual SQLite claim fails closed instead of publishing cached ready inventory", async (t) => {
  const f = await fixture(t);
  await f.openInstallation();
  const source = f.sources[0]!;
  await f.install(source);
  await f.select(source, 1);
  const app = productionStatusApp(f.installation);
  t.after(() => app.close());
  const trusted = {
    ...headers,
    [PRODUCTION_BFF_AUTHORIZATION_HEADER]: `Bearer ${"b".repeat(32)}`,
  };
  assert.equal(
    (await app.inject({ method: "GET", url, headers: trusted })).statusCode,
    200,
  );
  const lockRoot = `${f.databasePath}.plugin-profile-locks`;
  const locks = (await readdir(lockRoot)).filter((file) =>
    file.endsWith(".sqlite"),
  );
  assert.equal(locks.length, 1);
  const lock = join(lockRoot, locks[0]!);
  const captured = `${lock}.captured-fixture`;
  await rename(lock, captured);
  await writeFile(lock, "replacement-fixture-inode", { mode: 0o600 });
  try {
    const lost = await app.inject({ method: "GET", url, headers: trusted });
    assert.equal(lost.statusCode, 500, lost.body);
    assert.equal(lost.json().error.code, "internal_error");
    for (const privateText of [
      lock,
      f.root,
      source.pluginId,
      "ready",
      "plugins",
    ])
      assert.equal(lost.body.includes(privateText), false);
    const withdrawn = await app.inject({
      method: "GET",
      url,
      headers: trusted,
    });
    assert.equal(withdrawn.statusCode, 403, withdrawn.body);
    assert.equal(
      withdrawn.json().error.code,
      "desktop_plugin_authority_closed",
    );
  } finally {
    await rm(lock);
    await rename(captured, lock);
  }
});

test("bounded status pagination follows the actual owned selection page and rejects foreign selectors", async (t) => {
  const f = await fixture(
    t,
    Array.from({ length: 4 }, (_, index) => ({
      sourceId: `page-${index}`,
      pluginId: `status.page${index}`,
      uiOnly: true,
    })),
  );
  await f.openControl();
  for (const source of f.sources) await f.install(source);
  const first = await f.request("GET", `${url}?limit=2`);
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(
    first
      .json()
      .plugins.map(
        (entry: { selection: { pluginId: string } }) =>
          entry.selection.pluginId,
      ),
    ["status.page0", "status.page1"],
  );
  assert.equal(first.json().next, "status.page1");
  const next = await f.request(
    "GET",
    `${url}?limit=2&afterPluginId=status.page1`,
  );
  assert.deepEqual(
    next
      .json()
      .plugins.map(
        (entry: { selection: { pluginId: string } }) =>
          entry.selection.pluginId,
      ),
    ["status.page2", "status.page3"],
  );
  assert.equal(next.json().next, null);
  assert.ok(Buffer.byteLength(first.body) < 64 * 1024);
  for (const query of [
    "limit=51",
    "limit=01",
    "limit=2&limit=3",
    "profileId=foreign",
    "tenantId=foreign",
    "spaceId=foreign",
  ])
    assert.equal((await f.request("GET", `${url}?${query}`)).statusCode, 400);
  assert.equal(await f.marker(), "");
});

test("installation runtime copies bounded query data before awaiting and refuses getter or selector injection", async (t) => {
  const f = await fixture(t);
  await f.openInstallation();
  await f.install(f.sources[0]!);
  const query = { afterPluginId: null, limit: 1 };
  const captured = f.installation.compositionStatus.listStatus(actor, query);
  query.limit = 0;
  assert.equal((await captured).plugins.length, 1);
  for (const limit of [0, 51, 1.5, NaN])
    assert.throws(
      () =>
        f.installation.compositionStatus.listStatus(actor, {
          afterPluginId: null,
          limit,
        }),
      /plugin_control_limit_invalid/,
    );
  let getterCalls = 0;
  const getterQuery = Object.defineProperty({ ...firstPage }, "limit", {
    enumerable: true,
    get() {
      getterCalls++;
      return 20;
    },
  });
  assert.throws(
    () => f.installation.compositionStatus.listStatus(actor, getterQuery),
    /plugin_security_fields_invalid/,
  );
  assert.throws(
    () =>
      f.installation.compositionStatus.listStatus(actor, {
        ...firstPage,
        profileId: "injected",
      } as typeof firstPage),
    /plugin_security_fields_invalid/,
  );
  assert.equal(getterCalls, 0);
  assert.equal(await f.marker(), "");
});

test(
  "installation runtime physically joins a blocked status read and rejects it after synchronous close",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.openInstallation();
    const entered = deferred(),
      release = deferred();
    t.after(() => release.resolve());
    const epoch = f.authority.epoch.bind(f.authority);
    let blocked = false;
    t.mock.method(
      f.authority,
      "epoch",
      async (input: Parameters<DesktopPluginAuthority["epoch"]>[0]) => {
        const actual = await epoch(input);
        if (!blocked && input.action === "pluginInstallation:read") {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        return actual;
      },
    );
    const pending = f.installation.compositionStatus.listStatus(
      actor,
      firstPage,
    );
    const rejected = assert.rejects(
      pending,
      /plugin_installation_profile_unavailable/,
    );
    await entered.promise;
    let closed = false;
    const closing = f.installation.close().then(() => {
      closed = true;
    });
    assert.throws(
      () => f.installation.compositionStatus.listStatus(actor, firstPage),
      /runtime_closed/,
    );
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(
      closed,
      false,
      "close must join the real in-flight status operation before releasing its SQLite claim",
    );
    release.resolve();
    await rejected;
    await closing;
    assert.equal(closed, true);
    assert.equal(await f.marker(), "");
  },
);

function productionStatusApp(installation: DesktopPluginInstallationRuntime) {
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error, request.id);
    return reply.code(result.statusCode).send(result.body);
  });
  const now = Date.parse("2026-10-11T00:00:00.000Z");
  registerPluginControlRoutes(app, {
    identity: new ProductionControlApiIdentity({
      trustedBff: new StaticTrustedBffRequestVerifier({
        serviceToken: "b".repeat(32),
        allowedOrigins: ["crewon://desktop"],
        allowedRemoteAddresses: ["127.0.0.1"],
      }),
      tokens: {
        verify: async ({ accessToken }) => {
          const changes: Readonly<Record<string, object>> = {
            ["s".repeat(32)]: {},
            "foreign-principal": { principalId: "another-principal" },
            "foreign-actor": { actorId: "another-actor" },
            "foreign-tenant": { tenantId: "another-tenant" },
            "foreign-space": { spaceId: "another-space" },
          };
          if (!Object.hasOwn(changes, accessToken))
            throw new ControlApiIdentityError(
              "authentication",
              "token_invalid",
            );
          return {
            ...actor,
            ...changes[accessToken],
            issuer: "https://status-identity.example",
            audience: "crewon-control",
            issuedAt: new Date(now - 1000).toISOString(),
            expiresAt: new Date(now + 60000).toISOString(),
          };
        },
      },
      expectedIssuer: "https://status-identity.example",
      expectedAudience: "crewon-control",
      timeoutMs: 1000,
      cacheTtlMs: 0,
      now: () => now,
    }),
    pluginCompositionStatus: installation.compositionStatus,
  });
  return app;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
