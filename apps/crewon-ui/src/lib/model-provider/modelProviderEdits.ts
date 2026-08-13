/**
 * Validates provider input and turns it into config edits.
 *
 * Kept apart from the panels so the rules that decide whether a provider is
 * writable are asserted directly, rather than only through rendered output.
 */

import type { JsonValue } from "@crewon-ui-model/serde_json/JsonValue";

import type { Locale } from "../i18n";
import {
  MODEL_PROVIDERS_KEY,
  RESERVED_PROVIDER_IDS,
  SELECTED_PROVIDER_KEY_PATH,
  SUPPORTED_WIRE_API,
  type ModelProviderCredentialKind,
} from "./modelProviderConfig";

export type ModelProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  credentialKind: ModelProviderCredentialKind;
  /** Variable name for `env-key`. */
  envKey: string;
  /** New secret for `bearer-token`; blank keeps whatever is stored. */
  apiKey: string;
  /** Whether to point `model_provider` at this entry after writing. */
  setAsDefault: boolean;
};

export type ModelProviderConfigEdit = {
  keyPath: string;
  value: JsonValue;
  mergeStrategy?: "replace" | "upsert";
};

/**
 * An id has to survive being spliced into a dotted config key path, so
 * separators and quoting characters are rejected rather than escaped.
 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

export function modelProviderIdError(
  id: string,
  locale: Locale,
  existingIds: readonly string[] = [],
): string | null {
  const trimmed = id.trim();
  if (!trimmed) {
    return locale === "zh" ? "请填写 Provider ID" : "Provider ID is required";
  }
  if (!PROVIDER_ID_PATTERN.test(trimmed)) {
    return locale === "zh"
      ? "Provider ID 只能包含小写字母、数字、连字符和下划线，且以字母或数字开头"
      : "Provider ID may contain lowercase letters, digits, hyphens, and underscores, and must start with a letter or digit";
  }
  if (
    RESERVED_PROVIDER_IDS.includes(
      trimmed as (typeof RESERVED_PROVIDER_IDS)[number],
    )
  ) {
    return locale === "zh"
      ? `\`${trimmed}\` 是内置 Provider ID，无法覆盖。请换一个名字，例如 \`${trimmed}-custom\`。`
      : `\`${trimmed}\` is a built-in provider ID and cannot be overridden. Use another name, for example \`${trimmed}-custom\`.`;
  }
  if (existingIds.includes(trimmed)) {
    return locale === "zh"
      ? `Provider \`${trimmed}\` 已存在`
      : `Provider \`${trimmed}\` already exists`;
  }
  return null;
}

/**
 * The base URL must carry its own scheme and host, because the backend joins
 * `/models` onto it directly and a relative value produces a request that
 * cannot be built.
 */
export function modelProviderBaseUrlError(
  baseUrl: string,
  locale: Locale,
): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return locale === "zh" ? "请填写 Base URL" : "Base URL is required";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return locale === "zh"
      ? "Base URL 必须是完整地址，例如 https://api.example.com/v1"
      : "Base URL must be absolute, for example https://api.example.com/v1";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return locale === "zh"
      ? "Base URL 只支持 http 或 https"
      : "Base URL must use http or https";
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  if (parsed.protocol === "http:" && !isLoopback) {
    return locale === "zh"
      ? "远程 Base URL 必须使用 https；http 仅允许本机 loopback 地址"
      : "Remote Base URLs must use https; http is allowed only for loopback addresses";
  }
  return null;
}

/**
 * Validates a draft.
 *
 * `hasStoredToken` lets an existing provider be saved without retyping its
 * secret, while a brand-new bearer-token provider still has to supply one.
 */
export function modelProviderDraftError(
  draft: ModelProviderDraft,
  locale: Locale,
  options: {
    allowReservedId?: boolean;
    existingIds?: readonly string[];
    hasStoredToken?: boolean;
  } = {},
): string | null {
  const idError =
    options.allowReservedId === true &&
    RESERVED_PROVIDER_IDS.includes(
      draft.id.trim() as (typeof RESERVED_PROVIDER_IDS)[number],
    )
      ? null
      : modelProviderIdError(draft.id, locale, options.existingIds ?? []);
  if (idError) {
    return idError;
  }
  const baseUrlError = modelProviderBaseUrlError(draft.baseUrl, locale);
  if (baseUrlError) {
    return baseUrlError;
  }
  if (draft.credentialKind === "env-key" && !draft.envKey.trim()) {
    return locale === "zh"
      ? "请填写环境变量名"
      : "Environment variable name is required";
  }
  if (
    draft.credentialKind === "bearer-token" &&
    !draft.apiKey.trim() &&
    !options.hasStoredToken
  ) {
    return locale === "zh" ? "请填写 API Key" : "API key is required";
  }
  return null;
}

export function modelProviderKeyPath(providerId: string): string {
  return `${MODEL_PROVIDERS_KEY}.${providerId.trim()}`;
}

/**
 * Builds the non-sensitive edits that persist one provider.
 *
 * The whole entry is written with `replace` so switching credential kinds
 * clears a stale `env_key`. Raw bearer tokens are owned by the desktop OS
 * credential store and must never be represented in this config payload.
 */
export function buildModelProviderEdits(
  draft: ModelProviderDraft,
): ModelProviderConfigEdit[] {
  const providerId = draft.id.trim();
  const value: Record<string, JsonValue> = {
    name: draft.name.trim() || providerId,
    base_url: draft.baseUrl.trim(),
    wire_api: SUPPORTED_WIRE_API,
  };

  if (draft.credentialKind === "env-key") {
    value.env_key = draft.envKey.trim();
  }
  const edits: ModelProviderConfigEdit[] = [
    {
      keyPath: modelProviderKeyPath(providerId),
      value,
      mergeStrategy: "replace",
    },
  ];

  if (draft.setAsDefault) {
    edits.push({
      keyPath: SELECTED_PROVIDER_KEY_PATH,
      value: providerId,
      mergeStrategy: "replace",
    });
  }

  return edits;
}

/**
 * Builds the edit that removes a provider.
 *
 * A null value clears the path, which is how the backend deletes a table entry.
 *
 * This removes the entry only. A caller deleting the provider that
 * `model_provider` names must also move that selection, or config becomes
 * unreadable; see `buildClearModelProviderSelectionEdits`.
 */
export function buildModelProviderDeleteEdits(
  providerId: string,
): ModelProviderConfigEdit[] {
  return [
    {
      keyPath: modelProviderKeyPath(providerId),
      value: null,
      mergeStrategy: "replace",
    },
  ];
}

/**
 * Builds the edit that unsets the selected provider.
 *
 * Needed because `model_provider` naming a missing entry is not a soft
 * fallback: the backend fails to resolve config at all and every later
 * `config/read` errors, which locks the user out of the settings page that
 * would let them fix it.
 */
export function buildClearModelProviderSelectionEdits(): ModelProviderConfigEdit[] {
  return [
    {
      keyPath: SELECTED_PROVIDER_KEY_PATH,
      value: null,
      mergeStrategy: "replace",
    },
  ];
}

export function buildSelectModelProviderEdits(
  providerId: string,
): ModelProviderConfigEdit[] {
  return [
    {
      keyPath: SELECTED_PROVIDER_KEY_PATH,
      value: providerId.trim(),
      mergeStrategy: "replace",
    },
  ];
}
