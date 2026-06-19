import { useRef, useState } from "react";
import type { Thread } from "@crewon-protocol/v2/Thread";

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
  const [streamingTextByThread, setStreamingTextByThread] = useState<
    Record<string, string>
  >({});

  return {
    activeTurnByThread,
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
