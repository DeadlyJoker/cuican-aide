import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import type {
  LibraryItemAction,
  LibraryPanel,
  OfficeConfig,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import type { OfficeThreadResolution } from "./officeThreadActions";
import {
  buildOfficeDetailPanel,
  matchingOfficeDetailPanel,
  officeDetailBindFailurePanel,
  officeDetailHydratedThreadPanel,
  officeDetailPanel,
} from "./officeDetailPanel";

type OfficeDetailAction = Extract<LibraryItemAction, { type: "office-detail" }>;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type OpenOfficeDetailActionParams = {
  action: OfficeDetailAction;
  ensureOfficeThread: (
    panel: LibraryPanel,
    workspaceOverride?: OfficeWorkspace,
  ) => Promise<OfficeThreadResolution | null>;
  isConnected: boolean;
  isUnsupportedRpcError: (error: unknown) => boolean;
  locale: Locale;
  readOfficeConfig: (
    params: { threadId?: string | null; title?: string | null },
  ) => Promise<{ record: { config: OfficeConfig } | null } | null | undefined>;
  readThread: (threadId: string) => Promise<Thread | null | undefined>;
  setLibraryPanel: LibraryPanelSetter;
};

export async function openOfficeDetailAction({
  action,
  ensureOfficeThread,
  isConnected,
  isUnsupportedRpcError,
  locale,
  readOfficeConfig,
  readThread,
  setLibraryPanel,
}: OpenOfficeDetailActionParams): Promise<boolean> {
  const officePanel = buildOfficeDetailPanel(action, null, locale);
  setLibraryPanel((currentPanel) => officeDetailPanel(currentPanel, officePanel));

  if (!action.workspace || !isConnected) {
    return true;
  }

  try {
    let latestPanel = officePanel;
    try {
      const readResponse = await readOfficeConfig({
        threadId: action.workspace.threadId ?? null,
        title: action.title,
      });
      if (readResponse?.record) {
        latestPanel = buildOfficeDetailPanel(
          action,
          readResponse.record.config,
          locale,
        );
        setLibraryPanel((currentPanel) =>
          matchingOfficeDetailPanel(currentPanel, officePanel.title, latestPanel),
        );
      }
    } catch (error) {
      if (!isUnsupportedRpcError(error)) {
        throw error;
      }
    }

    const threadResolution = await ensureOfficeThread(
      latestPanel,
      latestPanel.workspace,
    );
    if (!threadResolution) {
      return true;
    }
    latestPanel = {
      ...latestPanel,
      configPath: threadResolution.filePath ?? latestPanel.configPath,
      title: threadResolution.config.title,
      subtitle: threadResolution.config.subtitle,
      workspace: threadResolution.config.workspace,
    };
    const thread = await readThread(threadResolution.threadId);
    if (!thread) {
      return true;
    }
    setLibraryPanel((currentPanel) =>
      officeDetailHydratedThreadPanel(currentPanel, threadResolution.threadId, {
        fallbackWorkspace: action.workspace,
        latestPanel,
        locale,
        thread,
      }),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      officeDetailBindFailurePanel(currentPanel, error, locale),
    );
  }
  return true;
}
