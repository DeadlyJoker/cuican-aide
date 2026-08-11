import assert from "node:assert/strict";
import test from "node:test";

import type {
  ModelProviderProbeResult,
  ModelProviderProbeWorkerPort,
} from "@crewon/application";

import {
  ControlProviderProbeService,
  HttpProviderProbeWorkerClient,
  ProviderProbeWorkerError,
  TenantRoutedProviderProbeWorker,
} from "./provider-probe-worker-client.ts";

const TOKEN = "private-control-worker-token-32-bytes-minimum";

test("uses the authenticated bounded private Worker protocol", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const client = new HttpProviderProbeWorkerClient(
    { origin: "http://127.0.0.1:3211", token: TOKEN },
    {
      fetch: async (input, init = {}) => {
        requests.push({ input: String(input), init });
        return jsonResponse(okResult(9));
      },
    },
  );
  assert.deepEqual(
    await client.probe(
      {
        tenantId: "tenant-1",
        expectedRevision: 9,
        expectedProviderId: "gateway",
        expectedRuntimeBindingId: "desktop-supervisor:generation-7",
      },
      new AbortController().signal,
    ),
    okResult(9),
  );
  assert.equal(
    requests[0]?.input,
    "http://127.0.0.1:3211/internal/v1/model-provider-probe",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    tenantId: "tenant-1",
    expectedRevision: 9,
    expectedProviderId: "gateway",
    expectedRuntimeBindingId: "desktop-supervisor:generation-7",
  });
  assert.equal(
    new Headers(requests[0]?.init.headers).get("authorization"),
    `Bearer ${TOKEN}`,
  );
});

test("fails closed on insecure routing and malformed cross-shape responses", async () => {
  assert.throws(
    () =>
      new HttpProviderProbeWorkerClient({
        origin: "http://worker.example",
        token: TOKEN,
      }),
    hasCode("provider_probe_worker_url_invalid"),
  );
  assert.throws(
    () =>
      new HttpProviderProbeWorkerClient({
        origin: "https://worker.example",
        token: "密".repeat(3_000),
      }),
    hasCode("provider_probe_worker_token_invalid"),
  );
  for (const body of [
    { ...okResult(), rawBody: "provider-secret" },
    { ...okResult(), modelCount: 2 },
    { ...okResult(), models: null },
    {
      ...okResult(),
      models: [{ id: "model-1", displayName: null, endpoint: "secret" }],
    },
    {
      ...okResult(),
      models: [{ id: "model-\u202econfused", displayName: null }],
    },
    { ...okResult(), retryAfterMs: 1_000 },
    { ...okResult(), retryable: true },
    {
      ...emptyResult("rateLimited"),
      retryable: false,
      retryAfterMs: 1_000,
    },
    { ...emptyResult("authenticationFailed"), retryable: true },
    { ...emptyResult("providerError"), retryAfterMs: 1_000 },
  ]) {
    const client = new HttpProviderProbeWorkerClient(
      { origin: "https://worker.example", token: TOKEN },
      { fetch: async () => jsonResponse(body) },
    );
    await assert.rejects(
      client.probe(
        {
          tenantId: "tenant-1",
          expectedRevision: 1,
          expectedProviderId: "gateway",
          expectedRuntimeBindingId: "desktop-supervisor:generation-7",
        },
        new AbortController().signal,
      ),
      hasCode("provider_probe_worker_response_invalid"),
    );
  }
  const wrongGeneration = new HttpProviderProbeWorkerClient(
    { origin: "https://worker.example", token: TOKEN },
    {
      fetch: async () =>
        jsonResponse({
          ...okResult(),
          runtimeBindingId: "desktop-supervisor:generation-6",
        }),
    },
  );
  await assert.rejects(
    wrongGeneration.probe(probeRequest(), new AbortController().signal),
    hasCode("provider_probe_worker_response_mismatch"),
  );
});

test("routes only by verified tenant and fails unavailable without a route", async () => {
  const calls: string[] = [];
  const tenantOne: ModelProviderProbeWorkerPort = {
    probe: async ({ tenantId }) => {
      calls.push(`one:${tenantId}`);
      return okResult();
    },
  };
  const tenantTwo: ModelProviderProbeWorkerPort = {
    probe: async ({ tenantId }) => {
      calls.push(`two:${tenantId}`);
      return { ...okResult(), providerId: "tenant-two-provider" };
    },
  };
  const routed = new TenantRoutedProviderProbeWorker({
    resolve: ({ tenantId, runtimeBindingId }) => {
      calls.push(`route:${tenantId}:${runtimeBindingId}`);
      return tenantId === "tenant-1"
        ? tenantOne
        : tenantId === "tenant-2"
          ? tenantTwo
          : null;
    },
  });
  assert.equal(
    (
      await routed.probe(
        {
          tenantId: "tenant-2",
          expectedRevision: 1,
          expectedProviderId: "tenant-two-provider",
          expectedRuntimeBindingId: "desktop-supervisor:generation-7",
        },
        new AbortController().signal,
      )
    ).providerId,
    "tenant-two-provider",
  );
  assert.deepEqual(calls, [
    "route:tenant-2:desktop-supervisor:generation-7",
    "two:tenant-2",
  ]);
  await assert.rejects(
    routed.probe(
      {
        tenantId: "missing",
        expectedRevision: 1,
        expectedProviderId: "gateway",
        expectedRuntimeBindingId: "desktop-supervisor:generation-7",
      },
      new AbortController().signal,
    ),
    hasCode("provider_probe_worker_unavailable"),
  );
});

test("preserves caller cancellation through HTTP and tenant resolution", async () => {
  const reason = new Error("caller_cancelled");
  const httpAbort = new AbortController();
  const http = new HttpProviderProbeWorkerClient(
    { origin: "http://127.0.0.1:3211", token: TOKEN },
    {
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    },
  );
  const httpResult = http.probe(probeRequest(), httpAbort.signal);
  httpAbort.abort(reason);
  await assert.rejects(httpResult, (error) => error === reason);

  const routeAbort = new AbortController();
  const routed = new TenantRoutedProviderProbeWorker({
    resolve: () => new Promise(() => {}),
  });
  const routedResult = routed.probe(probeRequest(), routeAbort.signal);
  routeAbort.abort(reason);
  await assert.rejects(routedResult, (error) => error === reason);
});

test("bounds authorization and tenant resolution with one Control deadline", async () => {
  for (const phase of ["authorization", "registry"] as const) {
    let expire = () => {};
    const started = deferred<void>();
    const service = new ControlProviderProbeService(
      {
        settings: {
          authorizeProbe:
            phase === "authorization"
              ? async () => {
                  started.resolve();
                  return new Promise(() => {});
                }
              : async () => catalog(),
        },
        workers: new TenantRoutedProviderProbeWorker({
          resolve: () => {
            started.resolve();
            return new Promise(() => {});
          },
        }),
      },
      {
        deadlineMs: 25,
        schedule: (callback) => {
          expire = callback;
          return () => {};
        },
      },
    );
    const result = service.probe(actor(), new AbortController().signal);
    await started.promise;
    expire();
    await assert.rejects(result, hasCode("provider_probe_worker_unavailable"));
  }
});

function okResult(catalogRevision = 1): ModelProviderProbeResult {
  return {
    providerId: "gateway",
    catalogRevision,
    runtimeBindingId: "desktop-supervisor:generation-7",
    status: "ok",
    models: [{ id: "model-1", displayName: "Model One" }],
    modelCount: 1,
    latencyMs: 5,
    retryable: false,
    retryAfterMs: null,
  };
}

function probeRequest() {
  return {
    tenantId: "tenant-1",
    expectedRevision: 1,
    expectedProviderId: "gateway",
    expectedRuntimeBindingId: "desktop-supervisor:generation-7",
  };
}

function catalog() {
  return {
    tenantId: "tenant-1",
    revision: 1,
    activeProviderId: "gateway",
    runtimeBindingId: "desktop-supervisor:generation-7",
    bindings: [],
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

function actor() {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function emptyResult(
  status: ModelProviderProbeResult["status"],
): ModelProviderProbeResult {
  return {
    providerId: "gateway",
    catalogRevision: 1,
    runtimeBindingId: "desktop-supervisor:generation-7",
    status,
    models: null,
    modelCount: null,
    latencyMs: 5,
    retryable: false,
    retryAfterMs: null,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof ProviderProbeWorkerError && error.code === code;
}
