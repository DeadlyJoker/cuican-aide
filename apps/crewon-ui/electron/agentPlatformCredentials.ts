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

const CATALOG_FILE = "agent-platform-credentials.json";
const CATALOG_SCHEMA = "crewon.agent-platform-credentials.v1";
const CREDENTIAL_SCHEMA = "crewon.agent-platform-credential.v1";
const MAX_BINDINGS = 32;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_API_KEY_BYTES = 8 * 1024;

export type AgentPlatformCredentialStatus = Readonly<{
  origin: string;
  credentialAvailable: boolean;
}>;

export type AgentPlatformCredentialCatalog = Readonly<{
  bindings: readonly AgentPlatformCredentialStatus[];
}>;

export type AgentPlatformCredentialEncryption = Readonly<{
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend():
    | "basic_text"
    | "gnome_libsecret"
    | "kwallet"
    | "kwallet5"
    | "kwallet6"
    | "unknown";
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}>;

export type AgentPlatformCredentialWriter = (
  path: string,
  contents: string,
) => void;

export type AgentPlatformCredentialStoreOptions = Readonly<{
  platform?: NodeJS.Platform;
  writer?: AgentPlatformCredentialWriter;
}>;

type StoredBinding = Readonly<{
  origin: string;
  encryptedApiKey: string;
}>;

type StoredCatalog = Readonly<{
  schemaVersion: typeof CATALOG_SCHEMA;
  bindings: readonly StoredBinding[];
}>;

/**
 * Stores Agent Open API keys independently from login and model credentials.
 * Only encrypted ciphertext and its exact Agent Platform origin reach disk.
 */
export class AgentPlatformCredentialStore {
  readonly #encryption: AgentPlatformCredentialEncryption;
  readonly #path: string;
  readonly #platform: NodeJS.Platform;
  readonly #writer: AgentPlatformCredentialWriter;
  #state: StoredCatalog;

  constructor(
    dataDirectory: string,
    encryption: AgentPlatformCredentialEncryption,
    options: AgentPlatformCredentialStoreOptions = {},
  ) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.#encryption = encryption;
    this.#path = join(dataDirectory, CATALOG_FILE);
    this.#platform = options.platform ?? process.platform;
    this.#writer = options.writer ?? writeCatalogAtomically;
    this.#state = this.#read();
  }

  catalog(): AgentPlatformCredentialCatalog {
    return {
      bindings: this.#state.bindings.map((binding) => ({
        origin: binding.origin,
        credentialAvailable:
          secureEncryptionAvailable(this.#encryption, this.#platform) &&
          this.#decrypt(binding) !== null,
      })),
    };
  }

  secretForOrigin(value: unknown): string | null {
    const origin = parseAgentPlatformOrigin(value);
    const binding = this.#state.bindings.find(
      (candidate) => candidate.origin === origin,
    );
    return binding === undefined ? null : this.#decrypt(binding);
  }

  upsert(value: unknown): AgentPlatformCredentialCatalog {
    if (!isPlainObject(value) || !hasExactKeys(value, ["apiKey", "origin"])) {
      throw new Error("agent_platform_credential_request_invalid");
    }
    const origin = parseAgentPlatformOrigin(value.origin);
    const apiKey = parseAgentPlatformApiKey(value.apiKey);
    if (!secureEncryptionAvailable(this.#encryption, this.#platform)) {
      throw new Error("agent_platform_credential_store_unavailable");
    }
    const binding: StoredBinding = {
      origin,
      encryptedApiKey: this.#encryption
        .encryptString(
          JSON.stringify({
            schemaVersion: CREDENTIAL_SCHEMA,
            origin,
            apiKey,
          }),
        )
        .toString("base64"),
    };
    const next = [
      ...this.#state.bindings.filter(
        (candidate) => candidate.origin !== origin,
      ),
      binding,
    ].sort((left, right) => left.origin.localeCompare(right.origin));
    if (next.length > MAX_BINDINGS) {
      throw new Error("agent_platform_credential_catalog_full");
    }
    const nextState: StoredCatalog = {
      schemaVersion: CATALOG_SCHEMA,
      bindings: next,
    };
    this.#write(nextState);
    this.#state = nextState;
    return this.catalog();
  }

  delete(value: unknown): AgentPlatformCredentialCatalog {
    const origin = parseAgentPlatformOrigin(value);
    const nextState: StoredCatalog = {
      schemaVersion: CATALOG_SCHEMA,
      bindings: this.#state.bindings.filter(
        (binding) => binding.origin !== origin,
      ),
    };
    this.#write(nextState);
    this.#state = nextState;
    return this.catalog();
  }

  #decrypt(binding: StoredBinding): string | null {
    if (!secureEncryptionAvailable(this.#encryption, this.#platform)) {
      return null;
    }
    try {
      const value = JSON.parse(
        this.#encryption.decryptString(
          Buffer.from(binding.encryptedApiKey, "base64"),
        ),
      ) as unknown;
      if (
        !isPlainObject(value) ||
        !hasExactKeys(value, ["apiKey", "origin", "schemaVersion"]) ||
        value.schemaVersion !== CREDENTIAL_SCHEMA ||
        parseAgentPlatformOrigin(value.origin) !== binding.origin
      ) {
        return null;
      }
      return parseAgentPlatformApiKey(value.apiKey);
    } catch {
      return null;
    }
  }

  #read(): StoredCatalog {
    if (!existsSync(this.#path)) return emptyCatalog();
    try {
      const metadata = statSync(this.#path);
      if (!metadata.isFile() || metadata.size > MAX_CATALOG_BYTES) {
        return emptyCatalog();
      }
      const value = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      if (
        !isPlainObject(value) ||
        value.schemaVersion !== CATALOG_SCHEMA ||
        !Array.isArray(value.bindings) ||
        value.bindings.length > MAX_BINDINGS
      ) {
        return emptyCatalog();
      }
      const bindings = value.bindings.map(parseStoredBinding);
      if (
        new Set(bindings.map(({ origin }) => origin)).size !== bindings.length
      ) {
        return emptyCatalog();
      }
      return { schemaVersion: CATALOG_SCHEMA, bindings };
    } catch {
      return emptyCatalog();
    }
  }

  #write(state: StoredCatalog): void {
    this.#writer(this.#path, `${JSON.stringify(state)}\n`);
  }
}

function secureEncryptionAvailable(
  encryption: AgentPlatformCredentialEncryption,
  platform: NodeJS.Platform,
): boolean {
  try {
    if (!encryption.isEncryptionAvailable()) return false;
    if (platform !== "linux") return true;
    const backend = encryption.getSelectedStorageBackend();
    return (
      backend === "gnome_libsecret" ||
      backend === "kwallet" ||
      backend === "kwallet5" ||
      backend === "kwallet6"
    );
  } catch {
    return false;
  }
}

function writeCatalogAtomically(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function parseAgentPlatformOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("agent_platform_credential_request_invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("agent_platform_credential_request_invalid");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    value !== url.origin ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("agent_platform_credential_request_invalid");
  }
  return url.origin;
}

function parseAgentPlatformApiKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > MAX_API_KEY_BYTES ||
    !/^bpk_[A-Za-z0-9_-]{8,}$/u.test(value)
  ) {
    throw new Error("agent_platform_credential_request_invalid");
  }
  return value;
}

function parseStoredBinding(value: unknown): StoredBinding {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["encryptedApiKey", "origin"]) ||
    typeof value.encryptedApiKey !== "string" ||
    value.encryptedApiKey.length === 0 ||
    value.encryptedApiKey.length > MAX_API_KEY_BYTES * 2
  ) {
    throw new Error("agent_platform_credential_catalog_invalid");
  }
  return {
    origin: parseAgentPlatformOrigin(value.origin),
    encryptedApiKey: value.encryptedApiKey,
  };
}

function emptyCatalog(): StoredCatalog {
  return { schemaVersion: CATALOG_SCHEMA, bindings: [] };
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
