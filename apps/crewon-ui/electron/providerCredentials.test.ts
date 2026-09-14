import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeStorage } from "electron";
import { ProviderCredentialStore } from "./providerCredentials.ts";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    decryptString: vi.fn(() => {
      throw new Error("other Mac keychain");
    }),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
  },
}));
const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "crewon-credentials-test-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("portable model credential state", () => {
  it("starts a clean install without borrowing a credential", () => {
    vi.stubEnv("AICUICAN_API_KEY", "");
    const store = new ProviderCredentialStore(
      directory(),
      async () => undefined,
    );
    expect(store.active()).toBeNull();
    expect(store.catalog()).toEqual({ activeProviderId: null, bindings: [] });
  });
  it("ignores an ambient developer API key in a packaged bootstrap", () => {
    vi.stubEnv("AICUICAN_API_KEY", "synthetic-developer-only");
    const store = new ProviderCredentialStore(
      directory(),
      async () => undefined,
      { allowEnvironmentBootstrap: false },
    );
    expect(store.active()).toBeNull();
    expect(store.catalog().bindings).toEqual([]);
  });
  it("keeps migrated provider metadata but requires a new credential when decryption fails", () => {
    const path = directory();
    writeFileSync(
      join(path, "provider-credentials.json"),
      JSON.stringify({
        schemaVersion: "crewon.provider-credentials.v1",
        activeProviderId: "example",
        bindings: [
          {
            providerId: "example",
            endpoint: "https://example.com/v1",
            modelId: "model",
            credentialKind: "keychain",
            environmentVariable: null,
            encryptedSecret:
              Buffer.from("foreign-ciphertext").toString("base64"),
          },
        ],
      }),
    );
    const store = new ProviderCredentialStore(path, async () => undefined);
    expect(store.active()).toBeNull();
    expect(store.catalog().bindings[0]).toMatchObject({
      providerId: "example",
      modelId: "model",
      credentialAvailable: false,
    });
    expect(safeStorage.decryptString).toHaveBeenCalled();
  });
});
