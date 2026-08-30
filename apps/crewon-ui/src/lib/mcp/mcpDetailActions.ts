import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import type { LibraryPanel, McpDetailAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  buildMcpDetailPanelContent,
  mcpDetailContentPanel,
  mcpToolEmptyHistoryPanel,
  mcpToolHistoryFailurePanel,
  mcpToolHistoryPanel,
  mcpToolThreadTitle,
} from "./mcpDetailPanel";
import { threadTitle } from "../thread/threadModel";
import { toolThreadHistoryItems } from "../thread/threadHistoryItems";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type OpenMcpDetailActionParams = {
  action: McpDetailAction;
  isConnected: boolean;
  listThreads: () => Promise<Thread[]>;
  locale: Locale;
  readThread: (threadId: string) => Promise<Thread | null | undefined>;
  refreshToolAction: (action: McpDetailAction) => Promise<McpDetailAction>;
  setLibraryPanel: LibraryPanelSetter;
};

export async function openMcpDetailAction({
  action,
  isConnected,
  listThreads,
  locale,
  readThread,
  refreshToolAction,
  setLibraryPanel,
}: OpenMcpDetailActionParams): Promise<boolean> {
  const mcpAction = await refreshToolAction(action);
  const tool = mcpAction.tool;
  const mcpDetailContent = buildMcpDetailPanelContent(mcpAction, locale);
  setLibraryPanel((currentPanel) =>
    mcpDetailContentPanel(currentPanel, mcpDetailContent),
  );

  if (!tool || !isConnected) {
    return true;
  }

  const panelTarget = {
    title: mcpAction.title,
    subtitle: mcpAction.subtitle,
  };
  try {
    const toolThreadTitle = mcpToolThreadTitle(tool, locale);
    const backendThreads = await listThreads();
    const matchingThread =
      backendThreads.find(
        (thread) =>
          threadTitle(thread, "") === toolThreadTitle ||
          thread.preview.includes(`${tool.server}.${tool.name}`),
      ) ?? null;
    if (!matchingThread) {
      setLibraryPanel((currentPanel) =>
        mcpToolEmptyHistoryPanel(currentPanel, panelTarget, locale),
      );
      return true;
    }

    const thread = (await readThread(matchingThread.id)) ?? matchingThread;
    setLibraryPanel((currentPanel) =>
      mcpToolHistoryPanel(currentPanel, panelTarget, {
        items: toolThreadHistoryItems(thread, locale),
        locale,
        threadId: thread.id,
      }),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      mcpToolHistoryFailurePanel(currentPanel, panelTarget, error, locale),
    );
  }
  return true;
}
