import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TLSSocket } from "node:tls";
import test, { type TestContext } from "node:test";

import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";

import {
  ProductionNetworkEgressPolicy,
  type NetworkEgressPolicy,
} from "./network-egress.ts";
import {
  PinnedNodeHttpError,
  PinnedNodeHttpTransport,
  sameRemoteAddress,
} from "./pinned-node-http.ts";
import { ProductionRemoteMcpMutationHttp } from "./remote-mcp-mutation-http.ts";

const loopbackPolicy: NetworkEgressPolicy = {
  authorize: ({ addresses }) => ({
    approvedAddresses: addresses.map(({ address }) => address),
  }),
};

test("production policy rejects every non-public address", () => {
  const policy = new ProductionNetworkEgressPolicy();
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "fe80::1",
    "ff02::1",
  ]) {
    assert.throws(
      () =>
        policy.authorize({
          tenantId: "tenant-1",
          scopeId: "binding-1",
          endpoint: new URL("https://server.example/mutate"),
          addresses: [{ address, family: address.includes(":") ? 6 : 4 }],
        }),
      /network_egress_denied/u,
    );
  }
});

test("remote address comparison accepts equivalent IPv6 text", () => {
  assert.equal(sameRemoteAddress("2001:db8:0:0::1", "2001:db8::1", 6), true);
});

test("transport pins and sends a bounded POST body", async (t) => {
  let received: Buffer | undefined;
  const server = await listen(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = Buffer.concat(chunks);
      response.writeHead(201, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const body = Buffer.from('{"command":"run"}');
  const response = await new PinnedNodeHttpTransport().request(
    {
      method: "POST",
      target: {
        endpoint: new URL(`${origin(server)}/mutate`),
        address: "127.0.0.1",
        family: 4,
      },
      headers: { "content-type": "application/json" },
      body,
      maxRequestBytes: 256 * 1024,
      maxResponseBytes: 256 * 1024,
    },
    new AbortController().signal,
  );
  assert.equal(response.status, 201);
  assert.deepEqual(received, body);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(response.body)), {
    ok: true,
  });
});

test("HTTPS transport requires TLS 1.3 and validates the admitted hostname", async (t) => {
  const protocols: Array<string | null> = [];
  const serverNames: Array<string | false | null> = [];
  const server = createHttpsServer(
    {
      key: TEST_SERVER_KEY,
      cert: TEST_SERVER_CERT,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    },
    (request, response) => {
      const socket = request.socket as TLSSocket;
      protocols.push(socket.getProtocol());
      serverNames.push(socket.servername);
      response.end("ok");
    },
  );
  await listenServer(t, server);
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("invalid_address");
  const transport = new PinnedNodeHttpTransport({
    certificateAuthority: TEST_CA_CERT,
  });
  const response = await transport.request(
    {
      method: "GET",
      target: {
        endpoint: new URL(`https://localhost:${address.port}/`),
        address: "127.0.0.1",
        family: 4,
      },
      maxRequestBytes: 0,
      maxResponseBytes: 2,
    },
    new AbortController().signal,
  );
  assert.equal(new TextDecoder().decode(response.body), "ok");
  assert.deepEqual(protocols, ["TLSv1.3"]);
  assert.deepEqual(serverNames, ["localhost"]);

  await assert.rejects(
    transport.request(
      {
        method: "GET",
        target: {
          endpoint: new URL(`https://wrong.example:${address.port}/`),
          address: "127.0.0.1",
          family: 4,
        },
        maxRequestBytes: 0,
        maxResponseBytes: 2,
      },
      new AbortController().signal,
    ),
    /transport_failed/u,
  );
});

test("production adapter cannot bypass baseline egress policy", async () => {
  let transportCalls = 0;
  const transport = {
    request: async () => {
      transportCalls += 1;
      throw new Error("unexpected_transport_call");
    },
  };
  const request = {
    endpoint: new URL("http://localhost/mutate"),
    headers: {},
    body: new Uint8Array(),
    signal: new AbortController().signal,
  };
  const adapter = new ProductionRemoteMcpMutationHttp({
    tenantId: "tenant-1",
    serverBindingId: "binding-1",
    egressPolicy: loopbackPolicy,
    dns: { resolveAll: async () => [{ address: "127.0.0.1", family: 4 }] },
    transport,
  });
  await assert.rejects(adapter.post(request), /network_egress_denied/u);
  assert.equal(transportCalls, 0);

  const tenantDeny: NetworkEgressPolicy = {
    authorize: () => {
      throw new Error("tenant_denied");
    },
  };
  const denied = new ProductionRemoteMcpMutationHttp({
    tenantId: "tenant-1",
    serverBindingId: "binding-1",
    egressPolicy: tenantDeny,
    dns: { resolveAll: async () => [{ address: "93.184.216.34", family: 4 }] },
    transport,
  });
  await assert.rejects(
    denied.post({
      ...request,
      endpoint: new URL("https://server.example/mutate"),
    }),
    /tenant_denied/u,
  );
  assert.equal(transportCalls, 0);
});

test("tenant policy mutation cannot change the authoritative pinned target", async () => {
  let target: unknown;
  const adapter = new ProductionRemoteMcpMutationHttp({
    tenantId: "tenant-1",
    serverBindingId: "binding-1",
    egressPolicy: {
      authorize: (input) => {
        input.endpoint.protocol = "http:";
        input.endpoint.hostname = "localhost";
        return { approvedAddresses: ["93.184.216.34"] };
      },
    },
    dns: { resolveAll: async () => [{ address: "93.184.216.34", family: 4 }] },
    transport: {
      request: async (input) => {
        target = input.target;
        return { status: 200, headers: {}, body: new Uint8Array() };
      },
    },
  });
  await adapter.post({
    endpoint: new URL("https://server.example/mutate"),
    headers: {},
    body: new Uint8Array(),
    signal: new AbortController().signal,
  });
  assert.deepEqual(target, {
    endpoint: new URL("https://server.example/mutate"),
    address: "93.184.216.34",
    family: 4,
  });
});

test("tenant policy cannot substitute a resolved address", async () => {
  let transportCalls = 0;
  const adapter = new ProductionRemoteMcpMutationHttp({
    tenantId: "tenant-1",
    serverBindingId: "binding-1",
    egressPolicy: {
      authorize: (input) => {
        (input.addresses[0] as { address: string }).address = "127.0.0.1";
        return { approvedAddresses: ["127.0.0.1"] };
      },
    },
    dns: { resolveAll: async () => [{ address: "93.184.216.34", family: 4 }] },
    transport: {
      request: async () => {
        transportCalls += 1;
        throw new Error("unexpected_transport_call");
      },
    },
  });
  await assert.rejects(
    adapter.post({
      endpoint: new URL("https://server.example/mutate"),
      headers: {},
      body: new Uint8Array(),
      signal: new AbortController().signal,
    }),
    /network_egress_decision_invalid/u,
  );
  assert.equal(transportCalls, 0);
});

test("transport enforces declared and streaming response caps", async (t) => {
  await assert.rejects(
    new PinnedNodeHttpTransport().request(
      {
        method: "POST",
        target: {
          endpoint: new URL("http://localhost/"),
          address: "127.0.0.1",
          family: 4,
        },
        body: new Uint8Array(11),
        maxRequestBytes: 10,
        maxResponseBytes: 10,
      },
      new AbortController().signal,
    ),
    /body_too_large/u,
  );

  const declared = await listen(t, (_request, response) => {
    response.writeHead(200, { "content-length": "12" });
    response.end("x".repeat(12));
  });
  await assert.rejects(request(declared, 10), /body_too_large/u);

  const streaming = await listen(t, (_request, response) => {
    response.writeHead(200);
    response.write("x".repeat(8));
    response.end("x".repeat(8));
  });
  await assert.rejects(request(streaming, 10), /body_too_large/u);
});

test("transport rejects a remote-address mismatch", async (t) => {
  const server = await listen(t, (_request, response) => response.end("ok"));
  const transport = new PinnedNodeHttpTransport({
    remoteAddressMatches: () => false,
  });
  await assert.rejects(
    transport.request(input(server, 10), new AbortController().signal),
    (error: unknown) =>
      error instanceof PinnedNodeHttpError &&
      error.code === "remote_address_mismatch",
  );
});

test("transport observes AbortSignal", async (t) => {
  const server = await listen(t, () => {});
  const controller = new AbortController();
  const pending = new PinnedNodeHttpTransport().request(
    input(server, 10),
    controller.signal,
  );
  controller.abort(new Error("test_abort"));
  await assert.rejects(pending, /request_aborted/u);
});

test("transport never exposes sensitive lower-level errors", async (t) => {
  const server = await listen(t, (_request, response) => response.end("ok"));
  const endpoint = new URL(origin(server));
  const sensitive =
    "Authorization: Bearer secret; Idempotency-Key: idem; body-secret";
  const transport = new PinnedNodeHttpTransport({
    remoteAddressMatches: () => {
      throw new Error(sensitive);
    },
  });
  const error = await transport
    .request(
      {
        method: "POST",
        target: { endpoint, address: "127.0.0.1", family: 4 },
        headers: {
          "authorization": "Bearer secret",
          "idempotency-key": "idem",
        },
        body: Buffer.from("body-secret"),
        maxRequestBytes: 100,
        maxResponseBytes: 100,
      },
      new AbortController().signal,
    )
    .catch((caught: unknown) => caught);
  const inspected = JSON.stringify(error, Object.getOwnPropertyNames(error));
  assert.equal(inspected.includes("secret"), false);
  assert.equal(inspected.includes("Idempotency"), false);
});

test("transport normalizes malformed runtime input", async () => {
  const error = await new PinnedNodeHttpTransport()
    .request(
      null as unknown as Parameters<PinnedNodeHttpTransport["request"]>[0],
      new AbortController().signal,
    )
    .catch((caught: unknown) => caught);
  assert.equal(error instanceof PinnedNodeHttpError, true);
  assert.equal((error as PinnedNodeHttpError).code, "request_invalid");
  assert.equal("cause" in (error as object), false);
});

test("production adapter validates opaque server binding IDs", () => {
  assert.throws(
    () =>
      new ProductionRemoteMcpMutationHttp({
        tenantId: "tenant-1",
        serverBindingId: "binding with spaces",
        egressPolicy: loopbackPolicy,
      }),
    /remote_mcp_network_binding_invalid/u,
  );
});

function request(server: Server, maxResponseBytes: number) {
  return new PinnedNodeHttpTransport().request(
    input(server, maxResponseBytes),
    new AbortController().signal,
  );
}

function input(server: Server, maxResponseBytes: number) {
  return {
    method: "GET" as const,
    target: {
      endpoint: new URL(origin(server)),
      address: "127.0.0.1",
      family: 4 as const,
    },
    maxRequestBytes: 0,
    maxResponseBytes,
  };
}

async function listen(
  t: TestContext,
  listener: RequestListener,
): Promise<Server> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return server;
}

async function listenServer(t: TestContext, server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
}

function origin(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("invalid_address");
  return `http://localhost:${address.port}`;
}
