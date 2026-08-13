import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";

import { refreshAccountPanelAction } from "../account/accountActions";
import type { AppServerClient } from "../app-server/appServer";
import type { ControlApiClient } from "@crewon/control-client";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import { refreshModelProvidersPanelAction } from "../model-provider/modelProviderActions";
import type { ConnectionState } from "../shared/connectionState";
import type { AgentPlatformUser } from "../agent-platform/agentPlatformSession";
import type { AccountStatus } from "../shared/statusTypes";
import {
  detectOperatingSystem,
  detectRuntimeSurface,
  type OperatingSystem,
  type RuntimeSurface,
} from "../platform";
import type { Theme } from "../theme";
import { previewAwareBackendThreadId } from "../thread/threadIds";
import { openThreadSettingsPanelAction } from "../thread/threadSettingsPanelActions";
import type {
  SettingsRefreshAction,
  SettingsSectionRefreshHandlers,
} from "./settingsActions";
import {
  refreshBrowserSettingsPanelAction,
  refreshComputerControlSettingsPanelAction,
  refreshHooksSettingsPanelAction,
  refreshIntegrationsPanelAction,
  refreshMcpSettingsPanelAction,
} from "./settingsCapabilityRefreshActions";
import {
  refreshAppearanceSettingsPanelAction,
  refreshConfigPanelAction,
  refreshKeyboardSettingsPanelAction,
  refreshPersonalizationSettingsPanelAction,
} from "./settingsConfigurationActions";
import {
  refreshAppSnapshotsSettingsPanelAction,
  refreshConnectionsSettingsPanelAction,
  refreshEnvironmentSettingsPanelAction,
} from "./settingsRuntimeRefreshActions";
import {
  refreshGitSettingsPanelAction,
  refreshWorktreesSettingsPanelAction,
} from "./settingsWorkspaceRefreshActions";

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

export type AppSettingsRefreshHandlers = {
  refreshAccountPanel: () => Promise<void>;
  refreshAppearanceSettingsPanel: () => Promise<void>;
  refreshAppSnapshotsSettingsPanel: () => Promise<void>;
  refreshBrowserSettingsPanel: () => Promise<void>;
  refreshComputerControlSettingsPanel: () => Promise<void>;
  refreshConfigPanel: () => Promise<void>;
  refreshConnectionsSettingsPanel: () => Promise<void>;
  refreshEnvironmentSettingsPanel: () => Promise<void>;
  refreshGitSettingsPanel: () => Promise<void>;
  refreshHooksPanel: () => Promise<void>;
  refreshIntegrationsPanel: () => Promise<void>;
  refreshKeyboardSettingsPanel: () => Promise<void>;
  refreshMcpSettingsPanel: () => Promise<void>;
  refreshModelProvidersPanel: () => Promise<void>;
  refreshPersonalizationSettingsPanel: () => Promise<void>;
  refreshWorktreesSettingsPanel: () => Promise<void>;
  openThreadSettingsPanel: () => Promise<void>;
};

export function createAppSettingsRefreshHandlers(params: {
  accountStatus: AccountStatus | null;
  client: AppServerClient | null;
  controlClient?: ControlApiClient | null;
  connectionHint: string;
  connectionState: ConnectionState;
  conversationSummary: ConversationSummary | null;
  currentCwd: string;
  isConnected: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  /** Defaults to the detected platform; callers override in tests. */
  os?: OperatingSystem;
  /** Enterprise identity from agent-platform, independent of the app-server. */
  platformUser: AgentPlatformUser | null;
  resolveBackendCwd: () => Promise<string>;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  setAccountStatus: (account: AccountStatus | null) => void;
  setCapabilityDockOpen: (open: boolean) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setThreads: (updater: (currentThreads: Thread[]) => Thread[]) => void;
  surface?: RuntimeSurface;
  theme: Theme;
  threadGoal: ThreadGoalView | null;
  threads: Thread[];
}): AppSettingsRefreshHandlers {
  const baseParams = {
    client: params.client,
    controlClient: params.controlClient,
    connectionHint: params.connectionHint,
    isConnected: params.isConnected,
    locale: params.locale,
    resolveBackendCwd: params.resolveBackendCwd,
    setCapabilityPanel: params.setCapabilityPanel,
  };

  return {
    refreshConfigPanel: () => refreshConfigPanelAction(baseParams),
    refreshHooksPanel: () => refreshHooksSettingsPanelAction(baseParams),
    refreshAppearanceSettingsPanel: () =>
      refreshAppearanceSettingsPanelAction({
        ...baseParams,
        currentLocale: params.locale,
        currentTheme: params.theme,
        os: params.os ?? detectOperatingSystem(),
        surface: params.surface ?? detectRuntimeSurface(),
      }),
    refreshPersonalizationSettingsPanel: () =>
      refreshPersonalizationSettingsPanelAction(baseParams),
    refreshKeyboardSettingsPanel: () =>
      refreshKeyboardSettingsPanelAction(baseParams),
    refreshMcpSettingsPanel: () =>
      refreshMcpSettingsPanelAction({
        ...baseParams,
        isDemoPreview: params.isDemoPreview,
        selectedThreadId: params.selectedThreadId,
      }),
    refreshModelProvidersPanel: () =>
      refreshModelProvidersPanelAction(baseParams),
    refreshBrowserSettingsPanel: () =>
      refreshBrowserSettingsPanelAction({
        client: params.client,
        connectionHint: params.connectionHint,
        isConnected: params.isConnected,
        isDemoPreview: params.isDemoPreview,
        locale: params.locale,
        selectedThreadId: params.selectedThreadId,
        setCapabilityPanel: params.setCapabilityPanel,
      }),
    refreshEnvironmentSettingsPanel: () =>
      refreshEnvironmentSettingsPanelAction(baseParams),
    refreshComputerControlSettingsPanel: () =>
      refreshComputerControlSettingsPanelAction({
        client: params.client,
        connectionHint: params.connectionHint,
        isConnected: params.isConnected,
        locale: params.locale,
        setCapabilityPanel: params.setCapabilityPanel,
      }),
    refreshAppSnapshotsSettingsPanel: () =>
      refreshAppSnapshotsSettingsPanelAction({
        client: params.client,
        connectionHint: params.connectionHint,
        isConnected: params.isConnected,
        locale: params.locale,
        setCapabilityPanel: params.setCapabilityPanel,
      }),
    refreshConnectionsSettingsPanel: () =>
      refreshConnectionsSettingsPanelAction({
        ...baseParams,
        isDemoPreview: params.isDemoPreview,
        selectedThreadId: params.selectedThreadId,
      }),
    refreshGitSettingsPanel: () =>
      refreshGitSettingsPanelAction({
        ...baseParams,
        conversationSummary: params.conversationSummary,
        selectedThread: params.selectedThread,
      }),
    refreshWorktreesSettingsPanel: () =>
      refreshWorktreesSettingsPanelAction({
        ...baseParams,
        conversationSummary: params.conversationSummary,
        currentThreads: params.threads,
        selectedThread: params.selectedThread,
        setThreads: params.setThreads,
      }),
    refreshIntegrationsPanel: () =>
      refreshIntegrationsPanelAction({
        ...baseParams,
        isDemoPreview: params.isDemoPreview,
        selectedThreadId: params.selectedThreadId,
      }),
    refreshAccountPanel: () =>
      refreshAccountPanelAction({
        ...baseParams,
        controlClient: params.controlClient,
        connectionState: params.connectionState,
        fallbackAccount: params.accountStatus,
        platformUser: params.platformUser,
        setAccountStatus: params.setAccountStatus,
      }),
    openThreadSettingsPanel: () =>
      openThreadSettingsPanelAction({
        client: params.client,
        cwd: params.currentCwd,
        hasBackendThread: Boolean(
          previewAwareBackendThreadId(
            params.selectedThreadId,
            params.isDemoPreview,
          ),
        ),
        isConnected: params.isConnected,
        isDemoPreview: params.isDemoPreview,
        locale: params.locale,
        resolveBackendCwd: params.resolveBackendCwd,
        setCapabilityDockOpen: params.setCapabilityDockOpen,
        setCapabilityPanel: params.setCapabilityPanel,
        threadGoal: params.threadGoal,
      }),
  };
}

export function createSettingsSectionRefreshHandlers(
  handlers: AppSettingsRefreshHandlers,
): SettingsSectionRefreshHandlers {
  return {
    account: handlers.refreshAccountPanel,
    appearance: handlers.refreshAppearanceSettingsPanel,
    appSnapshots: handlers.refreshAppSnapshotsSettingsPanel,
    browser: handlers.refreshBrowserSettingsPanel,
    computerControl: handlers.refreshComputerControlSettingsPanel,
    config: handlers.refreshConfigPanel,
    connections: handlers.refreshConnectionsSettingsPanel,
    environment: handlers.refreshEnvironmentSettingsPanel,
    git: handlers.refreshGitSettingsPanel,
    hooks: handlers.refreshHooksPanel,
    keyboard: handlers.refreshKeyboardSettingsPanel,
    mcpServers: handlers.refreshMcpSettingsPanel,
    modelProviders: handlers.refreshModelProvidersPanel,
    personalization: handlers.refreshPersonalizationSettingsPanel,
    worktrees: handlers.refreshWorktreesSettingsPanel,
  };
}

export function createSettingsRefreshHandlers(
  handlers: AppSettingsRefreshHandlers,
): Record<SettingsRefreshAction, () => void> {
  return {
    appearance: () => void handlers.refreshAppearanceSettingsPanel(),
    appSnapshots: () => void handlers.refreshAppSnapshotsSettingsPanel(),
    browserApps: () => void handlers.refreshBrowserSettingsPanel(),
    computerControl: () => void handlers.refreshComputerControlSettingsPanel(),
    config: () => void handlers.refreshConfigPanel(),
    connections: () => void handlers.refreshConnectionsSettingsPanel(),
    environment: () => void handlers.refreshEnvironmentSettingsPanel(),
    git: () => void handlers.refreshGitSettingsPanel(),
    hooks: () => void handlers.refreshHooksPanel(),
    integrations: () => void handlers.refreshIntegrationsPanel(),
    keyboard: () => void handlers.refreshKeyboardSettingsPanel(),
    mcpSettings: () => void handlers.refreshMcpSettingsPanel(),
    modelProviders: () => void handlers.refreshModelProvidersPanel(),
    personalization: () => void handlers.refreshPersonalizationSettingsPanel(),
    worktrees: () => void handlers.refreshWorktreesSettingsPanel(),
  };
}
