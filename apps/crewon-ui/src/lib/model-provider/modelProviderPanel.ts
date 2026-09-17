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
  fetchModels: "model-provider-fetch-models",
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

  if (!mutationAvailable) {
    sections.push(
      locale === "zh"
        ? "当前网页版不支持添加或修改模型服务。\n\n如需配置桌面端，请打开「设置 → AI 模型 → 添加模型」。桌面端配置不会自动应用到当前网页版。"
        : "Adding or editing model services is not supported on this web page.\n\nIn the desktop app, go to Settings → AI models → Add model. Desktop changes do not automatically apply to this web service.",
    );
  } else if (entries.length === 0) {
    sections.push(
      locale === "zh"
        ? "尚未添加模型服务。点击“添加模型”填写服务地址和密钥。"
        : "No model service added yet. Choose Add model to enter an address and access key.",
    );
  }

  if (probeText) {
    sections.push(probeText);
  }
  sections.push(
    locale === "zh"
      ? mutationAvailable
        ? "请等正在运行的任务结束后，再保存或切换模型来源。"
        : ""
      : mutationAvailable
        ? "Wait for running tasks to finish before saving or switching model sources."
        : "",
  );
  return sections.filter(Boolean).join("\n\n");
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
  defaultTaskModel?: string | null;
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
    defaultTaskModel = null,
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
      availability === null || (!mutationAvailable && entries.length === 0)
        ? null
        : locale === "zh"
          ? `模型来源状态: ${runtimeAvailabilityLabel(availability, locale)}`
          : `Model source status: ${runtimeAvailabilityLabel(availability, locale)}`,
      modelProviderListBody({
        entries,
        locale,
        mutationAvailable,
        probeText,
      }),
    ]
      .filter(Boolean)
      .join("\n\n"),
    rows: [
      ...(defaultTaskModel === null
        ? []
        : [
            {
              id: "runtime:default-task-model",
              title: locale === "zh" ? "默认任务模型" : "Default task model",
              subtitle: defaultTaskModel,
            },
          ]),
      ...entries.map((entry) => {
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
    ],
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

function modelListDescription(count: number, locale: Locale): string {
  return locale === "zh"
    ? `来自该 Provider /models 接口的 ${count} 个可用模型。列表之外的名字仍可手动保留。`
    : `${count} models advertised by this provider's /models API. Names outside the list can still be kept.`;
}

/** Select options for the model field, keeping the current value selectable. */
export function modelFieldOptions(
  models: readonly string[],
  currentValue: string,
): Array<{ label: string; value: string }> {
  const values =
    currentValue.length > 0 && !models.includes(currentValue)
      ? [currentValue, ...models]
      : [...models];
  return values.map((value) => ({ label: value, value }));
}

/**
 * Merges fetched models into a rendered form panel's model field.
 *
 * Applies in place so concurrent edits in other fields survive; an empty list
 * leaves the text input untouched (the caller surfaces the fetch failure).
 */
export function applyModelOptionsToPanel(
  panel: CapabilityPanel | null,
  models: readonly string[],
  locale: Locale,
): CapabilityPanel | null {
  if (panel === null || models.length === 0) return panel;
  return {
    ...panel,
    fields: panel.fields?.map((field) =>
      field.id === MODEL_PROVIDER_FIELD_IDS.modelId
        ? {
            ...field,
            description: modelListDescription(models.length, locale),
            options: modelFieldOptions(
              models,
              field.value.trim().length > 0 ? field.value : models[0],
            ),
            value: field.value.trim().length > 0 ? field.value : models[0],
          }
        : field,
    ),
  };
}

/**
 * Form for adding or editing one provider.
 *
 * `entry` is null when adding. When editing, the id is shown but not editable:
 * renaming it would mean writing a new table entry and deleting the old one,
 * which is a move rather than an edit.
 *
 * A provider is not one model: when `modelOptions` is non-empty the model field
 * becomes a select over the models the provider advertises, with the current
 * value kept selectable even when it is not advertised.
 */
export function modelProviderFormPanel(params: {
  allowAccountProvider?: boolean;
  entry: ModelProviderEntry | null;
  error?: string | null;
  isSelected: boolean;
  locale: Locale;
  modelOptions?: readonly string[];
}): CapabilityPanel {
  const {
    allowAccountProvider = true,
    entry,
    error = null,
    isSelected,
    locale,
    modelOptions = [],
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
          modelOptions.length > 0
            ? modelListDescription(modelOptions.length, locale)
            : locale === "zh"
              ? "发送给 Provider 的模型名。可点击「获取模型列表」查询该 Provider 实际可用的模型；使用 LiteLLM 时也支持 config.yaml 中的 model_name。"
              : "Model name sent to the provider. Use \u201cFetch model list\u201d to query the models this provider actually advertises; LiteLLM model_name aliases are also accepted.",
        placeholder: "claude-sonnet",
        value: entry?.modelId ?? "",
        ...(modelOptions.length > 0
          ? {
              options: modelFieldOptions(
                modelOptions,
                entry?.modelId || modelOptions[0],
              ),
              value: entry?.modelId || modelOptions[0],
            }
          : {}),
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
        id: MODEL_PROVIDER_ACTION_IDS.fetchModels,
        label: locale === "zh" ? "获取模型列表" : "Fetch model list",
      },
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
