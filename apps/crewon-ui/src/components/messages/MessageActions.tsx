import { useMessageCopyFeedback } from "./useMessageCopyFeedback";
import { Check, Copy, PencilLine } from "lucide-react";
import type { Locale } from "../../lib/i18n";
import { MessageActionButton } from "./MessageActionButton";
import { useMessageReplay } from "./MessageReplayScope";
import "./MessageActions.css";

export function MessageActions({
  text,
  locale,
  user = false,
  userMessageId,
  visibility = user ? "on-hover" : "always",
}: {
  text: string;
  locale: Locale;
  user?: boolean;
  userMessageId?: string;
  visibility?: "always" | "on-hover";
}) {
  const replay = useMessageReplay();
  const { copyState, copyText } = useMessageCopyFeedback();
  const zh = locale === "zh";
  const canReplay =
    replay?.available && userMessageId && replay.textOnly(userMessageId);
  if (
    user &&
    userMessageId &&
    replay?.selection?.userMessageId === userMessageId
  )
    return null;
  if (!text.trim()) return null;
  return (
    <div
      className="message-actions"
      data-user={user}
      data-visibility={visibility}
      role="group"
      aria-label={
        user
          ? zh
            ? "用户消息操作"
            : "User message actions"
          : zh
            ? "回复操作"
            : "Response actions"
      }
    >
      {text.trim() ? (
        <MessageActionButton
          label={
            copyState === "copied"
              ? zh
                ? "已复制"
                : "Copied"
              : zh
                ? "复制"
                : "Copy"
          }
          onClick={() => copyText(text)}
        >
          {copyState === "copied" ? (
            <Check aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
        </MessageActionButton>
      ) : null}
      {canReplay && user ? (
        <MessageActionButton
          label={zh ? "编辑消息" : "Edit message"}
          id={`message-edit-${userMessageId}`}
          disabled={replay.busy || replay.selection !== null}
          onClick={() => replay.open(userMessageId)}
        >
          <PencilLine aria-hidden="true" />
        </MessageActionButton>
      ) : null}
      <span className="message-action-status" role="status">
        {copyState === "failed"
          ? zh
            ? "复制失败，请手动复制"
            : "Copy failed; copy manually"
          : copyState === "copied"
            ? zh
              ? "已复制"
              : "Copied"
            : ""}
      </span>
    </div>
  );
}
