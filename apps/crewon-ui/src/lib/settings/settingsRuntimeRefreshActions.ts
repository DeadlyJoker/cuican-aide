import type { AppsListResponse } from "@crewon-ui-model/v2/AppsListResponse";
import type { ConfigRequirementsReadResponse } from "@crewon-ui-model/v2/ConfigRequirementsReadResponse";
import type { GetAccountResponse } from "@crewon-ui-model/v2/GetAccountResponse";
import type { GetAuthStatusResponse } from "@crewon-ui-model/GetAuthStatusResponse";
import type { ModelProviderCapabilitiesReadResponse } from "@crewon-ui-model/v2/ModelProviderCapabilitiesReadResponse";
import type { PluginListResponse } from "@crewon-ui-model/v2/PluginListResponse";
import type { WindowsSandboxReadinessResponse } from "@crewon-ui-model/v2/WindowsSandboxReadinessResponse";

import { listAppsForThreadOrGlobal } from "../shared/appsCatalog";
import {
  settledErrorMessages,
  settledMappedValue,
  settledValue,
} from "../shared/settledResults";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  appSnapshotsDisconnectedPanel,
  appSnapshotsErrorPanel,
  appSnapshotsLoadingPanel,
  appSnapshotsPanel,
  connectionsDisconnectedPanel,
  connectionsLoadingPanel,
  connectionsPanel,
  environmentDisconnectedPanel,
  environmentLoadingPanel,
  environmentPanel,
} from "./settingsPanelText";

type SettingsRuntimeRefreshClient = {
  getAccount(): Promise<GetAccountResponse>;
  getAuthStatus(): Promise<GetAuthStatusResponse>;
  getModelProviderCapabilities(): Promise<ModelProviderCapabilitiesReadResponse>;
  listApps(threadId?: string): Promise<AppsListResponse>;
  listPlugins(cwd?: string | null): Promise<PluginListResponse>;
  readConfigRequirements(): Promise<ConfigRequirementsReadResponse>;
  readWindowsSandboxReadiness(): Promise<WindowsSandboxReadinessResponse>;
};

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

type BaseSettingsRuntimeRefreshParams = {
  client: SettingsRuntimeRefreshClient | null | undefined;
  connectionHint: string;
  isConnected: boolean;
  locale: Locale;
  setCapabilityPanel: SetCapabilityPanel;
};

export type RefreshEnvironmentSettingsPanelParams =
  BaseSettingsRuntimeRefreshParams & {
    resolveBackendCwd: () => Promise<string | null | undefined>;
  };

export type RefreshAppSnapshotsSettingsPanelParams =
  BaseSettingsRuntimeRefreshParams;

export type RefreshConnectionsSettingsPanelParams =
  BaseSettingsRuntimeRefreshParams & {
    isDemoPreview: boolean;
    resolveBackendCwd: () => Promise<string | null | undefined>;
    selectedThreadId: string | null;
  };

export async function refreshEnvironmentSettingsPanelAction(
  params: RefreshEnvironmentSettingsPanelParams,
) {
  const {
    client,
    connectionHint,
    isConnected,
    locale,
    resolveBackendCwd,
    setCapabilityPanel,
  } = params;

  if (!isConnected) {
    setCapabilityPanel(environmentDisconnectedPanel(connectionHint, locale));
    return;
  }

  const environmentCwd = await resolveBackendCwd();
  setCapabilityPanel(environmentLoadingPanel(environmentCwd ?? null, locale));

  const [requirementsResult, readinessResult] = await Promise.allSettled([
    client?.readConfigRequirements(),
    client?.readWindowsSandboxReadiness(),
  ]);
  const requirements = settledValue(requirementsResult, null);
  const readiness = settledMappedValue(
    readinessResult,
    (value) => value?.status,
    null,
  );
  const readinessError =
    readinessResult.status === "rejected" &&
    readinessResult.reason instanceof Error
      ? readinessResult.reason.message
      : null;

  setCapabilityPanel(
    environmentPanel({
      cwd: environmentCwd ?? null,
      error:
        requirementsResult.status === "rejected" &&
        requirementsResult.reason instanceof Error
          ? requirementsResult.reason.message
          : undefined,
      locale,
      readiness,
      readinessError,
      requirements,
    }),
  );
}

export async function refreshAppSnapshotsSettingsPanelAction(
  params: RefreshAppSnapshotsSettingsPanelParams,
) {
  const { client, connectionHint, isConnected, locale, setCapabilityPanel } =
    params;

  if (!isConnected) {
    setCapabilityPanel(appSnapshotsDisconnectedPanel(connectionHint, locale));
    return;
  }

  setCapabilityPanel(appSnapshotsLoadingPanel(locale));

  try {
    const requirements = (await client?.readConfigRequirements()) ?? null;
    setCapabilityPanel(appSnapshotsPanel(requirements, locale));
  } catch (error) {
    setCapabilityPanel(appSnapshotsErrorPanel(error, locale));
  }
}

export async function refreshConnectionsSettingsPanelAction(
  params: RefreshConnectionsSettingsPanelParams,
) {
  const {
    client,
    connectionHint,
    isConnected,
    isDemoPreview,
    locale,
    resolveBackendCwd,
    selectedThreadId,
    setCapabilityPanel,
  } = params;

  if (!isConnected) {
    setCapabilityPanel(connectionsDisconnectedPanel(connectionHint, locale));
    return;
  }

  const connectionsCwd = await resolveBackendCwd();
  setCapabilityPanel(connectionsLoadingPanel(connectionsCwd ?? null, locale));

  if (!client) {
    setCapabilityPanel(connectionsDisconnectedPanel(connectionHint, locale));
    return;
  }

  const appsPromise = listAppsForThreadOrGlobal(
    client,
    isDemoPreview ? undefined : (selectedThreadId ?? undefined),
  );
  const [
    accountResult,
    authResult,
    providerResult,
    requirementsResult,
    pluginsResult,
    appsResult,
  ] = await Promise.allSettled([
    client.getAccount(),
    client.getAuthStatus(),
    client.getModelProviderCapabilities(),
    client.readConfigRequirements(),
    client.listPlugins(connectionsCwd ?? null),
    appsPromise,
  ]);
  const errors = settledErrorMessages([
    accountResult,
    authResult,
    providerResult,
    requirementsResult,
    pluginsResult,
    appsResult,
  ]);
  const account = settledValue(accountResult, null);
  const auth = settledValue(authResult, null);
  const provider = settledValue(providerResult, null);
  const requirements = settledValue(requirementsResult, null);
  const plugins = settledValue(pluginsResult, null);
  const apps = settledValue(appsResult, null);

  setCapabilityPanel(
    connectionsPanel({
      account,
      apps,
      auth,
      errors,
      locale,
      plugins,
      providerCapabilities: provider,
      requirements,
    }),
  );
}
