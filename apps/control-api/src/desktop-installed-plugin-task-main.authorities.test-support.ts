import assert from "node:assert/strict";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:net";
import {
  INSTALLED_PLUGIN_PEER_PRIVATE_PATH,
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  INSTALLED_PLUGIN_PEER_WIRE_LIMITS,
  parseInstalledPluginPeerRequest,
  parseInstalledPluginPeerResponse,
  type InstalledPluginPeerCatalogEntry,
  type InstalledPluginPeerRequest,
  type InstalledPluginPeerActor,
  type InstalledPluginPeerScope,
} from "@crewon/contracts/plugins";
import {
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";

export type NativeTaskMainAuthorityRole =
  | "task"
  | "ui"
  | "package"
  | "quote"
  | "activation";
export type NativeTaskMainAuthorityRequest = Readonly<{
  path: string;
  role: NativeTaskMainAuthorityRole;
  body: Record<string, unknown>;
}>;
export type NativeTaskMainAuthorityState = {
  responses: Record<NativeTaskMainAuthorityRole, unknown>;
  statuses: Partial<Record<NativeTaskMainAuthorityRole, number>>;
  before: Partial<
    Record<
      NativeTaskMainAuthorityRole,
      (body: Record<string, unknown>, signal: AbortSignal) => Promise<void>
    >
  >;
  requests: NativeTaskMainAuthorityRequest[];
  peerRequests: InstalledPluginPeerRequest[];
  failures: string[];
};

export const nativeTaskMainAuthorityTokens = Object.freeze({
  TEST_NATIVE_TASK_POLICY_TOKEN: "named-main-task-policy-" + "t".repeat(40),
  TEST_NATIVE_UI_POLICY_TOKEN: "named-main-ui-policy-" + "u".repeat(40),
  TEST_NATIVE_PACKAGE_TOKEN: "named-main-package-policy-" + "k".repeat(40),
  TEST_NATIVE_QUOTE_TOKEN: "named-main-personal-quote-" + "q".repeat(40),
  TEST_NATIVE_ACTIVATION_TOKEN:
    "named-main-activation-policy-" + "a".repeat(40),
  CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN: "e".repeat(64),
});
const endpoints = Object.freeze({
  "/tasks": { role: "task", reference: "TEST_NATIVE_TASK_POLICY_TOKEN" },
  "/ui": { role: "ui", reference: "TEST_NATIVE_UI_POLICY_TOKEN" },
  "/packages": { role: "package", reference: "TEST_NATIVE_PACKAGE_TOKEN" },
  "/quotes": { role: "quote", reference: "TEST_NATIVE_QUOTE_TOKEN" },
  "/activation": {
    role: "activation",
    reference: "TEST_NATIVE_ACTIVATION_TOKEN",
  },
} as const);

/** Real TLS/HTTP transport boundaries. Policies, quote and peer readiness are named
 * deterministic test authorities; this is neither a Worker nor an online supplier. */
export async function createNativeTaskMainAuthorities(
  input: Readonly<{
    actor: InstalledPluginPeerActor;
    scope: InstalledPluginPeerScope;
    entry: InstalledPluginPeerCatalogEntry;
    poolId: string;
  }>,
) {
  const state: NativeTaskMainAuthorityState = {
    responses: {
      task: { outcome: "allow" },
      ui: { outcome: "allow", authorityEpoch: "named-main-ui-policy-epoch" },
      package: { outcome: "allow" },
      quote: { poolId: input.poolId, priceRevision: 17, quotedCredits: "30" },
      activation: { outcome: "allow" },
    },
    statuses: {},
    before: {},
    requests: [],
    peerRequests: [],
    failures: [],
  };
  const lifetime = new AbortController();
  const pending = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const dispatch = (
    request: IncomingMessage,
    response: ServerResponse,
    work: () => Promise<void>,
  ) => {
    if (closed || pending.size >= 32) {
      response.writeHead(503).end();
      return;
    }
    // Register before callbacks, including gates that may synchronously reenter cleanup.
    const physical = Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        state.failures.push(
          error instanceof Error ? error.message : String(error),
        );
        if (!response.headersSent && !response.destroyed)
          json(
            response,
            { fixture: "named_native_main_authority_failed" },
            500,
          );
        else response.destroy();
      })
      .finally(() => pending.delete(physical));
    pending.add(physical);
    request.on("error", () => {});
  };
  const authority = createHttpsServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (request, response) =>
      dispatch(request, response, async () => {
        assert.equal(request.method, "POST");
        const path = request.url ?? "";
        assert.ok(Object.hasOwn(endpoints, path), "named_main_authority_path");
        const endpoint = endpoints[path as keyof typeof endpoints];
        assert.equal(
          request.headers.authorization,
          `Bearer ${nativeTaskMainAuthorityTokens[endpoint.reference]}`,
        );
        const body = await readJson(request, 128 * 1024);
        if (endpoint.role === "package") {
          assert.equal(
            body.schemaVersion,
            "crewon.plugin-execution-package.v1",
          );
          assert.deepEqual(body.scope, input.scope);
          assert.deepEqual(body.identity, {
            pluginId: input.entry.identity.pluginId,
            publisherId: input.entry.identity.publisherId,
            version: input.entry.identity.version,
            packageDigest: input.entry.identity.packageDigest,
          });
          assert.ok(body.purpose === "read" || body.purpose === "submit");
        } else {
          assert.deepEqual(body.actor, input.actor);
        }
        assert.ok(
          state.requests.length < 2048,
          "named_main_authority_request_limit",
        );
        state.requests.push({ path, role: endpoint.role, body });
        await state.before[endpoint.role]?.(body, lifetime.signal);
        if (!closed && !response.destroyed)
          json(
            response,
            state.responses[endpoint.role],
            state.statuses[endpoint.role] ?? 200,
          );
      }),
  );
  const peer = createHttpServer((request, response) =>
    dispatch(request, response, async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, INSTALLED_PLUGIN_PEER_PRIVATE_PATH);
      assert.equal(
        request.headers.authorization,
        `Bearer ${nativeTaskMainAuthorityTokens.CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN}`,
      );
      const body = parseInstalledPluginPeerRequest(
        await readJson(request, INSTALLED_PLUGIN_PEER_WIRE_LIMITS.messageBytes),
      );
      assert.deepEqual(body.actor, input.actor);
      assert.deepEqual(body.scope, input.scope);
      assert.ok(
        state.peerRequests.length < 2048,
        "named_main_peer_request_limit",
      );
      state.peerRequests.push(body);
      const common = {
        protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
        requestId: body.requestId,
        operation: body.operation,
        actor: input.actor,
        scope: input.scope,
      };
      if (body.operation === "catalog") {
        json(
          response,
          parseInstalledPluginPeerResponse({
            ...common,
            entries: [input.entry],
          }),
        );
        return;
      }
      assert.ok(
        body.operation === "readiness" ||
          body.operation === "prepareCandidate" ||
          body.operation === "validateConfiguration",
        "named_main_peer_query_is_not_supported",
      );
      assert.deepEqual(body.identity, input.entry.identity);
      assert.deepEqual(body.configuration, input.entry.configuration);
      const configuration = {
        ...common,
        identity: body.identity,
        configurationDigest: input.entry.configuration.contentDigest,
      };
      if (body.operation === "validateConfiguration") {
        json(response, parseInstalledPluginPeerResponse(configuration));
        return;
      }
      assert.deepEqual(body.expectedTarget, input.entry.configuredTarget);
      const result = {
        ...configuration,
        expectedTarget: body.expectedTarget,
        ...(body.operation === "prepareCandidate"
          ? { expectedSelectionRevision: body.expectedSelectionRevision }
          : {}),
        result: { outcome: "ready", target: input.entry.configuredTarget },
      };
      json(response, parseInstalledPluginPeerResponse(result));
    }),
  );
  try {
    const authorityPort = await listen(authority);
    const peerPort = await listen(peer);
    return {
      state,
      authorityOrigin: `https://localhost:${authorityPort}`,
      peerOrigin: `http://127.0.0.1:${peerPort}`,
      ports: Object.freeze([authorityPort, peerPort]),
      close(): Promise<void> {
        return (closing ??= (async () => {
          closed = true;
          lifetime.abort(new Error("named_main_authority_closed"));
          authority.closeAllConnections();
          peer.closeAllConnections();
          const serverResults = await Promise.allSettled([
            retire(authority),
            retire(peer),
          ]);
          await boundedJoin(
            Promise.allSettled([...pending]),
            "named_main_authority_pending_timeout",
          );
          const errors = serverResults.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (errors.length)
            throw new AggregateError(
              errors,
              "named_main_authority_close_failed",
            );
        })());
      },
    };
  } catch (error) {
    closed = true;
    lifetime.abort(error);
    authority.closeAllConnections();
    peer.closeAllConnections();
    await Promise.allSettled([retire(authority), retire(peer)]);
    throw error;
  }
}

async function readJson(
  request: IncomingMessage,
  limit: number,
): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    assert.ok(size <= limit, "named_main_authority_body_limit");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      accept();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function retire(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
}
async function boundedJoin<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
