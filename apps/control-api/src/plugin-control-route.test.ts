import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  createPluginControlRouteFixture,
  pluginRouteActor,
  pluginRouteCredentials,
  pluginRouteHeaders,
} from "./plugin-control-route.test-support.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import {
  PRODUCTION_BFF_AUTHORIZATION_HEADER,
  ProductionControlApiIdentity,
  StaticTrustedBffRequestVerifier,
} from "./production-security-adapters.ts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { errorResponse } from "./control-api-errors.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";

type Fixture = Awaited<ReturnType<typeof createPluginControlRouteFixture>>;
type Package = Awaited<ReturnType<Fixture["createPackage"]>>;
const prefix = "/api/v1/plugins";
function install(
  f: Fixture,
  pkg: Package,
  expectedSelectionRevision: number | null,
  key: string,
) {
  return f.app.inject({
    method: "POST",
    url: `${prefix}/installations`,
    headers: { ...pluginRouteHeaders, "idempotency-key": key },
    payload: {
      sourceId: pkg.sourceId,
      expectedPluginId: pkg.expectedPluginId,
      expectedPackageDigest: pkg.expectedPackageDigest,
      expectedSelectionRevision,
    },
  });
}
function select(
  f: Fixture,
  pkg: Package,
  expectedSelectionRevision: number,
  state: "enabled" | "disabled" | "uninstalled",
  key: string,
) {
  return f.app.inject({
    method: "PUT",
    url: `${prefix}/selections/${pkg.expectedPluginId}`,
    headers: { ...pluginRouteHeaders, "idempotency-key": key },
    payload: {
      state,
      selectedPackageDigest:
        state === "uninstalled" ? null : pkg.expectedPackageDigest,
      expectedSelectionRevision,
    },
  });
}
async function mount(f: Fixture, pkg: Package, expectedSelectionRevision = 2) {
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/ui/mounts`,
    headers: pluginRouteHeaders,
    payload: {
      pluginId: pkg.expectedPluginId,
      contributionId: "counter",
      expectedPackageDigest: pkg.expectedPackageDigest,
      expectedSelectionRevision,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<{
    mountRef: string;
    packageDigest: string;
    selectionRevision: number;
  }>();
}
function action(f: Fixture, mountRef: string) {
  return f.app.inject({
    method: "POST",
    url: `${prefix}/ui/mounts/${mountRef}/actions`,
    headers: pluginRouteHeaders,
    payload: { action: "counter.increment", input: { delta: 1 } },
  });
}

test("formal plugin routes install actual bytes, load selected Node/UI versions and withdraw old leases", async (t) => {
  const f = await createPluginControlRouteFixture(t);
  const v1 = await f.createPackage("1.0.0");
  const v2 = await f.createPackage("2.0.0");
  const first = await install(f, v1, null, "install-v1");
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().selection.state, "disabled");
  assert.deepEqual(Object.keys(first.json().package).sort(), [
    "installedAt",
    "packageDigest",
    "pluginId",
    "publisherId",
    "version",
  ]);
  assert.equal(JSON.stringify(first.json()).includes("tenantId"), false);
  assert.equal(JSON.stringify(first.json()).includes(f.root), false);
  assert.deepEqual(f.events, []);
  assert.equal(
    (await install(f, v1, null, "install-v1")).json().disposition,
    "replayed",
  );
  assert.equal((await install(f, v2, 1, "install-v2")).statusCode, 200);
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: `${prefix}/ui/catalog`,
        headers: pluginRouteHeaders,
      })
    ).json().plugins.length,
    0,
  );
  await f.removeDevelopmentSources();
  const enabled = await select(f, v1, 1, "enabled", "enable-v1");
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.deepEqual(enabled.json().projection, { outcome: "applied" });
  assert.deepEqual(f.events, ["setup:1.0.0"]);
  const catalog = await f.app.inject({
    method: "GET",
    url: `${prefix}/ui/catalog`,
    headers: pluginRouteHeaders,
  });
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.equal(catalog.json().plugins[0].descriptor.version, "1.0.0");
  assert.deepEqual(catalog.json().plugins[0].publicAssets, [
    "ui/chunk.mjs",
    "ui/entry.mjs",
  ]);
  const lease = await mount(f, v1);
  const asset = await f.app.inject({
    method: "GET",
    url: `${prefix}/ui/mounts/${lease.mountRef}/assets/ui/entry.mjs`,
    headers: pluginRouteHeaders,
  });
  assert.equal(asset.statusCode, 200, asset.body);
  assert.equal(asset.body, v1.content["ui/entry.mjs"]);
  assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(asset.headers["cache-control"], "no-store");
  assert.equal(asset.headers["x-content-type-options"], "nosniff");
  assert.equal(asset.headers["cross-origin-resource-policy"], "same-origin");
  assert.deepEqual((await action(f, lease.mountRef)).json(), {
    output: { count: 1, version: "1.0.0" },
  });
  const switched = await select(f, v2, 2, "enabled", "enable-v2");
  assert.equal(switched.statusCode, 200, switched.body);
  assert.equal((await action(f, lease.mountRef)).statusCode, 409);
  const secondLease = await mount(f, v2, 3);
  assert.deepEqual((await action(f, secondLease.mountRef)).json(), {
    output: { count: 1, version: "2.0.0" },
  });
  assert.equal(
    (await select(f, v2, 3, "disabled", "disable-v2")).statusCode,
    200,
  );
  assert.equal((await action(f, secondLease.mountRef)).statusCode, 409);
  const removed = await select(f, v2, 4, "uninstalled", "remove-v2");
  assert.equal(removed.statusCode, 200, removed.body);
  const packages = await f.app.inject({
    method: "GET",
    url: `${prefix}/packages`,
    headers: pluginRouteHeaders,
  });
  assert.equal(packages.json().packages.length, 2);
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: `${prefix}/selections/test.counter`,
        headers: pluginRouteHeaders,
      })
    ).json().selection.state,
    "uninstalled",
  );
});

test("installation requests use current identity, CSRF, strict commands and durable receipts", async (t) => {
  const f = await createPluginControlRouteFixture(t);
  const pkg = await f.createPackage("1.0.0");
  const body = {
    sourceId: pkg.sourceId,
    expectedPluginId: pkg.expectedPluginId,
    expectedPackageDigest: pkg.expectedPackageDigest,
    expectedSelectionRevision: null,
  };
  const request = {
    method: "POST" as const,
    url: `${prefix}/installations`,
    payload: body,
  };
  assert.equal((await f.app.inject(request)).statusCode, 401);
  assert.equal(
    (
      await f.app.inject({
        ...request,
        headers: {
          "authorization": pluginRouteHeaders.authorization,
          "origin": pluginRouteHeaders.origin,
          "idempotency-key": "missing-csrf",
        },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.app.inject({ ...request, headers: pluginRouteHeaders }))
      .statusCode,
    400,
  );
  for (const extra of [
    { tenantId: "foreign" },
    { profileId: "foreign" },
    { directory: pkg.directory },
    { url: "https://unapproved.test" },
    { actor: pluginRouteActor },
  ])
    assert.equal(
      (
        await f.app.inject({
          ...request,
          payload: { ...body, ...extra },
          headers: { ...pluginRouteHeaders, "idempotency-key": "invalid-body" },
        })
      ).statusCode,
      400,
    );
  assert.deepEqual(f.events, []);
  assert.equal(
    (
      await f.app.inject({
        ...request,
        payload: { ...body, sourceId: "unregistered" },
        headers: { ...pluginRouteHeaders, "idempotency-key": "unknown-source" },
      })
    ).statusCode,
    404,
  );
  assert.equal((await install(f, pkg, null, "fixed-key")).statusCode, 200);
  assert.equal((await install(f, pkg, null, "other-key")).statusCode, 409);
  assert.equal((await install(f, pkg, 1, "fixed-key")).statusCode, 409);
  const firstSelect = await select(f, pkg, 1, "enabled", "enable-once");
  assert.equal(firstSelect.statusCode, 200, firstSelect.body);
  const replay = await select(f, pkg, 1, "enabled", "enable-once");
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().mutation.disposition, "replayed");
  assert.deepEqual(replay.json().projection, { outcome: "unchanged" });
  assert.deepEqual(f.events, ["setup:1.0.0"]);
});

test("UI use permission is separate from installation, and each lease asset/action checks current epoch", async (t) => {
  const f = await createPluginControlRouteFixture(t);
  const pkg = await f.createPackage("1.0.0");
  assert.equal((await install(f, pkg, null, "install")).statusCode, 200);
  assert.equal((await select(f, pkg, 1, "enabled", "enable")).statusCode, 200);
  f.policy.denyInstallation = true;
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: `${prefix}/packages`,
        headers: pluginRouteHeaders,
      })
    ).statusCode,
    403,
  );
  const lease = await mount(f, pkg);
  const assetUrl = `${prefix}/ui/mounts/${lease.mountRef}/assets/ui/chunk.mjs`;
  assert.equal(
    (await f.app.inject({ method: "GET", url: assetUrl })).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: assetUrl,
        headers: pluginRouteHeaders,
      })
    ).statusCode,
    200,
  );
  f.policy.deniedUiActions.add("asset");
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: assetUrl,
        headers: pluginRouteHeaders,
      })
    ).statusCode,
    403,
  );
  f.policy.deniedUiActions.clear();
  assert.equal((await action(f, lease.mountRef)).statusCode, 200);
  const fresh = await mount(f, pkg);
  f.policy.epoch = "test-authority-v2";
  assert.equal((await action(f, fresh.mountRef)).statusCode, 403);
  f.policy.epoch = "test-authority-v1";
  assert.equal((await action(f, fresh.mountRef)).statusCode, 404);
  assert.ok(f.policy.uiActions.includes("asset"));
  assert.ok(f.policy.uiActions.includes("invoke"));
});

test("lease close is authenticated/idempotent and public assets cannot expose private inventory", async (t) => {
  const f = await createPluginControlRouteFixture(t);
  const pkg = await f.createPackage("1.0.0");
  await install(f, pkg, null, "install");
  await select(f, pkg, 1, "enabled", "enable");
  const lease = await mount(f, pkg);
  const base = `${prefix}/ui/mounts/${lease.mountRef}`;
  for (const path of [
    "node.mjs",
    "crewon.plugin.json",
    "ui/%2e%2e/node.mjs",
    "ui/%252e%252e/node.mjs",
    "ui/%2fnode.mjs",
  ])
    assert.notEqual(
      (
        await f.app.inject({
          method: "GET",
          url: `${base}/assets/${path}`,
          headers: pluginRouteHeaders,
        })
      ).statusCode,
      200,
    );
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: `${base}/assets/ui/chunk.mjs?tenantId=foreign`,
        headers: pluginRouteHeaders,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: pluginRouteHeaders,
        payload: { action: "node.exec", input: {} },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "DELETE",
        url: base,
        headers: {
          authorization: pluginRouteHeaders.authorization,
          origin: pluginRouteHeaders.origin,
        },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "DELETE",
        url: base,
        headers: pluginRouteHeaders,
        payload: { force: true },
      })
    ).statusCode,
    400,
  );
  for (let index = 0; index < 2; index++) {
    const close = await f.app.inject({
      method: "DELETE",
      url: base,
      headers: pluginRouteHeaders,
    });
    assert.equal(close.statusCode, 200, close.body);
    assert.deepEqual(close.json(), { closed: true });
  }
  assert.equal((await action(f, lease.mountRef)).statusCode, 404);
});

test("catalog pagination preserves underlying disabled selections rather than inventing an end cursor", async (t) => {
  const f = await createPluginControlRouteFixture(t);
  const hidden = await f.createPackage("1.0.0", {
    pluginId: "test.a-hidden",
    nodeOnly: true,
  });
  const visible = await f.createPackage("1.0.0", {
    pluginId: "test.z-visible",
  });
  await install(f, hidden, null, "hidden");
  await install(f, visible, null, "visible");
  await select(f, visible, 1, "enabled", "enable-visible");
  const first = await f.app.inject({
    method: "GET",
    url: `${prefix}/ui/catalog?limit=1`,
    headers: pluginRouteHeaders,
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { plugins: [], next: "test.a-hidden" });
  const second = await f.app.inject({
    method: "GET",
    url: `${prefix}/ui/catalog?limit=1&afterPluginId=test.a-hidden`,
    headers: pluginRouteHeaders,
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().plugins[0].descriptor.pluginId, "test.z-visible");
  assert.equal(second.json().next, null);
  for (const query of [
    "limit=0",
    "limit=51",
    "limit=1&limit=2",
    "profileId=foreign",
    "afterPluginId=test.a&afterPluginId=test.b",
  ])
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: `${prefix}/ui/catalog?${query}`,
          headers: pluginRouteHeaders,
        })
      ).statusCode,
      400,
    );
});

test("post-commit projection failure reports durable pending selection and prevents stale actions", async (t) => {
  const f = await createPluginControlRouteFixture(t);
  const pkg = await f.createPackage("1.0.0");
  await install(f, pkg, null, "install");
  f.policy.denyCommit = true;
  const pending = await select(f, pkg, 1, "enabled", "pending-enable");
  assert.equal(pending.statusCode, 200, pending.body);
  assert.deepEqual(pending.json().projection, {
    outcome: "pending",
    reasonCode: "plugin_projection_pending",
  });
  assert.equal(f.current(pkg.expectedPluginId)?.revision, 2);
  const lease = await mount(f, pkg);
  assert.notEqual((await action(f, lease.mountRef)).statusCode, 200);
  f.policy.denyCommit = false;
  const replay = await select(f, pkg, 1, "enabled", "pending-enable");
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json().projection, { outcome: "unchanged" });
  assert.notEqual((await action(f, lease.mountRef)).statusCode, 200);
});

test("expired and foreign actor mounts cannot read resources through formal routes", async (t) => {
  let selectedActor = pluginRouteActor;
  const f = await createPluginControlRouteFixture(t, {
    identity: { resolveActor: async () => selectedActor },
  });
  const pkg = await f.createPackage("1.0.0");
  await install(f, pkg, null, "install");
  await select(f, pkg, 1, "enabled", "enable");
  const lease = await mount(f, pkg);
  selectedActor = {
    ...pluginRouteActor,
    principalId: "other-principal",
    actorId: "other-actor",
  };
  assert.equal((await action(f, lease.mountRef)).statusCode, 404);
  const foreignClose = await f.app.inject({
    method: "DELETE",
    url: `${prefix}/ui/mounts/${lease.mountRef}`,
    headers: pluginRouteHeaders,
  });
  assert.equal(foreignClose.statusCode, 200, foreignClose.body);
  assert.deepEqual(foreignClose.json(), { closed: true });
  selectedActor = pluginRouteActor;
  assert.equal((await action(f, lease.mountRef)).statusCode, 200);
  f.advanceClock(300_001);
  assert.equal((await action(f, lease.mountRef)).statusCode, 409);
  assert.equal((await action(f, lease.mountRef)).statusCode, 404);
});

test("production identity rejects injected actors and obtains HTTP scope only from verified user tokens", async (t) => {
  const now = Date.parse("2026-10-03T00:00:00.000Z");
  const serviceToken = "test-bff-service-" + "b".repeat(32);
  let verifications = 0;
  const identity = new ProductionControlApiIdentity({
    trustedBff: new StaticTrustedBffRequestVerifier({
      serviceToken,
      allowedOrigins: [pluginRouteCredentials.origin],
      allowedRemoteAddresses: ["127.0.0.1"],
    }),
    tokens: {
      verify: async ({ accessToken }) => {
        verifications++;
        if (accessToken !== pluginRouteCredentials.sessionToken)
          throw new ControlApiIdentityError(
            "authentication",
            "test_token_invalid",
          );
        return {
          ...pluginRouteActor,
          issuer: "https://identity.example.test",
          audience: "crewon-control",
          issuedAt: new Date(now - 1_000).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
        };
      },
    },
    expectedIssuer: "https://identity.example.test",
    expectedAudience: "crewon-control",
    timeoutMs: 1_000,
    cacheTtlMs: 0,
    now: () => now,
  });
  const f = await createPluginControlRouteFixture(t, { identity });
  const headers = {
    ...pluginRouteHeaders,
    [PRODUCTION_BFF_AUTHORIZATION_HEADER]: `Bearer ${serviceToken}`,
  };
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: `${prefix}/selections`,
        headers,
      })
    ).statusCode,
    200,
  );
  assert.equal(verifications, 1);
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: `${prefix}/selections`,
        headers: { ...headers, "x-crewon-tenant-id": "foreign" },
      })
    ).statusCode,
    403,
  );
  assert.equal(verifications, 1);
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: `${prefix}/selections`,
        headers: pluginRouteHeaders,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: `${prefix}/selections?profileId=foreign`,
        headers,
      })
    ).statusCode,
    400,
  );
});

test("unconfigured plugin services publish no installation or UI mount routes", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let identities = 0;
  registerPluginControlRoutes(app, {
    identity: {
      resolveActor: async () => {
        identities++;
        return pluginRouteActor;
      },
    },
  });
  for (const url of [
    "/packages",
    "/selections",
    "/ui/mounts/" + "r".repeat(40),
  ])
    assert.equal(
      (await app.inject({ method: "GET", url: prefix + url })).statusCode,
      404,
    );
  assert.equal(identities, 0);
});

test("an unconfigured UI directory publishes its explicit marker only after existing identity and strict query validation", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, request, reply) => {
    const mapped = errorResponse(error, request.id);
    void reply.code(mapped.statusCode).send(mapped.body);
  });
  registerPluginControlRoutes(app, {
    identity: new StandaloneIdentity({
      actor: pluginRouteActor,
      sessionToken: pluginRouteCredentials.sessionToken,
      csrfToken: pluginRouteCredentials.csrfToken,
      allowedOrigins: [pluginRouteCredentials.origin],
    }),
  });
  const catalog = `${prefix}/ui/catalog`;
  for (const [headers, remoteAddress, expected] of [
    [{}, "127.0.0.1", 401],
    [
      { ...pluginRouteHeaders, authorization: "Bearer invalid-test-session" },
      "127.0.0.1",
      401,
    ],
    [
      { ...pluginRouteHeaders, origin: "https://foreign.example.test" },
      "127.0.0.1",
      403,
    ],
    [pluginRouteHeaders, "192.0.2.1", 403],
  ] as const) {
    const denied = await app.inject({
      method: "GET",
      url: catalog,
      headers,
      remoteAddress,
    });
    assert.equal(denied.statusCode, expected);
    assert.notEqual(denied.json().error.code, "plugin_ui_not_configured");
  }
  const valid = await app.inject({
    method: "GET",
    url: `${catalog}?limit=20`,
    headers: pluginRouteHeaders,
  });
  assert.equal(valid.statusCode, 404);
  assert.equal(valid.json().error.category, "notFound");
  assert.equal(valid.json().error.code, "plugin_ui_not_configured");
  assert.equal(typeof valid.json().error.requestId, "string");
  assert.equal(valid.headers["cache-control"], "no-store");
  assert.equal(valid.headers["x-content-type-options"], "nosniff");
  assert.equal(Object.hasOwn(valid.json(), "plugins"), false);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `${catalog}?profileId=foreign`,
        headers: pluginRouteHeaders,
      })
    ).statusCode,
    400,
  );

  // The existing unchanged client still receives its ordinary typed 404 error;
  // neither success DTOs nor HTTP/session authority are replaced by this marker.
  const client = new ControlApiClient({
    baseUrl: pluginRouteCredentials.origin,
    accessToken: pluginRouteCredentials.sessionToken,
    origin: pluginRouteCredentials.origin,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      const response = await app.inject({
        method: "GET",
        url: url.pathname + url.search,
        headers,
        remoteAddress: "127.0.0.1",
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await assert.rejects(
    client.plugins.uiCatalog(),
    (error) =>
      error instanceof ControlApiClientError &&
      error.status === 404 &&
      error.category === "notFound" &&
      error.code === "plugin_ui_not_configured",
  );
});
