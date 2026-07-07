import type { AppsListResponse } from "@crewon-protocol/v2/AppsListResponse";
import type { HooksListResponse } from "@crewon-protocol/v2/HooksListResponse";

import type {
  AppServerClient,
  RemoteControlClient,
  RemoteControlStatusResponse,
} from "../app-server/appServer";
import { listAppsForThreadOrGlobal } from "../app-server/appServerRequests";
import {
  settledErrorMessages,
  settledMappedValue,
} from "../shared/settledResults";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  loadMcpInventory,
  type McpInventory,
} from "../domain/domainCollaborationBackend";
import type { Locale } from "../i18n";
import {
  browserAppsDisconnectedPanel,
  browserAppsErrorPanel,
  browserAppsLoadingPanel,
  browserAppsPanel,
  computerControlDisconnectedPanel,
  computerControlErrorPanel,
  computerControlLoadingPanel,
  computerControlPanel,
  hooksDisconnectedPanel,
  hooksErrorPanel,
  hooksLoadingPanel,
  hooksPanel,
  integrationsDisconnectedPanel,
  integrationsErrorPanel,
  integrationsLoadingPanel,
  integrationsPanel,
  mcpSettingsDisconnectedPanel,
  mcpSettingsErrorPanel,
  mcpSettingsLoadingPanel,
  mcpSettingsPanel,
} from "./settingsPanelText";

type SettingsCapabilityRefreshClient = AppServerClient;

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

type BaseSettingsCapabilityRefreshParams = {
  client: SettingsCapabilityRefreshClient | null | undefined;
  connectionHint: string;
  isConnected: boolean;
  locale: Locale;
  setCapabilityPanel: SetCapabilityPanel;
};

export type RefreshHooksSettingsPanelParams =
  BaseSettingsCapabilityRefreshParams & {
    resolveBackendCwd: () => Promise<string | null | undefined>;
  };

export type RefreshMcpSettingsPanelParams =
  BaseSettingsCapabilityRefreshParams & {
    isDemoPreview: boolean;
    mcpInventoryLoader?: (
      client: SettingsCapabilityRefreshClient | null | undefined,
      effectiveThreadId: string | undefined,
      effectiveCwd: string | null | undefined,
    ) => Promise<McpInventory>;
    resolveBackendCwd: () => Promise<string | null | undefined>;
    selectedThreadId: string | null;
  };

export type RefreshBrowserSettingsPanelParams =
  BaseSettingsCapabilityRefreshParams & {
    isDemoPreview: boolean;
    selectedThreadId: string | null;
  };

export type RefreshComputerControlSettingsPanelParams =
  BaseSettingsCapabilityRefreshParams;

export type RefreshIntegrationsPanelParams = BaseSettingsCapabilityRefreshParams & {
  isDemoPreview: boolean;
  resolveBackendCwd: () => Promise<string | null | undefined>;
  selectedThreadId: string | null;
};

export async function refreshHooksSettingsPanelAction(
  params: RefreshHooksSettingsPanelParams,
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
    setCapabilityPanel(hooksDisconnectedPanel(connectionHint, locale));
    return;
  }

  const hooksCwd = await resolveBackendCwd();
  setCapabilityPanel(hooksLoadingPanel(hooksCwd ?? null, locale));

  try {
    const response = (await client?.listHooks(hooksCwd ?? undefined)) ?? null;
    setCapabilityPanel(hooksPanel(response, locale));
  } catch (error) {
    setCapabilityPanel(
      hooksErrorPanel({ cwd: hooksCwd ?? null, error, locale }),
    );
  }
}

export async function refreshMcpSettingsPanelAction(
  params: RefreshMcpSettingsPanelParams,
) {
  const {
    client,
    connectionHint,
    isConnected,
    isDemoPreview,
    locale,
    mcpInventoryLoader = loadMcpInventory,
    resolveBackendCwd,
    selectedThreadId,
    setCapabilityPanel,
  } = params;

  if (!isConnected) {
    setCapabilityPanel(mcpSettingsDisconnectedPanel(connectionHint, locale));
    return;
  }

  setCapabilityPanel(mcpSettingsLoadingPanel(locale));

  try {
    const configCwd = await resolveBackendCwd();
    const inventory = await mcpInventoryLoader(
      client,
      isDemoPreview ? undefined : (selectedThreadId ?? undefined),
      configCwd,
    );
    setCapabilityPanel(mcpSettingsPanel(inventory, locale));
  } catch (error) {
    setCapabilityPanel(mcpSettingsErrorPanel(error, locale));
  }
}

export async function refreshBrowserSettingsPanelAction(
  params: RefreshBrowserSettingsPanelParams,
) {
  const {
    client,
    connectionHint,
    isConnected,
    isDemoPreview,
    locale,
    selectedThreadId,
    setCapabilityPanel,
  } = params;

  if (!isConnected) {
    setCapabilityPanel(browserAppsDisconnectedPanel(connectionHint, locale));
    return;
  }

  setCapabilityPanel(browserAppsLoadingPanel(locale));

  try {
    const response = await listAppsForThreadOrGlobal(
      client,
      isDemoPreview ? undefined : (selectedThreadId ?? undefined),
    );
    setCapabilityPanel(browserAppsPanel(response ?? null, locale));
  } catch (error) {
    setCapabilityPanel(browserAppsErrorPanel(error, locale));
  }
}

export async function refreshComputerControlSettingsPanelAction(
  params: RefreshComputerControlSettingsPanelParams,
) {
  const { client, connectionHint, isConnected, locale, setCapabilityPanel } =
    params;

  if (!isConnected) {
    setCapabilityPanel(computerControlDisconnectedPanel(connectionHint, locale));
    return;
  }

  setCapabilityPanel(computerControlLoadingPanel(locale));

  try {
    const status = (await client?.readRemoteControlStatus()) ?? null;
    const { clientError, clients } = await loadRemoteControlClients(
      client,
      status,
      locale,
    );
    setCapabilityPanel(
      computerControlPanel({
        clientError,
        clients,
        locale,
        status,
      }),
    );
  } catch (error) {
    setCapabilityPanel(computerControlErrorPanel(error, locale));
  }
}

export async function refreshIntegrationsPanelAction(
  params: RefreshIntegrationsPanelParams,
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
    setCapabilityPanel(integrationsDisconnectedPanel(connectionHint, locale));
    return;
  }

  setCapabilityPanel(integrationsLoadingPanel(locale));

  try {
    if (!client) {
      throw new Error(
        locale === "zh"
          ? "未连接本地 app-server"
          : "Local app-server is not connected",
      );
    }

    const appsPromise = listAppsForThreadOrGlobal(
      client,
      isDemoPreview ? undefined : (selectedThreadId ?? undefined),
    );
    const integrationsCwd = await resolveBackendCwd();
    const hooksPromise = client.listHooks(integrationsCwd ?? undefined);

    const [appsResult, hooksResult] = await Promise.allSettled([
      appsPromise,
      hooksPromise,
    ]);
    const apps = settledMappedValue(appsResult, (value) => value?.data, []);
    const hooks = settledMappedValue(
      hooksResult,
      (value) => value?.data?.flatMap((entry) => entry.hooks),
      [],
    );
    const errors = settledErrorMessages([appsResult, hooksResult]);

    setCapabilityPanel(integrationsPanel({ apps, errors, hooks, locale }));
  } catch (error) {
    setCapabilityPanel(integrationsErrorPanel(error, locale));
  }
}

async function loadRemoteControlClients(
  client: SettingsCapabilityRefreshClient | null | undefined,
  status: RemoteControlStatusResponse | null,
  locale: Locale,
): Promise<{
  clientError: string | null;
  clients: RemoteControlClient[];
}> {
  if (!status?.environmentId) {
    return {
      clientError: null,
      clients: [],
    };
  }

  try {
    const clientsResponse = await client?.listRemoteControlClients(
      status.environmentId,
    );
    return {
      clientError: null,
      clients: clientsResponse?.data ?? [],
    };
  } catch (error) {
    return {
      clientError:
        error instanceof Error
          ? error.message
          : locale === "zh"
            ? "读取配对设备失败"
            : "Unable to read paired clients",
      clients: [],
    };
  }
}

export type {
  SettingsCapabilityRefreshClient,
};
