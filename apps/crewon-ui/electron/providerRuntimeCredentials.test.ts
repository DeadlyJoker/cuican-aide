// @vitest-environment node
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderCredentialStore,
  type ProviderRuntimeCredentialInput,
} from "./providerCredentials.ts";

const encryption = vi.hoisted(() => ({
  available: true,
  failDecrypt: false,
  decryptString: vi.fn((bytes: Buffer) => {
    if (encryption.failDecrypt)
      throw new Error("fixture-private-key-decrypt-failure");
    const encrypted = bytes.toString("utf8");
    if (!encrypted.startsWith("encrypted:")) throw new Error("bad_ciphertext");
    return encrypted.slice("encrypted:".length);
  }),
}));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    encryptString: (secret: string) => Buffer.from(`encrypted:${secret}`),
    decryptString: (bytes: Buffer) => encryption.decryptString(bytes),
  },
}));

const directories: string[] = [];
type PersistedFixtureCatalog = {
  schemaVersion: string;
  activeProviderId: string | null;
  bindings: Array<Record<string, unknown>>;
};
const request: ProviderRuntimeCredentialInput = Object.freeze({
  providerId: "first",
  endpoint: "https://provider.example/v1",
  responsesEndpoint: "https://provider.example/v1/responses",
  credentialRequired: true,
});

beforeEach(() => {
  vi.stubEnv("AICUICAN_API_KEY", "");
  encryption.available = true;
  encryption.failDecrypt = false;
  encryption.decryptString.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "crewon-runtime-credential-"));
  directories.push(directory);
  const changed = vi.fn(async () => {});
  return {
    directory,
    path: join(directory, "provider-credentials.json"),
    changed,
    store: new ProviderCredentialStore(directory, changed),
  };
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "first",
    endpoint: "https://provider.example/v1",
    modelId: "fixture-model",
    credentialKind: "keychain",
    environmentVariable: null,
    secret: "fixture-private-key",
    activate: true,
    ...overrides,
  };
}

describe("ProviderCredentialStore current runtime credentials", () => {
  it("uses persisted encrypted credentials and redacts inspect and JSON diagnostics", async () => {
    const { store, directory, path } = fixture();
    await store.upsert(provider());
    const input = { ...request };
    const result = store.resolveForRuntime(input);
    input.providerId = "other";
    input.endpoint = "https://other.example/v1";
    expect(result).toEqual({
      availability: "available",
      apiKey: "fixture-private-key",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(inspect(result)).toContain("[REDACTED]");
    expect(inspect(result)).not.toContain("fixture-private-key");
    expect(JSON.stringify(result)).toBe(
      '{"availability":"available","apiKey":"[REDACTED]"}',
    );
    expect(JSON.stringify(request)).not.toContain("fixture-private-key");
    expect(readFileSync(path, "utf8")).not.toContain("fixture-private-key");
    expect(JSON.stringify(store.catalog())).not.toContain(
      "fixture-private-key",
    );
    expect(
      new ProviderCredentialStore(directory, async () => {}).resolveForRuntime(
        request,
      ),
    ).toEqual(result);
  });

  it("resolves an inactive saved provider without active-provider or ambient key fallback", async () => {
    const { store } = fixture();
    await store.upsert(provider({ activate: false }));
    await store.upsert(
      provider({ providerId: "second", secret: "active-provider-key" }),
    );
    vi.stubEnv("CREWON_MODEL_API_KEY", "ambient-model-key");
    expect(store.active()?.providerId).toBe("second");
    expect(store.resolveForRuntime(request)).toEqual({
      availability: "available",
      apiKey: "fixture-private-key",
    });
    expect(
      store.resolveForRuntime({ ...request, providerId: "absent" }),
    ).toEqual({
      availability: "unavailable",
      reason: "provider_not_configured",
    });
  });

  it("normalizes complete URL host and default port while retaining its path", async () => {
    const { store } = fixture();
    await store.upsert(
      provider({ endpoint: "HTTPS://PROVIDER.EXAMPLE:443/outer/../v1" }),
    );
    expect(
      store.resolveForRuntime({
        ...request,
        endpoint: "https://PROVIDER.example:443/v1",
        responsesEndpoint: "HTTPS://PROVIDER.EXAMPLE:443/v1/responses",
      }),
    ).toEqual({ availability: "available", apiKey: "fixture-private-key" });
  });

  it.each([
    "https://provider.example/v2",
    "https://provider.example/v1/other",
    "https://provider.example/v1/",
    "https://provider.example/%76%31",
    "https://provider.example:8443/v1",
    "https://other.example/v1",
    "http://127.0.0.1:8000/v1",
  ])(
    "rejects a saved endpoint changed to %s before decrypting",
    async (endpoint) => {
      const { store } = fixture();
      await store.upsert(provider({ endpoint }));
      expect(store.resolveForRuntime(request)).toEqual({
        availability: "unavailable",
        reason: "provider_endpoint_mismatch",
      });
      expect(encryption.decryptString).not.toHaveBeenCalled();
    },
  );

  it("rechecks current disk on each call after another store rotates, redirects and deletes", async () => {
    const { store: reader, directory } = fixture();
    await reader.upsert(provider());
    const writer = new ProviderCredentialStore(directory, async () => {});
    await writer.upsert(provider({ secret: "rotated-current-key" }));
    expect(reader.resolveForRuntime(request)).toEqual({
      availability: "available",
      apiKey: "rotated-current-key",
    });
    await writer.upsert(
      provider({ endpoint: "https://redirect.example/v1", secret: "new-key" }),
    );
    expect(reader.resolveForRuntime(request)).toEqual({
      availability: "unavailable",
      reason: "provider_endpoint_mismatch",
    });
    await writer.delete("first");
    expect(reader.resolveForRuntime(request)).toEqual({
      availability: "unavailable",
      reason: "provider_not_configured",
    });
    expect(
      new ProviderCredentialStore(directory, async () => {}).resolveForRuntime(
        request,
      ),
    ).toEqual(reader.resolveForRuntime(request));
  });

  it("reads rotation only from the currently saved environment binding", async () => {
    const { store, directory } = fixture();
    vi.stubEnv("SAVED_PROVIDER_KEY", "first-env-key");
    await store.upsert(
      provider({
        credentialKind: "environment",
        environmentVariable: "SAVED_PROVIDER_KEY",
        secret: null,
      }),
    );
    expect(store.resolveForRuntime(request)).toEqual({
      availability: "available",
      apiKey: "first-env-key",
    });
    vi.stubEnv("SAVED_PROVIDER_KEY", " rotated-env-key ");
    expect(store.resolveForRuntime(request)).toEqual({
      availability: "available",
      apiKey: "rotated-env-key",
    });
    const writer = new ProviderCredentialStore(directory, async () => {});
    vi.stubEnv("REPLACED_PROVIDER_KEY", "replacement-env-key");
    await writer.upsert(
      provider({
        credentialKind: "environment",
        environmentVariable: "REPLACED_PROVIDER_KEY",
        secret: null,
      }),
    );
    expect(store.resolveForRuntime(request)).toEqual({
      availability: "available",
      apiKey: "replacement-env-key",
    });
    vi.stubEnv("REPLACED_PROVIDER_KEY", " ");
    vi.stubEnv("CREWON_MODEL_API_KEY", "unrelated-key");
    for (const credentialRequired of [true, false])
      expect(
        store.resolveForRuntime({ ...request, credentialRequired }),
      ).toEqual({
        availability: "unavailable",
        reason: "provider_credentials_unavailable",
      });
  });

  it("allows explicit saved anonymous credentials only when the runtime permits them", async () => {
    const { store } = fixture();
    await store.upsert(provider({ credentialKind: "none", secret: null }));
    expect(
      store.resolveForRuntime({ ...request, credentialRequired: false }),
    ).toEqual({ availability: "available", apiKey: null });
    expect(store.resolveForRuntime(request)).toEqual({
      availability: "unavailable",
      reason: "provider_credentials_unavailable",
    });
  });

  it("returns bounded unavailability when keychain is locked or decryption fails", async () => {
    const { store } = fixture();
    await store.upsert(provider());
    encryption.available = false;
    expect(store.resolveForRuntime(request)).toEqual({
      availability: "unavailable",
      reason: "provider_credentials_unavailable",
    });
    encryption.available = true;
    encryption.failDecrypt = true;
    const failure = store.resolveForRuntime(request);
    expect(failure).toEqual({
      availability: "unavailable",
      reason: "provider_credentials_unavailable",
    });
    expect(inspect(failure)).not.toContain(
      "fixture-private-key-decrypt-failure",
    );
    encryption.failDecrypt = false;
    expect(store.resolveForRuntime(request).availability).toBe("available");
  });

  it("treats absent encrypted secrets and oversized current environment secrets as unavailable", async () => {
    const { store } = fixture();
    await store.upsert(provider({ secret: null, activate: false }));
    expect(store.resolveForRuntime(request)).toEqual({
      availability: "unavailable",
      reason: "provider_credentials_unavailable",
    });
    vi.stubEnv("SAVED_PROVIDER_KEY", "x".repeat(32 * 1024 + 1));
    await store.upsert(
      provider({
        credentialKind: "environment",
        environmentVariable: "SAVED_PROVIDER_KEY",
        secret: null,
      }),
    );
    expect(store.resolveForRuntime(request)).toEqual({
      availability: "unavailable",
      reason: "provider_credentials_unavailable",
    });
  });

  it("does not authorize an unsaved bootstrap or fall back to it after file deletion", async () => {
    vi.stubEnv("AICUICAN_API_KEY", "bootstrap-key");
    const { store, path } = fixture();
    const input = {
      ...request,
      providerId: "aicuican",
      endpoint: "https://api.aicuican.com/v1",
      responsesEndpoint: "https://api.aicuican.com/v1/responses",
    };
    expect(store.active()?.providerId).toBe("aicuican");
    expect(store.resolveForRuntime(input)).toEqual({
      availability: "unavailable",
      reason: "provider_not_configured",
    });
    await store.upsert(
      provider({
        providerId: "aicuican",
        endpoint: input.endpoint,
        credentialKind: "environment",
        environmentVariable: "AICUICAN_API_KEY",
        secret: null,
      }),
    );
    expect(store.resolveForRuntime(input).availability).toBe("available");
    rmSync(path);
    expect(store.resolveForRuntime(input)).toEqual({
      availability: "unavailable",
      reason: "provider_not_configured",
    });
  });

  it.each([
    (state: PersistedFixtureCatalog) => ({ ...state, extra: true }),
    (state: PersistedFixtureCatalog) => ({
      ...state,
      schemaVersion: "unknown",
    }),
    (state: PersistedFixtureCatalog) => ({
      ...state,
      activeProviderId: "missing",
    }),
    (state: PersistedFixtureCatalog) => ({
      ...state,
      bindings: [...state.bindings, state.bindings[0]],
    }),
    (state: PersistedFixtureCatalog) => ({ ...state, bindings: "invalid" }),
    (state: PersistedFixtureCatalog) => ({
      ...state,
      bindings: [{ ...state.bindings[0], environmentVariable: "OVERRIDE_KEY" }],
    }),
    (state: PersistedFixtureCatalog) => ({
      ...state,
      bindings: [{ ...state.bindings[0], encryptedSecret: "not base64" }],
    }),
    (state: PersistedFixtureCatalog) => ({
      ...state,
      bindings: [{ ...state.bindings[0], secret: "unexpected-clear-secret" }],
    }),
    (state: PersistedFixtureCatalog) => ({
      ...state,
      bindings: [
        { ...state.bindings[0], endpoint: "https://user:secret@example/v1" },
      ],
    }),
  ])("fails closed after persisted catalog corruption %#", async (corrupt) => {
    const { store, path } = fixture();
    await store.upsert(provider());
    const state = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify(corrupt(state)));
    vi.stubEnv("AICUICAN_API_KEY", "ambient-fallback-key");
    expect(store.resolveForRuntime(request)).toEqual({
      availability: "unavailable",
      reason: "provider_catalog_invalid",
    });
    expect(encryption.decryptString).not.toHaveBeenCalled();
  });

  it.each([
    "invalid-json",
    "invalid-utf8",
    "oversized",
    "directory",
    "symlink",
  ])("rejects a current credential file that is %s", async (kind) => {
    const { store, path, directory } = fixture();
    await store.upsert(provider());
    if (kind === "invalid-json") writeFileSync(path, "{");
    if (kind === "invalid-utf8") writeFileSync(path, Buffer.from([0xff]));
    if (kind === "oversized") writeFileSync(path, " ".repeat(512 * 1024 + 1));
    if (kind === "directory") {
      rmSync(path);
      mkdirSync(path);
    }
    if (kind === "symlink") {
      const other = join(directory, "elsewhere.json");
      writeFileSync(other, readFileSync(path));
      rmSync(path);
      symlinkSync(other, path);
    }
    expect(store.resolveForRuntime(request)).toEqual({
      availability: "unavailable",
      reason: "provider_catalog_invalid",
    });
    expect(encryption.decryptString).not.toHaveBeenCalled();
  });

  it("rejects impure request descriptors without invoking getters", () => {
    const { store } = fixture();
    const getter = vi.fn(() => "first");
    const input = Object.defineProperty({ ...request }, "providerId", {
      get: getter,
      enumerable: true,
    });
    expect(() => store.resolveForRuntime(input)).toThrow(
      "provider_runtime_credential_request_invalid",
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    Object.create(request),
    { ...request, unexpected: "override" },
    { ...request, [Symbol("secret")]: "override" },
    { ...request, credentialRequired: 1 },
    { ...request, providerId: " First " },
    { ...request, endpoint: "https://provider.example/v1?" },
    { ...request, endpoint: "https://provider.example/v1#" },
    { ...request, endpoint: "https://provider.example\\v1" },
    { ...request, endpoint: "https://provider.example/" + "x".repeat(2048) },
    { ...request, responsesEndpoint: "https://provider.example/responses" },
    { ...request, responsesEndpoint: "https://other.example/v1/responses" },
    { ...request, responsesEndpoint: "https://provider.example/v1/responses/" },
  ])(
    "rejects invalid complete runtime requests %# with a fixed error",
    (input) => {
      const { store } = fixture();
      expect(() =>
        store.resolveForRuntime(input as ProviderRuntimeCredentialInput),
      ).toThrow("provider_runtime_credential_request_invalid");
    },
  );

  it("accepts strict null-prototype request data and preserves secretFor draft overrides", async () => {
    const { store } = fixture();
    await store.upsert(provider());
    const input = Object.assign(Object.create(null), request);
    expect(store.resolveForRuntime(input).availability).toBe("available");
    vi.stubEnv("DRAFT_PROVIDER_KEY", "draft-secret");
    expect(store.secretFor("unsaved-draft", "DRAFT_PROVIDER_KEY")).toBe(
      "draft-secret",
    );
    expect(store.secretFor("first", null)).toBe("fixture-private-key");
  });
});
