import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentPlatformCredentialStore,
  parseAgentPlatformOrigin,
  type AgentPlatformCredentialEncryption,
  type AgentPlatformCredentialWriter,
} from "./agentPlatformCredentials.ts";

const directories: string[] = [];
const encryption: AgentPlatformCredentialEncryption = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "gnome_libsecret",
  encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^encrypted:/u, ""),
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AgentPlatformCredentialStore", () => {
  it("persists only encrypted key material and returns only availability", () => {
    const directory = temporaryDirectory();
    const store = new AgentPlatformCredentialStore(directory, encryption);
    const apiKey = "bpk_credential-secret-123";

    expect(
      store.upsert({ origin: "https://platform.example", apiKey }),
    ).toEqual({
      bindings: [
        {
          origin: "https://platform.example",
          credentialAvailable: true,
        },
      ],
    });
    expect(store.secretForOrigin("https://platform.example")).toBe(apiKey);
    expect(store.secretForOrigin("https://other.example")).toBeNull();
    const persisted = readFileSync(
      join(directory, "agent-platform-credentials.json"),
      "utf8",
    );
    expect(persisted).not.toContain(apiKey);
    expect(JSON.stringify(store.catalog())).not.toContain(apiKey);
  });

  it("replaces and revokes one exact origin without affecting another", () => {
    const store = new AgentPlatformCredentialStore(
      temporaryDirectory(),
      encryption,
    );
    store.upsert({
      origin: "https://one.example",
      apiKey: "bpk_first-secret",
    });
    store.upsert({
      origin: "https://two.example",
      apiKey: "bpk_second-secret",
    });
    store.upsert({
      origin: "https://one.example",
      apiKey: "bpk_replaced-secret",
    });

    expect(store.secretForOrigin("https://one.example")).toBe(
      "bpk_replaced-secret",
    );
    store.delete("https://one.example");
    expect(store.secretForOrigin("https://one.example")).toBeNull();
    expect(store.secretForOrigin("https://two.example")).toBe(
      "bpk_second-secret",
    );
  });

  it("rejects ciphertext moved to a different outer origin", () => {
    const directory = temporaryDirectory();
    const store = new AgentPlatformCredentialStore(directory, encryption);
    store.upsert({
      origin: "https://one.example",
      apiKey: "bpk_first-secret",
    });
    store.upsert({
      origin: "https://two.example",
      apiKey: "bpk_second-secret",
    });
    const path = join(directory, "agent-platform-credentials.json");
    const catalog = JSON.parse(readFileSync(path, "utf8")) as {
      bindings: Array<{ origin: string; encryptedApiKey: string }>;
    };
    const firstCiphertext = catalog.bindings[0]!.encryptedApiKey;
    catalog.bindings[0]!.encryptedApiKey = catalog.bindings[1]!.encryptedApiKey;
    catalog.bindings[1]!.encryptedApiKey = firstCiphertext;
    writeFileSync(path, JSON.stringify(catalog), "utf8");

    const tampered = new AgentPlatformCredentialStore(directory, encryption);
    expect(tampered.secretForOrigin("https://one.example")).toBeNull();
    expect(tampered.secretForOrigin("https://two.example")).toBeNull();
    expect(
      tampered.catalog().bindings.every((item) => !item.credentialAvailable),
    ).toBe(true);
  });

  it("fails closed when OS encryption is unavailable or ciphertext is invalid", () => {
    const directory = temporaryDirectory();
    const unavailable: AgentPlatformCredentialEncryption = {
      ...encryption,
      isEncryptionAvailable: () => false,
    };
    const store = new AgentPlatformCredentialStore(directory, unavailable);
    expect(() =>
      store.upsert({
        origin: "https://platform.example",
        apiKey: "bpk_unavailable-secret",
      }),
    ).toThrow("agent_platform_credential_store_unavailable");
  });

  it("fails closed when Electron falls back to the Linux basic_text backend", () => {
    const directory = temporaryDirectory();
    new AgentPlatformCredentialStore(directory, encryption).upsert({
      origin: "https://platform.example",
      apiKey: "bpk_existing-secret",
    });
    const basicText: AgentPlatformCredentialEncryption = {
      ...encryption,
      getSelectedStorageBackend: () => "basic_text",
    };
    const store = new AgentPlatformCredentialStore(directory, basicText, {
      platform: "linux",
    });

    expect(store.catalog()).toEqual({
      bindings: [
        {
          origin: "https://platform.example",
          credentialAvailable: false,
        },
      ],
    });
    expect(store.secretForOrigin("https://platform.example")).toBeNull();
    expect(() =>
      store.upsert({
        origin: "https://platform.example",
        apiKey: "bpk_replacement-secret",
      }),
    ).toThrow("agent_platform_credential_store_unavailable");
  });

  it("fails closed when the Linux safeStorage backend is unknown", () => {
    const unknownBackend: AgentPlatformCredentialEncryption = {
      ...encryption,
      getSelectedStorageBackend: () => "unknown",
    };
    const store = new AgentPlatformCredentialStore(
      temporaryDirectory(),
      unknownBackend,
      { platform: "linux" },
    );

    expect(() =>
      store.upsert({
        origin: "https://platform.example",
        apiKey: "bpk_unknown-backend-secret",
      }),
    ).toThrow("agent_platform_credential_store_unavailable");
  });

  it("does not query the Linux-only backend on macOS", () => {
    const macEncryption: AgentPlatformCredentialEncryption = {
      ...encryption,
      getSelectedStorageBackend: () => {
        throw new Error("linux_only");
      },
    };
    const store = new AgentPlatformCredentialStore(
      temporaryDirectory(),
      macEncryption,
      { platform: "darwin" },
    );

    expect(
      store.upsert({
        origin: "https://platform.example",
        apiKey: "bpk_macos-secret",
      }).bindings[0]?.credentialAvailable,
    ).toBe(true);
  });

  it("does not commit in-memory state when the atomic write fails", () => {
    let failWrite = false;
    const writer: AgentPlatformCredentialWriter = () => {
      if (failWrite) throw new Error("rename_failed");
    };
    const store = new AgentPlatformCredentialStore(
      temporaryDirectory(),
      encryption,
      { writer },
    );
    store.upsert({
      origin: "https://platform.example",
      apiKey: "bpk_existing-secret",
    });
    failWrite = true;

    expect(() =>
      store.upsert({
        origin: "https://platform.example",
        apiKey: "bpk_replacement-secret",
      }),
    ).toThrow("rename_failed");
    expect(store.secretForOrigin("https://platform.example")).toBe(
      "bpk_existing-secret",
    );
    expect(() => store.delete("https://platform.example")).toThrow(
      "rename_failed",
    );
    expect(store.secretForOrigin("https://platform.example")).toBe(
      "bpk_existing-secret",
    );
  });

  it("rejects unsafe origins, malformed keys, and extra fields", () => {
    const store = new AgentPlatformCredentialStore(
      temporaryDirectory(),
      encryption,
    );
    for (const request of [
      { origin: "http://platform.example", apiKey: "bpk_valid-secret" },
      {
        origin: "https://platform.example/path",
        apiKey: "bpk_valid-secret",
      },
      { origin: "https://platform.example", apiKey: "login-jwt" },
      {
        origin: "https://platform.example",
        apiKey: "bpk_valid-secret",
        persistPlaintext: true,
      },
    ]) {
      expect(() => store.upsert(request)).toThrow(
        "agent_platform_credential_request_invalid",
      );
    }
    expect(parseAgentPlatformOrigin("http://127.0.0.1:8000")).toBe(
      "http://127.0.0.1:8000",
    );
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-platform-key-"));
  directories.push(directory);
  return directory;
}
