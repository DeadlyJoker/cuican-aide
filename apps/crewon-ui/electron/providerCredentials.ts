import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { safeStorage } from "electron";

type CredentialKind = "environment" | "keychain" | "none";
type StoredBinding = {
  providerId: string;
  endpoint: string;
  modelId: string;
  credentialKind: CredentialKind;
  environmentVariable: string | null;
  encryptedSecret: string | null;
};
type StoredCatalog = {
  schemaVersion: "crewon.provider-credentials.v1";
  activeProviderId: string | null;
  bindings: StoredBinding[];
};

export type ActiveProvider = Readonly<{
  providerId: string;
  endpoint: string;
  modelId: string;
  apiKey: string | null;
}>;

export class ProviderCredentialStore {
  readonly #path: string;
  #state: StoredCatalog;
  readonly #onChange: () => Promise<void>;

  constructor(dataDirectory: string, onChange: () => Promise<void>) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.#path = join(dataDirectory, "provider-credentials.json");
    this.#state = this.#read();
    this.#onChange = onChange;
  }

  catalog() {
    return {
      activeProviderId: this.#state.activeProviderId,
      bindings: this.#state.bindings.map((binding) => ({
        providerId: binding.providerId,
        endpoint: binding.endpoint,
        modelId: binding.modelId,
        credentialKind: binding.credentialKind,
        environmentVariable: binding.environmentVariable,
        credentialAvailable: this.#available(binding),
        isActive: binding.providerId === this.#state.activeProviderId,
      })),
    };
  }

  active(): ActiveProvider | null {
    const binding = this.#state.bindings.find(
      ({ providerId }) => providerId === this.#state.activeProviderId,
    );
    if (binding === undefined) return null;
    return {
      providerId: binding.providerId,
      endpoint: binding.endpoint,
      modelId: binding.modelId,
      apiKey: this.#secret(binding),
    };
  }

  async activate(value: unknown) {
    const providerId = parseProviderId(value);
    const binding = this.#state.bindings.find(
      (candidate) => candidate.providerId === providerId,
    );
    if (binding === undefined || !this.#available(binding)) {
      throw new Error("provider_credential_missing");
    }
    this.#state.activeProviderId = providerId;
    this.#write();
    await this.#onChange();
    return this.catalog();
  }

  async delete(value: unknown) {
    const providerId = parseProviderId(value);
    this.#state.bindings = this.#state.bindings.filter(
      (candidate) => candidate.providerId !== providerId,
    );
    if (this.#state.activeProviderId === providerId) {
      this.#state.activeProviderId = null;
    }
    this.#write();
    await this.#onChange();
    return this.catalog();
  }

  async upsert(value: unknown) {
    if (!isPlainObject(value))
      throw new Error("provider_credential_request_invalid");
    const providerId = parseProviderId(value.providerId);
    const endpoint = parseEndpoint(value.endpoint);
    const modelId = parseText(value.modelId, 256);
    const credentialKind = parseCredentialKind(value.credentialKind);
    const environmentVariable =
      value.environmentVariable === null
        ? null
        : parseEnvironmentVariable(value.environmentVariable);
    const secret =
      value.secret === null ? null : parseText(value.secret, 32 * 1024);
    if (
      (credentialKind === "environment" && environmentVariable === null) ||
      (credentialKind !== "environment" && environmentVariable !== null) ||
      (credentialKind !== "keychain" && secret !== null)
    ) {
      throw new Error("provider_credential_request_invalid");
    }
    const previous = this.#state.bindings.find(
      (binding) => binding.providerId === providerId,
    );
    let encryptedSecret: string | null = null;
    if (credentialKind === "keychain") {
      if (secret !== null) {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error("provider_credential_store_unavailable");
        }
        encryptedSecret = safeStorage.encryptString(secret).toString("base64");
      } else if (previous?.credentialKind === "keychain") {
        encryptedSecret = previous.encryptedSecret;
      }
    }
    const binding: StoredBinding = {
      providerId,
      endpoint,
      modelId,
      credentialKind,
      environmentVariable,
      encryptedSecret,
    };
    this.#state.bindings = [
      ...this.#state.bindings.filter(
        (candidate) => candidate.providerId !== providerId,
      ),
      binding,
    ].sort((left, right) => left.providerId.localeCompare(right.providerId));
    if (value.activate === true) this.#state.activeProviderId = providerId;
    this.#write();
    await this.#onChange();
    return this.catalog();
  }

  #available(binding: StoredBinding): boolean {
    if (binding.credentialKind === "none") return true;
    if (binding.credentialKind === "environment") {
      return Boolean(process.env[binding.environmentVariable!]?.trim());
    }
    return (
      binding.encryptedSecret !== null && safeStorage.isEncryptionAvailable()
    );
  }

  #secret(binding: StoredBinding): string | null {
    if (binding.credentialKind === "none") return null;
    if (binding.credentialKind === "environment") {
      return process.env[binding.environmentVariable!]?.trim() || null;
    }
    if (
      binding.encryptedSecret === null ||
      !safeStorage.isEncryptionAvailable()
    ) {
      return null;
    }
    return safeStorage.decryptString(
      Buffer.from(binding.encryptedSecret, "base64"),
    );
  }

  #read(): StoredCatalog {
    if (existsSync(this.#path)) {
      try {
        const metadata = statSync(this.#path);
        if (metadata.isFile() && metadata.size <= 512 * 1024) {
          const value = JSON.parse(
            readFileSync(this.#path, "utf8"),
          ) as StoredCatalog;
          if (
            value.schemaVersion === "crewon.provider-credentials.v1" &&
            Array.isArray(value.bindings)
          ) {
            return value;
          }
        }
      } catch {
        // Fall through to the environment bootstrap below.
      }
    }
    const apiKey = process.env.AICUICAN_API_KEY?.trim();
    return {
      schemaVersion: "crewon.provider-credentials.v1",
      activeProviderId: apiKey ? "aicuican" : null,
      bindings: apiKey
        ? [
            {
              providerId: "aicuican",
              endpoint: "https://api.aicuican.com/v1",
              modelId: process.env.CREWON_MODEL_ID?.trim() || "gpt-5.5",
              credentialKind: "environment",
              environmentVariable: "AICUICAN_API_KEY",
              encryptedSecret: null,
            },
          ]
        : [],
    };
  }

  #write(): void {
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.#state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.#path);
  }
}

function parseProviderId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value)
  ) {
    throw new Error("provider_credential_request_invalid");
  }
  return value;
}

function parseCredentialKind(value: unknown): CredentialKind {
  if (value === "environment" || value === "keychain" || value === "none")
    return value;
  throw new Error("provider_credential_request_invalid");
}

function parseEnvironmentVariable(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)
  ) {
    throw new Error("provider_credential_request_invalid");
  }
  return value;
}

function parseEndpoint(value: unknown): string {
  const raw = parseText(value, 2_048);
  const url = new URL(raw);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("provider_credential_request_invalid");
  }
  return raw;
}

function parseText(value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > maxBytes ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("provider_credential_request_invalid");
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
