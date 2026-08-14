import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Thread } from "@crewon-ui-model/v2/Thread";

import { pollLoadedThreadIdsAction } from "../appConnectionActions";
import type { NoticeState } from "../appRuntimeState";
import type { Locale } from "../../i18n";
import { runThreadSearchEffectAction } from "../../thread/threadSearchActions";
import type { EmptyThreadSelectionBehavior } from "../../thread/threadModel";

type SelectedThreadSetter = (
  updater: (currentThreadId: string | null) => string | null,
) => void;

type ThreadListEffectControlPort = {
  listLoadedThreadIds(): Promise<string[]>;
  listThreads(showArchived: boolean): Promise<Thread[]>;
  searchThreads(searchTerm: string, showArchived: boolean): Promise<Thread[]>;
};

export type AppThreadListEffectsParams = {
  client: ThreadListEffectControlPort | null;
  emptySelectionBehavior: EmptyThreadSelectionBehavior;
  isConnected: boolean;
  localeRef: MutableRefObject<Locale>;
  searchTerm: string;
  setIsSearchingThreads: (isSearching: boolean) => void;
  setLoadedThreadIds: (threadIds: string[]) => void;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  showArchivedThreads: boolean;
  showArchivedThreadsRef: MutableRefObject<boolean>;
};

export function useAppThreadListEffects({
  client,
  emptySelectionBehavior,
  isConnected,
  localeRef,
  searchTerm,
  setIsSearchingThreads,
  setLoadedThreadIds,
  setNotice,
  setSelectedThreadId,
  setThreads,
  showArchivedThreads,
  showArchivedThreadsRef,
}: AppThreadListEffectsParams) {
  const searchRequestRef = useRef(0);

  useEffect(() => {
    showArchivedThreadsRef.current = showArchivedThreads;
  }, [showArchivedThreads, showArchivedThreadsRef]);

  useEffect(() => {
    return pollLoadedThreadIdsAction({
      clearInterval: (intervalId) => window.clearInterval(intervalId),
      client,
      isConnected,
      setInterval: (handler, timeout) => window.setInterval(handler, timeout),
      setLoadedThreadIds,
    });
  }, [client, isConnected, setLoadedThreadIds]);

  useEffect(() => {
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;

    return runThreadSearchEffectAction({
      clearTimeout: (timeoutId) => window.clearTimeout(timeoutId),
      client,
      currentRequestId: () => searchRequestRef.current,
      emptySelectionBehavior,
      isConnected,
      locale: localeRef.current,
      requestId,
      searchTerm,
      setIsSearchingThreads,
      setNotice,
      setSelectedThreadId,
      setThreads,
      setTimeout: (handler, timeout) => window.setTimeout(handler, timeout),
      showArchivedThreads: showArchivedThreadsRef.current,
    });
  }, [
    client,
    emptySelectionBehavior,
    isConnected,
    localeRef,
    searchTerm,
    setIsSearchingThreads,
    setNotice,
    setSelectedThreadId,
    setThreads,
    showArchivedThreads,
    showArchivedThreadsRef,
  ]);
}
