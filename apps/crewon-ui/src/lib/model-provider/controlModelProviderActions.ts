import type { ControlApiClient } from "@crewon/control-client";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  modelProviderEntry,
  selectedModelProviderId,
} from "./modelProviderConfig";
import {
  MODEL_PROVIDER_ACTION_IDS,
  MODEL_PROVIDER_FIELD_IDS,
  modelProviderErrorPanel,
  modelProviderFormPanel,
  modelProviderListPanel,
  modelProviderLoadingPanel,
  parseModelProviderRowActionId,
} from "./modelProviderPanel";
import {
  modelProviderDraftError,
  type ModelProviderDraft,
} from "./modelProviderEdits";
import {
  providerCredentialStore,
  type ProviderCredentialCatalog,
  type ProviderCredentialStorePort,
} from "./providerCredentialStore";
import { CUSTOM_VENDOR_ID, modelProviderVendor } from "./modelProviderVendors";

export type ControlModelProviderAction =
  | "add"
  | "cancel"
  | "delete"
  | "edit"
  | "save"
  | "select"
  | "test";

type ControlModelProviderClient = Pick<
  ControlApiClient,
  "getModelProviderSettings" | "probeModelProvider"
>;

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((current: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

export type ControlModelProviderParams = {
  client: ControlModelProviderClient;
  credentialStore?: ProviderCredentialStorePort | null;
  fieldValue: (fieldId: string) => string;
  locale: Locale;
  setCapabilityPanel: SetCapabilityPanel;
};

function credentialStoreFor(
  params: ControlModelProviderParams,
): ProviderCredentialStorePort | null {
  return params.credentialStore === undefined
    ? providerCredentialStore()
    : params.credentialStore;
}

async function readCatalog(
  params: ControlModelProviderParams,
): Promise<ProviderCredentialCatalog> {
  const { settings } = await params.client.getModelProviderSettings();
  return {
    activeProviderId: settings.activeProviderId,
    bindings: settings.providers.map((provider) => ({
      credentialAvailable: true,
      credentialKind: provider.credentialKind,
      endpoint: provider.endpoint,
      environmentVariable: provider.environmentVariable,
      isActive: provider.isActive,
      providerId: provider.providerId,
    })),
  };
}

export function controlModelProviderActionForActionId(
  actionId: string,
): { action: ControlModelProviderAction; providerId: string | null } | null {
  const rowAction = parseModelProviderRowActionId(actionId);
  if (rowAction) return rowAction;
  switch (actionId) {
    case MODEL_PROVIDER_ACTION_IDS.add:
      return { action: "add", providerId: null };
    case MODEL_PROVIDER_ACTION_IDS.cancel:
      return { action: "cancel", providerId: null };
    case MODEL_PROVIDER_ACTION_IDS.save:
      return { action: "save", providerId: null };
    case MODEL_PROVIDER_ACTION_IDS.test:
      return { action: "test", providerId: null };
    default:
      return null;
  }
}

export async function refreshControlModelProvidersPanel(
  params: ControlModelProviderParams,
  probeText: string | null = null,
): Promise<void> {
  params.setCapabilityPanel(modelProviderLoadingPanel(params.locale));
  try {
    params.setCapabilityPanel(
      modelProviderListPanel({
        credentialCatalog: await readCatalog(params),
        configRead: null,
        cwd: null,
        locale: params.locale,
        probeText,
      }),
    );
  } catch (error) {
    params.setCapabilityPanel(modelProviderErrorPanel(error, params.locale));
  }
}

async function openForm(
  params: ControlModelProviderParams,
  providerId: string | null,
): Promise<void> {
  try {
    const catalog = providerId ? await readCatalog(params) : null;
    params.setCapabilityPanel(
      modelProviderFormPanel({
        allowAccountProvider: false,
        entry: providerId
          ? modelProviderEntry(null, providerId, catalog)
          : null,
        isSelected:
          providerId !== null &&
          selectedModelProviderId(null, catalog) === providerId,
        locale: params.locale,
      }),
    );
  } catch (error) {
    params.setCapabilityPanel(modelProviderErrorPanel(error, params.locale));
  }
}

function draftFromFields(
  params: ControlModelProviderParams,
): ModelProviderDraft {
  const credentialKind = params.fieldValue(
    MODEL_PROVIDER_FIELD_IDS.credentialKind,
  );
  const vendor = modelProviderVendor(
    params.fieldValue(MODEL_PROVIDER_FIELD_IDS.vendor),
  );
  const preset = vendor?.id === CUSTOM_VENDOR_ID ? null : vendor;
  return {
    apiKey: params.fieldValue(MODEL_PROVIDER_FIELD_IDS.apiKey),
    baseUrl:
      params.fieldValue(MODEL_PROVIDER_FIELD_IDS.baseUrl).trim() ||
      preset?.baseUrl ||
      "",
    credentialKind:
      credentialKind === "env-key" || credentialKind === "none"
        ? credentialKind
        : ("bearer-token" as const),
    envKey:
      params.fieldValue(MODEL_PROVIDER_FIELD_IDS.envKey).trim() ||
      preset?.envKey ||
      "",
    id:
      params.fieldValue(MODEL_PROVIDER_FIELD_IDS.id).trim() || preset?.id || "",
    name: params.fieldValue(MODEL_PROVIDER_FIELD_IDS.name),
    setAsDefault:
      params.fieldValue(MODEL_PROVIDER_FIELD_IDS.selected) === "true",
  };
}

function isSupportedBuiltInDraft(
  params: ControlModelProviderParams,
  draft: ReturnType<typeof draftFromFields>,
): boolean {
  const vendor = modelProviderVendor(
    params.fieldValue(MODEL_PROVIDER_FIELD_IDS.vendor),
  );
  return (
    vendor?.isBuiltIn === true &&
    vendor.baseUrl !== undefined &&
    draft.id === vendor.id &&
    draft.baseUrl === vendor.baseUrl
  );
}

function nativeStoreRequired(params: ControlModelProviderParams) {
  const store = credentialStoreFor(params);
  if (store === null) throw new Error("provider_credential_store_unavailable");
  return store;
}

async function save(
  params: ControlModelProviderParams,
  thenTest: boolean,
): Promise<void> {
  try {
    const store = nativeStoreRequired(params);
    const catalog = await readCatalog(params);
    const draft = draftFromFields(params);
    const existing = modelProviderEntry(null, draft.id, catalog);
    const validationError = modelProviderDraftError(draft, params.locale, {
      allowReservedId: isSupportedBuiltInDraft(params, draft),
      existingIds: [],
      hasStoredToken: existing?.hasStoredToken ?? false,
    });
    if (validationError) {
      params.setCapabilityPanel(
        modelProviderFormPanel({
          allowAccountProvider: false,
          entry: existing,
          error: validationError,
          isSelected: catalog.activeProviderId === draft.id,
          locale: params.locale,
        }),
      );
      return;
    }
    await store.upsert({
      activate: draft.setAsDefault || catalog.activeProviderId === draft.id,
      credentialKind:
        draft.credentialKind === "bearer-token"
          ? "keychain"
          : draft.credentialKind === "env-key"
            ? "environment"
            : "none",
      endpoint: draft.baseUrl.trim(),
      environmentVariable:
        draft.credentialKind === "env-key" ? draft.envKey.trim() : null,
      providerId: draft.id,
      secret:
        draft.credentialKind === "bearer-token" && draft.apiKey.length > 0
          ? draft.apiKey
          : null,
    });
    if (thenTest) {
      await probe(params, draft.id);
      return;
    }
    await refreshControlModelProvidersPanel(
      params,
      params.locale === "zh" ? `已保存 ${draft.id}` : `Saved ${draft.id}`,
    );
  } catch (error) {
    params.setCapabilityPanel(modelProviderErrorPanel(error, params.locale));
  }
}

async function probe(
  params: ControlModelProviderParams,
  providerId: string,
): Promise<void> {
  try {
    const catalog = await readCatalog(params);
    if (catalog.activeProviderId !== providerId) {
      throw new Error("model_provider_probe_requires_active_provider");
    }
    const result = await params.client.probeModelProvider(
      `settings.provider-probe:${crypto.randomUUID()}`,
    );
    if (result.providerId !== providerId) {
      throw new Error("model_provider_probe_binding_mismatch");
    }
    await refreshControlModelProvidersPanel(
      params,
      [
        result.status === "ok"
          ? params.locale === "zh"
            ? "连接成功"
            : "Connected"
          : `${params.locale === "zh" ? "连接结果" : "Result"}: ${result.status}`,
        `Provider: ${result.providerId}`,
        `${params.locale === "zh" ? "模型数" : "Models"}: ${result.modelCount ?? "-"}`,
        `${params.locale === "zh" ? "耗时" : "Latency"}: ${result.latencyMs}ms`,
      ].join("\n"),
    );
  } catch (error) {
    params.setCapabilityPanel(modelProviderErrorPanel(error, params.locale));
  }
}

async function remove(
  params: ControlModelProviderParams,
  providerId: string,
): Promise<void> {
  try {
    const store = nativeStoreRequired(params);
    const catalog = await readCatalog(params);
    const replacement =
      catalog.activeProviderId === providerId
        ? (catalog.bindings.find((entry) => entry.providerId !== providerId)
            ?.providerId ?? null)
        : undefined;
    if (replacement) await store.activate(replacement);
    await store.delete(providerId);
    await refreshControlModelProvidersPanel(
      params,
      params.locale === "zh" ? `已删除 ${providerId}` : `Deleted ${providerId}`,
    );
  } catch (error) {
    params.setCapabilityPanel(modelProviderErrorPanel(error, params.locale));
  }
}

async function select(
  params: ControlModelProviderParams,
  providerId: string,
): Promise<void> {
  try {
    await nativeStoreRequired(params).activate(providerId);
    await refreshControlModelProvidersPanel(
      params,
      params.locale === "zh"
        ? `已将 ${providerId} 设为默认 Provider`
        : `${providerId} is now the default provider`,
    );
  } catch (error) {
    params.setCapabilityPanel(modelProviderErrorPanel(error, params.locale));
  }
}

export function handleControlModelProviderAction(
  params: ControlModelProviderParams,
  action: ControlModelProviderAction,
  providerId: string | null,
): void {
  switch (action) {
    case "add":
      void openForm(params, null);
      return;
    case "edit":
      void openForm(params, providerId);
      return;
    case "cancel":
      void refreshControlModelProvidersPanel(params);
      return;
    case "save":
      void save(params, false);
      return;
    case "test":
      void (providerId ? probe(params, providerId) : save(params, true));
      return;
    case "delete":
      if (providerId) void remove(params, providerId);
      return;
    case "select":
      if (providerId) void select(params, providerId);
  }
}
