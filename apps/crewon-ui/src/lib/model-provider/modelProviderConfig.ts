/**
 * Reads and writes the `model_providers` table in the user's config.
 *
 * A provider is what makes the app usable at all, and until now it could only
 * be configured by hand-editing `~/.crewon/config.toml`. The backend already
 * accepts these writes through `config/batchWrite`; this module is the
 * serialization boundary so panels never assemble TOML-shaped payloads
 * themselves.
 */

import type { ConfigReadResponse } from "@crewon/app-server-protocol/v2/ConfigReadResponse";
import type { ModelProviderSettingsSnapshot } from "@crewon/contracts";

import type { ProviderCredentialCatalog } from "./providerCredentialStore";

/** Config key for the provider map. */
export const MODEL_PROVIDERS_KEY = "model_providers";

/** Config key naming the provider in use. */
export const SELECTED_PROVIDER_KEY_PATH = "model_provider";

/**
 * Built-in provider ids the backend refuses to let config override.
 *
 * Writing one of these is rejected as a reserved id, so the UI must not offer
 * them as names for a new entry.
 */
export const RESERVED_PROVIDER_IDS = [
  "openai",
  "amazon-bedrock",
  "ollama",
  "lmstudio",
] as const;

/**
 * The only wire protocol the backend supports.
 *
 * `WireApi` has a single variant, so a provider must expose a
 * Responses-compatible API. Chat Completions endpoints cannot be used, which is
 * worth stating in the UI because many third-party gateways speak that instead.
 */
export const SUPPORTED_WIRE_API = "responses";

/** How a provider's credential is supplied. */
export type ModelProviderCredentialKind = "bearer-token" | "env-key" | "none";

export type ModelProviderEntry = {
  id: string;
  name: string;
  baseUrl: string;
  credentialKind: ModelProviderCredentialKind;
  /** Present only for `env-key`; names the variable, not the secret. */
  envKey: string;
  /** True when a bearer token is already stored, so it can be left untouched. */
  hasStoredToken: boolean;
  /** Model alias sent to the Provider or LiteLLM deployment. */
  modelId: string;
};

/** A provider entry as it is stored under `model_providers.<id>`. */
type StoredProvider = {
  name?: unknown;
  base_url?: unknown;
  env_key?: unknown;
  experimental_bearer_token?: unknown;
  wire_api?: unknown;
};

function stringField(
  source: StoredProvider,
  key: keyof StoredProvider,
): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function storedProviders(
  configRead: ConfigReadResponse | null,
): Record<string, StoredProvider> {
  const table = configRead?.config[MODEL_PROVIDERS_KEY];
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(table).flatMap(([id, provider]) =>
      provider && typeof provider === "object" && !Array.isArray(provider)
        ? [[id, provider as StoredProvider]]
        : [],
    ),
  );
}

/** Provider entries from config, ordered by id so the list is stable. */
export function modelProviderEntries(
  configRead: ConfigReadResponse | ModelProviderSettingsSnapshot | null,
  credentialCatalog: ProviderCredentialCatalog | null = null,
): ModelProviderEntry[] {
  if (isProviderSettingsSnapshot(configRead)) {
    return configRead.providers.map((provider) => {
      const binding = credentialCatalog?.bindings.find(
        (candidate) => candidate.providerId === provider.providerId,
      );
      return {
        id: provider.providerId,
        name: provider.displayName ?? provider.providerId,
        baseUrl: provider.endpoint,
        credentialKind:
          provider.credentialKind === "keychain"
            ? "bearer-token"
            : provider.credentialKind === "environment"
              ? "env-key"
              : "none",
        envKey: provider.environmentVariable ?? "",
        hasStoredToken:
          provider.credentialKind === "keychain" &&
          binding?.credentialKind === "keychain" &&
          binding.credentialAvailable === true,
        modelId: binding?.modelId ?? "",
      };
    });
  }
  const configured = storedProviders(configRead);
  const providerIds = new Set([
    ...Object.keys(configured),
    ...(credentialCatalog?.bindings.map((binding) => binding.providerId) ?? []),
  ]);
  return [...providerIds]
    .map((id) => {
      const provider = configured[id] ?? {};
      const binding = credentialCatalog?.bindings.find(
        (candidate) => candidate.providerId === id,
      );
      const envKey =
        binding?.environmentVariable ?? stringField(provider, "env_key");
      const legacyStoredToken =
        typeof provider.experimental_bearer_token === "string" &&
        provider.experimental_bearer_token.length > 0;
      const hasStoredToken = credentialCatalog
        ? binding?.credentialKind === "keychain" && binding.credentialAvailable
        : legacyStoredToken;
      return {
        id,
        name: stringField(provider, "name") || id,
        baseUrl: binding?.endpoint || stringField(provider, "base_url"),
        credentialKind:
          binding?.credentialKind === "keychain"
            ? "bearer-token"
            : binding?.credentialKind === "environment"
              ? "env-key"
              : binding?.credentialKind === "none"
                ? "none"
                : providerCredentialKind(envKey, hasStoredToken),
        envKey,
        hasStoredToken,
        modelId: binding?.modelId ?? "",
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function providerCredentialKind(
  envKey: string,
  hasStoredToken: boolean,
): ModelProviderCredentialKind {
  if (envKey) {
    return "env-key";
  }
  return hasStoredToken ? "bearer-token" : "none";
}

/** The provider currently selected by `model_provider`. */
export function selectedModelProviderId(
  configRead: ConfigReadResponse | ModelProviderSettingsSnapshot | null,
  credentialCatalog: ProviderCredentialCatalog | null = null,
): string {
  if (isProviderSettingsSnapshot(configRead)) {
    return configRead.activeProviderId ?? "";
  }
  if (credentialCatalog?.activeProviderId) {
    return credentialCatalog.activeProviderId;
  }
  const value = configRead?.config.model_provider;
  return typeof value === "string" ? value : "";
}

export function modelProviderEntry(
  configRead: ConfigReadResponse | ModelProviderSettingsSnapshot | null,
  providerId: string,
  credentialCatalog: ProviderCredentialCatalog | null = null,
): ModelProviderEntry | null {
  return (
    modelProviderEntries(configRead, credentialCatalog).find(
      (entry) => entry.id === providerId,
    ) ?? null
  );
}

function isProviderSettingsSnapshot(
  value: ConfigReadResponse | ModelProviderSettingsSnapshot | null,
): value is ModelProviderSettingsSnapshot {
  return value !== null && "providers" in value && "revision" in value;
}
