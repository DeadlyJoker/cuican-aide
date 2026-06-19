import { useEffect, useRef, type MutableRefObject } from "react";
import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import { pollLoadedThreadIdsAction } from "../appConnectionActions";
import type { NoticeState } from "../appRuntimeState";
import type { Locale } from "../../i18n";
import { runThreadSearchEffectAction } from "../../thread/threadSearchActions";

type SelectedThreadSetter = (
  updater: (currentThreadId: string | null) => string | null,
) => void;

export type AppThreadListEffectsParams = {
  client: AppServerClient | null;
  isConnected: boolean;
  isDemoPreview: boolean;
  localeRef: MutableRefObject<Locale>;
  searchTerm: string;
  setIsSearchingThreads: (isSearching: boolean) => void;
  setLoadedThreadIds: (threadIds: string[]) => void;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setThreads: (threads: Thread[]) => void;
  showArchivedThreads: boolean;
  showArchivedThreadsRef: MutableRefObject<boolean>;
  showDemoThreads: () => void;
};

export function useAppThreadListEffects({
  client,
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
      clearInterval: window.clearInterval,
      client,
      isConnected,
      setInterval: window.setInterval,
      setLoadedThreadIds,
    });
  }, [client, isConnected, setLoadedThreadIds]);

  useEffect(() => {
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;

    return runThreadSearchEffectAction({
      clearTimeout: window.clearTimeout,
      client,
      currentRequestId: () => searchRequestRef.current,
      isConnected,
      isDemoPreview,
      locale: localeRef.current,
      requestId,
      searchTerm,
      setIsSearchingThreads,
      setNotice,
      setSelectedThreadId,
      setThreads,
      setTimeout: window.setTimeout,
      showArchivedThreads: showArchivedThreadsRef.current,
      showDemoThreads,
    });
  }, [
    client,
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
