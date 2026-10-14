import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClient } from "../../../packages/control-client/src/control-api-client.ts";
import {
  createPluginControlRouteFixture,
  pluginRouteCredentials,
} from "../../control-api/src/plugin-control-route.test-support.ts";
import { createWebBff } from "./web-bff.ts";

test("entry bytes revalidate each real mount across refresh without accepting revoked or closed owners", async (t) => {
  const f = await createPluginControlRouteFixture(t);
  const origin = pluginRouteCredentials.origin;
  const secret = "code-cache-browser-csrf-secret-" + "c".repeat(32);
  const session = {
    sessionId: "code-cache-account-session-" + "s".repeat(32),
    controlAccessToken: pluginRouteCredentials.sessionToken,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  const proxied: string[] = [];

  const bff = createWebBff({
    publicOrigin: origin,
    controlTarget: "http://127.0.0.1:3210",
    controlBffToken: "code-cache-service-token-" + "b".repeat(32),
    controlCsrfToken: pluginRouteCredentials.csrfToken,
    csrfSecret: secret,
    identity: {
      resolve: async ({ cookie }) =>
        cookie?.startsWith("account=owner")
          ? session
          : cookie?.startsWith("account=other")
            ? {
                ...session,
                sessionId: "other-account-session-" + "x".repeat(32),
                controlAccessToken:
                  "invalid-other-account-token-" + "o".repeat(32),
              }
            : null,
    },
    fetch: async (url, init) => {
      const value = new URL(String(url));
      proxied.push(value.pathname);
      const response = await f.app.inject({
        method: init?.method as "GET" | "POST" | "PUT" | "DELETE",
        url: value.pathname + value.search,
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(init?.body
          ? { payload: Buffer.from(init.body as ArrayBuffer) }
          : {}),
      });
      return new Response(Uint8Array.from(response.rawPayload).buffer, {
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
      });
    },
  });
  const browserFetch: typeof fetch = async (url, init) => {
    const response = await bff.handle(
      new Request(String(url), {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          cookie: "account=owner",
        },
      }),
    );
    return response;
  };
  const bootstrap = await browserFetch(origin + "/control-api/session");
  assert.equal(
    bootstrap.headers.get("x-crewon-plugin-ui-assets"),
    "entry-bytes.v1",
  );
  assert.deepEqual(Object.keys(await bootstrap.clone().json()), [
    "baseUrl",
    "csrfToken",
  ]);
  const { csrfToken } = (await bootstrap.json()) as { csrfToken: string };
  const client = new ControlApiClient({
    baseUrl: origin,
    origin,
    csrfToken,
    fetch: browserFetch,
  });
  const pkg = await f.createPackage("1.0.0", { uiFormat: "single-entry" });
  await client.plugins.installPackage(
    {
      sourceId: pkg.sourceId,
      expectedPluginId: pkg.expectedPluginId,
      expectedPackageDigest: pkg.expectedPackageDigest,
      expectedSelectionRevision: null,
    },
    "install-code-cache",
  );
  await client.plugins.setSelection(
    pkg.expectedPluginId,
    {
      state: "enabled",
      selectedPackageDigest: pkg.expectedPackageDigest,
      expectedSelectionRevision: 1,
    },
    "enable-code-cache",
  );
  const open = () =>
    client.plugins.openMount({
      pluginId: pkg.expectedPluginId,
      contributionId: "counter",
      expectedSelectionRevision: 2,
      expectedPackageDigest: pkg.expectedPackageDigest,
    });
  const first = await open();
  const pathFor = (mountRef: string) =>
    `/api/v1/plugins/ui/mounts/${mountRef}/assets/ui/entry.mjs`;
  let currentRef = first.mountRef;
  const read = (tag?: string, owner = "owner") =>
    bff.handle(
      new Request(origin + pathFor(currentRef), {
        headers: {
          "cookie": `account=${owner}`,
          "x-crewon-plugin-ui-code-cache": "entry-bytes.v1",
          ...(tag ? { "if-none-match": tag } : {}),
        },
      }),
    );
  const initial = await read();
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "private, no-cache");
  const code = await initial.text();
  assert.ok(code.length > 0);
  const etag = initial.headers.get("etag")!;
  assert.match(etag, /^"sha256:[a-f0-9]{64}"$/u);
  const second = await open();
  assert.notEqual(second.mountRef, first.mountRef);
  currentRef = second.mountRef;
  const before = proxied.length;
  const cached = await read(etag);
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  assert.equal(proxied.length, before + 1);
  assert.equal(
    proxied.at(-1),
    `/api/v1/plugins/ui/mounts/${second.mountRef}/assets/ui/entry.mjs`,
  );
  assert.equal((await read("W/" + etag)).status, 304);
  const legacy = await browserFetch(
    origin + `/api/v1/plugins/ui/mounts/${first.mountRef}/assets/ui/entry.mjs`,
  );
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get("cache-control"), "no-store");
  assert.equal(await legacy.text(), code);
  const dispatched = proxied.length;
  assert.equal((await read(etag, "other")).status, 401);
  assert.equal(proxied.length, dispatched + 1);
  f.policy.denyUi = true;
  const denied = await read(etag);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("cache-control"), "no-store");
  f.policy.denyUi = false;
  await client.plugins.closeMount(second.mountRef);
  assert.notEqual((await read(etag)).status, 304);
});
