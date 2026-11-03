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
  async function reloadToolHistory() {
    if (!runtime || !window || disabled || request.current !== null) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(false);
    try {
      await runtime.navigateTranscript(thread.id, window.cursor, {
        signal: controller.signal,
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
  if (window.toolHistory !== "partial" && !busy && !error) return null;
  return (
    <div
      className="transcript-window-controls"
      aria-label={zh ? "工具过程状态" : "Tool history status"}
      aria-busy={busy}
    >
      {busy ? <span role="status">{zh ? "正在读取…" : "Loading…"}</span> : null}
      {window.toolHistory === "partial" ? (
        <span className="transcript-history-note">
          {zh
            ? "部分工具过程尚未完整加载。"
            : "Some tool history is not fully loaded."}
          <button
            type="button"
            disabled={disabled}
            onClick={() => void reloadToolHistory()}
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
    </div>
  );
}
