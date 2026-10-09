import assert from "node:assert/strict";
import test from "node:test";

import { providerModelCatalog } from "./provider-model-catalog-main.ts";

test("projects advertised agent models without reviving a removed configured default", async () => {
  const result = await providerModelCatalog(input(), () => ({
    probe: async () => ({
      providerId: "provider-1",
      catalogRevision: 1,
      runtimeBindingId: "binding-1",
      status: "ok",
      models: [
        { id: "gpt-5.6-sol", displayName: "GPT 5.6 Sol" },
        { id: "gpt-image-2", displayName: null },
      ],
      modelCount: 2,
      latencyMs: 1,
      retryable: false,
      retryAfterMs: null,
    }),
  }));

  assert.deepEqual(result, {
    models: ["gpt-5.6-sol"],
    status: "ok",
  });
});

test("does not report a configured fallback as a discovered model when the Provider is unavailable", async () => {
  const result = await providerModelCatalog(input(), () => ({
    probe: async () => ({
      providerId: "provider-1",
      catalogRevision: 1,
      runtimeBindingId: "binding-1",
      status: "unreachable",
      models: null,
      modelCount: null,
      latencyMs: 3_000,
      retryable: true,
      retryAfterMs: null,
    }),
  }));

  assert.deepEqual(result, { models: [], status: "unreachable" });
});

test("a successful empty or media-only catalog contains no runnable model", async () => {
  for (const models of [[], [{ id: "gpt-image-2", displayName: null }]]) {
    const result = await providerModelCatalog(input(), () => ({
      probe: async () => ({
        providerId: "provider-1",
        catalogRevision: 1,
        runtimeBindingId: "binding-1",
        status: "ok",
        models,
        modelCount: models.length,
        latencyMs: 1,
        retryable: false,
        retryAfterMs: null,
      }),
    }));
    assert.deepEqual(result, { models: [], status: "ok" });
  }
});

function input() {
  return {
    apiKey: "secret",
    defaultModelId: "gpt-5.5",
    endpoint: "https://provider.example/v1",
    providerId: "provider-1",
  };
}

test("aicuican intersects key access with enabled metadata, preserving key order", async () => {
  const { intersectProviderCatalogs } = await import(
    "./provider-model-catalog-main.ts"
  );
  const probe = (ids: string[]) => ({
    probe: async () => ({
      providerId: "p",
      catalogRevision: 1,
      runtimeBindingId: "b",
      status: "ok" as const,
      models: ids.map((id) => ({ id, displayName: null })),
      modelCount: ids.length,
      latencyMs: 1,
      retryable: false,
      retryAfterMs: null,
    }),
  });
  const result = await intersectProviderCatalogs(
    probe(["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-luna"]),
    probe(["gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-sol"]),
  ).probe(new AbortController().signal);
  assert.deepEqual(
    result.models?.map((row) => row.id),
    ["gpt-5.6-sol", "gpt-5.6-luna"],
  );
  assert.equal(result.modelCount, 2);
});

test("metadata failure cannot fall back to disabled key-advertised models", async () => {
  const { intersectProviderCatalogs } = await import(
    "./provider-model-catalog-main.ts"
  );
  const base = {
    providerId: "p",
    catalogRevision: 1,
    runtimeBindingId: "b",
    modelCount: null,
    latencyMs: 1,
    retryable: false,
    retryAfterMs: null,
  };
  const result = await intersectProviderCatalogs(
    {
      probe: async () => ({
        ...base,
        status: "ok",
        models: [{ id: "gpt-5.5", displayName: null }],
        modelCount: 1,
      }),
    },
    {
      probe: async () => ({
        ...base,
        status: "authenticationFailed",
        models: null,
      }),
    },
  ).probe(new AbortController().signal);
  assert.equal(result.status, "authenticationFailed");
  assert.equal(result.models, null);
});
