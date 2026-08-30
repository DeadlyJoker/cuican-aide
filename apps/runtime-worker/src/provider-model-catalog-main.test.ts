import assert from "node:assert/strict";
import test from "node:test";

import { providerModelCatalog } from "./provider-model-catalog-main.ts";

test("projects only bounded agent models and keeps the configured default", async () => {
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

  assert.deepEqual(result, { models: ["gpt-5.5", "gpt-5.6-sol"] });
});

test("falls back to the configured model when the Provider is unavailable", async () => {
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

  assert.deepEqual(result, { models: ["gpt-5.5"] });
});

function input() {
  return {
    apiKey: "secret",
    defaultModelId: "gpt-5.5",
    endpoint: "https://provider.example/v1",
    providerId: "provider-1",
  };
}
