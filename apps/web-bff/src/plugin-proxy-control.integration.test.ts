import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiClientError,
} from "../../../packages/control-client/src/control-api-client.ts";
import {
  createPluginControlRouteFixture,
  pluginRouteActor,
  pluginRouteCredentials,
} from "../../control-api/src/plugin-control-route.test-support.ts";
import {
  ProductionControlApiIdentity,
  StaticTrustedBffRequestVerifier,
} from "../../control-api/src/production-security-adapters.ts";
import { ControlApiIdentityError } from "../../control-api/src/control-api-ports.ts";
import { createWebBff } from "./web-bff.ts";

test("actual client/BFF/Control HTTP installs immutable packages, serves authenticated chunks and fences each lease", async (t) => {
  const publicOrigin = pluginRouteCredentials.origin;
  const serviceToken = "plugin-bff-integration-service-" + "s".repeat(32);
  const cookie = "crewon_session=plugin-owner-session";
  const otherCookie = "crewon_session=plugin-other-session";
  const otherToken = "plugin-other-control-token-" + "o".repeat(32);
  const now = Date.parse("2026-10-03T00:00:00.000Z");
  const verifiedTokens: string[] = [];
  const identity = new ProductionControlApiIdentity({
    trustedBff: new StaticTrustedBffRequestVerifier({
      serviceToken,
      allowedOrigins: [publicOrigin],
      allowedRemoteAddresses: ["127.0.0.1"],
    }),
    tokens: {
      verify: async ({ accessToken }) => {
        verifiedTokens.push(accessToken);
        if (
          accessToken !== pluginRouteCredentials.sessionToken &&
          accessToken !== otherToken
        )
          throw new ControlApiIdentityError(
            "authentication",
            "test_token_invalid",
          );
        return {
          ...pluginRouteActor,
          ...(accessToken === otherToken
            ? { principalId: "other-principal", actorId: "other-actor" }
            : {}),
          issuer: "https://identity.example.test",
          audience: "crewon-control",
          issuedAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
        };
      },
    },
    expectedIssuer: "https://identity.example.test",
    expectedAudience: "crewon-control",
    timeoutMs: 1000,
    cacheTtlMs: 0,
    now: () => now,
  });
  const f = await createPluginControlRouteFixture(t, { identity });
  const controlOrigin = await f.app.listen({ host: "127.0.0.1", port: 0 });
  const proxied: { url: string; headers: Headers }[] = [];
  const resolvedCookies: (string | null)[] = [];
  const bff = createWebBff({
    publicOrigin,
    controlTarget: controlOrigin,
    controlBffToken: serviceToken,
    controlCsrfToken: pluginRouteCredentials.csrfToken,
    csrfSecret: "plugin-bff-integration-csrf-secret-" + "c".repeat(32),
    identity: {
      resolve: async ({ cookie: currentCookie }) => {
        resolvedCookies.push(currentCookie);
        if (currentCookie !== cookie && currentCookie !== otherCookie)
          return null;
        return {
          sessionId:
            currentCookie === cookie
              ? "plugin-owner-session-" + "a".repeat(32)
              : "plugin-other-session-" + "b".repeat(32),
          expiresAt: "2030-01-01T00:00:00.000Z",
          controlAccessToken:
            currentCookie === cookie
              ? pluginRouteCredentials.sessionToken
              : otherToken,
        };
      },
    },
    fetch: async (url, init = {}) => {
      const headers = new Headers(init.headers);
      assert.equal(
        headers.get("x-crewon-bff-authorization"),
        `Bearer ${serviceToken}`,
      );
      assert.equal(headers.get("cookie"), null);
      assert.equal(headers.get("x-crewon-tenant-id"), null);
      proxied.push({ url: String(url), headers });
      return globalThis.fetch(url, init);
    },
  });
  // Models the existing private HTTP BFF behind TLS termination, with the externally configured origin.
  // It does not claim packaged Electron file:// resource support or a browser module execution test.
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    incoming.once("aborted", abort);
    outgoing.once("close", abort);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const method = incoming.method ?? "GET";
      const headers = new Headers();
      for (const [name, values] of Object.entries(incoming.headersDistinct))
        for (const value of values ?? []) headers.append(name, value);
      const request = new Request(new URL(incoming.url ?? "/", publicOrigin), {
        method,
        headers,
        signal: controller.signal,
        ...(method === "GET" ? {} : { body: Buffer.concat(chunks) }),
      });
      const response = await bff.handle(request, {
        rawTarget: incoming.url ?? "/",
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500).end();
    } finally {
      incoming.removeListener("aborted", abort);
      outgoing.removeListener("close", abort);
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const browserOrigin = `http://127.0.0.1:${address.port}`;
  const sessionFetch =
    (sessionCookie: string): typeof globalThis.fetch =>
    (input, init = {}) => {
      const url = new URL(String(input));
      assert.equal(url.origin, publicOrigin);
      const headers = new Headers(init.headers);
      headers.set("cookie", sessionCookie);
      return globalThis.fetch(`${browserOrigin}${url.pathname}${url.search}`, {
        ...init,
        headers,
      });
    };
  const browserFetch = sessionFetch(cookie);
  const bootstrap = await browserFetch(`${publicOrigin}/control-api/session`);
  assert.equal(bootstrap.status, 200);
  const { csrfToken } = (await bootstrap.json()) as { csrfToken: string };
  const client = new ControlApiClient({
    baseUrl: publicOrigin,
    csrfToken,
    origin: publicOrigin,
    fetch: browserFetch,
  });
  const v1 = await f.createPackage("1.0.0");
  const v2 = await f.createPackage("2.0.0");
  const install = (pkg: typeof v1, revision: number | null, key: string) =>
    client.plugins.installPackage(
      {
        sourceId: pkg.sourceId,
        expectedPluginId: pkg.expectedPluginId,
        expectedPackageDigest: pkg.expectedPackageDigest,
        expectedSelectionRevision: revision,
      },
      key,
    );
  const select = (pkg: typeof v1, revision: number, key: string) =>
    client.plugins.setSelection(
      pkg.expectedPluginId,
      {
        state: "enabled",
        selectedPackageDigest: pkg.expectedPackageDigest,
        expectedSelectionRevision: revision,
      },
      key,
    );
  assert.equal(
    (await install(v1, null, "install-v1")).selection.state,
    "disabled",
  );
  assert.equal((await install(v1, null, "install-v1")).disposition, "replayed");
  assert.equal((await install(v2, 1, "install-v2")).selection.revision, 1);
  assert.equal(
    (await client.plugins.listPackages({ pluginId: v1.expectedPluginId }))
      .packages.length,
    2,
  );
  assert.equal(
    (await client.plugins.getPackage(v1.expectedPackageDigest)).package
      ?.version,
    "1.0.0",
  );
  assert.equal(
    (await client.plugins.listSelections()).selections[0]?.state,
    "disabled",
  );
  assert.equal(
    (await client.plugins.getSelection(v1.expectedPluginId)).selection
      ?.revision,
    1,
  );
  const disabledCatalog = await client.plugins.uiCatalog();
  assert.deepEqual(disabledCatalog, { plugins: [], next: null });
  await f.removeDevelopmentSources();
  assert.equal(
    (await select(v1, 1, "enable-v1")).projection.outcome,
    "applied",
  );
  const catalog = await client.plugins.uiCatalog();
  assert.equal(catalog.plugins[0]?.descriptor.version, "1.0.0");
  const mount = await client.plugins.openMount({
    pluginId: v1.expectedPluginId,
    contributionId: "counter",
    expectedSelectionRevision: 2,
    expectedPackageDigest: v1.expectedPackageDigest,
  });
  assert.equal(
    (await client.plugins.validateMount(mount.mountRef)).mountRef,
    mount.mountRef,
  );
  f.advanceClock(150_000);
  assert.deepEqual(await client.plugins.validateMount(mount.mountRef), mount);
  const renewed = await client.plugins.renewMount(mount.mountRef, {
    expectedExpiresAt: mount.expiresAt,
  });
  assert.equal(renewed.expiresAt, "2026-10-03T00:07:30.000Z");
  assert.deepEqual({ ...renewed, expiresAt: mount.expiresAt }, mount);
  assert.deepEqual(await client.plugins.validateMount(mount.mountRef), renewed);
  await assert.rejects(
    client.plugins.renewMount(mount.mountRef, {
      expectedExpiresAt: mount.expiresAt,
    }),
    (error: unknown) =>
      error instanceof ControlApiClientError &&
      error.status === 409 &&
      error.code === "plugin_ui_mount_lease_changed",
  );
  assert.equal(f.current(v1.expectedPluginId)?.revision, 2);
  const assetPath = `/api/v1/plugins/ui/mounts/${mount.mountRef}/assets/ui/entry.mjs`;
  const beforeAsset = verifiedTokens.length;
  for (const path of ["ui/entry.mjs", "ui/chunk.mjs"]) {
    const response = await browserFetch(
      `${publicOrigin}/api/v1/plugins/ui/mounts/${mount.mountRef}/assets/${path}`,
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), v1.content[path]);
  }
  assert.equal(verifiedTokens.length, beforeAsset + 2);
  assert.deepEqual(
    await client.plugins.invoke(mount.mountRef, {
      action: "counter.increment",
      input: { delta: 1 },
    }),
    { output: { count: 1, version: "1.0.0" } },
  );
  const beforeUnauthenticated = proxied.length;
  assert.equal(
    (
      await globalThis.fetch(`${browserOrigin}${assetPath}`, {
        headers: {
          "authorization": "Bearer forged",
          "x-crewon-bff-authorization": `Bearer ${serviceToken}`,
        },
      })
    ).status,
    401,
  );
  assert.equal(proxied.length, beforeUnauthenticated);
  const stolen = await globalThis.fetch(`${browserOrigin}${assetPath}`, {
    headers: { cookie: otherCookie },
  });
  assert.ok(stolen.status === 403 || stolen.status === 404);
  assert.equal(
    await stolen
      .text()
      .then((text) => text.includes(v1.content["ui/entry.mjs"]!)),
    false,
  );
  const otherFetch = sessionFetch(otherCookie);
  const otherBootstrap = await otherFetch(
    `${publicOrigin}/control-api/session`,
  );
  const otherCsrf = ((await otherBootstrap.json()) as { csrfToken: string })
    .csrfToken;
  const otherClient = new ControlApiClient({
    baseUrl: publicOrigin,
    csrfToken: otherCsrf,
    origin: publicOrigin,
    fetch: otherFetch,
  });
  const cacheHeaders = { "x-crewon-plugin-ui-code-cache": "entry-bytes.v1" };
  const code = await browserFetch(`${publicOrigin}${assetPath}`, {
    headers: cacheHeaders,
  });
  assert.equal(code.status, 200);
  const codeTag = code.headers.get("etag")!;
  await code.arrayBuffer();
  const cachedCode = await browserFetch(`${publicOrigin}${assetPath}`, {
    headers: { ...cacheHeaders, "if-none-match": codeTag },
  });
  assert.equal(cachedCode.status, 304);
  assert.equal(await cachedCode.text(), "");
  const foreignCode = await otherFetch(`${publicOrigin}${assetPath}`, {
    headers: { ...cacheHeaders, "if-none-match": codeTag },
  });
  assert.ok([403, 404].includes(foreignCode.status));
  assert.equal(foreignCode.headers.get("cache-control"), "no-store");
  assert.deepEqual(await otherClient.plugins.closeMount(mount.mountRef), {
    closed: true,
  });
  assert.equal(
    (await client.plugins.validateMount(mount.mountRef)).mountRef,
    mount.mountRef,
  );
  assert.equal(
    (
      await browserFetch(
        `${publicOrigin}/api/v1/plugins/ui/mounts/${mount.mountRef}/assets/node.mjs`,
      )
    ).status,
    404,
  );
  assert.equal(
    (await select(v2, 2, "enable-v2")).mutation.selection.revision,
    3,
  );
  await assert.rejects(
    client.plugins.invoke(mount.mountRef, {
      action: "counter.increment",
      input: { delta: 1 },
    }),
    (error: unknown) =>
      error instanceof ControlApiClientError &&
      (error.status === 409 || error.status === 404),
  );
  const newer = await client.plugins.openMount({
    pluginId: v2.expectedPluginId,
    contributionId: "counter",
    expectedSelectionRevision: 3,
    expectedPackageDigest: v2.expectedPackageDigest,
  });
  assert.equal(
    await (
      await browserFetch(
        `${publicOrigin}/api/v1/plugins/ui/mounts/${newer.mountRef}/assets/ui/chunk.mjs`,
      )
    ).text(),
    v2.content["ui/chunk.mjs"],
  );
  assert.deepEqual(await client.plugins.closeMount(newer.mountRef), {
    closed: true,
  });
  assert.deepEqual(await client.plugins.closeMount(newer.mountRef), {
    closed: true,
  });
  assert.equal(
    (
      await browserFetch(
        `${publicOrigin}/api/v1/plugins/ui/mounts/${newer.mountRef}/assets/ui/entry.mjs`,
      )
    ).status,
    404,
  );
  // http.request preserves the raw traversal which fetch/URL would normalize before dispatch.
  const beforeTraversal = proxied.length;
  const rawStatus = await new Promise<number>((resolve, reject) => {
    const outgoing = httpRequest(
      `${browserOrigin}`,
      {
        path: `/api/v1/plugins/ui/mounts/${newer.mountRef}/assets/%2e%2e/entry.mjs`,
        headers: { cookie },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
  assert.equal(rawStatus, 404);
  assert.equal(proxied.length, beforeTraversal);
  assert.ok(resolvedCookies.includes(otherCookie));
  assert.ok(verifiedTokens.includes(otherToken));
  for (const { url, headers } of proxied) {
    assert.equal(url.includes("token="), false);
    assert.equal(
      headers.get("authorization") ===
        `Bearer ${pluginRouteCredentials.sessionToken}` ||
        headers.get("authorization") === `Bearer ${otherToken}`,
      true,
    );
  }
});
