import assert from "node:assert/strict";
import { createServer, request } from "node:https";
import type { TestContext } from "node:test";
import type { TLSSocket } from "node:tls";
import type { ActorContext } from "@crewon/application";
import type { PluginProfileScope } from "@crewon/domain";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import {
  PRODUCTION_BFF_AUTHORIZATION_HEADER,
  ProductionControlApiIdentity,
  StaticTrustedBffRequestVerifier,
} from "./production-security-adapters.ts";

/** Explicit authority and session fixtures, never a production human, funds source or supplier. */
export async function projectGenerationHttpsAuthority(
  t: TestContext,
  input: Readonly<{
    actor: ActorContext;
    profile: PluginProfileScope;
    sourceId: string;
    sourceEpoch(): string;
    targetEpoch(): string;
  }>,
) {
  const profileToken = `project-profile-fixture-${"p".repeat(32)}`;
  const policyToken = `project-policy-fixture-${"d".repeat(32)}`;
  const state = {
    changedProfile: false,
    policyDenied: false,
    requests: [] as { path: string; body: Record<string, unknown> }[],
    verifiedTlsConnections: 0,
    failures: [] as unknown[],
  };
  const server = createServer(
    {
      key: TEST_SERVER_KEY,
      cert: TEST_SERVER_CERT,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    },
    async (req, res) => {
      try {
        assert.equal((req.socket as TLSSocket).getProtocol(), "TLSv1.3");
        assert.equal(req.method, "POST");
        assert.ok(req.url === "/profile" || req.url === "/policy");
        assert.equal(
          req.headers.authorization,
          `Bearer ${req.url === "/profile" ? profileToken : policyToken}`,
        );
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          assert.ok(size <= 16 * 1024);
          chunks.push(bytes);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.deepEqual(body.actor, input.actor);
        state.requests.push({ path: req.url, body });
        const output =
          req.url === "/profile"
            ? {
                ...input.profile,
                ...(state.changedProfile
                  ? { profileId: "withdrawn-https-profile" }
                  : {}),
              }
            : state.policyDenied
              ? {
                  outcome: "deny",
                  reasonCode: "https_project_policy_withdrawn",
                }
              : {
                  outcome: "allow",
                  authorityEpoch:
                    body.resource.pluginId === input.sourceId
                      ? input.sourceEpoch()
                      : input.targetEpoch(),
                };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(output));
      } catch (error) {
        state.failures.push(error);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: "fixture_authority_assertion_failed" }),
        );
      }
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.deepEqual(state.failures, []);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://localhost:${address.port}`;
  // No fetch result is fabricated: production adapters send real HTTPS through this CA/hostname-validated transport.
  const fetch: typeof globalThis.fetch = async (raw, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(raw instanceof Request ? raw.url : String(raw));
      assert.equal(url.origin, origin);
      assert.equal(init?.redirect, "error");
      const outgoing = request(
        url,
        {
          method: init?.method,
          headers: init?.headers as Record<string, string>,
          ca: TEST_CA_CERT,
          minVersion: "TLSv1.3",
          maxVersion: "TLSv1.3",
          family: 4,
          signal: init?.signal ?? undefined,
          lookup: (_hostname, _options, callback) =>
            callback(null, "127.0.0.1", 4),
        },
        (response) => {
          assert.equal((response.socket as TLSSocket).authorized, true);
          assert.equal((response.socket as TLSSocket).getProtocol(), "TLSv1.3");
          state.verifiedTlsConnections++;
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk) => {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > 16 * 1024) {
              response.destroy(new Error("fixture_authority_response_budget"));
              return;
            }
            chunks.push(bytes);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode,
                headers: {
                  "content-type": String(response.headers["content-type"]),
                },
              }),
            ),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(init?.body as string | undefined);
    });
  return {
    state,
    fetch,
    profileAuthority: { url: `${origin}/profile`, serviceToken: profileToken },
    policyAuthority: { url: `${origin}/policy`, serviceToken: policyToken },
  };
}

export function projectGenerationProductionIdentity(actor: ActorContext) {
  const origin = "https://project-generation-ui.fixture.test";
  const accessToken = `project-session-fixture-${"s".repeat(32)}`;
  const bffToken = `project-bff-fixture-${"b".repeat(32)}`;
  let reads = 0;
  const identity = new ProductionControlApiIdentity({
    trustedBff: new StaticTrustedBffRequestVerifier({
      serviceToken: bffToken,
      allowedOrigins: [origin],
      allowedRemoteAddresses: ["127.0.0.1"],
    }),
    tokens: {
      verify: async (input) => {
        assert.equal(input.accessToken, accessToken);
        reads++;
        const now = Date.now();
        return {
          ...actor,
          issuer: "https://project-identity.fixture.test",
          audience: "crewon-project-generation-ui",
          issuedAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
        };
      },
    },
    expectedIssuer: "https://project-identity.fixture.test",
    expectedAudience: "crewon-project-generation-ui",
    timeoutMs: 1000,
    cacheTtlMs: 0,
  });
  return {
    identity,
    reads: () => reads,
    headers: {
      "authorization": `Bearer ${accessToken}`,
      "origin": origin,
      "x-csrf-token": `project-csrf-fixture-${"c".repeat(32)}`,
      [PRODUCTION_BFF_AUTHORIZATION_HEADER]: `Bearer ${bffToken}`,
    },
  };
}
