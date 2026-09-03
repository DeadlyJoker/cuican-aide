import { describe, expect, it, vi } from "vitest";

import { createProviderCredentialStore } from "./providerCredentialStore";

const catalog = {
  activeProviderId: "gateway",
  bindings: [
    {
      credentialAvailable: true,
      credentialKind: "keychain",
      endpoint: "https://api.example.com/v1",
      environmentVariable: null,
      isActive: true,
      modelId: "gateway-model",
      providerId: "gateway",
    },
  ],
};

describe("providerCredentialStore", () => {
  it("writes the secret only through the typed native IPC request", async () => {
    const invoke = vi.fn(async () => catalog);
    const store = createProviderCredentialStore(invoke);

    await store.upsert({
      activate: true,
      credentialKind: "keychain",
      endpoint: "https://api.example.com/v1",
      environmentVariable: null,
      modelId: "gateway-model",
      providerId: "gateway",
      secret: "provider-secret",
    });

    expect(invoke).toHaveBeenCalledWith("provider_credential_upsert", {
      request: {
        activate: true,
        credentialKind: "keychain",
        endpoint: "https://api.example.com/v1",
        environmentVariable: null,
        modelId: "gateway-model",
        providerId: "gateway",
        secret: "provider-secret",
      },
    });
  });

  it("uses provider identity rather than a model id for activate and delete", async () => {
    const invoke = vi.fn(async () => catalog);
    const store = createProviderCredentialStore(invoke);

    await store.activate("gateway");
    await store.delete("gateway");

    expect(invoke.mock.calls).toEqual([
      ["provider_credential_activate", { request: { providerId: "gateway" } }],
      ["provider_credential_delete", { request: { providerId: "gateway" } }],
    ]);
  });

  it.each([
    { ...catalog, rawSecret: "must-not-cross" },
    { activeProviderId: "other", bindings: catalog.bindings },
    {
      activeProviderId: "gateway",
      bindings: [{ ...catalog.bindings[0], credentialKind: "unknown" }],
    },
    {
      activeProviderId: "gateway",
      bindings: [{ ...catalog.bindings[0], modelId: "\u0000invalid" }],
    },
  ])("fails closed on malformed or cross-shape catalog %#", async (value) => {
    const store = createProviderCredentialStore(async () => value);

    await expect(store.catalog()).rejects.toThrow();
  });

  it("rejects cross-kind secret input before invoking native code", async () => {
    const invoke = vi.fn(async () => catalog);
    const store = createProviderCredentialStore(invoke);

    await expect(
      store.upsert({
        activate: false,
        credentialKind: "none",
        endpoint: "http://127.0.0.1:11434/v1",
        environmentVariable: null,
        modelId: "llama3.3",
        providerId: "ollama-local",
        secret: "must-not-be-accepted",
      }),
    ).rejects.toThrow("provider_credential_request_invalid");
    await expect(
      store.upsert({
        activate: false,
        credentialKind: "keychain",
        endpoint: "http://127.evil.example/v1",
        environmentVariable: null,
        modelId: "model",
        providerId: "lookalike",
        secret: "must-not-leak",
      }),
    ).rejects.toThrow("provider_credential_request_invalid");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("allows http only for loopback endpoints", async () => {
    const invoke = vi.fn(async () => ({
      activeProviderId: null,
      bindings: [],
    }));
    const store = createProviderCredentialStore(invoke);

    await store.upsert({
      activate: false,
      credentialKind: "none",
      endpoint: "http://127.0.0.1:11434/v1",
      environmentVariable: null,
      modelId: "llama3.3",
      providerId: "ollama-local",
      secret: null,
    });
    await expect(
      store.upsert({
        activate: false,
        credentialKind: "keychain",
        endpoint: "http://api.example.com/v1",
        environmentVariable: null,
        modelId: "model",
        providerId: "remote-insecure",
        secret: "must-not-leak",
      }),
    ).rejects.toThrow("provider_credential_request_invalid");

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("sends the model catalog request through the native IPC bridge", async () => {
    const invoke = vi.fn(async () => ({
      models: ["gpt-5.6-sol", "claude-sonnet-4"],
      status: "ok",
    }));
    const store = createProviderCredentialStore(invoke);

    const result = await store.modelCatalog({
      apiKey: "sk-test",
      defaultModelId: "gpt-5.5",
      endpoint: "https://api.example.com/v1",
      environmentVariable: null,
      providerId: "gateway",
    });

    expect(invoke).toHaveBeenCalledWith("provider_model_catalog", {
      request: {
        apiKey: "sk-test",
        defaultModelId: "gpt-5.5",
        endpoint: "https://api.example.com/v1",
        environmentVariable: null,
        providerId: "gateway",
      },
    });
    expect(result).toEqual({
      models: ["gpt-5.6-sol", "claude-sonnet-4"],
      status: "ok",
    });
  });

  it("rejects an invalid model catalog result from the host", async () => {
    const store = createProviderCredentialStore(async () => ({
      models: "not-an-array",
      status: "ok",
    }));

    await expect(
      store.modelCatalog({
        apiKey: null,
        defaultModelId: null,
        endpoint: "https://api.example.com/v1",
        environmentVariable: null,
        providerId: "gateway",
      }),
    ).rejects.toThrow("provider_model_catalog_result_invalid");
  });
});
