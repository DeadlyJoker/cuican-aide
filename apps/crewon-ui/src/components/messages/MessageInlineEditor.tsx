import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Locale } from "../../lib/i18n";
import { Button } from "../ui/button";
import { useMessageReplay } from "./MessageReplayScope";
import "./MessageActions.css";

/** Replace the message body in place; ordinary Enter remains a newline. */
export function EditableMessageContent({
  messageId,
  locale,
  children,
}: {
  messageId?: string;
  locale: Locale;
  children: ReactNode;
}) {
  const replay = useMessageReplay();
  return messageId && replay?.selection?.userMessageId === messageId ? (
    <MessageInlineEditor locale={locale} />
  ) : (
    children
  );
}

export function MessageInlineEditor({ locale }: { locale: Locale }) {
  const replay = useMessageReplay();
  const hintId = useId();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.scrollIntoView({ block: "nearest" });
  }, []);
  if (!replay?.selection) return null;
  const zh = locale === "zh";
  return (
    <form
      ref={formRef}
      className="message-inline-editor"
      aria-label={zh ? "编辑消息" : "Edit message"}
      onSubmit={(event) => {
        event.preventDefault();
        void replay.submit();
      }}
    >
      <textarea
        autoFocus
        aria-label={zh ? "消息内容" : "Message content"}
        aria-describedby={hintId}
        value={replay.selection.text}
        readOnly={replay.submitting || replay.historyChanged}
        onChange={(event) => replay.changeText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            replay.cancel();
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void replay.submit();
          }
        }}
      />
      <p id={hintId} className="message-edit-hint">
        {replay.selection.removedTurns === null
          ? zh
            ? "将替换这条消息，并移除从这里开始的回复与后续对话。按当前模型和权限执行，已发生的文件修改和外部操作不会撤销。"
            : "This replaces this message and removes the replies and later conversation from here, using current model and permissions. Existing file changes and external actions are not undone."
          : zh
            ? `将替换这条消息，并移除从这里开始的 ${replay.selection.removedTurns} 轮回复与后续对话。按当前模型和权限执行，已发生的文件修改和外部操作不会撤销。`
            : `This replaces this message and removes ${replay.selection.removedTurns} turn(s) from here, using current model and permissions. Existing file changes and external actions are not undone.`}
      </p>
      {replay.error ? <p role="alert">{replay.error}</p> : null}
      {copyError ? (
        <p role="alert">
          {zh
            ? "复制失败，请手动复制上方内容。"
            : "Copy failed. Select and copy the text above."}
        </p>
      ) : null}
      <footer>
        <Button
          type="button"
          variant="ghost"
          disabled={replay.submitting}
          onClick={replay.cancel}
        >
          {zh ? "取消" : "Cancel"}
        </Button>
        {replay.historyChanged ? (
          <Button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  replay.selection?.text ?? "",
                );
                setCopied(true);
                setCopyError(false);
              } catch {
                setCopyError(true);
              }
            }}
          >
            {copied
              ? zh
                ? "已复制"
                : "Copied"
              : zh
                ? "复制修改内容"
                : "Copy edited text"}
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={replay.busy || !replay.selection.text.trim()}
          >
            {replay.submitting
              ? zh
                ? "正在重新执行…"
                : "Running…"
              : zh
                ? "保存并重新执行"
                : "Save and run again"}
          </Button>
        )}
      </footer>
    </form>
  );
}
