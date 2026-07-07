import type { NoticeState } from "../shared/noticeState";
import type {
  DomainConfigKind,
  LibraryKind,
  LibraryPanelAction,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  domainConfigDeletedNoticeState,
  mcpConfigDeletedNoticeState,
} from "./libraryActionPresentation";

export type LibraryMaintenanceActionParams = {
  action: LibraryPanelAction;
  deleteDomainConfigFile: (
    cwd: string,
    filePath: string,
    configKind?: DomainConfigKind,
  ) => Promise<void>;
  deleteMcpServerConfig: (serverName: string) => Promise<void>;
  deleteMcpToolConfigRecord: (
    cwd: string,
    serverName: string,
  ) => Promise<string | null>;
  fallbackLibraryKind: LibraryKind;
  locale: Locale;
  openLibrary: (kind: LibraryKind) => Promise<void>;
  reloadMcpServers: () => Promise<void>;
  resolveBackendCwd: () => Promise<string | null>;
  setNotice: (notice: NoticeState | null) => void;
};

export async function handleLibraryMaintenanceAction({
  action,
  deleteDomainConfigFile,
  deleteMcpServerConfig,
  deleteMcpToolConfigRecord,
  fallbackLibraryKind,
  locale,
  openLibrary,
  reloadMcpServers,
  resolveBackendCwd,
  setNotice,
}: LibraryMaintenanceActionParams): Promise<boolean> {
  if (action.id === "reload-tools") {
    await reloadMcpServers();
    await openLibrary("tools");
    return true;
  }

  if (action.id === "reload-plugins") {
    await openLibrary("plugins");
    return true;
  }

  if (action.id === "delete-config-file") {
    if (!action.pathToOpen) {
      return true;
    }
    const configCwd = await resolveBackendCwd();
    if (!configCwd) {
      throwNotConnected(locale);
    }
    await deleteDomainConfigFile(
      configCwd,
      action.pathToOpen,
      action.domainConfigKind,
    );
    setNotice(domainConfigDeletedNoticeState(action.pathToOpen, locale));
    await openLibrary(fallbackLibraryKind);
    return true;
  }

  if (action.id === "delete-mcp-config") {
    if (!action.mcpServerName) {
      return true;
    }
    await deleteMcpServerConfig(action.mcpServerName);
    const toolCwd = await resolveBackendCwd();
    const deletedToolRecord = toolCwd
      ? await deleteMcpToolConfigRecord(toolCwd, action.mcpServerName)
      : null;
    setNotice(
      mcpConfigDeletedNoticeState({
        deletedToolRecord,
        locale,
        serverName: action.mcpServerName,
      }),
    );
    await openLibrary("tools");
    return true;
  }

  return false;
}

function throwNotConnected(locale: Locale): never {
  throw new Error(
    locale === "zh" ? "未连接本地 app-server" : "Local app-server is not connected",
  );
}
