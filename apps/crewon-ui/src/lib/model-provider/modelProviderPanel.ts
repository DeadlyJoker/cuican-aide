/**
 * Panels for the model access settings page.
 *
 * The page has two shapes: a list of configured providers, and a form for the
 * one being added or edited. Both are built here so the refresh action stays
 * focused on fetching.
 */

import type { ConfigReadResponse } from "@crewon/app-server-protocol/v2/ConfigReadResponse";
import type { ModelProviderSettingsSnapshot } from "@crewon/contracts";

import type {
  CapabilityPanel,
  CapabilityPanelAction,
} from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  modelProviderEntries,
  selectedModelProviderId,
  type ModelProviderEntry,
} from "./modelProviderConfig";
import {
  CUSTOM_VENDOR_ID,
  MODEL_PROVIDER_VENDORS,
  vendorForBaseUrl,
  vendorNote,
} from "./modelProviderVendors";
import type { ProviderCredentialCatalog } from "./providerCredentialStore";

export const MODEL_PROVIDER_FIELD_IDS = {
  apiKey: "model-provider-api-key",
  baseUrl: "model-provider-base-url",
  credentialKind: "model-provider-credential-kind",
  envKey: "model-provider-env-key",
  id: "model-provider-id",
  modelId: "model-provider-model-id",
  name: "model-provider-name",
  selected: "model-provider-selected",
  vendor: "model-provider-vendor",
} as const;

export const MODEL_PROVIDER_ACTION_IDS = {
  add: "model-provider-add",
  cancel: "model-provider-cancel",
  delete: "model-provider-delete",
  edit: "model-provider-edit",
  refresh: "refresh-model-providers",
  save: "model-provider-save",
  test: "model-provider-test",
} as const;

function panelTitle(locale: Locale): string {
  return locale === "zh" ? "模型接入" : "Model access";
}

function runtimeAvailabilityLabel(
  value: ModelProviderSettingsSnapshot["runtimeAvailability"],
  locale: Locale,
): string {
  if (locale !== "zh") {
    return {
      available: "Available",
      unconfigured: "Not configured",
      switchPending: "Switch pending",
      unavailable: "Unavailable",
    }[value];
  }
  return {
    available: "可用",
    unconfigured: "未配置",
    switchPending: "切换中",
    unavailable: "不可用",
  }[value];
}

function credentialKindLabel(
  entry: ModelProviderEntry,
  locale: Locale,
): string {
  switch (entry.credentialKind) {
    case "bearer-token":
      return entry.hasStoredToken
        ? locale === "zh"
          ? "已保存密钥"
          : "key stored"
        : locale === "zh"
          ? "系统密钥库凭据（状态未公开）"
          : "OS credential (availability not exposed)";
    case "env-key":
      return locale === "zh"
        ? `环境变量 ${entry.envKey}`
        : `env var ${entry.envKey}`;
    case "none":
      return locale === "zh" ? "无需密钥" : "no credential";
  }
}

/**
 * Encodes which provider a row action targets.
 *
 * Rows render actions grouped per provider, but the dispatcher resolves a bare
 * action id, so the target still travels in the id.
 */
export function modelProviderRowActionId(
  action: "delete" | "edit" | "select" | "test",
  providerId: string,
): string {
  return `model-provider-${action}:${providerId}`;
}

export function parseModelProviderRowActionId(actionId: string): {
  action: "delete" | "edit" | "select" | "test";
  providerId: string;
} | null {
  const match = /^model-provider-(delete|edit|select|test):(.+)$/u.exec(
    actionId,
  );
  if (!match) {
    return null;
  }
  const [, action, providerId] = match;
  return {
    action: action as "delete" | "edit" | "select" | "test",
    providerId,
  };
}

export function modelProviderDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: panelTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "Provider Control API 当前不可用"
        : "Provider Control API is unavailable",
  };
}

export function modelProviderLoadingPanel(locale: Locale): CapabilityPanel {
  return {
    title: panelTitle(locale),
    body:
      locale === "zh"
        ? "正在读取模型接入配置..."
        : "Reading model access configuration...",
  };
}

/** Body text for the list view: status, empty hint, and notes. The providers
 * themselves render as structured rows (`panel.rows`), not text bullets. */
function modelProviderListBody(params: {
  entries: ModelProviderEntry[];
  locale: Locale;
  mutationAvailable: boolean;
  probeText: string | null;
}): string {
  const { entries, locale, mutationAvailable, probeText } = params;
  const sections: string[] = [];

  if (entries.length === 0) {
    sections.push(
      locale === "zh"
        ? "还没有配置任何模型服务。点击下方“新增 Provider”填写服务地址和密钥。"
        : "No model service is configured yet. Use \u201cAdd provider\u201d below to enter an address and credential.",
    );
  }

  if (probeText) {
    sections.push(probeText);
  }

  /* Security and protocol boundaries are stated before the user saves. */
  sections.push(
    [
      locale === "zh" ? "说明" : "Notes",
      locale === "zh"
        ? "- 推荐使用开源 LiteLLM Gateway：由 LiteLLM 适配 OpenAI、Anthropic、Gemini、Bedrock、DeepSeek 等主流厂商和本地模型；CrewON 不复制各厂商协议。"
        : "- LiteLLM Gateway is recommended. LiteLLM adapts OpenAI, Anthropic, Gemini, Bedrock, DeepSeek, and other major vendors or local models; CrewON does not duplicate vendor protocols.",
      locale === "zh"
        ? "- CrewON 调用 Responses 接口；只有原生支持 Responses 的服务才能直连，其他模型应由 LiteLLM 的 Responses bridge 转换。"
        : "- CrewON calls the Responses API. Connect directly only when the service supports Responses; route other models through LiteLLM's Responses bridge.",
      ...(mutationAvailable
        ? [
            locale === "zh"
              ? "- 直接填写的 API Key 只保存在系统密钥库：macOS Keychain、Windows Credential Manager 或 Linux Secret Service；桌面 catalog 只保存 Provider ID 与地址。"
              : "- An API key entered here is stored only in the OS credential store: macOS Keychain, Windows Credential Manager, or Linux Secret Service. The desktop catalog stores only provider identity and endpoint.",
            locale === "zh"
              ? "- 保存或切换后会在无活动任务时受监督重启 Worker；有任务运行时会拒绝切换，不会中断任务。"
              : "- Saving or switching performs a supervised Worker restart only while no task is active; an active task rejects the switch instead of being interrupted.",
          ]
        : [
            locale === "zh"
              ? "- 此只读视图不接收 API Key，也不会把 Team 环境标记为已具备 Provider 切换能力。"
              : "- This read-only view never accepts an API key or presents Team Provider switching as available.",
          ]),
    ].join("\n"),
  );

  return sections.join("\n\n");
}

export function modelProviderListPanel(params: {
  configRead?: ConfigReadResponse | null;
  settings?: ModelProviderSettingsSnapshot | null;
  credentialCatalog?: ProviderCredentialCatalog | null;
  cwd: string | null;
  locale: Locale;
  mutationAvailable?: boolean;
  probeAvailable?: boolean;
  probeText?: string | null;
}): CapabilityPanel {
  const {
    configRead = null,
    settings = null,
    credentialCatalog = null,
    cwd,
    locale,
    mutationAvailable = credentialCatalog !== null,
    probeAvailable = settings?.runtimeAvailability === "available",
    probeText = null,
  } = params;
  const authority = settings ?? configRead;
  const entries = modelProviderEntries(authority, credentialCatalog);
  const selectedId = selectedModelProviderId(authority, credentialCatalog);
  const availability = settings?.runtimeAvailability ?? null;

  const rowLabels =
    locale === "zh"
      ? { test: "测试", edit: "编辑", use: "设为默认", remove: "删除" }
      : { test: "Test", edit: "Edit", use: "Set as default", remove: "Delete" };

  return {
    title: panelTitle(locale),
    subtitle:
      cwd ||
      (credentialCatalog !== null
        ? locale === "zh"
          ? "桌面凭据 catalog"
          : "Desktop credential catalog"
        : locale === "zh"
          ? "全局配置"
          : "Global config"),
    body: [
      availability === null
        ? null
        : locale === "zh"
          ? `运行状态: ${runtimeAvailabilityLabel(availability, locale)}`
          : `Runtime: ${runtimeAvailabilityLabel(availability, locale)}`,
      modelProviderListBody({
        entries,
        locale,
        mutationAvailable,
        probeText,
      }),
    ]
      .filter(Boolean)
      .join("\n\n"),
    rows: entries.map((entry) => {
      const vendor = vendorForBaseUrl(entry.baseUrl);
      const rowActions: CapabilityPanelAction[] = [];
      if (probeAvailable && entry.id === selectedId) {
        rowActions.push({
          id: modelProviderRowActionId("test", entry.id),
          label: rowLabels.test,
        });
      }
      if (mutationAvailable) {
        rowActions.push({
          id: modelProviderRowActionId("edit", entry.id),
          label: rowLabels.edit,
        });
        if (entry.id !== selectedId) {
          rowActions.push({
            id: modelProviderRowActionId("select", entry.id),
            label: rowLabels.use,
          });
        }
        rowActions.push({
          id: modelProviderRowActionId("delete", entry.id),
          label: rowLabels.remove,
          tone: "danger",
        });
      }
      return {
        id: entry.id,
        title: entry.name,
        subtitle: entry.baseUrl,
        meta: [
          vendor?.name ?? null,
          entry.modelId
            ? locale === "zh"
              ? `模型 ${entry.modelId}`
              : `model ${entry.modelId}`
            : null,
          credentialKindLabel(entry, locale),
        ].filter((fact): fact is string => fact !== null),
        badge:
          entry.id === selectedId
            ? locale === "zh"
              ? "当前使用"
              : "In use"
            : undefined,
        actions: rowActions,
      };
    }),
    actions: [
      ...(mutationAvailable
        ? [
            {
              id: MODEL_PROVIDER_ACTION_IDS.add,
              label: locale === "zh" ? "新增 Provider" : "Add provider",
              tone: "primary" as const,
            },
          ]
        : []),
      {
        id: MODEL_PROVIDER_ACTION_IDS.refresh,
        label: locale === "zh" ? "刷新" : "Refresh",
      },
    ],
  };
}

/**
 * Vendor choices, each labelled with its own caveat.
 *
 * The note rides in the label because the renderer draws a bare select with no
 * per-option description, and the tradeoff (needs a key, runs locally, uses the
 * Crewon account) is the whole basis for choosing.
 */
/**
 * Which vendor an existing entry came from.
 *
 * Recovered from the base URL rather than stored, so entries written before the
 * vendor catalog existed still resolve. An unrecognized URL is a custom one.
 */
function vendorValue(
  entry: ModelProviderEntry | null,
  vendors: typeof MODEL_PROVIDER_VENDORS,
): string {
  if (entry === null) return vendors[0]?.id ?? CUSTOM_VENDOR_ID;
  return vendorForBaseUrl(entry.baseUrl)?.id ?? CUSTOM_VENDOR_ID;
}

function vendorOptions(locale: Locale, vendors: typeof MODEL_PROVIDER_VENDORS) {
  return vendors.map((vendor) => ({
    label: `${vendor.name} — ${vendorNote(vendor, locale)}`,
    value: vendor.id,
  }));
}

function credentialKindOptions(locale: Locale) {
  return locale === "zh"
    ? [
        { label: "保存到系统密钥库", value: "bearer-token" },
        { label: "使用环境变量（不保存密钥）", value: "env-key" },
        { label: "无需密钥（如本地模型）", value: "none" },
      ]
    : [
        {
          label: "Store an API key in the OS credential store",
          value: "bearer-token",
        },
        { label: "Read from an environment variable", value: "env-key" },
        { label: "No credential (e.g. a local model)", value: "none" },
      ];
}

/**
 * Form for adding or editing one provider.
 *
 * `entry` is null when adding. When editing, the id is shown but not editable:
 * renaming it would mean writing a new table entry and deleting the old one,
 * which is a move rather than an edit.
 */
export function modelProviderFormPanel(params: {
  allowAccountProvider?: boolean;
  entry: ModelProviderEntry | null;
  error?: string | null;
  isSelected: boolean;
  locale: Locale;
}): CapabilityPanel {
  const {
    allowAccountProvider = true,
    entry,
    error = null,
    isSelected,
    locale,
  } = params;
  const isEditing = entry !== null;
  const vendors = allowAccountProvider
    ? MODEL_PROVIDER_VENDORS
    : MODEL_PROVIDER_VENDORS.filter(
        (vendor) => vendor.credentialStyle !== "crewon-account",
      );

  return {
    title: panelTitle(locale),
    subtitle: isEditing
      ? locale === "zh"
        ? `编辑 ${entry.id}`
        : `Edit ${entry.id}`
      : locale === "zh"
        ? "新增 Provider"
        : "Add provider",
    error: error ?? undefined,
    fields: [
      {
        id: MODEL_PROVIDER_FIELD_IDS.vendor,
        label: locale === "zh" ? "供应商" : "Vendor",
        description:
          locale === "zh"
            ? "选择供应商会自动填入 Base URL；选「自定义」则手动填写。"
            : "Picking a vendor fills in its base URL; choose Custom to enter one by hand.",
        options: vendorOptions(locale, vendors),
        value: vendorValue(entry, vendors),
      },
      {
        id: MODEL_PROVIDER_FIELD_IDS.id,
        label: "Provider ID",
        description: isEditing
          ? locale === "zh"
            ? "已存在的 Provider ID 不可修改。"
            : "The ID of an existing provider cannot be changed."
          : locale === "zh"
            ? "配置中的唯一标识，小写字母、数字、连字符或下划线。例如 my-gateway。"
            : "Unique key in config: lowercase letters, digits, hyphens, or underscores. For example my-gateway.",
        placeholder: "my-gateway",
        value: entry?.id ?? "",
      },
      {
        id: MODEL_PROVIDER_FIELD_IDS.name,
        label: locale === "zh" ? "显示名称" : "Display name",
        description:
          locale === "zh"
            ? "留空则使用 Provider ID。"
            : "Defaults to the provider ID when left blank.",
        placeholder: locale === "zh" ? "我的模型网关" : "My model gateway",
        value: entry?.name ?? "",
      },
      {
        id: MODEL_PROVIDER_FIELD_IDS.baseUrl,
        label: "Base URL",
        description:
          locale === "zh"
            ? "Responses 兼容接口的完整地址，通常以 /v1 结尾。"
            : "Full address of a Responses-compatible API, usually ending in /v1.",
        placeholder: "https://api.example.com/v1",
        value: entry?.baseUrl ?? "",
      },
      {
        id: MODEL_PROVIDER_FIELD_IDS.modelId,
        label:
          locale === "zh"
            ? "模型 ID / LiteLLM 模型别名"
            : "Model ID / LiteLLM model alias",
        description:
          locale === "zh"
            ? "发送给 Provider 的模型名。使用 LiteLLM 时填写 config.yaml 中的 model_name，例如 claude-sonnet 或 deepseek-coder。"
            : "Model name sent to the provider. For LiteLLM, use the model_name from config.yaml, such as claude-sonnet or deepseek-coder.",
        placeholder: "claude-sonnet",
        value: entry?.modelId ?? "",
      },
      {
        id: MODEL_PROVIDER_FIELD_IDS.credentialKind,
        label: locale === "zh" ? "鉴权方式" : "Credential",
        options: credentialKindOptions(locale),
        value: entry?.credentialKind ?? "bearer-token",
      },
      {
        id: MODEL_PROVIDER_FIELD_IDS.apiKey,
        label: "API Key",
        description: entry?.hasStoredToken
          ? locale === "zh"
            ? "已保存密钥。留空则保持不变；填写则覆盖。"
            : "A key is already stored. Leave blank to keep it, or type a new one to replace it."
          : locale === "zh"
            ? "只写入系统密钥库，不写入 config.toml、SQLite 或浏览器存储。"
            : "Stored only in the OS credential store, never config.toml, SQLite, or browser storage.",
        placeholder: entry?.hasStoredToken
          ? locale === "zh"
            ? "保持现有密钥"
            : "Keep the stored key"
          : "sk-...",
        secret: true,
        value: "",
      },
      {
        id: MODEL_PROVIDER_FIELD_IDS.envKey,
        label: locale === "zh" ? "环境变量名" : "Environment variable",
        description:
          locale === "zh"
            ? "仅在选择环境变量方式时使用。该变量需存在于桌面宿主进程环境中，宿主只在启动 Worker 时读取并注入内存。"
            : "Used only with the environment-variable option. It must exist in the desktop host environment and is read only when the host starts the Worker.",
        placeholder: "MY_GATEWAY_API_KEY",
        value: entry?.envKey ?? "",
      },
      {
        id: MODEL_PROVIDER_FIELD_IDS.selected,
        label:
          locale === "zh" ? "设为默认 Provider" : "Use as default provider",
        control: "toggle",
        value: String(isSelected || !isEditing),
      },
    ],
    actions: [
      {
        id: MODEL_PROVIDER_ACTION_IDS.save,
        label: locale === "zh" ? "保存" : "Save",
        tone: "primary",
      },
      {
        id: MODEL_PROVIDER_ACTION_IDS.test,
        label: locale === "zh" ? "保存并测试连接" : "Save and test connection",
      },
      {
        id: MODEL_PROVIDER_ACTION_IDS.cancel,
        label: locale === "zh" ? "取消" : "Cancel",
      },
    ],
  };
}

/**
 * Readable copy for the error codes the control runtime actually throws.
 * The raw code stays appended after "·" so support can still identify it.
 */
function providerErrorCopy(code: string, locale: Locale): string {
  const copy = (zh: string, en: string) =>
    `${locale === "zh" ? zh : en} · ${code}`;
  switch (code) {
    case "session_invalid":
    case "control_runtime_session_invalid":
      return copy(
        "登录会话已失效，请重新登录后再试",
        "The sign-in session has expired. Sign in again and retry",
      );
    case "control_runtime_session_unavailable":
    case "control_runtime_bootstrap_timeout":
      return copy(
        "本地控制服务暂时不可用，请稍后重试",
        "The local control service is unavailable. Retry in a moment",
      );
    case "model_provider_control_unavailable":
      return copy(
        "Provider 控制服务不可用",
        "The Provider control service is unavailable",
      );
    default:
      return copy(
        "读取模型接入配置失败",
        "Unable to read model access configuration",
      );
  }
}

export function modelProviderErrorPanel(
  error: unknown,
  locale: Locale,
): CapabilityPanel {
  const code = error instanceof Error ? error.message : "";
  return {
    title: panelTitle(locale),
    error: code
      ? providerErrorCopy(code, locale)
      : locale === "zh"
        ? "读取模型接入配置失败"
        : "Unable to read model access configuration",
    actions: [
      {
        id: MODEL_PROVIDER_ACTION_IDS.refresh,
        label: locale === "zh" ? "重试" : "Retry",
      },
    ],
  };
}
