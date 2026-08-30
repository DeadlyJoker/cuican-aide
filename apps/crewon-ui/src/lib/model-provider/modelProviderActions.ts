/** Final Provider settings actions: public Control reads/probes and native-only mutations. */

import {
  ControlApiClientError,
  ControlApiProtocolError,
  type ControlApiClient,
} from "@crewon/control-client";
import type { ModelProviderSettingsSnapshot } from "@crewon/contracts";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  modelProviderEntries,
  modelProviderEntry,
  selectedModelProviderId,
} from "./modelProviderConfig";
import {
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
import {
  modelProviderProbeSucceeded,
  modelProviderProbeText,
} from "./modelProviderProbeText";
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

type ProviderControlClient = Pick<
  ControlApiClient,
  "getModelProviderSettings" | "probeModelProvider"
>;

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

export type ModelProviderRefreshParams = {
  /** The legacy app-server is intentionally not a Provider authority. */
  client?: unknown;
  connectionHint?: string;
  controlClient: ProviderControlClient | null | undefined;
  isConnected?: boolean;
  locale: Locale;
  credentialStore?: ProviderCredentialStorePort | null;
  nextIdempotencyKey?: () => string;
  resolveBackendCwd?: () => Promise<string | null | undefined>;
  setCapabilityPanel: SetCapabilityPanel;
};

export type ModelProviderActionParams = ModelProviderRefreshParams & {
  fieldValue: (fieldId: string) => string;
};

type ProviderState = Readonly<{
  catalog: ProviderCredentialCatalog | null;
  settings: ModelProviderSettingsSnapshot;
}>;

type ProviderProbeOutcome = Readonly<{
  succeeded: boolean;
  text: string;
}>;

function credentialStoreFor(
  params: ModelProviderRefreshParams,
): ProviderCredentialStorePort | null {
  return params.credentialStore === undefined
    ? providerCredentialStore()
    : params.credentialStore;
}

async function readProviderState(
  params: ModelProviderRefreshParams,
): Promise<ProviderState> {
  const store = credentialStoreFor(params);
  if (params.controlClient === null || params.controlClient === undefined) {
    const catalog = await store?.catalog();
    if (catalog === undefined) {
      throw new Error("model_provider_control_unavailable");
    }
    return { catalog, settings: settingsFromCredentialCatalog(catalog) };
  }
  const [response, catalog] = await Promise.all([
    params.controlClient.getModelProviderSettings(),
    store?.catalog() ?? Promise.resolve(null),
  ]);
  return { catalog, settings: response.settings };
}

function settingsFromCredentialCatalog(
  catalog: ProviderCredentialCatalog,
): ModelProviderSettingsSnapshot {
  return {
    revision: 0,
    activeProviderId: catalog.activeProviderId,
    providers: catalog.bindings.map((binding) => ({
      providerId: binding.providerId,
      displayName: binding.providerId,
      endpoint: binding.endpoint,
      credentialKind: binding.credentialKind,
      environmentVariable: binding.environmentVariable,
      isActive: binding.isActive,
    })),
    runtimeAvailability:
      catalog.activeProviderId === null ? "unconfigured" : "unavailable",
    updatedAt: null,
  };
}

/** Resolves an action id, including the provider identity carried by row ids. */
export function modelProviderActionForActionId(
  actionId: string,
): { action: ModelProviderAction; providerId: string | null } | null {
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

export function modelProviderDraftFromFields(
  fieldValue: (fieldId: string) => string,
): ModelProviderDraft {
  const credentialKind = fieldValue(MODEL_PROVIDER_FIELD_IDS.credentialKind);
  const vendor = modelProviderVendor(
    fieldValue(MODEL_PROVIDER_FIELD_IDS.vendor),
  );
  const preset = vendor?.id === CUSTOM_VENDOR_ID ? null : vendor;
  return {
    id: fieldValue(MODEL_PROVIDER_FIELD_IDS.id).trim() || preset?.id || "",
    name: fieldValue(MODEL_PROVIDER_FIELD_IDS.name),
    modelId:
      fieldValue(MODEL_PROVIDER_FIELD_IDS.modelId).trim() ||
      preset?.defaultModel ||
      "",
    baseUrl:
      fieldValue(MODEL_PROVIDER_FIELD_IDS.baseUrl).trim() ||
      preset?.baseUrl ||
      "",
    credentialKind:
      credentialKind === "env-key" || credentialKind === "none"
        ? credentialKind
        : "bearer-token",
    envKey:
      fieldValue(MODEL_PROVIDER_FIELD_IDS.envKey).trim() ||
      preset?.envKey ||
      "",
    apiKey: fieldValue(MODEL_PROVIDER_FIELD_IDS.apiKey),
    setAsDefault: fieldValue(MODEL_PROVIDER_FIELD_IDS.selected) === "true",
  };
}

export async function refreshModelProvidersPanelAction(
  params: ModelProviderRefreshParams,
  probeText: string | null = null,
): Promise<void> {
  if (
    (params.controlClient === null || params.controlClient === undefined) &&
    credentialStoreFor(params) === null
  ) {
    params.setCapabilityPanel(
      modelProviderDisconnectedPanel(
        params.connectionHint ?? "",
        params.locale,
      ),
    );
    return;
  }
  params.setCapabilityPanel(modelProviderLoadingPanel(params.locale));
  try {
    const { catalog, settings } = await readProviderState(params);
    params.setCapabilityPanel(
      modelProviderListPanel({
        settings,
        credentialCatalog: catalog,
        cwd: null,
        locale: params.locale,
        mutationAvailable: catalog !== null,
        probeAvailable: settings.runtimeAvailability === "available",
        probeText,
      }),
    );
  } catch (error) {
    params.setCapabilityPanel(modelProviderErrorPanel(error, params.locale));
  }
}

async function openFormForProvider(
  params: ModelProviderRefreshParams,
  providerId: string | null,
): Promise<void> {
  const store = credentialStoreFor(params);
  if (store === null) {
    params.setCapabilityPanel((panel) =>
      actionError(panel, mutationUnavailable(params.locale)),
    );
    return;
  }
  try {
    const { catalog, settings } = await readProviderState(params);
    params.setCapabilityPanel(
      modelProviderFormPanel({
        allowAccountProvider: false,
        entry:
          providerId === null
            ? null
            : modelProviderEntry(settings, providerId, catalog),
        isSelected:
          providerId !== null &&
          selectedModelProviderId(settings, catalog) === providerId,
        locale: params.locale,
      }),
    );
  } catch (error) {
    params.setCapabilityPanel(modelProviderErrorPanel(error, params.locale));
  }
}

async function saveDraft(
  params: ModelProviderActionParams,
  options: { thenTest: boolean },
): Promise<void> {
  const draft = modelProviderDraftFromFields(params.fieldValue);
  const store = credentialStoreFor(params);
  if (store === null) {
    params.setCapabilityPanel((panel) =>
      actionError(panel, mutationUnavailable(params.locale)),
    );
    return;
  }
  // The immutable draft above is the one native IPC request payload. Remove
  // the raw key from renderer panel state before the first asynchronous gap so
  // a slow coordinator/probe never leaves it in the DOM-backed form model.
  params.setCapabilityPanel(clearSecretField);
  try {
    const { catalog, settings } = await readProviderState(params);
    const existing = modelProviderEntry(settings, draft.id, catalog);
    const validationError = modelProviderDraftError(draft, params.locale, {
      // Reserved ids belonged to legacy config.toml. The native Provider
      // catalog is the desktop authority and can safely own built-in ids.
      allowReservedId: true,
      existingIds: [],
      hasStoredToken: existing?.hasStoredToken ?? false,
    });
    if (validationError !== null) {
      params.setCapabilityPanel(
        formFromDraft(
          { ...draft, apiKey: "" },
          existing,
          validationError,
          params.locale,
        ),
      );
      return;
    }
    const activate =
      options.thenTest ||
      draft.setAsDefault ||
      settings.activeProviderId === draft.id;
    await store.upsert({
      activate,
      credentialKind:
        draft.credentialKind === "bearer-token"
          ? "keychain"
          : draft.credentialKind === "env-key"
            ? "environment"
            : "none",
      endpoint: draft.baseUrl.trim(),
      environmentVariable:
        draft.credentialKind === "env-key" ? draft.envKey.trim() : null,
      modelId: draft.modelId.trim(),
      providerId: draft.id.trim(),
      secret:
        draft.credentialKind === "bearer-token" && draft.apiKey.length > 0
          ? draft.apiKey
          : null,
    });
    // The native coordinator has finalized before IPC resolves. Rehydrate only
    // from the public Control authority; native catalog output is not UI truth.
    if (options.thenTest) {
      const outcome = await runProviderProbe(
        params,
        draft.id.trim(),
        draft.modelId.trim(),
      );
      const previousProviderId = settings.activeProviderId;
      const restorePrevious =
        previousProviderId !== null &&
        previousProviderId !== draft.id &&
        (!outcome.succeeded || !draft.setAsDefault);
      let resultText = outcome.text;
      if (restorePrevious) {
        try {
          await store.activate(previousProviderId);
          resultText = `${resultText}\n${
            params.locale === "zh"
              ? `已恢复默认 Provider: ${previousProviderId}`
              : `Restored default Provider: ${previousProviderId}`
          }`;
        } catch (error) {
          resultText = `${resultText}\n${
            params.locale === "zh"
              ? "恢复原默认 Provider 失败"
              : "Could not restore the previous default Provider"
          }: ${safeError(error)}`;
        }
      }
      await refreshModelProvidersPanelAction(params, resultText);
    } else {
      await refreshModelProvidersPanelAction(
        params,
        params.locale === "zh"
          ? `已保存 ${draft.id.trim()}`
          : `Saved ${draft.id.trim()}`,
      );
    }
  } catch (error) {
    params.setCapabilityPanel(
      formFromDraft(
        { ...draft, apiKey: "" },
        null,
        safeError(error),
        params.locale,
      ),
    );
  }
}

async function probeProvider(
  params: ModelProviderRefreshParams,
  providerId: string,
): Promise<void> {
  let expectedModelId: string | null = null;
  try {
    const { catalog } = await readProviderState(params);
    expectedModelId =
      catalog?.bindings.find((binding) => binding.providerId === providerId)
        ?.modelId ?? null;
  } catch (error) {
    await refreshModelProvidersPanelAction(
      params,
      `${params.locale === "zh" ? "连接测试未能开始" : "Connection test could not start"}\n${safeError(error)}`,
    );
    return;
  }
  const outcome = await runProviderProbe(params, providerId, expectedModelId);
  await refreshModelProvidersPanelAction(params, outcome.text);
}

async function runProviderProbe(
  params: ModelProviderRefreshParams,
  providerId: string,
  expectedModelId: string | null,
): Promise<ProviderProbeOutcome> {
  const client = params.controlClient;
  if (client === null || client === undefined) {
    return {
      succeeded: false,
      text:
        params.locale === "zh"
          ? "连接测试未能完成\nmodel_provider_control_unavailable"
          : "Connection test did not complete\nmodel_provider_control_unavailable",
    };
  }
  params.setCapabilityPanel((panel) =>
    panel === null
      ? null
      : {
          ...panel,
          body:
            params.locale === "zh"
              ? `正在测试 ${providerId} 的连接...`
              : `Testing the connection to ${providerId}...`,
          error: undefined,
        },
  );
  const key = (params.nextIdempotencyKey ?? (() => crypto.randomUUID()))();
  try {
    let probe;
    try {
      probe = await client.probeModelProvider({}, key);
    } catch (error) {
      if (!unknownOutcome(error)) throw error;
      probe = await client.probeModelProvider({}, key);
    }
    if (probe.providerId !== providerId) {
      throw new Error("model_provider_probe_active_binding_changed");
    }
    return {
      succeeded: modelProviderProbeSucceeded(probe, expectedModelId),
      text: modelProviderProbeText(probe, params.locale, expectedModelId),
    };
  } catch (error) {
    return {
      succeeded: false,
      text: `${params.locale === "zh" ? "连接测试未能完成" : "Connection test did not complete"}\n${safeError(error)}`,
    };
  }
}

async function deleteProvider(
  params: ModelProviderRefreshParams,
  providerId: string,
): Promise<void> {
  const store = credentialStoreFor(params);
  if (store === null) return;
  try {
    const { catalog, settings } = await readProviderState(params);
    if (settings.activeProviderId === providerId) {
      const replacement = modelProviderEntries(settings, catalog).find(
        (entry) => entry.id !== providerId,
      );
      if (replacement !== undefined) await store.activate(replacement.id);
    }
    await store.delete(providerId);
    await refreshModelProvidersPanelAction(
      params,
      params.locale === "zh" ? `已删除 ${providerId}` : `Deleted ${providerId}`,
    );
  } catch (error) {
    params.setCapabilityPanel((panel) => actionError(panel, safeError(error)));
  }
}

async function selectProvider(
  params: ModelProviderRefreshParams,
  providerId: string,
): Promise<void> {
  const store = credentialStoreFor(params);
  if (store === null) return;
  try {
    await store.activate(providerId);
    await refreshModelProvidersPanelAction(
      params,
      params.locale === "zh"
        ? `已将 ${providerId} 设为默认 Provider`
        : `${providerId} is now the default provider`,
    );
  } catch (error) {
    params.setCapabilityPanel((panel) => actionError(panel, safeError(error)));
  }
}

export function handleModelProviderAction(
  params: ModelProviderActionParams,
  action: ModelProviderAction,
  providerId: string | null,
): void {
  switch (action) {
    case "add":
      void openFormForProvider(params, null);
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
      void (providerId === null
        ? saveDraft(params, { thenTest: true })
        : probeProvider(params, providerId));
      return;
    case "delete":
      if (providerId !== null) void deleteProvider(params, providerId);
      return;
    case "select":
      if (providerId !== null) void selectProvider(params, providerId);
      return;
  }
}

function formFromDraft(
  draft: ModelProviderDraft,
  existing: ReturnType<typeof modelProviderEntry>,
  error: string,
  locale: Locale,
): CapabilityPanel {
  return modelProviderFormPanel({
    allowAccountProvider: false,
    entry: {
      id: draft.id.trim(),
      name: draft.name,
      baseUrl: draft.baseUrl,
      credentialKind: draft.credentialKind,
      envKey: draft.envKey,
      hasStoredToken: existing?.hasStoredToken ?? false,
      modelId: draft.modelId,
    },
    error,
    isSelected: draft.setAsDefault,
    locale,
  });
}

function actionError(
  panel: CapabilityPanel | null,
  error: string,
): CapabilityPanel | null {
  if (panel === null) return null;
  return {
    ...panel,
    error,
    fields: panel.fields?.map((field) =>
      field.id === MODEL_PROVIDER_FIELD_IDS.apiKey
        ? { ...field, value: "" }
        : field,
    ),
  };
}

function clearSecretField(
  panel: CapabilityPanel | null,
): CapabilityPanel | null {
  if (panel === null) return null;
  return {
    ...panel,
    fields: panel.fields?.map((field) =>
      field.id === MODEL_PROVIDER_FIELD_IDS.apiKey
        ? { ...field, value: "" }
        : field,
    ),
  };
}

function unknownOutcome(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ControlApiProtocolError ||
    (error instanceof ControlApiClientError &&
      error.category === "unknownOutcome")
  );
}

function mutationUnavailable(locale: Locale): string {
  return locale === "zh"
    ? "Provider 修改只在受监督的桌面运行时中可用"
    : "Provider changes are available only in the supervised desktop runtime";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
