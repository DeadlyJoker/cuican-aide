import type { Thread } from "@crewon-protocol/v2/Thread";

import { backendThreadId } from "../thread/threadIds";
import type { NoticeState } from "../shared/noticeState";
import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  knowledgeDisconnectedPanel,
  knowledgeResetConfirmMessage,
  knowledgeResetDemoPanel,
  knowledgeResetFailurePanel,
  knowledgeResetProgressPanel,
  knowledgeResetSuccessNotice,
  knowledgeWriteFailurePanel,
  knowledgeWriteMissingWorkspacePanel,
  knowledgeWriteProgressPanel,
  knowledgeWriteSuccessNotice,
} from "../knowledge/knowledgeMemoryPanel";
import { threadTitle } from "../thread/threadModel";
import type { ConfirmHandler } from "../shared/confirmHandler";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type KnowledgeLibraryActionParams = {
  action: LibraryPanelAction;
  confirm: ConfirmHandler;
  isConnected: boolean;
  isDemo: boolean;
  locale: Locale;
  openKnowledgeLibrary: () => Promise<void>;
  resetMemory: () => Promise<void>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  writeKnowledgeMemory: () => Promise<string | null>;
};

export type KnowledgeMemoryThreadContext = {
  selectedThreadId: string | null;
  selectedThreadTitle: string | null;
};

export function knowledgeMemoryThreadContext(params: {
  selectedThreadId: string | null;
  threads: readonly Thread[];
}): KnowledgeMemoryThreadContext {
  const selectedBackendThreadId = backendThreadId(params.selectedThreadId);
  const selectedBackendThread = selectedBackendThreadId
    ? params.threads.find((thread) => thread.id === selectedBackendThreadId)
    : null;
  const selectedBackendThreadTitle =
    selectedBackendThread && threadTitle(selectedBackendThread, "")
      ? threadTitle(selectedBackendThread, "")
      : null;

  return {
    selectedThreadId: selectedBackendThread?.id ?? null,
    selectedThreadTitle: selectedBackendThreadTitle,
  };
}

export async function handleKnowledgeLibraryAction({
  action,
  confirm,
  isConnected,
  isDemo,
  locale,
  openKnowledgeLibrary,
  resetMemory,
  setLibraryPanel,
  setNotice,
  writeKnowledgeMemory,
}: KnowledgeLibraryActionParams): Promise<boolean> {
  if (action.id === "refresh-knowledge") {
    await openKnowledgeLibrary();
    return true;
  }

  if (action.id === "reset-memory") {
    if (isDemo) {
      setLibraryPanel((currentPanel) =>
        knowledgeResetDemoPanel(currentPanel, locale),
      );
      return true;
    }

    if (!isConnected) {
      setLibraryPanel((currentPanel) =>
        knowledgeDisconnectedPanel(currentPanel, locale),
      );
      return true;
    }

    if (!(await confirm(knowledgeResetConfirmMessage(locale)))) {
      return true;
    }

    setLibraryPanel((currentPanel) =>
      knowledgeResetProgressPanel(currentPanel, locale),
    );
    try {
      await resetMemory();
      await openKnowledgeLibrary();
      setNotice(knowledgeResetSuccessNotice(locale));
    } catch (error) {
      setLibraryPanel((currentPanel) =>
        knowledgeResetFailurePanel(currentPanel, error, locale),
      );
    }
    return true;
  }

  if (action.id === "create-knowledge-memory") {
    setLibraryPanel((currentPanel) =>
      knowledgeWriteProgressPanel(currentPanel, locale),
    );
    try {
      const path = await writeKnowledgeMemory();
      if (!path) {
        setLibraryPanel((currentPanel) =>
          knowledgeWriteMissingWorkspacePanel(currentPanel, locale),
        );
        return true;
      }
      await openKnowledgeLibrary();
      setNotice(knowledgeWriteSuccessNotice(path, locale));
    } catch (error) {
      setLibraryPanel((currentPanel) =>
        knowledgeWriteFailurePanel(currentPanel, error, locale),
      );
    }
    return true;
  }

  return false;
}
