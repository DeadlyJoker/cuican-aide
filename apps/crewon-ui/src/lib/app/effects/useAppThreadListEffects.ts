import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import { pollLoadedThreadIdsAction } from "../appConnectionActions";
import type { NoticeState } from "../appRuntimeState";
import type { Locale } from "../../i18n";
import { runThreadSearchEffectAction } from "../../thread/threadSearchActions";
import type { EmptyThreadSelectionBehavior } from "../../thread/threadModel";

type SelectedThreadSetter = (
  updater: (currentThreadId: string | null) => string | null,
) => void;

export type AppThreadListEffectsParams = {
  client: AppServerClient | null;
  emptySelectionBehavior: EmptyThreadSelectionBehavior;
  isConnected: boolean;
  isDemoPreview: boolean;
  localeRef: MutableRefObject<Locale>;
  searchTerm: string;
  setIsSearchingThreads: (isSearching: boolean) => void;
  setLoadedThreadIds: (threadIds: string[]) => void;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  showArchivedThreads: boolean;
  showArchivedThreadsRef: MutableRefObject<boolean>;
  showDemoThreads: () => void;
};

export function useAppThreadListEffects({
  client,
  emptySelectionBehavior,
  isConnected,
  isDemoPreview,
  localeRef,
  searchTerm,
  setIsSearchingThreads,
  setLoadedThreadIds,
  setNotice,
  setSelectedThreadId,
  setThreads,
  showArchivedThreads,
  showArchivedThreadsRef,
  showDemoThreads,
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
      isDemoPreview,
      locale: localeRef.current,
      requestId,
      searchTerm,
      setIsSearchingThreads,
      setNotice,
      setSelectedThreadId,
      setThreads,
      setTimeout: (handler, timeout) => window.setTimeout(handler, timeout),
      showArchivedThreads: showArchivedThreadsRef.current,
      showDemoThreads,
    });
  }, [
    client,
    emptySelectionBehavior,
    isConnected,
    isDemoPreview,
    localeRef,
    searchTerm,
    setIsSearchingThreads,
    setNotice,
    setSelectedThreadId,
    setThreads,
    showArchivedThreads,
    showArchivedThreadsRef,
    showDemoThreads,
  ]);
}
