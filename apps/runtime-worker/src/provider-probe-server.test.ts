import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import type {
  ModelProviderSettingsState,
  ModelProviderSettingsStore,
} from "@crewon/application";

import { DesktopProviderProbeEgressPolicy } from "./provider-probe-egress.ts";
import { startRuntimeProviderProbeServer } from "./provider-probe-server.ts";
import { RuntimeProviderProbeService } from "./provider-probe-service.ts";

const TOKEN = "private-control-worker-token-32-bytes-minimum";
const RUNTIME_BINDING_ID = "desktop-supervisor:generation-7";

test("aborts a completed private request when the response peer disconnects", async (t) => {
  const probeStarted = deferred<void>();
  const probeAborted = deferred<unknown>();
  const secretReleased = deferred<void>();
  const service = new RuntimeProviderProbeService(
    {
      store: fakeStore(),
      tenantId: "tenant-1",
      runtimeBinding: {
        runtimeBindingId: RUNTIME_BINDING_ID,
        providerId: "gateway",
        endpoint: "https://provider.example/v1",
        credentialKind: "keychain",
        environmentVariable: null,
      },
      secrets: {
        resolve: () => ({
          value: "worker-only-secret",
          release: () => secretReleased.resolve(),
        }),
      },
      egressPolicy: new DesktopProviderProbeEgressPolicy(),
    },
    {
      createProbe: () => ({
        probe: (signal) => {
          probeStarted.resolve();
          return new Promise((_resolve, reject) => {
            const abort = () => {
              probeAborted.resolve(signal.reason);
              reject(signal.reason);
            };
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        },
      }),
    },
  );
  await assert.rejects(
    startRuntimeProviderProbeServer({
      port: 0,
      token: "密".repeat(3_000),
      service,
    }),
    /provider_probe_token_invalid/u,
  );
  const server = await startRuntimeProviderProbeServer({
    port: 0,
    token: TOKEN,
    service,
  });
  t.after(() => server.close());

  const body = JSON.stringify({
    tenantId: "tenant-1",
    expectedRevision: 3,
    expectedProviderId: "gateway",
    expectedRuntimeBindingId: RUNTIME_BINDING_ID,
  });
  const request = httpRequest(
    `${server.origin}/internal/v1/model-provider-probe`,
    {
      method: "POST",
      headers: {
        "authorization": `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    },
  );
  request.on("error", () => {});
  request.end(body);
  await probeStarted.promise;
  request.destroy(new Error("caller_disconnected"));

  const reason = await probeAborted.promise;
  await secretReleased.promise;
  assert.equal(reason instanceof Error, true);
  assert.equal((reason as Error).message, "control_disconnected");
});

function fakeStore(): ModelProviderSettingsStore {
  const current = state();
  return {
    loadModelProviderSettingsState: async () => structuredClone(current),
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
      runtimeBindingId: RUNTIME_BINDING_ID,
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
