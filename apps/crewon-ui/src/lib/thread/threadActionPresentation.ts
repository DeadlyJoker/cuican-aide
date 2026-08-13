import type { NoticeState } from "../shared/noticeState";
import type { Locale } from "../i18n";

export function threadReadPreservedFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh"
      ? "读取后端会话失败，已保留当前会话列表。"
      : "Unable to read backend session. Current sessions are preserved.",
  );
}

export function threadListFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh" ? "读取会话失败" : "Unable to load sessions",
  );
}

export function threadSearchFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh" ? "搜索会话失败" : "Unable to search sessions",
  );
}

export function threadArchiveFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh" ? "会话操作失败" : "Session action failed",
  );
}

export function threadDeleteArchivedConfirmMessage(
  title: string,
  locale: Locale,
): string {
  return locale === "zh"
    ? `永久删除已归档会话「${title}」？此操作无法撤销。`
    : `Permanently delete archived session "${title}"? This cannot be undone.`;
}

export function threadDeletedNotice(
  title: string,
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh" ? `已删除会话：${title}` : `Deleted session: ${title}`,
    tone: "success",
  };
}

export function threadDeleteFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh" ? "删除会话失败" : "Unable to delete session",
  );
}

export function assistantThreadClearConfirmMessage(locale: Locale): string {
  return locale === "zh"
    ? "清理助理会话？当前消息和上下文将被永久删除，且无法恢复。"
    : "Clear the assistant conversation? Its messages and context will be permanently deleted and cannot be recovered.";
}

export function assistantThreadClearedNotice(locale: Locale): NoticeState {
  return {
    text: locale === "zh" ? "助理会话已清理" : "Assistant conversation cleared",
    tone: "success",
  };
}

export function assistantThreadClearFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh"
      ? "清理助理会话失败"
      : "Unable to clear the assistant conversation",
  );
}

export function assistantThreadClearUnavailableNotice(
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? "连接 CrewON Control 后才能清理助理会话"
        : "Connect to CrewON Control before clearing the assistant conversation",
    tone: "warning",
  };
}

export function threadRenamePromptLabel(locale: Locale): string {
  return locale === "zh" ? "重命名会话" : "Rename session";
}

export function threadRenameFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh" ? "重命名会话失败" : "Unable to rename session",
  );
}

export function threadCreateFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh"
      ? "创建后端会话失败，已保留当前会话。"
      : "Unable to create backend session. Current sessions are preserved.",
  );
}

export function threadGuidanceAppendedNotice(locale: Locale): NoticeState {
  return {
    text:
      locale === "zh"
        ? "已追加到当前任务"
        : "Added guidance to the current turn",
    tone: "success",
  };
}

export function threadSendFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh"
      ? "发送到后端失败，消息已保留在输入框。"
      : "Unable to send to backend. The message was kept in the composer.",
  );
}

export function threadInterruptRequestedNotice(locale: Locale): NoticeState {
  return {
    text:
      locale === "zh"
        ? "已请求停止当前任务"
        : "Requested stop for current turn",
    tone: "success",
  };
}

export function threadInterruptFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh" ? "停止当前任务失败" : "Unable to stop current turn",
  );
}

export function threadReviewFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh"
      ? "启动审查失败，已保留当前会话。"
      : "Unable to start review. Current sessions are preserved.",
  );
}

function warningNotice(error: unknown, fallback: string): NoticeState {
  return {
    text: error instanceof Error ? error.message : fallback,
    tone: "warning",
  };
}
