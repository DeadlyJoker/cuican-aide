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

export function workspaceArchiveConfirmMessage(
  workspaceName: string,
  count: number,
  locale: Locale,
): string {
  return locale === "zh"
    ? `归档工作空间「${workspaceName}」下的 ${count} 个会话？`
    : `Archive ${count} session${count === 1 ? "" : "s"} in workspace "${workspaceName}"?`;
}

export function workspaceDeleteConfirmMessage(
  workspaceName: string,
  count: number,
  locale: Locale,
): string {
  return locale === "zh"
    ? `永久删除工作空间「${workspaceName}」下的 ${count} 个会话？此操作无法撤销。`
    : `Permanently delete ${count} session${count === 1 ? "" : "s"} in workspace "${workspaceName}"? This cannot be undone.`;
}

export function workspaceArchivedNotice(
  workspaceName: string,
  count: number,
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? `已归档工作空间「${workspaceName}」下的 ${count} 个会话`
        : `Archived ${count} session${count === 1 ? "" : "s"} in workspace "${workspaceName}"`,
    tone: "success",
  };
}

export function workspaceDeletedNotice(
  workspaceName: string,
  count: number,
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? `已删除工作空间「${workspaceName}」下的 ${count} 个会话`
        : `Deleted ${count} session${count === 1 ? "" : "s"} in workspace "${workspaceName}"`,
    tone: "success",
  };
}

export function workspaceArchiveFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh" ? "批量归档会话失败" : "Unable to archive sessions",
  );
}

export function workspaceDeleteFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh" ? "批量删除会话失败" : "Unable to delete sessions",
  );
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
        ? "连接 App Server 后才能清理助理会话"
        : "Connect to the App Server before clearing the assistant conversation",
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
  if (error instanceof Error) {
    const executionIntentFailure = executionIntentFailureNotice(
      error.message,
      locale,
    );
    if (executionIntentFailure !== null) {
      return executionIntentFailure;
    }
  }
  return warningNotice(
    error,
    locale === "zh"
      ? "发送到后端失败，消息已保留在输入框。"
      : "Unable to send to backend. The message was kept in the composer.",
  );
}

function executionIntentFailureNotice(
  code: string,
  locale: Locale,
): NoticeState | null {
  const text =
    code === "control_execution_intent_capability_unavailable"
      ? locale === "zh"
        ? "当前后端版本还不支持目标或计划模式。请完成服务升级后重试；消息和模式已保留。"
        : "The current backend does not support Goal or Plan mode yet. Finish the service upgrade and try again; the message and mode were preserved."
      : code === "control_team_plan_unsupported"
        ? locale === "zh"
          ? "多成员团队暂不支持计划模式。请选择单个成员，或关闭计划模式后重试；消息和模式已保留。"
          : "Plan mode is not yet supported for multi-member teams. Select one member or turn Plan off; the message and mode were preserved."
        : code === "control_active_turn_execution_intent_unsupported"
          ? locale === "zh"
            ? "当前任务运行中，不能追加目标或计划模式。请等待完成或先停止任务；消息和模式已保留。"
            : "Goal and Plan modes cannot be appended to an active turn. Wait for it to finish or stop it first; the message and mode were preserved."
          : code === "control_review_execution_intent_unsupported"
            ? locale === "zh"
              ? "代码审查暂不支持目标或计划模式。请关闭该模式后重试；消息和模式已保留。"
              : "Code review does not yet support Goal or Plan mode. Turn the mode off and retry; the message and mode were preserved."
            : code === "goal_budget_limited" || code === "goal_usage_limited"
              ? locale === "zh"
                ? "当前目标已达到使用或预算限制，请先调整目标后再继续；消息和模式已保留。"
                : "The current Goal reached its usage or budget limit. Adjust it before continuing; the message and mode were preserved."
              : null;
  return text === null ? null : { text, tone: "warning" };
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
