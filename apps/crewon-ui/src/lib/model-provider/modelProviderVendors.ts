/**
 * Catalog of known model vendors.
 *
 * Adding a provider by hand means knowing its base URL, which is the part a
 * user is least likely to remember and most likely to get subtly wrong. This
 * catalog turns that into a pick-then-paste-a-key flow, while still leaving the
 * fully manual path open for gateways nobody has heard of.
 *
 * Only Responses-compatible endpoints belong here. `WireApi` has a single
 * variant, so a vendor that speaks Chat Completions cannot be reached even with
 * a correct URL and key -- listing one would promise something the backend
 * cannot deliver.
 */

import type { Locale } from "../i18n";

/** How a vendor expects to be authenticated. */
export type VendorCredentialStyle =
  /** Bearer token the user pastes in, stored on this machine. */
  | "api-key"
  /** Signed in through the Crewon account; no key to enter. */
  | "crewon-account"
  /** Reachable without any credential, such as a model running locally. */
  | "none";

export type ModelProviderVendor = {
  /** Base URL prefilled into the form. Absent when the user must supply it. */
  readonly baseUrl?: string;
  readonly credentialStyle: VendorCredentialStyle;
  /** Suggested direct model id; gateway aliases are intentionally user-owned. */
  readonly defaultModel?: string;
  /**
   * Vendor-recommended environment variable, offered when the user would
   * rather not have the key written to disk.
   */
  readonly envKey?: string;
  /** Stable id, also used as the default provider id in config. */
  readonly id: string;
  /** Set for vendors the backend already ships; these cannot be redefined. */
  readonly isBuiltIn?: boolean;
  readonly name: string;
  /** Shown under the vendor so the tradeoff is visible before committing. */
  readonly note: { readonly en: string; readonly zh: string };
};

/**
 * The vendor a user should reach for first.
 *
 * Listed ahead of the rest because it needs no key at all: the signed-in Crewon
 * account already carries the entitlement.
 */
export const CREWON_OFFICIAL_VENDOR_ID = "openai";

/** Sentinel for "none of the above"; keeps the manual path a normal choice. */
export const CUSTOM_VENDOR_ID = "custom";

/**
 * Known vendors, in the order they are offered.
 *
 * The Crewon account comes first, then vendors needing a key, then local
 * runtimes, then the manual escape hatch.
 */
export const MODEL_PROVIDER_VENDORS: readonly ModelProviderVendor[] = [
  {
    credentialStyle: "crewon-account",
    id: CREWON_OFFICIAL_VENDOR_ID,
    isBuiltIn: true,
    name: "Crewon",
    note: {
      en: "Uses your signed-in Crewon account. No API key needed.",
      zh: "使用已登录的 Crewon 账号，无需填写密钥。",
    },
  },
  {
    baseUrl: "http://127.0.0.1:4000/v1",
    credentialStyle: "api-key",
    envKey: "LITELLM_MASTER_KEY",
    id: "litellm",
    name: "LiteLLM Gateway（推荐）",
    note: {
      en: "Open-source gateway for 100+ models; configure vendor credentials once in LiteLLM.",
      zh: "开源统一网关，覆盖 100+ 模型；厂商凭据统一配置在 LiteLLM 中。",
    },
  },
  {
    baseUrl: "https://api.openai.com/v1",
    credentialStyle: "api-key",
    defaultModel: "gpt-5.6",
    envKey: "OPENAI_API_KEY",
    id: "openai-api",
    name: "OpenAI API",
    note: {
      en: "Direct native Responses API connection.",
      zh: "直接连接原生 Responses API。",
    },
  },
  {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    credentialStyle: "api-key",
    defaultModel: "qwen3-coder-plus",
    envKey: "DASHSCOPE_API_KEY",
    id: "qwen",
    name: "\u963f\u91cc\u4e91\u767e\u70bc / Qwen",
    note: {
      en: "Alibaba Cloud Model Studio, Responses-compatible mode.",
      zh: "\u963f\u91cc\u4e91\u767e\u70bc\u5e73\u53f0\uff0c\u517c\u5bb9\u6a21\u5f0f\u7aef\u70b9\u3002",
    },
  },
  {
    baseUrl: "https://api.moonshot.cn/v1",
    credentialStyle: "api-key",
    defaultModel: "kimi-k2.5",
    envKey: "MOONSHOT_API_KEY",
    id: "moonshot",
    name: "\u6708\u4e4b\u6697\u9762 / Kimi",
    note: {
      en: "Moonshot AI.",
      zh: "\u6708\u4e4b\u6697\u9762 Kimi \u5f00\u653e\u5e73\u53f0\u3002",
    },
  },
  {
    baseUrl: "https://api-inference.modelscope.cn/v1",
    credentialStyle: "api-key",
    envKey: "MODELSCOPE_API_KEY",
    id: "modelscope",
    name: "\u9b54\u642d ModelScope",
    note: {
      en: "Alibaba's ModelScope inference API.",
      zh: "\u9b54\u642d\u793e\u533a\u63a8\u7406 API\u3002",
    },
  },
  {
    baseUrl: "https://openrouter.ai/api/v1",
    credentialStyle: "api-key",
    envKey: "OPENROUTER_API_KEY",
    id: "openrouter",
    name: "OpenRouter",
    note: {
      en: "Aggregator fronting many vendors behind one key.",
      zh: "\u805a\u5408\u7f51\u5173\uff0c\u4e00\u4e2a\u5bc6\u94a5\u8f6c\u53d1\u591a\u5bb6\u6a21\u578b\u3002",
    },
  },
  {
    baseUrl: "https://api.x.ai/v1",
    credentialStyle: "api-key",
    defaultModel: "grok-4",
    envKey: "XAI_API_KEY",
    id: "xai",
    name: "xAI Grok",
    note: { en: "xAI.", zh: "xAI Grok \u5f00\u653e\u5e73\u53f0\u3002" },
  },
  {
    baseUrl: "http://127.0.0.1:11434/v1",
    credentialStyle: "none",
    id: "ollama",
    isBuiltIn: true,
    name: "Ollama",
    note: {
      en: "Model running on this machine. Nothing leaves the device.",
      zh: "\u672c\u673a\u8fd0\u884c\u7684\u6a21\u578b\uff0c\u6570\u636e\u4e0d\u51fa\u8bbe\u5907\u3002",
    },
  },
  {
    baseUrl: "http://127.0.0.1:1234/v1",
    credentialStyle: "none",
    id: "lmstudio",
    isBuiltIn: true,
    name: "LM Studio",
    note: {
      en: "Model running on this machine. Nothing leaves the device.",
      zh: "\u672c\u673a\u8fd0\u884c\u7684\u6a21\u578b\uff0c\u6570\u636e\u4e0d\u51fa\u8bbe\u5907\u3002",
    },
  },
  {
    credentialStyle: "api-key",
    id: CUSTOM_VENDOR_ID,
    name: "\u81ea\u5b9a\u4e49 / Custom",
    note: {
      en: "Any other Responses-compatible endpoint, such as a private gateway.",
      zh: "\u5176\u4ed6 Responses \u517c\u5bb9\u7aef\u70b9\uff0c\u4f8b\u5982\u81ea\u5efa\u7f51\u5173\u3002",
    },
  },
];

export function modelProviderVendor(
  vendorId: string,
): ModelProviderVendor | null {
  return MODEL_PROVIDER_VENDORS.find((v) => v.id === vendorId) ?? null;
}

export function vendorNote(
  vendor: ModelProviderVendor,
  locale: Locale,
): string {
  return locale === "zh" ? vendor.note.zh : vendor.note.en;
}

/**
 * Vendor whose base URL matches a configured provider, if any.
 *
 * Lets an existing entry be shown as "Qwen" rather than a bare URL. Matching is
 * on the URL because the provider id is user-chosen and may not be the vendor
 * id when several accounts of one vendor are configured.
 */
export function vendorForBaseUrl(baseUrl: string): ModelProviderVendor | null {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (!normalized) return null;
  return (
    MODEL_PROVIDER_VENDORS.find(
      (v) => v.baseUrl !== undefined && v.baseUrl === normalized,
    ) ?? null
  );
}
