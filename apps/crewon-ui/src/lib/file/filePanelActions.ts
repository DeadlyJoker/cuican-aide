import type { FsGetMetadataResponse } from "@crewon-ui-model/v2/FsGetMetadataResponse";

import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import { fileMetadataText } from "../capability/capabilityPanelText";
import {
  contextNoteBody,
  contextNoteCreatedNotice,
  contextNoteFailurePanel,
  contextNotePanel,
  contextNoteProgressPanel,
  fileCopyBodyPrefix,
  fileCopyDestinationPath,
  fileCopyFailurePanel,
  fileCopyNotice,
  fileCopyProgressPanel,
  fileSearchProgressPanel,
  fileWatchDemoPanel,
  fileWatchFailurePanel,
  fileWatchNoActivePanel,
  fileWatchProgressPanel,
  fileWatchStartedPanel,
  fileWatchStoppedPanel,
} from "./fileActionPresentation";
import {
  directoryEntriesToPanelItems,
  directoryPanel,
  searchErrorPanel,
  searchFilesToPanelItems,
  searchResultsPanel,
} from "./filePanelItems";
import type { Locale } from "../i18n";
import { joinPath, pathDirName } from "../shared/pathUtils";

export type FilePanelAction =
  | "clearSearch"
  | "copyCurrentPath"
  | "createContextNote"
  | "searchFiles"
  | "unwatchCurrentPath"
  | "watchCurrentPath";

export type ActiveFileWatch = {
  id: string;
  path: string;
};

type DirectoryEntry = {
  fileName: string;
  isDirectory: boolean;
};

type SearchFile = {
  match_type: "directory" | "file";
  path: string;
  root: string;
};

type FilePanelClient = {
  copyPath(
    sourcePath: string,
    destinationPath: string,
    recursive?: boolean,
  ): Promise<void>;
  createDirectory(path: string, recursive?: boolean): Promise<unknown>;
  fuzzyFileSearch(
    query: string,
    roots: string[],
  ): Promise<{ files?: SearchFile[] }>;
  getMetadata(path: string): Promise<FsGetMetadataResponse>;
  readDirectory(path: string): Promise<{ entries?: DirectoryEntry[] }>;
  unwatchPath(watchId: string): Promise<void>;
  watchPath(watchId: string, path: string): Promise<{ path?: string }>;
  writeTextFile(path: string, text: string): Promise<unknown>;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

export type FilePanelActionHandlersParams = {
  activeFileWatch: ActiveFileWatch | null;
  busyToolId: string | null;
  capabilityPanel: CapabilityPanel | null;
  client: FilePanelClient | null | undefined;
  cwd: string;
  fieldValue: (fieldId: string) => string;
  isConnected: boolean;
  isDemo: boolean;
  locale: Locale;
  nowIso?: () => string;
  readWorkspaceFiles: () => Promise<void> | void;
  resolveBackendCwd: () => Promise<string | null | undefined>;
  setActiveFileWatch: (watch: ActiveFileWatch | null) => void;
  setBusyToolId: (toolId: "files" | null) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setNotice: (notice: NoticeState) => void;
  watchId?: () => string;
};

export function filePanelActionForActionId(
  actionId: string,
): FilePanelAction | null {
  switch (actionId) {
    case "clear-file-search":
      return "clearSearch";
    case "copy-current-path":
      return "copyCurrentPath";
    case "create-context-note":
      return "createContextNote";
    case "search-files":
      return "searchFiles";
    case "unwatch-current-path":
      return "unwatchCurrentPath";
    case "watch-current-path":
      return "watchCurrentPath";
    default:
      return null;
  }
}

export function createFilePanelActionHandlers(
  params: FilePanelActionHandlersParams,
): Record<FilePanelAction, () => void> {
  return {
    clearSearch: () => clearFileSearch(params),
    copyCurrentPath: () => copyCurrentPath(params),
    createContextNote: () => createContextNote(params),
    searchFiles: () => searchFiles(params),
    unwatchCurrentPath: () => updateFileWatch(params, "unwatch"),
    watchCurrentPath: () => updateFileWatch(params, "watch"),
  };
}

function createContextNote(params: FilePanelActionHandlersParams) {
  const { busyToolId, fieldValue, isConnected } = params;
  const selectedRoot = fieldValue("file-search-root");

  if (busyToolId || !isConnected) {
    return;
  }

  void createContextNoteWithBackend(params, selectedRoot);
}

async function createContextNoteWithBackend(
  params: FilePanelActionHandlersParams,
  selectedRoot: string,
) {
  const {
    client,
    locale,
    nowIso = () => new Date().toISOString(),
    resolveBackendCwd,
    setBusyToolId,
    setCapabilityPanel,
    setNotice,
  } = params;
  const root = selectedRoot || (await resolveBackendCwd());
  if (!root) {
    return;
  }

  setBusyToolId("files");
  setCapabilityPanel((currentPanel) =>
    contextNoteProgressPanel(currentPanel, locale),
  );

  try {
    const notesDir = joinPath(joinPath(root, ".crewon"), "context-notes");
    const createdAtIso = nowIso();
    const stamp = createdAtIso.replace(/[:.]/g, "-");
    const notePath = joinPath(notesDir, `note-${stamp}.md`);
    const noteBody = contextNoteBody({
      createdAtIso,
      locale,
      root,
    });

    await client?.createDirectory(notesDir, true);
    await client?.writeTextFile(notePath, noteBody);
    const metadata = await client?.getMetadata(notePath);
    setCapabilityPanel(() =>
      contextNotePanel({
        locale,
        metadataText: fileMetadataText(metadata ?? null, locale),
        noteBody,
        notePath,
        root,
      }),
    );
    setNotice(contextNoteCreatedNotice(notePath, locale));
  } catch (error) {
    setCapabilityPanel((currentPanel) =>
      contextNoteFailurePanel(currentPanel, error, locale),
    );
  } finally {
    setBusyToolId(null);
  }
}

function updateFileWatch(
  params: FilePanelActionHandlersParams,
  action: "unwatch" | "watch",
) {
  const {
    busyToolId,
    capabilityPanel,
    fieldValue,
    isConnected,
    isDemo,
    locale,
    setCapabilityPanel,
  } = params;

  if (isDemo) {
    setCapabilityPanel((currentPanel) =>
      fileWatchDemoPanel(currentPanel, locale),
    );
    return;
  }

  const targetPath =
    fieldValue("file-search-root") || capabilityPanel?.subtitle?.trim() || "";

  if (busyToolId || !isConnected || !targetPath) {
    return;
  }

  void updateFileWatchWithBackend(params, action, targetPath);
}

async function updateFileWatchWithBackend(
  params: FilePanelActionHandlersParams,
  action: "unwatch" | "watch",
  targetPath: string,
) {
  const {
    activeFileWatch,
    client,
    locale,
    setActiveFileWatch,
    setBusyToolId,
    setCapabilityPanel,
    watchId = () => `crewon-ui-${Date.now()}`,
  } = params;

  setBusyToolId("files");
  setCapabilityPanel((currentPanel) =>
    fileWatchProgressPanel(currentPanel, action, locale),
  );

  try {
    if (action === "unwatch") {
      if (!activeFileWatch) {
        setCapabilityPanel((currentPanel) =>
          fileWatchNoActivePanel(currentPanel, locale),
        );
        return;
      }
      await client?.unwatchPath(activeFileWatch.id);
      setActiveFileWatch(null);
      setCapabilityPanel((currentPanel) =>
        fileWatchStoppedPanel(currentPanel, activeFileWatch.path, locale),
      );
      return;
    }

    if (activeFileWatch) {
      await client?.unwatchPath(activeFileWatch.id);
    }
    const nextWatchId = watchId();
    const response = await client?.watchPath(nextWatchId, targetPath);
    const watchedPath = response?.path ?? targetPath;
    setActiveFileWatch({ id: nextWatchId, path: watchedPath });
    setCapabilityPanel((currentPanel) =>
      fileWatchStartedPanel(currentPanel, watchedPath, locale),
    );
  } catch (error) {
    setCapabilityPanel((currentPanel) =>
      fileWatchFailurePanel(currentPanel, error, locale),
    );
  } finally {
    setBusyToolId(null);
  }
}

function copyCurrentPath(params: FilePanelActionHandlersParams) {
  const { busyToolId, capabilityPanel, isConnected } = params;
  const sourcePath = capabilityPanel?.subtitle?.trim() ?? "";
  if (!sourcePath || busyToolId || !isConnected) {
    return;
  }

  void copyCurrentPathWithBackend(params, sourcePath);
}

async function copyCurrentPathWithBackend(
  params: FilePanelActionHandlersParams,
  sourcePath: string,
) {
  const { client, locale, setBusyToolId, setCapabilityPanel, setNotice } =
    params;

  setBusyToolId("files");
  setCapabilityPanel((currentPanel) =>
    fileCopyProgressPanel(currentPanel, locale),
  );

  try {
    const metadata = await client?.getMetadata(sourcePath);
    const destinationPath = fileCopyDestinationPath(sourcePath);
    await client?.copyPath(
      sourcePath,
      destinationPath,
      Boolean(metadata?.isDirectory),
    );
    const parentPath = pathDirName(sourcePath);
    const [response, parentMetadata] = await Promise.all([
      client?.readDirectory(parentPath),
      client?.getMetadata(parentPath),
    ]);
    const entries = directoryEntriesToPanelItems(response?.entries, parentPath);
    setCapabilityPanel(() =>
      directoryPanel({
        bodyPrefix: fileCopyBodyPrefix(destinationPath, locale),
        entries,
        locale,
        metadataText: fileMetadataText(parentMetadata ?? null, locale),
        path: parentPath,
      }),
    );
    setNotice(fileCopyNotice(destinationPath, locale));
  } catch (error) {
    setCapabilityPanel((currentPanel) =>
      fileCopyFailurePanel(currentPanel, error, locale),
    );
  } finally {
    setBusyToolId(null);
  }
}

function clearFileSearch(params: FilePanelActionHandlersParams) {
  const { cwd, fieldValue, readWorkspaceFiles } = params;
  const root = fieldValue("file-search-root") || cwd;

  if (!root) {
    return;
  }

  void readWorkspaceFiles();
}

function searchFiles(params: FilePanelActionHandlersParams) {
  const { busyToolId, cwd, fieldValue, isConnected } = params;
  const root = fieldValue("file-search-root") || cwd;

  if (!root) {
    return;
  }

  const query = fieldValue("file-search");
  if (!query || busyToolId || !isConnected) {
    return;
  }

  void searchFilesWithBackend(params, query, root);
}

async function searchFilesWithBackend(
  params: FilePanelActionHandlersParams,
  query: string,
  root: string,
) {
  const { client, locale, setBusyToolId, setCapabilityPanel } = params;

  setBusyToolId("files");
  setCapabilityPanel((currentPanel) =>
    fileSearchProgressPanel(currentPanel, locale),
  );

  try {
    const response = await client?.fuzzyFileSearch(query, [root]);
    const items = searchFilesToPanelItems(response?.files ?? []);

    setCapabilityPanel(() => searchResultsPanel({ items, locale, query, root }));
  } catch (error) {
    setCapabilityPanel(() => searchErrorPanel({ error, locale, query, root }));
  } finally {
    setBusyToolId(null);
  }
}
