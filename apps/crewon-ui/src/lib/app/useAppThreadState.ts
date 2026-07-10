import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Thread } from "@crewon-protocol/v2/Thread";

import {
  createStreamingTextBuffer,
  type StreamingTextByThread,
} from "../thread/threadStreamingTextBuffer";

export function useAppThreadState() {
  const [showArchivedThreads, setShowArchivedThreads] = useState(false);
  const showArchivedThreadsRef = useRef(false);
  const [threadSearchTerm, setThreadSearchTerm] = useState("");
  const [isSearchingThreads, setIsSearchingThreads] = useState(false);
  const [loadedThreadIds, setLoadedThreadIds] = useState<string[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const threadsRef = useRef<Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const selectedThreadIdRef = useRef<string | null>(null);
  const [activeTurnByThread, setActiveTurnByThread] = useState<
    Record<string, string>
  >({});
  const [streamingTextByThread, setStreamingTextByThreadState] =
    useState<StreamingTextByThread>({});
  const streamingTextBufferRef = useRef<ReturnType<
    typeof createStreamingTextBuffer
  > | null>(null);

  if (streamingTextBufferRef.current === null) {
    streamingTextBufferRef.current = createStreamingTextBuffer(
      setStreamingTextByThreadState,
    );
  }

  const setStreamingTextByThread: Dispatch<
    SetStateAction<StreamingTextByThread>
  > = useCallback((next) => {
    streamingTextBufferRef.current?.clearPending();
    setStreamingTextByThreadState(next);
  }, []);

  const appendStreamingTextDelta = useCallback(
    (threadId: string, delta: string) => {
      streamingTextBufferRef.current?.append(threadId, delta);
    },
    [],
  );

  useEffect(
    () => () => {
      streamingTextBufferRef.current?.dispose();
    },
    [],
  );

  return {
    activeTurnByThread,
    appendStreamingTextDelta,
    isSearchingThreads,
    loadedThreadIds,
    selectedThreadId,
    selectedThreadIdRef,
    setActiveTurnByThread,
    setIsSearchingThreads,
    setLoadedThreadIds,
    setSelectedThreadId,
    setShowArchivedThreads,
    setStreamingTextByThread,
    setThreadSearchTerm,
    setThreads,
    showArchivedThreads,
    showArchivedThreadsRef,
    streamingTextByThread,
    threadSearchTerm,
    threads,
    threadsRef,
  };
}
