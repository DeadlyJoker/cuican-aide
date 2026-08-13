import type { Thread } from "@crewon-ui-model/v2/Thread";

import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { AppView } from "../shared/appView";
import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  libraryOpenThreadFailureNotice,
  libraryOpenThreadOpenedNotice,
  libraryOpenThreadUnavailableNotice,
} from "./libraryActionPresentation";
import { threadTitle, upsertThread } from "../thread/threadModel";

type StateSetter<T> = (updater: (current: T) => T) => void;

export type LibraryThreadActionParams = {
  action: LibraryPanelAction;
  locale: Locale;
  readThread: (threadId: string) => Promise<Thread | null | undefined>;
  setAppView: (view: AppView) => void;
  setCapabilityPanel: (panel: CapabilityPanel | null) => void;
  setLibraryPanel: (panel: LibraryPanel | null) => void;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setThreads: StateSetter<Thread[]>;
};

export async function handleLibraryThreadAction({
  action,
  locale,
  readThread,
  setAppView,
  setCapabilityPanel,
  setLibraryPanel,
  setNotice,
  setSelectedThreadId,
  setThreads,
}: LibraryThreadActionParams): Promise<boolean> {
  if (action.id !== "open-thread") {
    return false;
  }

  if (!action.threadId) {
    setNotice(libraryOpenThreadUnavailableNotice(locale));
    return true;
  }

  try {
    const thread = await readThread(action.threadId);
    if (thread) {
      setThreads((current) => upsertThread(current, thread));
      setSelectedThreadId(thread.id);
      setAppView("chat");
      setLibraryPanel(null);
      setCapabilityPanel(null);
      setNotice(
        libraryOpenThreadOpenedNotice(threadTitle(thread, thread.id), locale),
      );
    }
  } catch (error) {
    setNotice(libraryOpenThreadFailureNotice(error, locale));
  }

  return true;
}
