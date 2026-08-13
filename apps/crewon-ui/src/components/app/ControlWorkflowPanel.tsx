import { ArrowLeft, RotateCw, Square } from "lucide-react";
import type {
  RunEventView,
  RunView,
  StartWorkflowRunRequest,
  WorkflowVersionSummaryView,
  WorkflowVersionView,
} from "@crewon/contracts";
import { useEffect, useRef, useState } from "react";

import type { ControlWorkflowAdapter } from "../../lib/workflow/controlWorkflowAdapter";

const PAGE_SIZE = 100;
const MAX_PAGES = 16;

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
  const [catalogState, setCatalogState] = useState<
    "loading" | "ready" | "unavailable"
  >("loading");
  const [selected, setSelected] = useState<WorkflowVersionView | null>(null);
  const [input, setInput] = useState("{}");
  const [run, setRun] = useState<RunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const runAbortRef = useRef<AbortController | null>(null);

  async function reload(signal?: AbortSignal) {
    const request = ++requestRef.current;
    setCatalogState("loading");
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
        if (response.nextCursor === cursor || page === MAX_PAGES - 1)
          throw new Error("workflow_catalog_pagination_invalid");
        cursor = response.nextCursor;
      }
      if (request !== requestRef.current || signal?.aborted) return;
      setCatalog(items);
      setCatalogState("ready");
    } catch (loadError) {
      if (signal?.aborted || request !== requestRef.current) return;
      setCatalog([]);
      setCatalogState("unavailable");
      setError(message(loadError, "无法读取协作流目录"));
    }
  }

  useEffect(() => {
    const abort = new AbortController();
    void reload(abort.signal);
    return () => {
      requestRef.current += 1;
      abort.abort();
      runAbortRef.current?.abort();
    };
  }, [adapter]);

  async function open(summary: WorkflowVersionSummaryView) {
    const request = ++requestRef.current;
    setBusy(true);
    setError(null);
    try {
      const version = await adapter.readVersion(summary.workflowVersionId);
      if (request !== requestRef.current) return;
      setSelected(version);
      setRun(null);
      onRoomOpenChange?.(true);
    } catch (readError) {
      if (request === requestRef.current)
        setError(message(readError, "无法读取协作流定义"));
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  }

  async function start() {
    if (selected === null || selectedThreadId === null || busy) return;
    let value: StartWorkflowRunRequest["input"];
    try {
      value = JSON.parse(input) as StartWorkflowRunRequest["input"];
    } catch {
      setError("输入必须是有效 JSON，并符合当前协作流的输入 Schema。");
      return;
    }
    const abort = new AbortController();
    runAbortRef.current?.abort();
    runAbortRef.current = abort;
    setBusy(true);
    setError(null);
    try {
      const started = await adapter.start({
        workflowVersionId: selected.workflowVersionId,
        threadId: selectedThreadId,
        value,
        signal: abort.signal,
      });
      setRun(started);
      setBusy(false);
      await followRun(adapter, started, abort.signal, setRun);
    } catch (runError) {
      if (!abort.signal.aborted)
        setError(message(runError, "协作流执行失败"));
    } finally {
      if (runAbortRef.current === abort) {
        runAbortRef.current = null;
        setBusy(false);
      }
    }
  }

  async function cancel() {
    if (run === null || terminal(run.status) || busy) return;
    setBusy(true);
    setError(null);
    try {
      setRun(await adapter.cancel(run));
    } catch (cancelError) {
      setError(message(cancelError, "无法取消协作流"));
    } finally {
      setBusy(false);
    }
  }

  if (selected === null) {
    if (catalogState !== "ready")
      return <EmptyState state={catalogState} reload={() => void reload()} />;
    if (catalog.length === 0)
      return <EmptyState state="empty" reload={() => void reload()} />;
    return (
      <div className="workflow-list" aria-label="Control 协作流版本目录">
        {catalog.map((workflow) => (
          <button
            className="workflow-list-item"
            key={workflow.workflowVersionId}
            type="button"
            disabled={busy}
            onClick={() => void open(workflow)}
          >
            <span className="workflow-list-main">
              <strong>{workflow.name}</strong>
              <em className="status success">已发布</em>
            </span>
            <span className="workflow-list-meta">
              <span className="workflow-list-copy">{workflow.description}</span>
              <span className="workflow-member-strip">
                <small>流</small>
                <em>{workflow.workflowVersionId}</em>
              </span>
            </span>
            <span className="workflow-list-foot">
              <b>查看定义</b>
            </span>
          </button>
        ))}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    );
  }

  return (
    <section className="workflow-room-inline workflow-runtime-room">
      <header className="workflow-room-top">
        <button
          className="button compact"
          type="button"
          onClick={() => {
            runAbortRef.current?.abort();
            setSelected(null);
            setRun(null);
            setError(null);
            onRoomOpenChange?.(false);
          }}
        >
          <ArrowLeft aria-hidden="true" /> 返回
        </button>
        <div className="workflow-room-title-block">
          <span>Control Workflow</span>
          <h3>{selected.name}</h3>
          <p>{selected.description}</p>
        </div>
        {run !== null && !terminal(run.status) ? (
          <button
            className="button compact workflow-cancel-button"
            type="button"
            disabled={busy}
            onClick={() => void cancel()}
          >
            <Square aria-hidden="true" /> 取消运行
          </button>
        ) : null}
      </header>
      <main className="workflow-room-stage">
        <section className="workflow-execution-strip" aria-label="静态节点定义">
          {selected.nodes.map((node, index) => (
            <article className="workflow-step-node" key={node.nodeId}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{node.title}</strong>
                <p>{node.kind === "humanGate" ? "人工确认（当前 UI 只读）" : node.kind}</p>
              </div>
              <em className="status">定义节点</em>
            </article>
          ))}
        </section>
        <section className="workflow-chat-panel">
          <div className="workflow-room-thread" role="log">
            <article className="office-room-message">
              <span className="team-avatar">流</span>
              <div>
                <strong>不可变版本 {selected.workflowVersionId}</strong>
                <p>节点状态不做推断；运行进度仅来自 canonical Run。</p>
              </div>
            </article>
            {run ? <RunMessage run={run} /> : null}
            {error ? <p role="alert">{error}</p> : null}
          </div>
          <label className="form-field workflow-global-composer">
            <span>Workflow JSON 输入</span>
            <textarea
              aria-label="Workflow JSON 输入"
              disabled={busy || (run !== null && !terminal(run.status))}
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            <button
              className="button primary"
              type="button"
              disabled={busy || selectedThreadId === null || (run !== null && !terminal(run.status))}
              onClick={() => void start()}
            >
              {busy ? "执行中…" : "启动协作流"}
            </button>
            {selectedThreadId === null ? <small>请先打开一个 Control 会话。</small> : null}
          </label>
        </section>
      </main>
    </section>
  );
}

async function followRun(
  adapter: ControlWorkflowAdapter,
  started: RunView,
  signal: AbortSignal,
  setRun: (run: RunView) => void,
) {
  let cursor = started.lastSequence;
  let current = started;
  for (let reconnect = 0; reconnect < 3 && !terminal(current.status); reconnect += 1) {
    for await (const event of adapter.events({
      runId: started.runId,
      afterSequence: cursor,
      signal,
    })) {
      cursor = event.sequence;
      if (runLifecycle(event)) {
        current = await adapter.readRun(started.runId, signal);
        setRun(current);
        if (terminal(current.status)) return;
      }
    }
    current = await adapter.readRun(started.runId, signal);
    setRun(current);
  }
  if (!terminal(current.status)) throw new Error("workflow_event_stream_ended");
}

function runLifecycle(event: RunEventView) {
  return event.type.startsWith("run.");
}

function terminal(status: RunView["status"]) {
  return status === "completed" || status === "failed" || status === "canceled";
}

function RunMessage({ run }: { run: RunView }) {
  return (
    <article className="office-room-message">
      <span className="team-avatar">流</span>
      <div>
        <strong>Run #{run.runId}</strong>
        <p>
          状态：{run.status}
          {run.outputRef ? ` · 输出引用：${run.outputRef}` : ""}
          {run.failure ? ` · ${run.failure.code}` : ""}
        </p>
      </div>
    </article>
  );
}

function EmptyState({
  state,
  reload,
}: {
  state: "loading" | "unavailable" | "empty";
  reload: () => void;
}) {
  const copy =
    state === "loading"
      ? ["正在读取协作流", "正在从 CrewON Control 读取不可变版本目录。"]
      : state === "empty"
        ? ["还没有已发布的协作流", "发布 WorkflowVersion 后即可在这里启动。"]
        : ["协作流服务暂不可用", "请检查 CrewON Control 连接后重试。"];
  return (
    <section className="team-office-empty team-capability-live-empty">
      <span className="team-office-empty-kicker">CrewON Workflow</span>
      <h2>{copy[0]}</h2>
      <p>{copy[1]}</p>
      <button className="button" type="button" onClick={reload}>
        <RotateCw aria-hidden="true" /> 重新同步
      </button>
    </section>
  );
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
