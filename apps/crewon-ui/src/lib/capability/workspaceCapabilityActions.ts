import type { AppsListResponse } from "@crewon-protocol/v2/AppsListResponse";
import type { FsGetMetadataResponse } from "@crewon-protocol/v2/FsGetMetadataResponse";
import type { PluginSource } from "@crewon-protocol/v2/PluginSource";

import { listAppsForThreadOrGlobal } from "../shared/appsCatalog";
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
  attachContextWorkspaceRequiredPanel,
  buildAttachContextItems,
} from "../context/contextAttachPanel";
import { demoCapabilityPanel } from "../demo/demoContent";
import {
  workbenchTerminalDemoNotice,
  workbenchTerminalErrorNotice,
  workbenchTerminalExitNotice,
  workbenchTerminalStopErrorNotice,
  workbenchTerminalWorkspaceRequiredNotice,
  workbenchTerminalWriteErrorNotice,
} from "../terminal/workbenchTerminalNotices";
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
  listPlugins(
    cwd?: string,
  ): Promise<{ marketplaces?: BrowserCapabilityMarketplace[] }>;
  readDirectory(path: string): Promise<{ entries?: DirectoryEntry[] }>;
  runCommand(
    cwd: string,
    command: string,
    processId?: string,
    options?: { outputBytesCap?: number; timeoutMs?: number },
  ): Promise<TerminalCommandResponse>;
  resizeCommand(
    processId: string,
    size: { cols: number; rows: number },
  ): Promise<void>;
  startTerminalSession(
    cwd: string,
    processId: string,
    size: { cols: number; rows: number },
  ): Promise<TerminalCommandResponse>;
  terminateCommand(processId: string): Promise<void>;
  writeCommandInput(
    processId: string,
    text: string,
    closeStdin?: boolean,
  ): Promise<void>;
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

export type RunTerminalStatusActionParams =
  BaseWorkspaceCapabilityActionParams & {
    processIdFactory?: () => string;
    setTerminalProcessId: (processId: string | null) => void;
    terminalCommand: string;
    terminalProcessId: () => string | null;
  };

export type WorkbenchTerminalSessionActionParams =
  BaseWorkspaceCapabilityActionParams & {
    appendTerminalOutputLine: (notice: string) => void;
    processIdFactory?: () => string;
    setTerminalProcessId: (processId: string | null) => void;
    terminalProcessId: () => string | null;
  };

export type WorkbenchTerminalInputActionParams = {
  appendTerminalOutputLine: (notice: string) => void;
  client: WorkspaceCapabilityClient | null | undefined;
  input: string;
  locale: Locale;
  terminalProcessId: () => string | null;
};

export type WorkbenchTerminalResizeActionParams = {
  client: WorkspaceCapabilityClient | null | undefined;
  cols: number;
  rows: number;
  terminalProcessId: () => string | null;
};

export type ReadWorkspaceFilesActionParams =
  BaseWorkspaceCapabilityActionParams;

export type ReadWorkspaceDiffActionParams = BaseWorkspaceCapabilityActionParams;

export type AttachWorkspaceContextActionParams =
  BaseWorkspaceCapabilityActionParams & {
    setCapabilityDockOpen: (open: boolean) => void;
    workspaceCwd?: string | null;
  };

export type LoadBrowserAppsActionParams =
  BaseWorkspaceCapabilityActionParams & {
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

export async function startWorkbenchTerminalSessionAction(
  params: WorkbenchTerminalSessionActionParams,
) {
  const {
    appendTerminalOutputLine,
    busyToolId,
    client,
    isConnected,
    isDemo,
    locale,
    processIdFactory = () => `crewon-ui-pty-${Date.now()}`,
    resolveBackendCwd,
    setBusyToolId,
    setTerminalProcessId,
    terminalProcessId,
  } = params;

  if (isDemo) {
    appendTerminalOutputLine(workbenchTerminalDemoNotice(locale));
    return;
  }
  if (busyToolId || !isConnected || terminalProcessId()) {
    return;
  }

  const terminalCwd = await resolveBackendCwd();
  if (!terminalCwd || !client) {
    appendTerminalOutputLine(workbenchTerminalWorkspaceRequiredNotice(locale));
    return;
  }

  const processId = processIdFactory();
  setBusyToolId("terminal");
  setTerminalProcessId(processId);
  const session = client.startTerminalSession(terminalCwd, processId, {
    cols: 100,
    rows: 30,
  });
  setBusyToolId(null);

  /*
   * Session status is written into the terminal's own output stream. It used to
   * go into `capabilityPanel`, which any other workbench surface would replace.
   */
  void session
    .then((response) => {
      appendTerminalOutputLine(
        workbenchTerminalExitNotice(response?.exitCode, locale),
      );
    })
    .catch((error) => {
      appendTerminalOutputLine(workbenchTerminalErrorNotice(error, locale));
    })
    .finally(() => {
      if (terminalProcessId() === processId) {
        setTerminalProcessId(null);
      }
    });
}

export async function writeWorkbenchTerminalInputAction(
  params: WorkbenchTerminalInputActionParams,
) {
  const { appendTerminalOutputLine, client, input, locale, terminalProcessId } =
    params;
  const processId = terminalProcessId();
  if (!client || !processId || !input) {
    return;
  }
  try {
    await client.writeCommandInput(processId, input);
  } catch (error) {
    appendTerminalOutputLine(workbenchTerminalWriteErrorNotice(error, locale));
  }
}

export async function resizeWorkbenchTerminalAction(
  params: WorkbenchTerminalResizeActionParams,
) {
  const { client, cols, rows, terminalProcessId } = params;
  const processId = terminalProcessId();
  if (!client || !processId || cols < 1 || rows < 1) {
    return;
  }
  await client.resizeCommand(processId, { cols, rows });
}

export async function stopWorkbenchTerminalSessionAction(
  params: WorkbenchTerminalInputActionParams,
) {
  const { appendTerminalOutputLine, client, locale, terminalProcessId } =
    params;
  const processId = terminalProcessId();
  if (!client || !processId) {
    return;
  }
  try {
    await client.terminateCommand(processId);
  } catch (error) {
    appendTerminalOutputLine(workbenchTerminalStopErrorNotice(error, locale));
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

export async function readWorkspaceDiffAction(
  params: ReadWorkspaceDiffActionParams,
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
    setCapabilityPanel({
      title: locale === "zh" ? "当前改动" : "Current changes",
      subtitle: "git diff HEAD · demo",
      body:
        "diff --git a/apps/crewon-ui/src/App.tsx b/apps/crewon-ui/src/App.tsx\n" +
        "--- a/apps/crewon-ui/src/App.tsx\n" +
        "+++ b/apps/crewon-ui/src/App.tsx\n" +
        "@@ -42,6 +42,7 @@\n" +
        "+  const capabilitySidebar = true;",
    });
    return;
  }
  if (busyToolId || !isConnected) {
    return;
  }

  const diffCwd = await resolveBackendCwd();
  if (!diffCwd) {
    return;
  }

  setBusyToolId("review");
  setCapabilityPanel({
    title: locale === "zh" ? "当前改动" : "Current changes",
    subtitle: diffCwd,
    body: locale === "zh" ? "正在读取 git diff…" : "Reading git diff…",
  });

  const command = [
    "tracked_files=$(git diff --name-only --no-ext-diff HEAD -- . ':(exclude).crewon/**')",
    "untracked_files=$(git ls-files --others --exclude-standard -- . ':(exclude).crewon/**')",
    "all_files=$(printf '%s\\n%s\\n' \"$tracked_files\" \"$untracked_files\" | sed '/^$/d' | sort -u)",
    "count=$(printf '%s\\n' \"$all_files\" | sed '/^$/d' | wc -l | tr -d ' ')",
    "files=$(printf '%s\\n' \"$all_files\" | sed -n '1,200p')",
    'printf "__CREWON_DIFF_COUNT__=%s\\n" "$count"',
    'printf \'%s\\n\' "$files" | while IFS= read -r file_path; do test -n "$file_path" || continue; if git ls-files --error-unmatch -- "$file_path" >/dev/null 2>&1; then git diff --no-ext-diff --unified=3 HEAD -- "$file_path"; else git diff --no-ext-diff --no-index --unified=3 -- /dev/null "$file_path" || test $? -eq 1; fi; done',
  ].join("; ");
  try {
    const response = await client?.runCommand(diffCwd, command, undefined, {
      outputBytesCap: 2_000_000,
      timeoutMs: 30_000,
    });
    if (!response) {
      throw new Error(
        locale === "zh" ? "未收到 git diff 响应" : "No git diff response",
      );
    }
    if (response.exitCode !== 0) {
      throw new Error(
        response.stderr?.trim() ||
          (locale === "zh" ? "读取 git diff 失败" : "Unable to read git diff"),
      );
    }

    const output = response.stdout?.trim() ?? "";
    const countMatch = output.match(/^__CREWON_DIFF_COUNT__=(\d+)\n?/);
    const totalChanges = Number(countMatch?.[1] ?? 0);
    const diff = output.replace(/^__CREWON_DIFF_COUNT__=\d+\n?/, "");
    const added = diff.match(/^\+(?!\+\+)/gm)?.length ?? 0;
    const removed = diff.match(/^-(?!--)/gm)?.length ?? 0;
    const files = diff.match(/^diff --git /gm)?.length ?? 0;
    const maxDiffCharacters = 2_000_000;
    const body = diff
      ? diff.length > maxDiffCharacters
        ? `${diff.slice(0, maxDiffCharacters)}\n\n${
            locale === "zh"
              ? "…diff 过大，已截断显示"
              : "…diff is too large and was truncated"
          }`
        : diff
      : locale === "zh"
        ? "当前没有文件改动。"
        : "There are no file changes.";

    setCapabilityPanel({
      title: locale === "zh" ? "当前改动" : "Current changes",
      subtitle:
        locale === "zh"
          ? `${totalChanges} 个改动 · 当前显示 ${files} 个文件 · +${added} / -${removed}`
          : `${totalChanges} ${totalChanges === 1 ? "change" : "changes"} · showing ${files} ${files === 1 ? "file" : "files"} · +${added} / -${removed}`,
      body,
    });
  } catch (error) {
    setCapabilityPanel({
      title: locale === "zh" ? "当前改动" : "Current changes",
      subtitle: diffCwd,
      error:
        error instanceof Error
          ? error.message
          : locale === "zh"
            ? "读取 git diff 失败"
            : "Unable to read git diff",
    });
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
    workspaceCwd,
  } = params;

  if (isDemo) {
    setCapabilityDockOpen(true);
    setCapabilityPanel(attachContextDemoPanel(locale));
    return;
  }

  if (busyToolId || !isConnected) {
    return;
  }

  const contextCwd =
    workspaceCwd === undefined
      ? await resolveBackendCwd()
      : workspaceCwd?.trim() || null;
  if (!contextCwd) {
    setCapabilityDockOpen(true);
    setCapabilityPanel(attachContextWorkspaceRequiredPanel(locale));
    return;
  }

  setCapabilityDockOpen(true);
  setBusyToolId("files");
  setCapabilityPanel(attachContextLoadingPanel(contextCwd, locale));

  try {
    const suggestedItems = await buildAttachContextItems({
      contextCwd,
      getMetadata: async (path) => client?.getMetadata(path),
      searchFiles: async (query, roots) =>
        client?.fuzzyFileSearch(query, roots),
    });
    const items = [
      {
        intent: "attach-context" as const,
        kind: "directory" as const,
        label:
          locale === "zh"
            ? "> 浏览工作空间中的文件和文件夹"
            : "> Browse workspace files and folders",
        path: contextCwd,
      },
      ...suggestedItems,
    ];
    setCapabilityPanel(
      attachContextResultsPanel({ contextCwd, items, locale }),
    );
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
