import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Locale } from "../../lib/i18n";
import {
  MessageReplayError,
  replaySource,
  type MessageReplayRequest,
} from "../../lib/control-runtime/controlMessageReplay";
import { MessageInlineEditor } from "./MessageInlineEditor";
import { transcriptWindow } from "../../lib/control-runtime/controlTranscriptWindow";

type Selection = {
  userMessageId: string;
  expectedTurnIds: string[];
  text: string;
  removedTurns: number | null;
  expectedThreadRevision?: number;
};
const ReplayContext = createContext<{
  available: boolean;
  busy: boolean;
  selection: Selection | null;
  submitting: boolean;
  error: string | null;
  historyChanged: boolean;
  textOnly: (messageId: string) => boolean;
  open: (messageId: string) => void;
  changeText: (text: string) => void;
  cancel: () => void;
  submit: () => Promise<void>;
} | null>(null);
export const useMessageReplay = () => useContext(ReplayContext);
export type ReplayMessage = (request: MessageReplayRequest) => Promise<void>;

/** Own the draft above the turns so a rollback cannot discard an unconfirmed edit. */
export function MessageReplayScope({
  thread,
  busy,
  locale,
  onReplay,
  children,
}: {
  thread: Thread | null;
  busy: boolean;
  locale: Locale;
  onReplay?: ReplayMessage;
  children: ReactNode;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyChanged, setHistoryChanged] = useState(false);
  const lock = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const zh = locale === "zh";
  async function submit() {
    if (
      !thread ||
      !selection ||
      !onReplay ||
      busy ||
      lock.current ||
      historyChanged ||
      !selection.text.trim()
    )
      return;
    lock.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onReplay({
        threadId: thread.id,
        userMessageId: selection.userMessageId,
        expectedTurnIds: selection.expectedTurnIds,
        ...(selection.expectedThreadRevision === undefined
          ? {}
          : { expectedThreadRevision: selection.expectedThreadRevision }),
        text: selection.text,
      });
      setSelection(null);
    } catch (cause) {
      const changed =
        cause instanceof MessageReplayError && cause.historyChanged;
      setHistoryChanged(changed);
      setError(
        changed
          ? zh
            ? "历史已更新，但发送未确认成功。修改内容已保留；请先检查会话，避免重复执行。"
            : "History was updated, but delivery is unconfirmed. Your text is retained. Check the conversation before resending."
          : cause instanceof MessageReplayError && cause.code === "input"
            ? zh
              ? "消息为空、过长或包含附件／额外上下文，暂不能直接替换。请从输入框重新提交，原记录未改动。"
              : "This message is empty, too long, or includes additional context. Resubmit from the composer; history is unchanged."
            : zh
              ? "未能重新执行。会话可能已变化或服务暂不可用，修改内容已保留。"
              : "Could not run again. The conversation may have changed or the service is unavailable. Your edit is retained.",
      );
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }
  return (
    <ReplayContext.Provider
      value={{
        available: Boolean(onReplay && thread),
        busy: busy || submitting,
        selection,
        submitting,
        error,
        historyChanged,
        textOnly: (id) =>
          thread !== null && replaySource(thread, id)?.textOnly === true,
        open: (id) => {
          if (!thread || !onReplay || busy || lock.current || selection) return;
          const source = replaySource(thread, id);
          if (!source?.textOnly) return;
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          setSelection({
            userMessageId: id,
            expectedTurnIds: thread.turns.map((turn) => turn.id),
            text: source.text,
            removedTurns: transcriptWindow(thread)
              ? null
              : thread.turns.length - source.index,
            ...(transcriptWindow(thread)
              ? {
                  expectedThreadRevision:
                    transcriptWindow(thread)!.threadRevision,
                }
              : {}),
          });
          setError(null);
          setHistoryChanged(false);
        },
        changeText: (text) => {
          if (!lock.current && !historyChanged)
            setSelection((current) => (current ? { ...current, text } : null));
        },
        cancel: () => {
          if (lock.current) return;
          setSelection(null);
          requestAnimationFrame(() => {
            if (returnFocus.current?.isConnected) returnFocus.current.focus();
            if (returnFocus.current?.id)
              document.getElementById(returnFocus.current.id)?.focus();
          });
        },
        submit,
      }}
    >
      {children}
      {selection &&
      error &&
      thread &&
      !replaySource(thread, selection.userMessageId) ? (
        <MessageInlineEditor locale={locale} />
      ) : null}
    </ReplayContext.Provider>
  );
}
