import assert from "node:assert/strict";
import { createServer, request } from "node:https";
import { join } from "node:path";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import type {
  PluginUiActionPort,
  PluginUiCommittedTaskPort,
} from "@crewon/application";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import { errorResponse } from "./control-api-errors.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import {
  createPluginControlRouteFixture,
  pluginRouteActor,
  pluginRouteCredentials,
  pluginRouteHeaders,
  pluginRouteScope,
} from "./plugin-control-route.test-support.ts";
import { createProductionPluginUiRuntime } from "./production-plugin-ui-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import {
  PRODUCTION_BFF_AUTHORIZATION_HEADER,
  ProductionControlApiIdentity,
  StaticTrustedBffRequestVerifier,
} from "./production-security-adapters.ts";

export async function pluginUiHttpsAuthority(t: TestContext) {
  const profileToken = "fixture-profile-service-" + "p".repeat(32);
  const policyToken = "fixture-policy-service-" + "s".repeat(32);
  const state = {
    epoch: "fixture-ui-grant-v1",
    deny: false,
    foreignProfile: false,
    holdProfile: false,
    requests: [] as { path: string; body: Record<string, unknown> }[],
    aborts: 0,
  };
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    async (req, res) => {
      assert.equal(
        (req.socket as import("node:tls").TLSSocket).getProtocol(),
        "TLSv1.3",
      );
      assert.ok(req.url === "/profile" || req.url === "/policy");
      assert.equal(
        req.headers.authorization,
        `Bearer ${req.url === "/profile" ? profileToken : policyToken}`,
      );
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      assert.ok(Buffer.concat(chunks).length <= 16 * 1024);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.requests.push({ path: req.url, body });
      if (req.url === "/profile" && state.holdProfile) {
        entered();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/profile"
            ? {
                ...pluginRouteScope,
                ...(state.foreignProfile ? { tenantId: "foreign-tenant" } : {}),
              }
            : state.deny
              ? { outcome: "deny", reasonCode: "fixture_ui_revoked" }
              : { outcome: "allow", authorityEpoch: state.epoch },
        ),
      );
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://localhost:${address.port}`;
  // Actual HTTPS with CA/hostname validation and the production transport's AbortSignal.
  const fetch: typeof globalThis.fetch = async (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, origin);
      const abort = () => {
        state.aborts++;
      };
      init?.signal?.addEventListener("abort", abort, { once: true });
      const req = request(
        url,
        {
          method: init?.method,
          headers: init?.headers as Record<string, string>,
          ca: TEST_CA_CERT,
          family: 4,
          signal: init?.signal ?? undefined,
          lookup: (_hostname, _options, callback) =>
            callback(null, "127.0.0.1", 4),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("error", reject);
          res.on("end", () => {
            init?.signal?.removeEventListener("abort", abort);
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: {
                  "content-type": String(res.headers["content-type"]),
                },
              }),
            );
          });
        },
      );
      req.on("error", (error) => {
        init?.signal?.removeEventListener("abort", abort);
        reject(error);
      });
      req.end(init?.body as string | undefined);
    });
  return {
    state,
    held,
    fetch,
    profileAuthority: { url: `${origin}/profile`, serviceToken: profileToken },
    policyAuthority: { url: `${origin}/policy`, serviceToken: policyToken },
  };
}

export function pluginUiProductionIdentity() {
  const bffToken = "fixture-production-bff-" + "b".repeat(32);
  let reads = 0;
  const identity = new ProductionControlApiIdentity({
    trustedBff: new StaticTrustedBffRequestVerifier({
      serviceToken: bffToken,
      allowedOrigins: [pluginRouteCredentials.origin],
      allowedRemoteAddresses: ["127.0.0.1"],
    }),
    tokens: {
      verify: async ({ accessToken }) => {
        assert.equal(accessToken, pluginRouteCredentials.sessionToken);
        reads++;
        const now = Date.now();
        return {
          ...pluginRouteActor,
          issuer: "https://identity.fixture.test",
          audience: "crewon-control",
          issuedAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
        };
      },
    },
    expectedIssuer: "https://identity.fixture.test",
    expectedAudience: "crewon-control",
    timeoutMs: 1000,
    cacheTtlMs: 0,
  });
  return {
    identity,
    reads: () => reads,
    headers: {
      ...pluginRouteHeaders,
      [PRODUCTION_BFF_AUTHORIZATION_HEADER]: `Bearer ${bffToken}`,
    },
  };
}

/** SQLite installed-byte fixture is only the test publisher; production UI never borrows its Node host. */
export async function productionPluginUiFixture(
  t: TestContext,
  options: {
    actions?: PluginUiActionPort;
    committedTasks?: PluginUiCommittedTaskPort;
    publicAssets?: readonly string[];
  } = {},
) {
  const source = await createPluginControlRouteFixture(t);
  const pkg = await source.createPackage("1.0.0");
  const installed = await source.app.inject({
    method: "POST",
    url: "/api/v1/plugins/installations",
    headers: {
      ...pluginRouteHeaders,
      "idempotency-key": "production-ui-fixture-install",
    },
    payload: {
      sourceId: pkg.sourceId,
      expectedPluginId: pkg.expectedPluginId,
      expectedPackageDigest: pkg.expectedPackageDigest,
      expectedSelectionRevision: null,
    },
  });
  assert.equal(installed.statusCode, 200, installed.body);
  const selected = await source.app.inject({
    method: "PUT",
    url: `/api/v1/plugins/selections/${pkg.expectedPluginId}`,
    headers: {
      ...pluginRouteHeaders,
      "idempotency-key": "production-ui-fixture-enable",
    },
    payload: {
      state: "enabled",
      selectedPackageDigest: pkg.expectedPackageDigest,
      expectedSelectionRevision: 1,
    },
  });
  assert.equal(selected.statusCode, 200, selected.body);
  const authority = await pluginUiHttpsAuthority(t);
  const authentication = pluginUiProductionIdentity();
  const configuration = parseProductionPluginUiConfiguration({
    installRoot: join(source.root, "installed"),
    profileAuthority: authority.profileAuthority,
    policyAuthority: authority.policyAuthority,
    publications: [
      {
        packageDigest: pkg.expectedPackageDigest,
        pluginId: pkg.expectedPluginId,
        publisherId: "test.publisher",
        publicAssets: options.publicAssets ?? ["ui/entry.mjs", "ui/chunk.mjs"],
      },
    ],
    timeoutMs: 1000,
  });
  const runtime = createProductionPluginUiRuntime(
    {
      configuration,
      ...(options.actions ? { actions: options.actions } : {}),
      ...(options.committedTasks
        ? { committedTasks: options.committedTasks }
        : {}),
    },
    {
      ledger: source.ledger,
      clock: { now: () => new Date().toISOString() },
      fetch: authority.fetch,
    },
  );
  const app = Fastify({ trustProxy: false });
  app.setErrorHandler((error, req, reply) => {
    const result = errorResponse(error, req.id);
    return reply.code(result.statusCode).send(result.body);
  });
  registerPluginControlRoutes(app, {
    identity: authentication.identity,
    pluginUi: runtime.service,
  });
  app.addHook("onClose", async () => runtime.close());
  t.after(async () => {
    runtime.close();
    await app.close();
  });
  const open = async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/plugins/ui/mounts",
      headers: authentication.headers,
      payload: {
        pluginId: pkg.expectedPluginId,
        contributionId: "counter",
        expectedPackageDigest: pkg.expectedPackageDigest,
        expectedSelectionRevision: 2,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ mountRef: string }>();
  };
  return {
    source,
    pkg,
    authority,
    authentication,
    configuration,
    runtime,
    app,
    open,
  };
}
