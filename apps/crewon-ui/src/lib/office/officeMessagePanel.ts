import type { LibraryPanel, OfficeMessage, OfficeWorkspace } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { officeWorkspaceConnectedPatch } from "./officeDetailPanel";

export function buildOfficeUserMessage(params: {
  locale: Locale;
  rawText: string;
  workspace: OfficeWorkspace;
}): OfficeMessage | null {
  const { locale, rawText, workspace } = params;
  const text = rawText.trim();
  if (!text) {
    return null;
  }
  const owner = workspace.members.find((member) => member.glyph === "@");
  return {
    author: owner?.name ?? (locale === "zh" ? "你" : "You"),
    glyph: "@",
    accent: "slate",
    time: locale === "zh" ? "现在" : "now",
    text,
    kind: "message",
  };
}

export function appendOfficeUserOnlyMessage(params: {
  locale: Locale;
  rawText: string;
  workspace: OfficeWorkspace;
}): OfficeWorkspace {
  const { locale, rawText, workspace } = params;
  const message = buildOfficeUserMessage({ locale, rawText, workspace });
  if (!message) {
    return workspace;
  }
  return {
    ...workspace,
    messages: [...workspace.messages, message],
  };
}

export function optimisticOfficeBackendStatus(
  workspace: OfficeWorkspace,
): OfficeWorkspace["backendStatus"] {
  return workspace.threadId ? "connected" : workspace.backendStatus;
}

export function optimisticOfficeMessagePanel(
  panel: LibraryPanel | null,
  params: {
    backendStatus: OfficeWorkspace["backendStatus"];
    workspace: OfficeWorkspace;
  },
): LibraryPanel | null {
  return panel?.workspace
    ? {
        ...panel,
        workspace: {
          ...params.workspace,
          backendStatus: params.backendStatus,
        },
      }
    : panel;
}

export function officeMessageTurnPrompt(params: {
  locale: Locale;
  officeTitle: string;
  text: string;
  threadId: string;
}): string {
  const { locale, officeTitle, text, threadId } = params;
  return [
    locale === "zh"
      ? `办公室「${officeTitle}」群聊消息：${text}`
      : `Office "${officeTitle}" group chat message: ${text}`,
    locale === "zh"
      ? "主控智能体：先识别这条消息是提问、状态催办、背景补充还是新的可执行目标，再决定是否规划或派发任务。"
      : "Manager agent: first decide whether this message is a question, status nudge, added context, or new actionable goal before planning or delegating tasks.",
    locale === "zh"
      ? "后端记录：已提交到 office/message/send"
      : "Backend record: submitted to office/message/send",
    locale === "zh" ? `执行线程：${threadId}` : `Execution thread: ${threadId}`,
  ].join("\n");
}

export function officeMessageFallbackError(locale: Locale): string {
  return locale === "zh"
    ? "办公室消息发送到后端失败"
    : "Unable to send office message to backend";
}

export function officeWorkspaceWithMessageError(params: {
  error: unknown;
  locale: Locale;
  workspace: OfficeWorkspace;
}): OfficeWorkspace {
  const { error, locale, workspace } = params;
  return {
    ...workspace,
    backendStatus: "error",
    messages: [
      ...workspace.messages,
      {
        author: locale === "zh" ? "系统" : "System",
        glyph: "⌗",
        accent: "rose",
        time: locale === "zh" ? "现在" : "now",
        kind: "system",
        text: error instanceof Error ? error.message : officeMessageFallbackError(locale),
      },
    ],
  };
}

export function officeMessageConnectedPanel(
  panel: LibraryPanel | null,
  params: {
    threadId: string;
    workspace: OfficeWorkspace;
  },
): LibraryPanel | null {
  return panel?.workspace
    ? {
        ...panel,
        ...officeWorkspaceConnectedPatch(params.workspace, params.threadId),
      }
    : panel;
}

export function officeMessageFailurePanel(
  panel: LibraryPanel | null,
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return panel?.workspace
    ? {
        ...panel,
        workspace: officeWorkspaceWithMessageError({
          workspace: panel.workspace,
          error,
          locale,
        }),
      }
    : panel;
}
