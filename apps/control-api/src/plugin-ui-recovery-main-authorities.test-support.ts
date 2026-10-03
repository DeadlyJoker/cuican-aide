import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import type { TLSSocket } from "node:tls";
import type { ActorContext } from "@crewon/application";
import {
  mainRecoveryInstallationDecision,
  type MainRecoveryManagementPackage,
} from "./plugin-ui-recovery-main-management.test-support.ts";
import {
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";

/** Named TLS identity/profile/PDP/package authorities; no real supplier or execution quote. */
export async function startMainRecoveryAuthorities(
  input: Readonly<{
    actor: ActorContext;
    profileScope: Readonly<{
      tenantId: string;
      spaceId: string;
      profileId: string;
    }>;
    accessToken: string;
    authorityToken: string;
    sessionCookie?: string;
    installationPackages?: readonly MainRecoveryManagementPackage[];
    state: {
      tlsConnections: number;
      peerCalls: number;
      quoteCalls: number;
      policyCalls: number;
      sessionCalls: number;
      failures: unknown[];
    };
    beforePolicy(): Promise<void>;
    registerClose(close: () => Promise<void>): unknown;
  }>,
) {
  const {
    actor,
    profileScope,
    accessToken,
    authorityToken,
    sessionCookie,
    installationPackages,
    state,
    beforePolicy,
    registerClose,
  } = input;
  const authority = httpsServer(
    {
      key: TEST_SERVER_KEY,
      cert: TEST_SERVER_CERT,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    },
    (request, response) => {
      void (async () => {
        assert.equal((request.socket as TLSSocket).getProtocol(), "TLSv1.3");
        state.tlsConnections++;
        assert.equal(request.method, "POST");
        assert.equal(request.headers.authorization, `Bearer ${authorityToken}`);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += Buffer.byteLength(chunk);
          assert.ok(size <= 128 * 1024);
          chunks.push(Buffer.from(chunk));
        }
        const body =
          size === 0
            ? null
            : JSON.parse(Buffer.concat(chunks).toString("utf8"));
        let output: unknown;
        if (request.url === "/session" && sessionCookie !== undefined) {
          assert.equal(body, null);
          if (request.headers.cookie !== sessionCookie) {
            response.writeHead(401).end();
            return;
          }
          state.sessionCalls++;
          output = {
            controlAccessToken: accessToken,
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            sessionId: "named-main-web-session-" + "j".repeat(32),
          };
        } else if (request.url === "/verify") {
          assert.deepEqual(body, { accessToken });
          output = {
            ...actor,
            issuer: "https://named-main-identity.fixture.test",
            audience: "crewon-main-recovery",
            issuedAt: new Date(Date.now() - 1000).toISOString(),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          };
        } else if (request.url === "/profile") {
          assert.deepEqual(body, { actor });
          output = profileScope;
        } else if (
          request.url === "/installation-policy" &&
          installationPackages !== undefined
        ) {
          state.policyCalls++;
          output = mainRecoveryInstallationDecision({
            request: body,
            actor,
            profileScope,
            packages: installationPackages,
          });
        } else if (request.url === "/policy") {
          assert.deepEqual(body.actor, actor);
          state.policyCalls++;
          await beforePolicy();
          output = String(body.action).startsWith("pluginUi:")
            ? { outcome: "allow", authorityEpoch: "named-main-ui-epoch" }
            : { outcome: "allow" };
        } else if (request.url === "/package") {
          assert.equal(
            body.schemaVersion,
            "crewon.plugin-execution-package.v1",
          );
          assert.deepEqual(body.scope, profileScope);
          output = { outcome: "allow" };
        } else if (request.url === "/quote") {
          state.quoteCalls++;
          throw new Error("named_main_must_not_quote_or_fund_execution");
        } else throw new Error("named_main_authority_unknown_route");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(output));
      })().catch((error) => {
        state.failures.push(error);
        response.writeHead(500).end('{"fixture":"failed"}');
      });
    },
  );
  const peer = httpServer((_request, response) => {
    state.peerCalls++;
    response.writeHead(503).end();
  });
  for (const server of [authority, peer]) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    registerClose(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  }
  registerClose(async () => {
    assert.deepEqual(state.failures, []);
    assert.equal(state.peerCalls, 0);
    assert.equal(state.quoteCalls, 0);
  });
  const address = authority.address(),
    peerAddress = peer.address();
  assert.ok(
    address &&
      typeof address !== "string" &&
      peerAddress &&
      typeof peerAddress !== "string",
  );
  return {
    authorityOrigin: `https://localhost:${address.port}`,
    peerOrigin: `http://127.0.0.1:${peerAddress.port}`,
  };
}
