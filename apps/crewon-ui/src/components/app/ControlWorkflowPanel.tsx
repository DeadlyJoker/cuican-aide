import type {
  RunView,
  WorkflowVersionSummaryView,
  WorkflowVersionView,
} from "@crewon/contracts";
import { useEffect, useRef, useState } from "react";

import type { ControlWorkflowAdapter } from "../../lib/workflow/controlWorkflowAdapter";
import {
  ControlWorkflowInputError,
  followControlWorkflowRun,
  startControlWorkflowRun,
  type WorkflowStreamState,
} from "../../lib/workflow/controlWorkflowRun";
import {
  ControlWorkflowPanelView,
  type ControlWorkflowPanelViewState,
} from "./ControlWorkflowPanelView";

const PAGE_SIZE = 100;
const MAX_PAGES = 16;

type CatalogState = "loading" | "ready" | "unavailable";
type PanelStreamState = WorkflowStreamState | Readonly<{ kind: "idle" }>;

export function ControlWorkflowPanel({
  adapter,
  selectedThreadId,
  onRoomOpenChange,
}: {
  adapter: ControlWorkflowAdapter;
  selectedThreadId: string | null;
  onRoomOpenChange?: (open: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<WorkflowVersionSummaryView[]>([]);
  const [catalogState, setCatalogState] = useState<CatalogState>("loading");
  const [selected, setSelected] = useState<WorkflowVersionView | null>(null);
  const [input, setInput] = useState("{}");
  const [run, setRun] = useState<RunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<PanelStreamState>({
    kind: "idle",
  });
  const requestRef = useRef(0);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const runAbortRef = useRef<AbortController | null>(null);
  const threadRef = useRef(selectedThreadId);

  async function reload(signal: AbortSignal) {
    const request = ++requestRef.current;
    setCatalogState("loading");
    setError(null);
    try {
      const items: WorkflowVersionSummaryView[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await adapter.discover({
          cursor,
          limit: PAGE_SIZE,
          signal,
        });
        items.push(...response.data);
        if (response.nextCursor === null) break;
        if (response.nextCursor === cursor || page === MAX_PAGES - 1) {
          throw new Error("workflow_catalog_pagination_invalid");
        }
        cursor = response.nextCursor;
      }
      if (request !== requestRef.current || signal.aborted) return;
      setCatalog(items);
      setCatalogState("ready");
    } catch (loadError) {
      if (signal.aborted || request !== requestRef.current) return;
      setCatalog([]);
      setCatalogState("unavailable");
      setError(errorMessage(loadError, "无法读取协作流目录"));
    }
  }

  function beginReload() {
    catalogAbortRef.current?.abort();
    const abort = new AbortController();
    catalogAbortRef.current = abort;
    void reload(abort.signal);
  }

  useEffect(() => {
    const abort = new AbortController();
    catalogAbortRef.current = abort;
    void reload(abort.signal);
    return () => {
      requestRef.current += 1;
      abort.abort();
      detailAbortRef.current?.abort();
      runAbortRef.current?.abort();
    };
  }, [adapter]);

  useEffect(() => {
    if (threadRef.current === selectedThreadId) return;
    threadRef.current = selectedThreadId;
    runAbortRef.current?.abort();
    runAbortRef.current = null;
    setRun(null);
    setBusy(false);
    setError(null);
    setStreamState({ kind: "idle" });
  }, [selectedThreadId]);

  async function open(summary: WorkflowVersionSummaryView) {
    const request = ++requestRef.current;
    detailAbortRef.current?.abort();
    runAbortRef.current?.abort();
    const abort = new AbortController();
    detailAbortRef.current = abort;
    setBusy(true);
    setError(null);
    try {
      const version = await adapter.readVersion(
        summary.workflowVersionId,
        abort.signal,
      );
      if (request !== requestRef.current || abort.signal.aborted) return;
      setSelected(version);
      setRun(null);
      setStreamState({ kind: "idle" });
      onRoomOpenChange?.(true);
    } catch (readError) {
      if (request === requestRef.current && !abort.signal.aborted) {
        setError(errorMessage(readError, "无法读取协作流定义"));
      }
    } finally {
      if (request === requestRef.current) setBusy(false);
      if (detailAbortRef.current === abort) detailAbortRef.current = null;
    }
  }

  async function start() {
    if (selected === null || selectedThreadId === null || busy) return;
    runAbortRef.current?.abort();
    const abort = new AbortController();
    runAbortRef.current = abort;
    setBusy(true);
    setError(null);
    setStreamState({ kind: "connecting" });
    try {
      const started = await startControlWorkflowRun(adapter, {
        raw: input,
        workflowVersionId: selected.workflowVersionId,
        threadId: selectedThreadId,
        signal: abort.signal,
      });
      if (runAbortRef.current !== abort || abort.signal.aborted) return;
      setRun(started);
      setBusy(false);
      await followControlWorkflowRun(adapter, started, {
        signal: abort.signal,
        onRun: (next) => {
          if (runAbortRef.current === abort) setRun(next);
        },
        onStreamState: (next) => {
          if (runAbortRef.current === abort) setStreamState(next);
        },
      });
    } catch (runError) {
      if (!abort.signal.aborted && runAbortRef.current === abort) {
        setError(errorMessage(runError, "协作流执行失败"));
        setStreamState({ kind: "idle" });
      }
    } finally {
      if (runAbortRef.current === abort) {
        runAbortRef.current = null;
        setBusy(false);
      }
    }
  }

  function close() {
    requestRef.current += 1;
    detailAbortRef.current?.abort();
    runAbortRef.current?.abort();
    setSelected(null);
    setRun(null);
    setBusy(false);
    setError(null);
    setStreamState({ kind: "idle" });
    onRoomOpenChange?.(false);
  }

  const state: ControlWorkflowPanelViewState = {
    busy,
    catalog,
    catalogState,
    error,
    input,
    run,
    selected,
    selectedThreadId,
    streamState,
  };
  return (
    <ControlWorkflowPanelView
      state={state}
      onClose={close}
      onInputChange={setInput}
      onOpen={(summary) => void open(summary)}
      onReload={beginReload}
      onStart={() => void start()}
    />
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ControlWorkflowInputError) {
    return error.code === "invalid_json"
      ? "输入必须是有效的严格 JSON。"
      : "输入 JSON 不符合 Control Workflow 输入约束。";
  }
  return error instanceof Error ? error.message : fallback;
}
