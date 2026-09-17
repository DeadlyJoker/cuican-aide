import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ControlThreadRuntime } from "../lib/control-runtime/controlThreadRuntime";
import { transcriptWindow } from "../lib/control-runtime/controlTranscriptWindow";
import type { Locale } from "../lib/i18n";
import { useMessageReplay } from "./messages/MessageReplayScope";
import "./TranscriptWindowControls.css";

const NavigationContext = createContext<Pick<
  ControlThreadRuntime,
  "navigateTranscript"
> | null>(null);
export function TranscriptNavigationScope({
  runtime,
  children,
}: {
  runtime: Pick<ControlThreadRuntime, "navigateTranscript"> | null;
  children: ReactNode;
}) {
  return (
    <NavigationContext.Provider value={runtime}>
      {children}
    </NavigationContext.Provider>
  );
}

export function TranscriptWindowControls({
  thread,
  locale,
}: {
  thread: Thread;
  locale: Locale;
}) {
  const runtime = useContext(NavigationContext);
  const window = transcriptWindow(thread);
  const replay = useMessageReplay();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false);
    setError(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [runtime, thread.id]);
  if (!window || !runtime) return null;
  const zh = locale === "zh";
  const disabled = busy || Boolean(replay?.selection);
  async function navigate(cursor: string | null, includeTaskChanges = false) {
    if (!runtime || disabled) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(false);
    try {
      await runtime.navigateTranscript(thread.id, cursor, {
        signal: controller.signal,
        includeTaskChanges,
      });
    } catch (cause) {
      if (
        !controller.signal.aborted &&
        !(
          cause instanceof Error &&
          cause.message === "control_thread_projection_superseded"
        )
      )
        setError(true);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <nav
      className="transcript-window-controls"
      aria-label={zh ? "对话历史" : "Conversation history"}
      aria-busy={busy}
    >
      <button
        type="button"
        disabled={disabled || window.olderCursor === null}
        onClick={() => void navigate(window.olderCursor)}
      >
        {zh ? "更早消息" : "Older messages"}
      </button>
      <span role="status">
        {busy
          ? zh
            ? "正在读取…"
            : "Loading…"
          : window.newerCursor !== null
            ? zh
              ? "正在查看历史，任务继续运行"
              : "Viewing history; tasks keep running"
            : zh
              ? "最新消息"
              : "Latest messages"}
      </span>
      <button
        type="button"
        disabled={disabled || window.newerCursor === null}
        onClick={() => void navigate(window.newerCursor)}
      >
        {zh ? "较新消息" : "Newer messages"}
      </button>
      <button
        type="button"
        disabled={disabled || window.cursor === null}
        onClick={() => void navigate(null)}
      >
        {zh ? "回到最新" : "Jump to latest"}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void navigate(window.cursor, true)}
      >
        {zh ? "汇总文件变更" : "Summarize file changes"}
      </button>
      {window.toolHistory === "partial" ? (
        <span className="transcript-history-note">
          {zh
            ? "部分工具过程尚未完整加载。"
            : "Some tool history is not fully loaded."}
          <button
            type="button"
            disabled={disabled}
            onClick={() => void navigate(window.cursor)}
          >
            {zh ? "重新读取工具过程" : "Reload tool history"}
          </button>
        </span>
      ) : null}
      {error ? (
        <span role="alert">
          {zh
            ? "读取失败，当前消息已保留，请重试。"
            : "Loading failed. Current messages are retained; please retry."}
        </span>
      ) : null}
    </nav>
  );
}
