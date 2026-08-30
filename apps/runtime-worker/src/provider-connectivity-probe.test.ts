import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import test, { type TestContext } from "node:test";
import type { TLSSocket } from "node:tls";

import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";

import {
  PinnedNodeProviderProbeHttp,
  ResponsesProviderConnectivityProbe,
  type ProviderProbeHttpPort,
} from "./provider-connectivity-probe.ts";
import {
  DesktopModelCatalogEgressPolicy,
  DesktopProviderProbeEgressPolicy,
  ProviderProbeEgressResolver,
  providerAddressKind,
  type ProviderProbeDnsResolver,
  type ProviderProbeEgressPolicy,
  type ProviderProbeResolvedAddress,
} from "./provider-probe-egress.ts";

test("classifies transition, mapped, metadata, private and reserved addresses", () => {
  assert.deepEqual(
    [
      "::ffff:127.0.0.1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::1",
      "2002:7f00:1::",
      "2001:0000::1",
      "169.254.169.254",
      "10.0.0.1",
      "fec0::1",
      "100::1",
      "2001:2::1",
      "3fff::1",
      "fe80::1",
      "2001:db8::1",
      "2606:4700:4700::1111",
    ].map(providerAddressKind),
    [
      "mapped",
      "transition",
      "transition",
      "transition",
      "transition",
      "metadata",
      "private",
      "private",
      "private",
      "private",
      "private",
      "linkLocal",
      "private",
      "public",
    ],
  );
});

test("validates every DNS answer and allows explicit HTTPS loopback", async () => {
  const mixed = resolver(
    [address("93.184.216.34"), address("10.0.0.7")],
    new DesktopProviderProbeEgressPolicy(),
  );
  await assert.rejects(
    mixed.resolve(
      endpointInput("https://provider.example/v1/models"),
      new AbortController().signal,
    ),
    /provider_probe_egress_denied/u,
  );

  const httpsLoopback = resolver(
    [address("127.0.0.1")],
    new DesktopProviderProbeEgressPolicy(),
  );
  assert.equal(
    (
      await httpsLoopback.resolve(
        endpointInput("https://localhost/v1/models"),
        new AbortController().signal,
      )
    ).address,
    "127.0.0.1",
  );

  const disguisedLoopback = resolver(
    [address("127.0.0.1")],
    new DesktopProviderProbeEgressPolicy(),
  );
  await assert.rejects(
    disguisedLoopback.resolve(
      endpointInput("http://provider.example/v1/models"),
      new AbortController().signal,
    ),
    /provider_probe_egress_denied/u,
  );
  await assert.rejects(
    httpsLoopback.resolve(
      endpointInput("ftp://localhost/v1/models"),
      new AbortController().signal,
    ),
    /provider_probe_egress_denied/u,
  );
});

test("model catalog admits only HTTPS hostname Fake-IP proxy routes", async () => {
  const policy = new DesktopModelCatalogEgressPolicy();
  assert.equal(
    (
      await resolver([address("198.18.1.210")], policy).resolve(
        endpointInput("https://provider.example/v1/models"),
        new AbortController().signal,
      )
    ).address,
    "198.18.1.210",
  );
  for (const endpoint of [
    "https://198.18.1.210/v1/models",
    "http://provider.example/v1/models",
  ]) {
    await assert.rejects(
      resolver([address("198.18.1.210")], policy).resolve(
        endpointInput(endpoint),
        new AbortController().signal,
      ),
      /provider_probe_egress_denied/u,
    );
  }
  await assert.rejects(
    resolver([address("10.0.0.7")], policy).resolve(
      endpointInput("https://provider.example/v1/models"),
      new AbortController().signal,
    ),
    /provider_probe_egress_denied/u,
  );
});

test("production policy can explicitly approve private self-hosted addresses", async () => {
  const productionPolicy: ProviderProbeEgressPolicy = {
    authorize: ({ addresses }) => ({
      approvedAddresses: addresses.map(({ address }) => address),
    }),
  };
  assert.equal(
    (
      await resolver([address("10.8.0.9")], productionPolicy).resolve(
        endpointInput("https://provider.internal/v1/models"),
        new AbortController().signal,
      )
    ).address,
    "10.8.0.9",
  );
});

test("intrinsically unsafe DNS answers are denied even by a permissive policy", async () => {
  const permissive: ProviderProbeEgressPolicy = {
    authorize: ({ addresses }) => ({
      approvedAddresses: addresses.map(({ address }) => address),
    }),
  };
  for (const unsafe of [
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::1",
    "2002:7f00:1::",
    "2001:0000::1",
    "169.254.169.254",
    "fe80::1",
  ]) {
    await assert.rejects(
      resolver([address(unsafe)], permissive).resolve(
        endpointInput("https://provider.example/v1/models"),
        new AbortController().signal,
      ),
      /provider_probe_egress_denied/u,
    );
  }
  await assert.rejects(
    resolver(
      [address("10.0.0.7")],
      new DesktopProviderProbeEgressPolicy(),
    ).resolve(
      endpointInput("https://provider.example/v1/models"),
      new AbortController().signal,
    ),
    /provider_probe_egress_denied/u,
  );
});

test("projects denied egress as non-retryable without opening a socket", async () => {
  let requests = 0;
  const result = await new ResponsesProviderConnectivityProbe(
    providerConfig("https://provider.example/v1"),
    {
      egress: resolver(
        [address("10.0.0.7")],
        new DesktopProviderProbeEgressPolicy(),
      ),
      http: {
        request: async () => {
          requests += 1;
          return jsonResponse({ data: [] });
        },
      },
      now: monotonicNow(0, 1),
    },
  ).probe(new AbortController().signal);
  assert.equal(result.status, "unreachable");
  assert.equal(result.retryable, false);
  assert.equal(requests, 0);
});

test("pins the one validated DNS result without a second resolution", async () => {
  let dnsCalls = 0;
  const dns: ProviderProbeDnsResolver = {
    resolveAll: async () => {
      dnsCalls += 1;
      return dnsCalls === 1
        ? [address("93.184.216.34")]
        : [address("169.254.169.254")];
    },
  };
  let pinned: unknown;
  const http: ProviderProbeHttpPort = {
    request: async (input) => {
      pinned = input.target;
      return jsonResponse({ data: [{ id: "model-1" }] });
    },
  };
  const result = await new ResponsesProviderConnectivityProbe(
    providerConfig("https://provider.example/v1"),
    {
      egress: new ProviderProbeEgressResolver({
        dns,
        policy: new DesktopProviderProbeEgressPolicy(),
      }),
      http,
      now: monotonicNow(1_000, 7),
    },
  ).probe(new AbortController().signal);
  assert.equal(dnsCalls, 1);
  assert.deepEqual(pinned, {
    endpoint: new URL("https://provider.example/v1/models"),
    address: "93.184.216.34",
    family: 4,
  });
  assert.equal(result.status, "ok");
});

test("performs a real loopback request and projects bounded model metadata", async (t) => {
  const requests: Array<{
    authorization: string | undefined;
    url: string | undefined;
  }> = [];
  const server = await listen(t, (request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      url: request.url,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: [
          { id: "model-1", display_name: "Model One", secret: "ignored" },
          { id: "model-2" },
        ],
        raw: "not projected",
      }),
    );
  });
  const result = await new ResponsesProviderConnectivityProbe(
    providerConfig(`${origin(server)}/v1`),
    {
      egress: new ProviderProbeEgressResolver({
        policy: new DesktopProviderProbeEgressPolicy(),
      }),
      http: new PinnedNodeProviderProbeHttp(),
      now: monotonicNow(1_000, 7),
    },
  ).probe(new AbortController().signal);
  assert.deepEqual(requests, [
    { authorization: "Bearer worker-only-secret", url: "/v1/models" },
  ]);
  assert.deepEqual(result, {
    providerId: "gateway",
    catalogRevision: 3,
    runtimeBindingId: "desktop-supervisor:generation-7",
    status: "ok",
    models: [
      { id: "model-1", displayName: "Model One" },
      { id: "model-2", displayName: null },
    ],
    modelCount: 2,
    latencyMs: 7,
    retryable: false,
    retryAfterMs: null,
  });
  assert.equal(JSON.stringify(result).includes("worker-only-secret"), false);
  assert.equal(JSON.stringify(result).includes("not projected"), false);
});

test("pins a localhost hostname with Node 24 lookup-all transport", async (t) => {
  const server = await listen(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "model-localhost" }] }));
  });
  const addressInfo = server.address();
  if (addressInfo === null || typeof addressInfo === "string") {
    throw new Error("provider_test_address_invalid");
  }
  const result = await new ResponsesProviderConnectivityProbe(
    providerConfig(`http://localhost:${addressInfo.port}/v1`),
    {
      egress: resolver(
        [address("127.0.0.1")],
        new DesktopProviderProbeEgressPolicy(),
      ),
      http: new PinnedNodeProviderProbeHttp(),
      now: monotonicNow(0, 1),
    },
  ).probe(new AbortController().signal);
  assert.equal(result.status, "ok");
});

test("uses a dedicated socket for every pinned request", async (t) => {
  let connections = 0;
  const server = await listen(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "model-localhost" }] }));
  });
  server.on("connection", () => {
    connections += 1;
  });
  const addressInfo = server.address();
  if (addressInfo === null || typeof addressInfo === "string") {
    throw new Error("provider_test_address_invalid");
  }
  const http = new PinnedNodeProviderProbeHttp();
  const makeProbe = () =>
    new ResponsesProviderConnectivityProbe(
      providerConfig(`http://localhost:${addressInfo.port}/v1`),
      {
        egress: resolver(
          [address("127.0.0.1")],
          new DesktopProviderProbeEgressPolicy(),
        ),
        http,
        now: monotonicNow(0, 1),
      },
    ).probe(new AbortController().signal);
  assert.deepEqual(
    (await Promise.all([makeProbe(), makeProbe()])).map(({ status }) => status),
    ["ok", "ok"],
  );
  assert.equal(connections, 2);
});

test("pins HTTPS while preserving hostname SNI and certificate validation", async (t) => {
  const serverNames: Array<string | false | null> = [];
  const server = createHttpsServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT },
    (request, response) => {
      serverNames.push((request.socket as TLSSocket).servername);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "model-tls" }] }));
    },
  );
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
  const addressInfo = server.address();
  if (addressInfo === null || typeof addressInfo === "string") {
    throw new Error("provider_test_address_invalid");
  }
  const result = await new ResponsesProviderConnectivityProbe(
    providerConfig(`https://localhost:${addressInfo.port}/v1`),
    {
      egress: resolver(
        [address("127.0.0.1")],
        new DesktopProviderProbeEgressPolicy(),
      ),
      http: new PinnedNodeProviderProbeHttp({
        certificateAuthority: TEST_CA_CERT,
      }),
      now: monotonicNow(0, 1),
    },
  ).probe(new AbortController().signal);
  assert.equal(result.status, "ok");
  assert.deepEqual(serverNames, ["localhost"]);
});

test("does not follow redirects and rejects oversized provider bodies", async (t) => {
  let requests = 0;
  const redirect = await listen(t, (_request, response) => {
    requests += 1;
    response.writeHead(302, { location: "/credential-leak" });
    response.end();
  });
  const redirectResult = await realLoopbackProbe(origin(redirect));
  assert.equal(redirectResult.status, "providerError");
  assert.equal(requests, 1);

  const oversized = await listen(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("x".repeat(64 * 1024 + 1));
  });
  const oversizedResult = await realLoopbackProbe(origin(oversized));
  assert.equal(oversizedResult.status, "invalidResponse");
  assert.equal(oversizedResult.retryable, false);
});

test("validates content type, model count, IDs and display names", async () => {
  for (const response of [
    {
      ...jsonResponse({ data: [] }),
      headers: { "content-type": "text/plain" },
    },
    jsonResponse({
      data: Array.from({ length: 101 }, (_, index) => ({
        id: `model-${index}`,
      })),
    }),
    jsonResponse({ data: [{ id: "x".repeat(257) }] }),
    jsonResponse({ data: [{ id: "model-1", display_name: "bad\nname" }] }),
    jsonResponse({ data: [{ id: "model-\u202econfused" }] }),
    jsonResponse({ data: [{ id: "model-worker-only-secret" }] }),
    jsonResponse({
      data: [{ id: "model-1", display_name: "Bearer worker-only-secret" }],
    }),
  ]) {
    const result = await fakeResponseProbe(response);
    assert.equal(result.status, "invalidResponse");
    assert.equal(result.retryable, false);
  }
  const authentication = await fakeResponseProbe({
    status: 401,
    headers: { "content-type": "text/plain" },
    body: new TextEncoder().encode("credential and raw provider details"),
  });
  assert.equal(authentication.status, "authenticationFailed");
  assert.equal(JSON.stringify(authentication).includes("credential"), false);
});

test("enforces the deadline and rejects an invalid clock", async () => {
  const timeout = new ResponsesProviderConnectivityProbe(
    { ...providerConfig("https://provider.example/v1"), deadlineMs: 25 },
    {
      egress: resolver(
        [address("93.184.216.34")],
        new DesktopProviderProbeEgressPolicy(),
      ),
      http: {
        request: async (_input, signal) => {
          assert.equal(signal.aborted, true);
          throw signal.reason;
        },
      },
      now: monotonicNow(0, 25),
      schedule: (callback) => {
        callback();
        return () => {};
      },
    },
  );
  assert.equal(
    (await timeout.probe(new AbortController().signal)).status,
    "unreachable",
  );

  const invalidClock = new ResponsesProviderConnectivityProbe(
    providerConfig("https://provider.example/v1"),
    {
      egress: resolver(
        [address("93.184.216.34")],
        new DesktopProviderProbeEgressPolicy(),
      ),
      http: { request: async () => jsonResponse({ data: [] }) },
      now: () => Number.NaN,
    },
  );
  await assert.rejects(
    invalidClock.probe(new AbortController().signal),
    /provider_probe_clock_invalid/u,
  );
});

function resolver(
  addresses: readonly ProviderProbeResolvedAddress[],
  policy: ProviderProbeEgressPolicy,
): ProviderProbeEgressResolver {
  return new ProviderProbeEgressResolver({
    dns: { resolveAll: async () => addresses },
    policy,
  });
}

function endpointInput(value: string) {
  return {
    tenantId: "tenant-1",
    providerId: "gateway",
    catalogRevision: 3,
    endpoint: new URL(value),
  };
}

function address(value: string): ProviderProbeResolvedAddress {
  return { address: value, family: value.includes(":") ? 6 : 4 };
}

function providerConfig(endpoint: string) {
  return {
    tenantId: "tenant-1",
    providerId: "gateway",
    catalogRevision: 3,
    runtimeBindingId: "desktop-supervisor:generation-7",
    endpoint,
    secret: "worker-only-secret",
  };
}

function jsonResponse(value: unknown) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function monotonicNow(initial: number, advance: number): () => number {
  let value = initial - advance;
  return () => (value += advance);
}

async function realLoopbackProbe(endpoint: string) {
  return new ResponsesProviderConnectivityProbe(providerConfig(endpoint), {
    egress: new ProviderProbeEgressResolver({
      policy: new DesktopProviderProbeEgressPolicy(),
    }),
    now: monotonicNow(0, 1),
  }).probe(new AbortController().signal);
}

async function fakeResponseProbe(response: ReturnType<typeof jsonResponse>) {
  return new ResponsesProviderConnectivityProbe(
    providerConfig("https://provider.example/v1"),
    {
      egress: resolver(
        [address("93.184.216.34")],
        new DesktopProviderProbeEgressPolicy(),
      ),
      http: { request: async () => response },
      now: monotonicNow(0, 1),
    },
  ).probe(new AbortController().signal);
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

function origin(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("provider_test_address_invalid");
  }
  return `http://127.0.0.1:${address.port}`;
}
