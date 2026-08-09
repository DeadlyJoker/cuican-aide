import assert from "node:assert/strict";
import test from "node:test";

import type {
  ModelProviderProbeResult,
  ModelProviderSettingsState,
  ModelProviderSettingsStore,
} from "@crewon/application";

import { DesktopProviderProbeEgressPolicy } from "./provider-probe-egress.ts";
import {
  RuntimeProviderProbeService,
  type RuntimeProviderSecretResolver,
} from "./provider-probe-service.ts";

test("checks active Provider authority before and after the network request", async () => {
  const changed = {
    ...state(),
    catalog: { ...state().catalog!, revision: 4 },
  };
  const store = fakeStore([state(), changed]);
  let networkCalls = 0;
  let released = 0;
  const service = serviceWith(store, {
    secrets: {
      resolve: () => ({
        value: "worker-only-secret",
        release: () => {
          released += 1;
        },
      }),
    },
    createProbe: () => {
      networkCalls += 1;
      return { probe: async () => okResult() };
    },
  });
  assert.equal(
    (
      await service.probe(
        probeRequest(),
        new AbortController().signal,
      )
    ).status,
    "bindingMismatch",
  );
  assert.equal(networkCalls, 1);
  assert.equal(released, 1);
});

test("fails closed for pending, wrong tenant, stale revision and missing secret", async () => {
  let networkCalls = 0;
  const pending = { ...state(), pending: pendingState() };
  for (const [storeState, tenantId, revision, providerId, status] of [
    [pending, "tenant-1", 3, "gateway", "bindingMismatch"],
    [state(), "tenant-2", 3, "gateway", "bindingMismatch"],
    [state(), "tenant-1", 2, "gateway", "bindingMismatch"],
    [state(), "tenant-1", 3, "wrong-provider", "bindingMismatch"],
    [state(), "tenant-1", 3, "gateway", "credentialMissing"],
  ] as const) {
    const service = serviceWith(fakeStore([storeState]), {
      secrets: { resolve: () => null },
      createProbe: () => {
        networkCalls += 1;
        return { probe: async () => okResult() };
      },
    });
    assert.equal(
      (
        await service.probe(
          {
            tenantId,
            expectedRevision: revision,
            expectedProviderId: providerId,
            expectedRuntimeBindingId: "desktop-supervisor:generation-7",
          },
          new AbortController().signal,
        )
      ).status,
      status,
    );
  }
  assert.equal(networkCalls, 0);
});

test("enforces per-binding concurrency and rate limits", async () => {
  const response = deferred<ModelProviderProbeResult>();
  const service = serviceWith(fakeStore([state(), state()]), {
    rateLimit: 2,
    concurrencyLimit: 1,
    createProbe: () => ({ probe: () => response.promise }),
  });
  const first = service.probe(
    probeRequest(),
    new AbortController().signal,
  );
  await Promise.resolve();
  assert.equal(
    (
      await service.probe(
        probeRequest(),
        new AbortController().signal,
      )
    ).status,
    "rateLimited",
  );
  assert.equal(
    (
      await service.probe(
        probeRequest(),
        new AbortController().signal,
      )
    ).status,
    "rateLimited",
  );
  response.resolve(okResult());
  assert.equal((await first).status, "ok");
});

test("the total deadline bounds a hung secret resolver", async () => {
  const started = deferred<void>();
  let expire = () => {};
  const service = serviceWith(fakeStore([state()]), {
    secrets: {
      resolve: () => {
        started.resolve();
        return new Promise(() => {});
      },
    },
    deadlineMs: 25,
    schedule: (callback) => {
      expire = callback;
      return () => {};
    },
  });
  const result = service.probe(
    probeRequest(),
    new AbortController().signal,
  );
  await started.promise;
  expire();
  assert.equal((await result).status, "unreachable");
});

test("the total deadline bounds a hung final authority recheck", async () => {
  const finalRead = deferred<ModelProviderSettingsState>();
  const finalStarted = deferred<void>();
  let reads = 0;
  const store = fakeStore([], async () => {
    reads += 1;
    if (reads === 1) return state();
    finalStarted.resolve();
    return finalRead.promise;
  });
  let expire = () => {};
  const service = serviceWith(store, {
    deadlineMs: 25,
    schedule: (callback) => {
      expire = callback;
      return () => {};
    },
    createProbe: () => ({ probe: async () => okResult() }),
  });
  const result = service.probe(
    probeRequest(),
    new AbortController().signal,
  );
  await finalStarted.promise;
  expire();
  assert.equal((await result).status, "unreachable");
});

test("fails closed when the rate-limit clock is invalid or moves backward", async () => {
  let now = 10;
  const service = serviceWith(fakeStore([state(), state()]), {
    now: () => now,
    createProbe: () => ({ probe: async () => okResult() }),
  });
  assert.equal(
    (
      await service.probe(
        probeRequest(),
        new AbortController().signal,
      )
    ).status,
    "ok",
  );
  now = 9;
  await assert.rejects(
    service.probe(
      probeRequest(),
      new AbortController().signal,
    ),
    /provider_probe_clock_invalid/u,
  );
});

function serviceWith(
  store: ModelProviderSettingsStore,
  options: ConstructorParameters<typeof RuntimeProviderProbeService>[1] & {
    secrets?: RuntimeProviderSecretResolver;
  } = {},
): RuntimeProviderProbeService {
  const { secrets, ...serviceOptions } = options;
  return new RuntimeProviderProbeService(
    {
      store,
      tenantId: "tenant-1",
      runtimeBinding: {
        runtimeBindingId: "desktop-supervisor:generation-7",
        providerId: "gateway",
        endpoint: "https://provider.example/v1",
        credentialKind: "keychain",
        environmentVariable: null,
      },
      secrets:
        secrets ??
        ({
          resolve: () => ({ value: "worker-only-secret", release: () => {} }),
        } satisfies RuntimeProviderSecretResolver),
      egressPolicy: new DesktopProviderProbeEgressPolicy(),
    },
    serviceOptions,
  );
}

function fakeStore(
  values: readonly ModelProviderSettingsState[],
  load?: () => Promise<ModelProviderSettingsState>,
): ModelProviderSettingsStore {
  let index = 0;
  return {
    loadModelProviderSettingsState: async () =>
      load?.() ?? structuredClone(values[Math.min(index++, values.length - 1)]!),
    prepareModelProviderSettings: async () => unexpected(),
    finalizeModelProviderSettings: async () => unexpected(),
    abortModelProviderSettings: async () => unexpected(),
    expireModelProviderSettings: async () => unexpected(),
  };
}

function state(): ModelProviderSettingsState {
  return {
    catalog: {
      tenantId: "tenant-1",
      revision: 3,
      activeProviderId: "gateway",
      runtimeBindingId: "desktop-supervisor:generation-7",
      bindings: [
        {
          providerId: "gateway",
          displayName: "Gateway",
          endpoint: "https://provider.example/v1",
          credentialKind: "keychain",
          environmentVariable: null,
        },
      ],
      updatedAt: "2026-08-09T00:00:00.000Z",
    },
    pending: null,
  };
}

function pendingState() {
  return {
    tenantId: "tenant-1",
    operationId: "operation-1",
    coordinatorBinding: "desktop:generation-1",
    baseRevision: 3,
    activeProviderId: "gateway",
    runtimeBindingId: "desktop:generation-1",
    bindings: state().catalog!.bindings,
    preparedAt: "2026-08-09T00:00:00.000Z",
    expiresAt: "2026-08-09T00:05:00.000Z",
  };
}

function okResult(): ModelProviderProbeResult {
  return {
    providerId: "gateway",
    catalogRevision: 3,
    runtimeBindingId: "desktop-supervisor:generation-7",
    status: "ok",
    models: [{ id: "model-1", displayName: null }],
    modelCount: 1,
    latencyMs: 5,
    retryable: false,
    retryAfterMs: null,
  };
}

function probeRequest() {
  return {
    tenantId: "tenant-1",
    expectedRevision: 3,
    expectedProviderId: "gateway",
    expectedRuntimeBindingId: "desktop-supervisor:generation-7",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function unexpected(): never {
  throw new Error("unexpected_provider_store_mutation");
}
