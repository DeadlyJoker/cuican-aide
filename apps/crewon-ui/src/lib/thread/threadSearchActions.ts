import type { Thread } from "@crewon-ui-model/v2/Thread";

import type { NoticeState } from "../shared/noticeState";
import type { Locale } from "../i18n";
import {
  threadListFailureNotice,
  threadSearchFailureNotice,
} from "./threadActionPresentation";
import {
  type EmptyThreadSelectionBehavior,
  mergeThreadListSummaries,
  selectedThreadIdAfterThreadList,
} from "./threadModel";

type ThreadSearchClient = {
  listThreads(showArchived: boolean): Promise<Thread[]>;
  searchThreads(searchTerm: string, showArchived: boolean): Promise<Thread[]>;
};

type SelectedThreadSetter = (
  updater: (currentThreadId: string | null) => string | null,
) => void;
type ThreadListSetter = (updater: (currentThreads: Thread[]) => Thread[]) => void;

export function runThreadSearchEffectAction(params: {
  clearTimeout: (timeoutId: ReturnType<typeof setTimeout>) => void;
  client: ThreadSearchClient | null | undefined;
  currentRequestId: () => number;
  isConnected: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  emptySelectionBehavior: EmptyThreadSelectionBehavior;
  requestId: number;
  searchTerm: string;
  setIsSearchingThreads: (isSearching: boolean) => void;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setThreads: ThreadListSetter;
  setTimeout: (
    handler: () => void,
    timeout: number,
  ) => ReturnType<typeof setTimeout>;
  showArchivedThreads: boolean;
  showDemoThreads: () => void;
}): (() => void) | undefined {
  const trimmedSearchTerm = params.searchTerm.trim();

  if (params.isDemoPreview) {
    params.setIsSearchingThreads(false);
    params.showDemoThreads();
    return undefined;
  }

  if (!params.isConnected) {
    params.setIsSearchingThreads(false);
    return undefined;
  }

  params.setIsSearchingThreads(true);

  if (!trimmedSearchTerm) {
    void runThreadRequest({
      ...params,
      failureNotice: threadListFailureNotice,
      request: () => params.client?.listThreads(params.showArchivedThreads),
    });
    return undefined;
  }

  const timeoutId = params.setTimeout(() => {
    void runThreadRequest({
      ...params,
      failureNotice: threadSearchFailureNotice,
      request: () =>
        params.client?.searchThreads(
          trimmedSearchTerm,
          params.showArchivedThreads,
        ),
    });
  }, 180);

  return () => params.clearTimeout(timeoutId);
}

async function runThreadRequest(params: {
  currentRequestId: () => number;
  emptySelectionBehavior: EmptyThreadSelectionBehavior;
  failureNotice: (error: unknown, locale: Locale) => NoticeState;
  locale: Locale;
  request: () => Promise<Thread[]> | undefined;
  requestId: number;
  setIsSearchingThreads: (isSearching: boolean) => void;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setThreads: ThreadListSetter;
}): Promise<void> {
  try {
    const serverThreads = await params.request();
    if (params.currentRequestId() !== params.requestId) {
      return;
    }

    params.setThreads((currentThreads) =>
      mergeThreadListSummaries(currentThreads, serverThreads ?? []),
    );
    params.setSelectedThreadId((currentThreadId) => {
      if (
        currentThreadId === null &&
        params.emptySelectionBehavior === "preserve"
      ) {
        return null;
      }
      return selectedThreadIdAfterThreadList(currentThreadId, serverThreads);
    });
  } catch (error) {
    if (params.currentRequestId() === params.requestId) {
      params.setNotice(params.failureNotice(error, params.locale));
    }
  } finally {
    if (params.currentRequestId() === params.requestId) {
      params.setIsSearchingThreads(false);
    }
  }
}
