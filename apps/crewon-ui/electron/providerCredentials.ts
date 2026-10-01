import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";

import { safeStorage } from "electron";
import { writeDesktopConfigAtomically } from "./desktopConfigFile.ts";

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

export type ProviderRuntimeCredentialInput = Readonly<{
  providerId: string;
  endpoint: string;
  responsesEndpoint: string;
  credentialRequired: boolean;
}>;

export type ProviderRuntimeCredentialUnavailableReason =
  | "provider_not_configured"
  | "provider_endpoint_mismatch"
  | "provider_credentials_unavailable"
  | "provider_catalog_invalid";

export type ProviderRuntimeCredentialResolution =
  | Readonly<{ availability: "available"; apiKey: string | null }>
  | Readonly<{
      availability: "unavailable";
      reason: ProviderRuntimeCredentialUnavailableReason;
    }>;

const MAX_PROVIDER_CATALOG_BYTES = 512 * 1024;

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

  /**
   * Resolves the usable secret for a provider without activating it.
   *
   * An explicit environment variable wins (the draft being edited may not be
   * saved yet); otherwise a stored keychain/env binding for the provider id is
   * decrypted. Returns null when no credential is available.
   */
  secretFor(
    providerId: string,
    environmentVariable: string | null,
  ): string | null {
    if (environmentVariable !== null) {
      return process.env[environmentVariable]?.trim() || null;
    }
    const binding = this.#state.bindings.find(
      (candidate) => candidate.providerId === providerId,
    );
    return binding === undefined ? null : this.#secret(binding);
  }

  /** Reads current persisted authority; draft overrides and active selection do not apply. */
  resolveForRuntime(
    input: ProviderRuntimeCredentialInput,
  ): ProviderRuntimeCredentialResolution {
    const request = copyRuntimeCredentialInput(input);
    let descriptor: number;
    try {
      descriptor = openSync(
        this.#path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      return unavailable(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "provider_not_configured"
          : "provider_catalog_invalid",
      );
    }
    let state: StoredCatalog;
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.size > MAX_PROVIDER_CATALOG_BYTES)
        throw new Error();
      const bytes = readFileSync(descriptor);
      if (bytes.byteLength > MAX_PROVIDER_CATALOG_BYTES) throw new Error();
      state = copyRuntimeProviderCatalog(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch {
      return unavailable("provider_catalog_invalid");
    } finally {
      closeSync(descriptor);
    }
    const binding = state.bindings.find(
      (candidate) => candidate.providerId === request.providerId,
    );
    if (binding === undefined) return unavailable("provider_not_configured");
    if (
      normalizedEndpoint(binding.endpoint) !== request.endpoint ||
      derivedResponsesEndpoint(binding.endpoint) !== request.responsesEndpoint
    )
      return unavailable("provider_endpoint_mismatch");
    if (binding.credentialKind === "none")
      return request.credentialRequired
        ? unavailable("provider_credentials_unavailable")
        : available(null);
    try {
      const apiKey = this.#secret(binding);
      if (apiKey === null)
        return unavailable("provider_credentials_unavailable");
      return available(parseText(apiKey, 32 * 1024));
    } catch {
      return unavailable("provider_credentials_unavailable");
    }
  }

  async activate(value: unknown) {
    const providerId = parseProviderId(value);
    const binding = this.#state.bindings.find(
      (candidate) => candidate.providerId === providerId,
    );
    if (binding === undefined || !this.#available(binding)) {
      throw new Error("provider_credential_missing");
    }
    this.#write({ ...this.#state, activeProviderId: providerId });
    await this.#onChange();
    return this.catalog();
  }

  async delete(value: unknown) {
    const providerId = parseProviderId(value);
    this.#write({
      ...this.#state,
      bindings: this.#state.bindings.filter(
        (candidate) => candidate.providerId !== providerId,
      ),
      activeProviderId:
        this.#state.activeProviderId === providerId
          ? null
          : this.#state.activeProviderId,
    });
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
    const bindings = [
      ...this.#state.bindings.filter(
        (candidate) => candidate.providerId !== providerId,
      ),
      binding,
    ].sort((left, right) => left.providerId.localeCompare(right.providerId));
    this.#write({
      ...this.#state,
      bindings,
      activeProviderId:
        value.activate === true ? providerId : this.#state.activeProviderId,
    });
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

  #write(state: StoredCatalog): void {
    writeDesktopConfigAtomically(this.#path, `${JSON.stringify(state)}\n`);
    this.#state = state;
  }
}

function copyRuntimeCredentialInput(
  input: unknown,
): ProviderRuntimeCredentialInput {
  try {
    const value = copyDataObject(input, [
      "providerId",
      "endpoint",
      "responsesEndpoint",
      "credentialRequired",
    ]);
    if (typeof value.credentialRequired !== "boolean") throw new Error();
    const endpoint = normalizedEndpoint(value.endpoint);
    const responsesEndpoint = normalizedEndpoint(value.responsesEndpoint);
    if (derivedResponsesEndpoint(endpoint) !== responsesEndpoint)
      throw new Error();
    return Object.freeze({
      providerId: parseProviderId(value.providerId),
      endpoint,
      responsesEndpoint,
      credentialRequired: value.credentialRequired,
    });
  } catch {
    throw new Error("provider_runtime_credential_request_invalid");
  }
}

function copyRuntimeProviderCatalog(input: unknown): StoredCatalog {
  const value = copyDataObject(input, [
    "schemaVersion",
    "activeProviderId",
    "bindings",
  ]);
  if (
    value.schemaVersion !== "crewon.provider-credentials.v1" ||
    !Array.isArray(value.bindings) ||
    value.bindings.length > 4096
  )
    throw new Error();
  const activeProviderId =
    value.activeProviderId === null
      ? null
      : parseProviderId(value.activeProviderId);
  const ids = new Set<string>();
  const bindings = value.bindings.map((input): StoredBinding => {
    const binding = copyDataObject(input, [
      "providerId",
      "endpoint",
      "modelId",
      "credentialKind",
      "environmentVariable",
      "encryptedSecret",
    ]);
    const providerId = parseProviderId(binding.providerId);
    if (ids.has(providerId)) throw new Error();
    ids.add(providerId);
    const credentialKind = parseCredentialKind(binding.credentialKind);
    const environmentVariable =
      binding.environmentVariable === null
        ? null
        : parseEnvironmentVariable(binding.environmentVariable);
    const encryptedSecret =
      binding.encryptedSecret === null
        ? null
        : parseText(binding.encryptedSecret, 128 * 1024);
    if (
      (credentialKind === "environment" && environmentVariable === null) ||
      (credentialKind !== "environment" && environmentVariable !== null) ||
      (credentialKind !== "keychain" && encryptedSecret !== null) ||
      (encryptedSecret !== null &&
        (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
          encryptedSecret,
        ) ||
          Buffer.from(encryptedSecret, "base64").toString("base64") !==
            encryptedSecret))
    )
      throw new Error();
    return {
      providerId,
      endpoint: normalizedEndpoint(binding.endpoint),
      modelId: parseText(binding.modelId, 256),
      credentialKind,
      environmentVariable,
      encryptedSecret,
    };
  });
  if (activeProviderId !== null && !ids.has(activeProviderId))
    throw new Error();
  return {
    schemaVersion: "crewon.provider-credentials.v1",
    activeProviderId,
    bindings,
  };
}

function copyDataObject(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.getOwnPropertySymbols(input).length !== 0
  )
    throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.keys(descriptors).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some(
      (descriptor) => !("value" in descriptor) || !descriptor.enumerable,
    )
  )
    throw new Error();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function normalizedEndpoint(input: unknown): string {
  const raw = parseEndpoint(input);
  if (/[\\?#]/u.test(raw)) throw new Error();
  return parseText(new URL(raw).toString(), 2_048);
}

function derivedResponsesEndpoint(input: string): string {
  const url = new URL(normalizedEndpoint(input));
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/responses`;
  return url.toString();
}

function available(apiKey: string | null): ProviderRuntimeCredentialResolution {
  const resolution = { availability: "available" as const, apiKey };
  const redacted = () => ({
    availability: "available" as const,
    apiKey: apiKey === null ? null : "[REDACTED]",
  });
  Object.defineProperties(resolution, {
    [inspect.custom]: { value: redacted },
    toJSON: { value: redacted },
  });
  return Object.freeze(resolution);
}

function unavailable(
  reason: ProviderRuntimeCredentialUnavailableReason,
): ProviderRuntimeCredentialResolution {
  return Object.freeze({ availability: "unavailable" as const, reason });
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
