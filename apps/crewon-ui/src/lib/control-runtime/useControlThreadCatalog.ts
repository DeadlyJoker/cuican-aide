import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import {
  ControlThreadRuntime,
  controlThreadSummary,
} from "./controlThreadRuntime";
import { EMPTY_CONTROL_CATALOG } from "./controlThreadCatalog";
import { isSingleConversationThread } from "../thread/threadSourceFilters";
import { upsertThread } from "../thread/threadModel";
import type { ThreadCatalogNavigation } from "../thread/threadCatalogNavigation";
import type { ThreadSelectionRead } from "../thread/useThreadSelectionRead";

const noSubscription = () => () => {};
const emptySnapshot = () => EMPTY_CONTROL_CATALOG;

export function useControlThreadCatalog(params: {
  runSelectionRead: ThreadSelectionRead;
  runtime: ControlThreadRuntime | null;
  connected: boolean;
  search: string;
  archived: boolean;
  preserveEmptySelection: boolean;
  selectedThreadId: string | null;
  setSelectedThreadId: (id: string | null) => void;
  setThreadCatalogPage: (threads: readonly Thread[]) => void;
  setThreads: (update: (threads: Thread[]) => Thread[]) => void;
}): ThreadCatalogNavigation | undefined {
  const catalog = params.runtime?.catalog;
  const snapshot = useSyncExternalStore(
    catalog?.subscribe ?? noSubscription,
    catalog?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  const latest = useRef(params);
  latest.current = params;
  const initialized = useRef<ControlThreadRuntime | null>(null);
  const [initialSelection, setInitialSelection] = useState<{
    runtime: ControlThreadRuntime;
    threadId: string;
  } | null>(null);
  useEffect(() => {
    if (initialized.current !== params.runtime) initialized.current = null;
    setInitialSelection((current) =>
      current?.runtime === params.runtime ? current : null,
    );
  }, [params.runtime]);
  useEffect(() => {
    if (!params.connected || catalog === undefined) return;
    latest.current.setThreadCatalogPage([]);
    const timer = setTimeout(
      () => {
        void catalog
          .load({
            status: params.archived ? "archived" : "active",
            search: params.search,
          })
          .catch(() => undefined);
      },
      params.search.trim() === "" ? 0 : 180,
    );
    return () => {
      clearTimeout(timer);
      catalog.cancel();
    };
  }, [catalog, params.connected, params.search, params.archived]);

  useEffect(() => {
    const current = latest.current;
    if (
      snapshot.revision === 0 ||
      current.runtime === null ||
      snapshot.filter.search !== current.search.trim() ||
      snapshot.filter.status !== (current.archived ? "archived" : "active")
    )
      return;
    const page = snapshot.threads.map(controlThreadSummary);
    current.setThreadCatalogPage(page);
    if (initialized.current === current.runtime) return;
    initialized.current = current.runtime;
    let selected = current.selectedThreadId;
    if (
      selected === null &&
      !current.preserveEmptySelection &&
      snapshot.filter.search === ""
    ) {
      selected = page.find(isSingleConversationThread)?.id ?? null;
      current.setSelectedThreadId(selected);
    }
    if (selected !== null)
      setInitialSelection({ runtime: current.runtime, threadId: selected });
    // Loading/error transitions do not reapply a stale page or reset the selected conversation.
  }, [catalog, snapshot.revision]);

  // Run after the initial selection commits. StrictMode cleanup must not leave
  // a completed initialization latch pointing at an already-canceled read.
  useEffect(() => {
    const current = latest.current;
    if (
      !current.connected ||
      !initialSelection ||
      current.runtime !== initialSelection.runtime ||
      current.selectedThreadId !== initialSelection.threadId
    )
      return;
    const { runtime, threadId } = initialSelection;
    void current
      .runSelectionRead(threadId, async (signal) => {
        const thread = await runtime.readThread(threadId, { signal });
        signal.throwIfAborted();
        if (
          latest.current.runtime === runtime &&
          latest.current.selectedThreadId === threadId
        )
          current.setThreads((threads) => upsertThread(threads, thread));
      })
      .catch(() => undefined);
  }, [initialSelection, params.runtime, params.connected]);

  return useMemo(() => {
    if (catalog === undefined) return undefined;
    const navigate = (direction: "older" | "newer" | "latest") => {
      void catalog.navigate(direction).catch(() => undefined);
    };
    return {
      loading:
        snapshot.loading ||
        (snapshot.error === null &&
          (snapshot.filter.search !== params.search.trim() ||
            snapshot.filter.status !==
              (params.archived ? "archived" : "active"))),
      empty: !snapshot.threads.some((thread) =>
        isSingleConversationThread(controlThreadSummary(thread)),
      ),
      searching: snapshot.filter.search !== "",
      hasOlder: snapshot.olderCursor !== null,
      hasNewer: snapshot.newerCursor !== null,
      failed: snapshot.error !== null,
      onOlder: () => navigate("older"),
      onNewer: () => navigate("newer"),
      onRefresh: () => {
        void catalog
          .load({
            status: params.archived ? "archived" : "active",
            search: params.search,
          })
          .catch(() => undefined);
      },
    };
  }, [catalog, snapshot, params.search, params.archived]);
}
