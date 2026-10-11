import {
  useCallback,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import {
  createThreadCollectionReducer,
  initialThreadCollection,
  materializeThreads,
} from "../thread/threadDetailCache";

import { useStreamingTextState } from "../thread/useStreamingTextState";
import { usePendingThreadSubmissions } from "../thread/usePendingThreadSubmissions";
import { initialThreadRouteSelection } from "./appThreadRoute";

export function useAppThreadState() {
  const [showArchivedThreads, setShowArchivedThreads] = useState(false);
  const showArchivedThreadsRef = useRef(false);
  const [threadSearchTerm, setThreadSearchTerm] = useState("");
  const [isSearchingThreads, setIsSearchingThreads] = useState(false);
  const [loadedThreadIds, setLoadedThreadIds] = useState<string[]>([]);
  const reducerRef = useRef<ReturnType<
    typeof createThreadCollectionReducer
  > | null>(null);
  if (reducerRef.current === null)
    reducerRef.current = createThreadCollectionReducer();
  const [collection, dispatch] = useReducer(
    reducerRef.current,
    undefined,
    () => ({
      ...initialThreadCollection(),
      selectedThreadId: initialThreadRouteSelection(),
    }),
  );
  const threads = useMemo(() => materializeThreads(collection), [collection]);
  const { selectedThreadId, activeTurnByThread } = collection;
  const selectedThreadIdRef = useRef<string | null>(null);
  const selectionEpochRef = useRef(0);
  selectedThreadIdRef.current = selectedThreadId;
  const setThreads: Dispatch<SetStateAction<Thread[]>> = useCallback(
    (update) => {
      dispatch({ type: "threads", update });
    },
    [],
  );
  const setThreadCatalogPage = useCallback((threads: readonly Thread[]) => {
    dispatch({ type: "catalogPage", threads });
  }, []);
  const setSelectedThreadId: Dispatch<SetStateAction<string | null>> =
    useCallback((update) => {
      selectedThreadIdRef.current =
        typeof update === "function"
          ? update(selectedThreadIdRef.current)
          : update;
      selectionEpochRef.current += 1;
      dispatch({ type: "selection", update });
    }, []);
  const setActiveTurnByThread: Dispatch<
    SetStateAction<Record<string, string>>
  > = useCallback((update) => {
    dispatch({ type: "activeTurns", update });
  }, []);
  const threadsRef = useRef<Thread[]>([]);
  const activeTurnByThreadRef = useRef<Record<string, string>>({});
  activeTurnByThreadRef.current = activeTurnByThread;
  const streamingState = useStreamingTextState(selectedThreadId);
  const pendingSubmissionState = usePendingThreadSubmissions(selectionEpochRef);

  return {
    ...streamingState,
    ...pendingSubmissionState,
    activeTurnByThread,
    activeTurnByThreadRef,
    isSearchingThreads,
    loadedThreadIds,
    selectedThreadId,
    selectedThreadIdRef,
    selectionEpochRef,
    setActiveTurnByThread,
    setIsSearchingThreads,
    setLoadedThreadIds,
    setSelectedThreadId,
    setShowArchivedThreads,
    setThreadSearchTerm,
    setThreadCatalogPage,
    setThreads,
    showArchivedThreads,
    showArchivedThreadsRef,
    threadSearchTerm,
    threadDetailCacheUsage: collection.usage,
    threadCatalogIds: collection.catalogIds,
    threads,
    threadsRef,
  };
}
