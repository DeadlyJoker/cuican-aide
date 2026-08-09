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
      providerId: "gateway",
      secret: "provider-secret",
    });

    expect(invoke).toHaveBeenCalledWith("provider_credential_upsert", {
      request: {
        activate: true,
        credentialKind: "keychain",
        endpoint: "https://api.example.com/v1",
        environmentVariable: null,
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
      bindings: [{ ...catalog.bindings[0], modelId: "gpt-secret-slot" }],
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
      providerId: "ollama-local",
      secret: null,
    });
    await expect(
      store.upsert({
        activate: false,
        credentialKind: "keychain",
        endpoint: "http://api.example.com/v1",
        environmentVariable: null,
        providerId: "remote-insecure",
        secret: "must-not-leak",
      }),
    ).rejects.toThrow("provider_credential_request_invalid");

    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
