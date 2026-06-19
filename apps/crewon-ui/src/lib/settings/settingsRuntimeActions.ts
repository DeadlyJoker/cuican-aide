import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  mcpReloadFailurePanel,
  mcpReloadProgressPanel,
  windowsSandboxSetupFailurePanel,
  windowsSandboxSetupNotice,
  windowsSandboxSetupProgressPanel,
} from "./settingsPanelText";
import type { WindowsSandboxSetupMode } from "./settingsRuntimePanels";

export type SettingsRuntimeAction =
  | {
      mode: WindowsSandboxSetupMode;
      type: "setupWindowsSandbox";
    }
  | {
      type: "reloadTools";
    };

type SettingsRuntimeClient = {
  reloadMcpServers(): Promise<unknown>;
  startWindowsSandboxSetup(
    mode: WindowsSandboxSetupMode,
    cwd?: string,
  ): Promise<{ started?: boolean | null }>;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

export type SettingsRuntimeActionHandlersParams = {
  client: SettingsRuntimeClient | null | undefined;
  locale: Locale;
  refreshEnvironmentSettingsPanel: () => Promise<void>;
  refreshMcpSettingsPanel: () => Promise<void>;
  resolveBackendCwd: () => Promise<string | null | undefined>;
  setCapabilityPanel: SetCapabilityPanel;
  setNotice: (notice: NoticeState) => void;
};

export function settingsRuntimeActionForActionId(
  actionId: string,
): SettingsRuntimeAction | null {
  if (actionId === "reload-tools") {
    return { type: "reloadTools" };
  }

  if (!actionId.startsWith("setup-windows-sandbox-")) {
    return null;
  }

  const mode = actionId.replace("setup-windows-sandbox-", "");
  return mode === "elevated" || mode === "unelevated"
    ? { type: "setupWindowsSandbox", mode }
    : null;
}

export function handleSettingsRuntimeAction(
  params: SettingsRuntimeActionHandlersParams,
  action: SettingsRuntimeAction,
) {
  switch (action.type) {
    case "reloadTools":
      reloadTools(params);
      return;
    case "setupWindowsSandbox":
      setupWindowsSandbox(params, action.mode);
      return;
  }
}

function reloadTools(params: SettingsRuntimeActionHandlersParams) {
  const {
    client,
    locale,
    refreshMcpSettingsPanel,
    setCapabilityPanel,
  } = params;

  void (async () => {
    setCapabilityPanel((currentPanel) =>
      mcpReloadProgressPanel(currentPanel, locale),
    );
    try {
      await client?.reloadMcpServers();
      await refreshMcpSettingsPanel();
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        mcpReloadFailurePanel(currentPanel, error, locale),
      );
    }
  })();
}

function setupWindowsSandbox(
  params: SettingsRuntimeActionHandlersParams,
  mode: WindowsSandboxSetupMode,
) {
  const {
    client,
    locale,
    refreshEnvironmentSettingsPanel,
    resolveBackendCwd,
    setCapabilityPanel,
    setNotice,
  } = params;

  void (async () => {
    setCapabilityPanel((currentPanel) =>
      windowsSandboxSetupProgressPanel(currentPanel, mode, locale),
    );
    try {
      const cwd = await resolveBackendCwd();
      const response = await client?.startWindowsSandboxSetup(
        mode,
        cwd || undefined,
      );
      await refreshEnvironmentSettingsPanel();
      setNotice(windowsSandboxSetupNotice(response?.started, locale));
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        windowsSandboxSetupFailurePanel(currentPanel, error, locale),
      );
    }
  })();
}
