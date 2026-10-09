import { hasDesktopBridge } from "../platform";
import { requireDesktopBridge } from "../desktop/desktopBridge";

const MAX_BINDINGS = 128;
const MAX_SECRET_BYTES = 32 * 1024;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

export const DESKTOP_PROVIDER_CHANGED_EVENT = "crewon:desktop-provider-changed";

export type ProviderCredentialKind = "environment" | "keychain" | "none";

export type ProviderCredentialBinding = Readonly<{
  credentialAvailable: boolean;
  credentialKind: ProviderCredentialKind;
  endpoint: string;
  environmentVariable: string | null;
  isActive: boolean;
  modelId: string | null;
  providerId: string;
}>;

export type ProviderCredentialCatalog = Readonly<{
  activeProviderId: string | null;
  bindings: readonly ProviderCredentialBinding[];
}>;

export type ProviderCredentialUpsert = Readonly<{
  activate: boolean;
  credentialKind: ProviderCredentialKind;
  endpoint: string;
  environmentVariable: string | null;
  modelId: string;
  providerId: string;
  secret: string | null;
}>;

export type ProviderModelCatalogRequest = Readonly<{
  /** Raw key typed in the form; the host falls back to stored credentials. */
  apiKey: string | null;
  /** Default model preference; never limits the discovered gateway directory. */
  defaultModelId: string | null;
  endpoint: string;
  environmentVariable: string | null;
  providerId: string;
}>;

export type ProviderModelCatalogResult = Readonly<{
  models: readonly string[];
  status: string;
}>;

export interface ProviderCredentialStorePort {
  activate(providerId: string): Promise<ProviderCredentialCatalog>;
  catalog(): Promise<ProviderCredentialCatalog>;
  delete(providerId: string): Promise<ProviderCredentialCatalog>;
  /** Discovers the models an endpoint advertises via its /models API. */
  modelCatalog(
    request: ProviderModelCatalogRequest,
  ): Promise<ProviderModelCatalogResult>;
  upsert(request: ProviderCredentialUpsert): Promise<ProviderCredentialCatalog>;
}

type DesktopInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export function createProviderCredentialStore(
  invoke: DesktopInvoke,
): ProviderCredentialStorePort {
  return {
    async activate(providerId) {
      return parseCatalog(
        await invoke("provider_credential_activate", {
          request: { providerId: parseProviderId(providerId) },
        }),
      );
    },
    async catalog() {
      return parseCatalog(await invoke("provider_credential_catalog"));
    },
    async delete(providerId) {
      return parseCatalog(
        await invoke("provider_credential_delete", {
          request: { providerId: parseProviderId(providerId) },
        }),
      );
    },
    async modelCatalog(request) {
      return parseModelCatalogResult(
        await invoke("provider_model_catalog", {
          request: parseModelCatalogRequest(request),
        }),
      );
    },
    async upsert(request) {
      const parsed = parseUpsert(request);
      return parseCatalog(
        await invoke("provider_credential_upsert", { request: parsed }),
      );
    },
  };
}

let desktopStore: ProviderCredentialStorePort | null = null;

/** Native secret storage is intentionally unavailable on the Web surface. */
export function providerCredentialStore(): ProviderCredentialStorePort | null {
  if (!hasDesktopBridge()) return null;
  desktopStore ??= createProviderCredentialStore(async (command, args) => {
    const bridge = requireDesktopBridge().providers;
    let result: unknown;
    switch (command) {
      case "provider_credential_catalog":
        return bridge.catalog();
      case "provider_credential_activate":
        result = await bridge.activate(
          (args?.request as { providerId: string }).providerId,
        );
        break;
      case "provider_credential_delete":
        result = await bridge.delete(
          (args?.request as { providerId: string }).providerId,
        );
        break;
      case "provider_credential_upsert":
        result = await bridge.upsert(args?.request);
        break;
      case "provider_model_catalog": {
        const request = args?.request as
          | ProviderModelCatalogRequest
          | undefined;
        if (request === undefined) {
          throw new Error("provider_model_catalog_request_invalid");
        }
        return bridge.modelCatalog(request);
      }
      default:
        throw new Error("provider_credential_command_unknown");
    }
    globalThis.dispatchEvent(new Event(DESKTOP_PROVIDER_CHANGED_EVENT));
    return result;
  });
  return desktopStore;
}

function parseUpsert(
  value: ProviderCredentialUpsert,
): ProviderCredentialUpsert {
  const providerId = parseProviderId(value.providerId);
  const endpoint = parseEndpoint(value.endpoint);
  const credentialKind = parseCredentialKind(value.credentialKind);
  const environmentVariable =
    value.environmentVariable === null
      ? null
      : parseEnvironmentVariable(value.environmentVariable);
  const secret = value.secret === null ? null : parseSecret(value.secret);
  if (
    (credentialKind === "environment" && environmentVariable === null) ||
    (credentialKind !== "environment" && environmentVariable !== null) ||
    (credentialKind !== "keychain" && secret !== null)
  ) {
    throw new Error("provider_credential_request_invalid");
  }
  return {
    activate: value.activate === true,
    credentialKind,
    endpoint,
    environmentVariable,
    modelId: parseModelId(value.modelId),
    providerId,
    secret,
  };
}

function parseModelCatalogRequest(
  value: ProviderModelCatalogRequest,
): ProviderModelCatalogRequest {
  const providerId = parseProviderId(value.providerId);
  const endpoint = parseEndpoint(value.endpoint);
  const apiKey =
    value.apiKey === null ? null : requiredModelText(value.apiKey, 32_768);
  const defaultModelId =
    value.defaultModelId === null
      ? null
      : requiredModelText(value.defaultModelId, 256);
  const environmentVariable =
    value.environmentVariable === null
      ? null
      : parseEnvironmentVariable(value.environmentVariable);
  return {
    apiKey,
    defaultModelId,
    endpoint,
    environmentVariable,
    providerId,
  };
}

function parseModelCatalogResult(value: unknown): ProviderModelCatalogResult {
  exactObject(value, ["models", "status"]);
  if (
    !Array.isArray(value.models) ||
    value.models.length > 100 ||
    !value.models.every((id) => parseModelCatalogText(id, 256) !== null) ||
    typeof value.status !== "string" ||
    value.status.length === 0 ||
    value.status.length > 64
  ) {
    throw new Error("provider_model_catalog_result_invalid");
  }
  return { models: value.models as readonly string[], status: value.status };
}

function requiredModelText(value: unknown, maximum: number): string {
  const parsed = parseModelCatalogText(value, maximum);
  if (parsed === null) {
    throw new Error("provider_model_catalog_request_invalid");
  }
  return parsed;
}

function parseModelCatalogText(value: unknown, maximum: number): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function parseCatalog(value: unknown): ProviderCredentialCatalog {
  exactObject(value, ["activeProviderId", "bindings"]);
  const activeProviderId =
    value.activeProviderId === null
      ? null
      : parseProviderId(value.activeProviderId);
  if (!Array.isArray(value.bindings) || value.bindings.length > MAX_BINDINGS) {
    throw new Error("provider_credential_catalog_invalid");
  }
  const bindings = value.bindings.map(parseBinding);
  const ids = new Set(bindings.map((binding) => binding.providerId));
  if (
    ids.size !== bindings.length ||
    (activeProviderId !== null && !ids.has(activeProviderId)) ||
    bindings.some(
      (binding) =>
        binding.isActive !== (binding.providerId === activeProviderId),
    )
  ) {
    throw new Error("provider_credential_catalog_invalid");
  }
  return { activeProviderId, bindings };
}

function parseBinding(value: unknown): ProviderCredentialBinding {
  exactObject(value, [
    "credentialAvailable",
    "credentialKind",
    "endpoint",
    "environmentVariable",
    "isActive",
    "modelId",
    "providerId",
  ]);
  if (
    typeof value.credentialAvailable !== "boolean" ||
    typeof value.isActive !== "boolean"
  ) {
    throw new Error("provider_credential_catalog_invalid");
  }
  const credentialKind = parseCredentialKind(value.credentialKind);
  const environmentVariable =
    value.environmentVariable === null
      ? null
      : parseEnvironmentVariable(value.environmentVariable);
  if (
    (credentialKind === "environment" && environmentVariable === null) ||
    (credentialKind !== "environment" && environmentVariable !== null)
  ) {
    throw new Error("provider_credential_catalog_invalid");
  }
  return {
    credentialAvailable: value.credentialAvailable,
    credentialKind,
    endpoint: parseEndpoint(value.endpoint),
    environmentVariable,
    isActive: value.isActive,
    modelId: value.modelId === null ? null : parseModelId(value.modelId),
    providerId: parseProviderId(value.providerId),
  };
}

function parseModelId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("provider_credential_request_invalid");
  }
  return value;
}

function parseCredentialKind(value: unknown): ProviderCredentialKind {
  if (value === "environment" || value === "keychain" || value === "none") {
    return value;
  }
  throw new Error("provider_credential_request_invalid");
}

function parseProviderId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !PROVIDER_ID_PATTERN.test(value)
  ) {
    throw new Error("provider_credential_request_invalid");
  }
  return value;
}

function parseEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("provider_credential_request_invalid");
  }
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    (parsed.protocol === "http:" && !isLoopback) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("provider_credential_request_invalid");
  }
  return value;
}

function parseEnvironmentVariable(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
  ) {
    throw new Error("provider_credential_request_invalid");
  }
  return value;
}

function parseSecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("provider_credential_request_invalid");
  }
  return value;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    throw new Error("provider_credential_catalog_invalid");
  }
}
