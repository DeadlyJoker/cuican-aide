/**
 * Actions for the model access settings page.
 *
 * Packaged desktop mutations commit through the native credential catalog and
 * supervised Worker replacement. Legacy config writes are non-secret,
 * best-effort compatibility only and never define desktop mutation success.
 */

import type { ConfigReadResponse } from "@crewon-protocol/v2/ConfigReadResponse";
import type { ModelProviderProbeResponse } from "@crewon-protocol/v2/ModelProviderProbeResponse";
import type { JsonValue } from "@crewon-protocol/serde_json/JsonValue";
import type { ControlApiClient } from "@crewon/control-client";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  modelProviderEntries,
  modelProviderEntry,
  selectedModelProviderId,
} from "./modelProviderConfig";
import {
  buildClearModelProviderSelectionEdits,
  buildModelProviderDeleteEdits,
  buildModelProviderEdits,
  buildSelectModelProviderEdits,
  modelProviderDraftError,
  type ModelProviderDraft,
} from "./modelProviderEdits";
import {
  MODEL_PROVIDER_ACTION_IDS,
  MODEL_PROVIDER_FIELD_IDS,
  modelProviderDisconnectedPanel,
  modelProviderErrorPanel,
  modelProviderFormPanel,
  modelProviderListPanel,
  modelProviderLoadingPanel,
  parseModelProviderRowActionId,
} from "./modelProviderPanel";
import { modelProviderProbeText } from "./modelProviderProbeText";
import { CUSTOM_VENDOR_ID, modelProviderVendor } from "./modelProviderVendors";
import {
  providerCredentialStore,
  type ProviderCredentialCatalog,
  type ProviderCredentialStorePort,
} from "./providerCredentialStore";

export type ModelProviderAction =
  | "add"
  | "cancel"
  | "delete"
  | "edit"
  | "save"
  | "select"
  | "test";

type ModelProviderClient = {
  probeModelProvider(providerId?: string): Promise<ModelProviderProbeResponse>;
  readConfig(cwd?: string | null): Promise<ConfigReadResponse>;
  writeConfigBatch(
    edits: Array<{
      keyPath: string;
      value: JsonValue;
      mergeStrategy?: "replace" | "upsert";
    }>,
  ): Promise<unknown>;
};

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

/**
 * What reading the panel needs.
 *
 * Split out from the full action params so the settings refresh path, which has
 * no panel form to read, does not have to supply a `fieldValue` accessor.
 */
export type ModelProviderRefreshParams = {
  client: ModelProviderClient | null | undefined;
  controlClient?: Pick<ControlApiClient, "getModelProviderSettings"> | null;
  /** Shown as the subtitle when disconnected; the action dispatcher has none. */
  connectionHint?: string;
  isConnected: boolean;
  locale: Locale;
  /** Injectable for deterministic tests; undefined resolves the desktop IPC store. */
  credentialStore?: ProviderCredentialStorePort | null;
  resolveBackendCwd: () => Promise<string | null | undefined>;
  setCapabilityPanel: SetCapabilityPanel;
};

export type ModelProviderActionParams = ModelProviderRefreshParams & {
  fieldValue: (fieldId: string) => string;
};

function credentialStoreFor(
  params: ModelProviderRefreshParams,
): ProviderCredentialStorePort | null {
  return params.credentialStore === undefined
    ? providerCredentialStore()
    : params.credentialStore;
}

async function readProviderState(params: ModelProviderRefreshParams): Promise<{
  catalog: ProviderCredentialCatalog | null;
  configRead: ConfigReadResponse | null;
  cwd: string | null;
}> {
  if (params.controlClient !== null && params.controlClient !== undefined) {
    const { settings } = await params.controlClient.getModelProviderSettings();
    return {
      catalog: {
        activeProviderId: settings.activeProviderId,
        bindings: settings.providers.map((provider) => ({
          credentialAvailable: true,
          credentialKind: provider.credentialKind,
          endpoint: provider.endpoint,
          environmentVariable: provider.environmentVariable,
          isActive: provider.isActive,
          providerId: provider.providerId,
        })),
      },
      configRead: null,
      cwd: null,
    };
  }
  const store = credentialStoreFor(params);
  const catalog = (await store?.catalog()) ?? null;
  if (store !== null) {
    return { catalog, configRead: null, cwd: null };
  }
  if (!params.client || !params.isConnected) {
    return { catalog, configRead: null, cwd: null };
  }
  try {
    const cwd = (await params.resolveBackendCwd()) ?? null;
    const configRead = await params.client.readConfig(cwd);
    return { catalog, configRead, cwd };
  } catch (error) {
    if (store === null) throw error;
    return { catalog, configRead: null, cwd: null };
  }
}

async function syncCompatibilityConfig(
  params: ModelProviderRefreshParams,
  edits: Parameters<ModelProviderClient["writeConfigBatch"]>[0],
): Promise<boolean> {
  if (!params.client || !params.isConnected) return false;
  try {
    await params.client.writeConfigBatch(edits);
    return true;
  } catch {
    return false;
  }
}

function compatibilityNotice(synchronized: boolean, locale: Locale): string {
  if (synchronized) return "";
  return locale === "zh"
    ? "旧 app-server 配置未同步；桌面运行时已按系统密钥库中的绑定生效。"
    : "Legacy app-server config was not synchronized; the desktop runtime is active from its OS credential binding.";
}

/** Resolves an action id, including the per-row ids that carry a provider. */
export function modelProviderActionForActionId(
  actionId: string,
): { action: ModelProviderAction; providerId: string | null } | null {
  const rowAction = parseModelProviderRowActionId(actionId);
  if (rowAction) {
    return { action: rowAction.action, providerId: rowAction.providerId };
  }
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

/** Reads the form into a draft. */
/**
 * The built-in vendor the form is pointed at, if any.
 *
 * Returns null once the user has typed their own base URL, because that is a
 * different endpoint than the built-in one even when the vendor stays selected.
 */
function builtInVendorFor(
  fieldValue: (fieldId: string) => string,
): { id: string } | null {
  const vendor = modelProviderVendor(
    fieldValue(MODEL_PROVIDER_FIELD_IDS.vendor),
  );
  if (vendor === null || vendor.isBuiltIn !== true) return null;
  const typedBaseUrl = fieldValue(MODEL_PROVIDER_FIELD_IDS.baseUrl).trim();
  if (typedBaseUrl && typedBaseUrl !== vendor.baseUrl) return null;
  return { id: vendor.id };
}

export function modelProviderDraftFromFields(
  fieldValue: (fieldId: string) => string,
): ModelProviderDraft {
  const credentialKind = fieldValue(MODEL_PROVIDER_FIELD_IDS.credentialKind);
  /*
   * A picked vendor supplies the fields the user left blank. Only blanks are
   * filled: anything typed wins, so a vendor preset never silently overwrites a
   * deliberate override such as a region-specific endpoint or a proxy in front
   * of the vendor.
   */
  const vendor = modelProviderVendor(
    fieldValue(MODEL_PROVIDER_FIELD_IDS.vendor),
  );
  const typedId = fieldValue(MODEL_PROVIDER_FIELD_IDS.id).trim();
  const typedBaseUrl = fieldValue(MODEL_PROVIDER_FIELD_IDS.baseUrl).trim();
  const typedEnvKey = fieldValue(MODEL_PROVIDER_FIELD_IDS.envKey).trim();
  const preset = vendor?.id === CUSTOM_VENDOR_ID ? null : vendor;

  return {
    id: typedId || preset?.id || "",
    name: fieldValue(MODEL_PROVIDER_FIELD_IDS.name),
    baseUrl: typedBaseUrl || preset?.baseUrl || "",
    credentialKind:
      credentialKind === "env-key" || credentialKind === "none"
        ? credentialKind
        : "bearer-token",
    envKey: typedEnvKey || preset?.envKey || "",
    apiKey: fieldValue(MODEL_PROVIDER_FIELD_IDS.apiKey),
    setAsDefault: fieldValue(MODEL_PROVIDER_FIELD_IDS.selected) === "true",
  };
}

export async function refreshModelProvidersPanelAction(
  params: ModelProviderRefreshParams,
  probeText: string | null = null,
) {
  const { connectionHint, isConnected, locale, setCapabilityPanel } = params;

  if (!isConnected && credentialStoreFor(params) === null) {
    setCapabilityPanel(
      modelProviderDisconnectedPanel(connectionHint ?? "", locale),
    );
    return;
  }

  setCapabilityPanel(modelProviderLoadingPanel(locale));

  try {
    const { catalog, configRead, cwd } = await readProviderState(params);
    setCapabilityPanel(
      modelProviderListPanel({
        credentialCatalog: catalog,
        configRead,
        cwd,
        locale,
        probeText,
      }),
    );
  } catch (error) {
    setCapabilityPanel(modelProviderErrorPanel(error, locale));
  }
}

async function openFormForProvider(
  params: ModelProviderRefreshParams,
  providerId: string | null,
) {
  const { locale, setCapabilityPanel } = params;

  if (!providerId) {
    setCapabilityPanel(
      modelProviderFormPanel({
        allowAccountProvider: credentialStoreFor(params) === null,
        entry: null,
        isSelected: false,
        locale,
      }),
    );
    return;
  }

  try {
    const { catalog, configRead } = await readProviderState(params);
    setCapabilityPanel(
      modelProviderFormPanel({
        allowAccountProvider: credentialStoreFor(params) === null,
        entry: modelProviderEntry(configRead, providerId, catalog),
        isSelected: selectedModelProviderId(configRead, catalog) === providerId,
        locale,
      }),
    );
  } catch (error) {
    setCapabilityPanel(modelProviderErrorPanel(error, locale));
  }
}

/** Saves the form, optionally probing the provider afterwards. */
async function saveDraft(
  params: ModelProviderActionParams,
  options: { thenTest: boolean },
) {
  const { client, fieldValue, isConnected, locale, setCapabilityPanel } =
    params;

  const store = credentialStoreFor(params);
  if (store === null && (!client || !isConnected)) {
    setCapabilityPanel((currentPanel) =>
      currentPanel
        ? {
            ...currentPanel,
            error:
              locale === "zh"
                ? "未连接本地 app-server"
                : "Local app-server is not connected",
          }
        : currentPanel,
    );
    return;
  }

  const draft = modelProviderDraftFromFields(fieldValue);
  /*
   * A built-in vendor is already defined by the backend, so "saving" it means
   * selecting it. Writing an entry under its id would be rejected as an attempt
   * to override a reserved provider, and would be redundant even if allowed.
   */
  const builtInVendor = builtInVendorFor(fieldValue);
  if (
    builtInVendor !== null &&
    modelProviderVendor(builtInVendor.id)?.baseUrl === undefined
  ) {
    await selectProvider(params, builtInVendor.id, /*activateRuntime*/ false);
    return;
  }

  try {
    const { catalog, configRead } = await readProviderState(params);
    const providerId = builtInVendor?.id ?? draft.id.trim();
    const effectiveDraft = { ...draft, id: providerId };
    const existing = modelProviderEntry(configRead, providerId, catalog);
    /*
     * Only a genuinely new id is checked for collision. Editing an existing
     * provider legitimately writes to the id that already exists.
     */
    const validationError = modelProviderDraftError(effectiveDraft, locale, {
      allowReservedId: builtInVendor !== null,
      existingIds: [],
      hasStoredToken: existing?.hasStoredToken ?? false,
    });
    if (validationError) {
      setCapabilityPanel(
        modelProviderFormPanel({
          allowAccountProvider: store === null,
          entry: existing,
          error: validationError,
          isSelected:
            selectedModelProviderId(configRead, catalog) === providerId,
          locale,
        }),
      );
      return;
    }

    if (store === null && effectiveDraft.credentialKind === "bearer-token") {
      throw new Error("provider_credential_store_unavailable");
    }
    if (store !== null) {
      await store.upsert({
        activate:
          effectiveDraft.setAsDefault ||
          catalog?.activeProviderId === providerId,
        credentialKind:
          effectiveDraft.credentialKind === "bearer-token"
            ? "keychain"
            : effectiveDraft.credentialKind === "env-key"
              ? "environment"
              : "none",
        endpoint: effectiveDraft.baseUrl.trim(),
        environmentVariable:
          effectiveDraft.credentialKind === "env-key"
            ? effectiveDraft.envKey.trim()
            : null,
        providerId,
        secret:
          effectiveDraft.credentialKind === "bearer-token" &&
          effectiveDraft.apiKey.length > 0
            ? effectiveDraft.apiKey
            : null,
      });
    }
    const compatibilitySynchronized =
      builtInVendor === null
        ? await syncCompatibilityConfig(
            params,
            buildModelProviderEdits(effectiveDraft),
          )
        : effectiveDraft.setAsDefault
          ? await syncCompatibilityConfig(
              params,
              buildSelectModelProviderEdits(providerId),
            )
          : true;
    const notice = compatibilityNotice(compatibilitySynchronized, locale);

    if (!options.thenTest) {
      await refreshModelProvidersPanelAction(
        params,
        locale === "zh"
          ? [`已保存 ${providerId}`, notice].filter(Boolean).join("\n")
          : [`Saved ${providerId}`, notice].filter(Boolean).join("\n"),
      );
      return;
    }

    await probeProvider(params, providerId);
  } catch (error) {
    setCapabilityPanel(modelProviderErrorPanel(error, locale));
  }
}

/**
 * Probes a provider and shows the result on the list.
 *
 * The packaged runtime does not yet expose a dedicated probe. Desktop actions
 * therefore report probe unavailability rather than using the legacy runtime
 * as evidence for the new Worker.
 */
async function probeProvider(
  params: ModelProviderRefreshParams,
  providerId: string,
) {
  const { client, locale, setCapabilityPanel } = params;

  if (credentialStoreFor(params) !== null) {
    await refreshModelProvidersPanelAction(
      params,
      locale === "zh"
        ? `已保存 ${providerId}。当前桌面运行时尚未提供独立连接探针；请用下一次真实任务验证，旧运行时探针不作为结果。`
        : `${providerId} is saved. The desktop runtime does not yet expose a dedicated connection probe; verify with the next real task. The legacy runtime probe is not used as evidence.`,
    );
    return;
  }

  setCapabilityPanel((currentPanel) =>
    currentPanel
      ? {
          ...currentPanel,
          body:
            locale === "zh"
              ? `正在测试 ${providerId} 的连接...`
              : `Testing the connection to ${providerId}...`,
          error: undefined,
        }
      : currentPanel,
  );

  try {
    const probe = await client?.probeModelProvider(providerId);
    await refreshModelProvidersPanelAction(
      params,
      probe ? modelProviderProbeText(probe, locale) : null,
    );
  } catch (error) {
    /*
     * A failed probe request is not a failed save. The list is reloaded so the
     * saved provider is still visible, with the request error alongside it.
     */
    await refreshModelProvidersPanelAction(
      params,
      [
        locale === "zh"
          ? "连接测试未能完成"
          : "Connection test did not complete",
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
    );
  }
}

/**
 * Deletes a provider, moving the default off it first when it is in use.
 *
 * Leaving `model_provider` pointing at a removed entry makes the backend fail
 * to resolve config at all, so every later `config/read` errors and the user
 * cannot reach the page that would let them recover.
 */
async function deleteProvider(
  params: ModelProviderRefreshParams,
  providerId: string,
) {
  const { locale, setCapabilityPanel } = params;
  try {
    const { catalog, configRead } = await readProviderState(params);
    const entries = modelProviderEntries(configRead, catalog);
    const selectedId = selectedModelProviderId(configRead, catalog);
    const replacement =
      selectedId === providerId
        ? (entries.find((entry) => entry.id !== providerId)?.id ?? null)
        : undefined;

    const store = credentialStoreFor(params);
    const hasBinding =
      catalog?.bindings.some((binding) => binding.providerId === providerId) ??
      false;
    if (store !== null && hasBinding) {
      if (replacement !== undefined && replacement !== null) {
        await store.activate(replacement);
      }
      await store.delete(providerId);
    }

    const compatibilitySynchronized = await syncCompatibilityConfig(params, [
      ...buildModelProviderDeleteEdits(providerId),
      ...(replacement === undefined
        ? []
        : replacement === null
          ? buildClearModelProviderSelectionEdits()
          : buildSelectModelProviderEdits(replacement)),
    ]);

    await refreshModelProvidersPanelAction(
      params,
      [
        deletedProviderText(providerId, replacement, locale),
        compatibilityNotice(compatibilitySynchronized, locale),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (error) {
    setCapabilityPanel(modelProviderErrorPanel(error, locale));
  }
}

function deletedProviderText(
  providerId: string,
  replacement: string | null | undefined,
  locale: Locale,
): string {
  const deleted =
    locale === "zh" ? `已删除 ${providerId}` : `Deleted ${providerId}`;
  if (replacement === undefined) {
    return deleted;
  }
  if (replacement === null) {
    return [
      deleted,
      locale === "zh"
        ? "它是当前使用的 Provider，已清除默认设置。请新增一个模型服务后再继续。"
        : "It was the provider in use, so the default is now unset. Add a model service before continuing.",
    ].join("\n");
  }
  return [
    deleted,
    locale === "zh"
      ? `它是当前使用的 Provider，已改用 ${replacement}。`
      : `It was the provider in use, so ${replacement} is now the default.`,
  ].join("\n");
}

async function selectProvider(
  params: ModelProviderRefreshParams,
  providerId: string,
  activateRuntime = true,
) {
  const { client, locale, setCapabilityPanel } = params;
  try {
    const store = credentialStoreFor(params);
    if (!activateRuntime && store !== null) {
      throw new Error("model_provider_account_runtime_unavailable");
    }
    if (!activateRuntime && (!client || !params.isConnected)) {
      throw new Error("model_provider_account_runtime_unavailable");
    }
    if (store !== null && activateRuntime) {
      await store.activate(providerId);
    }
    const compatibilitySynchronized = await syncCompatibilityConfig(
      params,
      buildSelectModelProviderEdits(providerId),
    );
    await refreshModelProvidersPanelAction(
      params,
      locale === "zh"
        ? [
            `已将 ${providerId} 设为默认 Provider`,
            compatibilityNotice(compatibilitySynchronized, locale),
          ]
            .filter(Boolean)
            .join("\n")
        : [
            `${providerId} is now the default provider`,
            compatibilityNotice(compatibilitySynchronized, locale),
          ]
            .filter(Boolean)
            .join("\n"),
    );
  } catch (error) {
    setCapabilityPanel(modelProviderErrorPanel(error, locale));
  }
}

export function handleModelProviderAction(
  params: ModelProviderActionParams,
  action: ModelProviderAction,
  providerId: string | null,
): void {
  switch (action) {
    case "add":
      void openFormForProvider(params, /*providerId*/ null);
      return;
    case "edit":
      void openFormForProvider(params, providerId);
      return;
    case "cancel":
      void refreshModelProvidersPanelAction(params);
      return;
    case "save":
      void saveDraft(params, { thenTest: false });
      return;
    case "test":
      /*
       * From a row the provider is already saved, so it is probed directly.
       * From the form there is no id yet in the panel, so the draft is saved
       * first and the stored entry is what gets probed.
       */
      if (providerId) {
        void probeProvider(params, providerId);
      } else {
        void saveDraft(params, { thenTest: true });
      }
      return;
    case "delete":
      if (providerId) {
        void deleteProvider(params, providerId);
      }
      return;
    case "select":
      if (providerId) {
        void selectProvider(params, providerId);
      }
      return;
  }
}
