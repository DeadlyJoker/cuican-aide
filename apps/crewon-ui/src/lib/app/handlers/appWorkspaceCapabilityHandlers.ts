import type { AppServerClient } from "../../app-server/appServer";
import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../i18n";
import {
  attachWorkspaceContextAction,
  loadBrowserAppsAction,
  readWorkspaceDiffAction,
  readWorkspaceFilesAction,
  resizeWorkbenchTerminalAction,
  runTerminalStatusAction,
  startWorkbenchTerminalSessionAction,
  stopWorkbenchTerminalSessionAction,
  writeWorkbenchTerminalInputAction,
} from "../../capability/workspaceCapabilityActions";

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

export type AppWorkspaceCapabilityHandlers = {
  attachWorkspaceContext: (workspaceCwd?: string | null) => Promise<void>;
  loadBrowserApps: () => Promise<void>;
  readWorkspaceDiff: () => Promise<void>;
  readWorkspaceFiles: () => Promise<void>;
  resizeWorkbenchTerminal: (cols: number, rows: number) => Promise<void>;
  runTerminalStatus: () => Promise<void>;
  startWorkbenchTerminal: () => Promise<void>;
  stopWorkbenchTerminal: () => Promise<void>;
  writeWorkbenchTerminalInput: (input: string) => Promise<void>;
};

export type AppWorkspaceCapabilityHandlersParams = {
  appendTerminalOutputLine: (notice: string) => void;
  busyToolId: ToolId | null;
  client: AppServerClient | null;
  getTerminalProcessId: () => string | null;
  isConnected: boolean;
  isDemo: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  resolveBackendCwd: () => Promise<string | null | undefined>;
  selectedThreadId: string | null;
  setBusyToolId: (toolId: ToolId | null) => void;
  setCapabilityDockOpen: (open: boolean) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setTerminalProcessId: (processId: string | null) => void;
  terminalCommand: string;
};

export function createAppWorkspaceCapabilityHandlers(
  params: AppWorkspaceCapabilityHandlersParams,
): AppWorkspaceCapabilityHandlers {
  return {
    attachWorkspaceContext: (workspaceCwd) =>
      attachWorkspaceContextAction({
        busyToolId: params.busyToolId,
        client: params.client,
        isConnected: params.isConnected,
        isDemo: params.isDemo,
        locale: params.locale,
        resolveBackendCwd: params.resolveBackendCwd,
        setBusyToolId: params.setBusyToolId,
        setCapabilityDockOpen: params.setCapabilityDockOpen,
        setCapabilityPanel: params.setCapabilityPanel,
        workspaceCwd,
      }),
    loadBrowserApps: () =>
      loadBrowserAppsAction({
        busyToolId: params.busyToolId,
        client: params.client,
        isConnected: params.isConnected,
        isDemo: params.isDemo,
        isDemoPreview: params.isDemoPreview,
        locale: params.locale,
        resolveBackendCwd: params.resolveBackendCwd,
        selectedThreadId: params.selectedThreadId,
        setBusyToolId: params.setBusyToolId,
        setCapabilityPanel: params.setCapabilityPanel,
      }),
    readWorkspaceDiff: () =>
      readWorkspaceDiffAction({
        busyToolId: params.busyToolId,
        client: params.client,
        isConnected: params.isConnected,
        isDemo: params.isDemo,
        locale: params.locale,
        resolveBackendCwd: params.resolveBackendCwd,
        setBusyToolId: params.setBusyToolId,
        setCapabilityPanel: params.setCapabilityPanel,
      }),
    readWorkspaceFiles: () =>
      readWorkspaceFilesAction({
        busyToolId: params.busyToolId,
        client: params.client,
        isConnected: params.isConnected,
        isDemo: params.isDemo,
        locale: params.locale,
        resolveBackendCwd: params.resolveBackendCwd,
        setBusyToolId: params.setBusyToolId,
        setCapabilityPanel: params.setCapabilityPanel,
      }),
    runTerminalStatus: () =>
      runTerminalStatusAction({
        busyToolId: params.busyToolId,
        client: params.client,
        isConnected: params.isConnected,
        isDemo: params.isDemo,
        locale: params.locale,
        resolveBackendCwd: params.resolveBackendCwd,
        setBusyToolId: params.setBusyToolId,
        setCapabilityPanel: params.setCapabilityPanel,
        setTerminalProcessId: params.setTerminalProcessId,
        terminalCommand: params.terminalCommand,
        terminalProcessId: params.getTerminalProcessId,
      }),
    startWorkbenchTerminal: () =>
      startWorkbenchTerminalSessionAction({
        appendTerminalOutputLine: params.appendTerminalOutputLine,
        busyToolId: params.busyToolId,
        client: params.client,
        isConnected: params.isConnected,
        isDemo: params.isDemo,
        locale: params.locale,
        resolveBackendCwd: params.resolveBackendCwd,
        setBusyToolId: params.setBusyToolId,
        setCapabilityPanel: params.setCapabilityPanel,
        setTerminalProcessId: params.setTerminalProcessId,
        terminalProcessId: params.getTerminalProcessId,
      }),
    writeWorkbenchTerminalInput: (input) =>
      writeWorkbenchTerminalInputAction({
        appendTerminalOutputLine: params.appendTerminalOutputLine,
        client: params.client,
        input,
        locale: params.locale,
        terminalProcessId: params.getTerminalProcessId,
      }),
    resizeWorkbenchTerminal: (cols, rows) =>
      resizeWorkbenchTerminalAction({
        client: params.client,
        cols,
        rows,
        terminalProcessId: params.getTerminalProcessId,
      }),
    stopWorkbenchTerminal: () =>
      stopWorkbenchTerminalSessionAction({
        appendTerminalOutputLine: params.appendTerminalOutputLine,
        client: params.client,
        input: "",
        locale: params.locale,
        terminalProcessId: params.getTerminalProcessId,
      }),
  };
}
