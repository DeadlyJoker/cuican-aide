import type { AppsListResponse } from "@crewon-protocol/v2/AppsListResponse";
import type { FsGetMetadataResponse } from "@crewon-protocol/v2/FsGetMetadataResponse";
import type { PluginSource } from "@crewon-protocol/v2/PluginSource";

import { listAppsForThreadOrGlobal } from "../app-server/appServerRequests";
import type { CapabilityPanel } from "./capabilityPanelTypes";
import {
  browserCapabilityErrorPanel,
  browserCapabilityLoadingPanel,
  browserCapabilityPanel,
} from "./browserCapabilityPanel";
import {
  defaultCapabilityPanel,
  fileMetadataText,
  terminalCompletedPanel,
  terminalErrorPanel,
  terminalRunningPanel,
} from "./capabilityPanelText";
import {
  attachContextDemoPanel,
  attachContextErrorPanel,
  attachContextLoadingPanel,
  attachContextResultsPanel,
  buildAttachContextItems,
} from "../context/contextAttachPanel";
import { demoCapabilityPanel } from "../demo/demoContent";
import {
  directoryEntriesToPanelItems,
  directoryPanel,
  fileErrorPanel,
  fileLoadingPanel,
} from "../file/filePanelItems";
import type { Locale, ToolId } from "../i18n";

type DirectoryEntry = {
  fileName: string;
  isDirectory: boolean;
};

type SearchFile = {
  match_type: "directory" | "file";
  path: string;
  root: string;
};

type BrowserCapabilityHook = {
  eventName: string;
  handlerType: string;
  enabled: boolean;
};

type BrowserCapabilityPlugin = {
  name: string;
  source: PluginSource;
  installed: boolean;
  enabled: boolean;
};

type BrowserCapabilityMarketplace = {
  name: string;
  path: string | null;
  plugins: BrowserCapabilityPlugin[];
};

type TerminalCommandResponse = {
  exitCode: number;
  stderr?: string | null;
  stdout?: string | null;
};

type WorkspaceCapabilityClient = {
  fuzzyFileSearch(
    query: string,
    roots: string[],
  ): Promise<{ files?: SearchFile[] | null }>;
  getMetadata(path: string): Promise<FsGetMetadataResponse>;
  listApps(threadId?: string): Promise<AppsListResponse>;
  listHooks(
    cwd?: string,
  ): Promise<{ data?: Array<{ hooks: BrowserCapabilityHook[] }> }>;
  listPlugins(cwd?: string): Promise<{ marketplaces?: BrowserCapabilityMarketplace[] }>;
  readDirectory(path: string): Promise<{ entries?: DirectoryEntry[] }>;
  runCommand(
    cwd: string,
    command: string,
    processId: string,
  ): Promise<TerminalCommandResponse>;
};

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

type BaseWorkspaceCapabilityActionParams = {
  busyToolId: string | null;
  client: WorkspaceCapabilityClient | null | undefined;
  isConnected: boolean;
  isDemo: boolean;
  locale: Locale;
  resolveBackendCwd: () => Promise<string | null | undefined>;
  setBusyToolId: (toolId: ToolId | null) => void;
  setCapabilityPanel: SetCapabilityPanel;
};

export type RunTerminalStatusActionParams = BaseWorkspaceCapabilityActionParams & {
  processIdFactory?: () => string;
  setTerminalProcessId: (processId: string | null) => void;
  terminalCommand: string;
  terminalProcessId: () => string | null;
};

export type ReadWorkspaceFilesActionParams = BaseWorkspaceCapabilityActionParams;

export type AttachWorkspaceContextActionParams =
  BaseWorkspaceCapabilityActionParams & {
    setCapabilityDockOpen: (open: boolean) => void;
  };

export type LoadBrowserAppsActionParams = BaseWorkspaceCapabilityActionParams & {
  isDemoPreview: boolean;
  selectedThreadId: string | null;
};

export async function runTerminalStatusAction(
  params: RunTerminalStatusActionParams,
) {
  const {
    busyToolId,
    client,
    isConnected,
    isDemo,
    locale,
    processIdFactory = () => `crewon-ui-terminal-${Date.now()}`,
    resolveBackendCwd,
    setBusyToolId,
    setCapabilityPanel,
    setTerminalProcessId,
    terminalCommand,
    terminalProcessId,
  } = params;

  const command = terminalCommand.trim();
  if (isDemo) {
    const panel = demoCapabilityPanel("terminal", locale);
    setCapabilityPanel(
      command ? { ...panel, subtitle: `${command}  ·  exit 0` } : panel,
    );
    return;
  }

  if (busyToolId || !isConnected || !command) {
    return;
  }

  const terminalCwd = await resolveBackendCwd();
  if (!terminalCwd) {
    return;
  }

  setBusyToolId("terminal");
  const processId = processIdFactory();
  setTerminalProcessId(processId);
  setCapabilityPanel(terminalRunningPanel(terminalCwd, locale));

  try {
    const response = await client?.runCommand(terminalCwd, command, processId);
    setCapabilityPanel((currentPanel) =>
      terminalCompletedPanel({
        command,
        currentBody: currentPanel?.body,
        locale,
        response,
      }),
    );
  } catch (error) {
    setCapabilityPanel(terminalErrorPanel({ command, error, locale }));
  } finally {
    if (terminalProcessId() === processId) {
      setTerminalProcessId(null);
    }
    setBusyToolId(null);
  }
}

export async function readWorkspaceFilesAction(
  params: ReadWorkspaceFilesActionParams,
) {
  const {
    busyToolId,
    client,
    isConnected,
    isDemo,
    locale,
    resolveBackendCwd,
    setBusyToolId,
    setCapabilityPanel,
  } = params;

  if (isDemo) {
    setCapabilityPanel(demoCapabilityPanel("files", locale));
    return;
  }
  if (busyToolId || !isConnected) {
    return;
  }

  const filesCwd = await resolveBackendCwd();
  if (!filesCwd) {
    return;
  }

  setBusyToolId("files");
  setCapabilityPanel(fileLoadingPanel(filesCwd, locale));

  try {
    const [response, metadata] = await Promise.all([
      client?.readDirectory(filesCwd),
      client?.getMetadata(filesCwd),
    ]);
    const entries = directoryEntriesToPanelItems(response?.entries, filesCwd);
    setCapabilityPanel(
      directoryPanel({
        entries,
        locale,
        metadataText: fileMetadataText(metadata ?? null, locale),
        path: filesCwd,
      }),
    );
  } catch (error) {
    setCapabilityPanel(
      fileErrorPanel({
        error,
        fallback: locale === "zh" ? "读取目录失败" : "Unable to read directory",
        locale,
        path: filesCwd,
      }),
    );
  } finally {
    setBusyToolId(null);
  }
}

export async function attachWorkspaceContextAction(
  params: AttachWorkspaceContextActionParams,
) {
  const {
    busyToolId,
    client,
    isConnected,
    isDemo,
    locale,
    resolveBackendCwd,
    setBusyToolId,
    setCapabilityDockOpen,
    setCapabilityPanel,
  } = params;

  if (isDemo) {
    setCapabilityDockOpen(true);
    setCapabilityPanel(attachContextDemoPanel(locale));
    return;
  }

  if (busyToolId || !isConnected) {
    return;
  }

  const contextCwd = await resolveBackendCwd();
  if (!contextCwd) {
    return;
  }

  setCapabilityDockOpen(true);
  setBusyToolId("files");
  setCapabilityPanel(attachContextLoadingPanel(contextCwd, locale));

  try {
    const items = await buildAttachContextItems({
      contextCwd,
      getMetadata: async (path) => client?.getMetadata(path),
      searchFiles: async (query, roots) => client?.fuzzyFileSearch(query, roots),
    });
    setCapabilityPanel(attachContextResultsPanel({ contextCwd, items, locale }));
  } catch (error) {
    setCapabilityPanel(attachContextErrorPanel({ contextCwd, error, locale }));
  } finally {
    setBusyToolId(null);
  }
}

export async function loadBrowserAppsAction(
  params: LoadBrowserAppsActionParams,
) {
  const {
    busyToolId,
    client,
    isConnected,
    isDemo,
    isDemoPreview,
    locale,
    resolveBackendCwd,
    selectedThreadId,
    setBusyToolId,
    setCapabilityPanel,
  } = params;

  if (isDemo) {
    setCapabilityPanel(demoCapabilityPanel("web", locale));
    return;
  }
  if (busyToolId || !isConnected) {
    return;
  }

  setBusyToolId("web");
  const appsCwd = await resolveBackendCwd();
  setCapabilityPanel(browserCapabilityLoadingPanel(locale));

  try {
    const responsePromise = listAppsForThreadOrGlobal(
      client,
      isDemoPreview ? undefined : (selectedThreadId ?? undefined),
    );
    const [response, hooksResponse, pluginsResponse] = await Promise.all([
      responsePromise,
      client?.listHooks(appsCwd ?? undefined),
      client?.listPlugins(appsCwd ?? undefined),
    ]);

    setCapabilityPanel(
      browserCapabilityPanel({
        apps: response?.data ?? [],
        hookEntries: hooksResponse?.data ?? [],
        marketplaces: pluginsResponse?.marketplaces ?? [],
        locale,
      }),
    );
  } catch (error) {
    setCapabilityPanel(browserCapabilityErrorPanel(error, locale));
  } finally {
    setBusyToolId(null);
  }
}

export function openDefaultCapabilityPanel(params: {
  locale: Locale;
  setCapabilityPanel: SetCapabilityPanel;
}) {
  params.setCapabilityPanel(defaultCapabilityPanel(params.locale));
}
