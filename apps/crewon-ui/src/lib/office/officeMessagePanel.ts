import type { LibraryPanel, OfficeMessage, OfficeWorkspace } from "../domain/crewonDomain";
import type { OfficeMessageSubmitResponse } from "../app-server/appServer";
import type { Locale } from "../i18n";
import { officeWorkspaceConnectedPatch } from "./officeDetailPanel";
import type { OfficeIdentity } from "./officeIdentity";
import {
  officePanelMatchesIdentity,
  officeResponseMatchesIdentity,
} from "./officeIdentity";

export function buildOfficeUserMessage(params: {
  clientUserMessageId?: string;
  locale: Locale;
  rawText: string;
  workspace: OfficeWorkspace;
}): OfficeMessage | null {
  const { clientUserMessageId, locale, rawText, workspace } = params;
  const text = rawText.trim();
  if (!text) {
    return null;
  }
  const owner = workspace.members.find((member) => member.glyph === "@");
  return {
    ...(clientUserMessageId ? { clientUserMessageId } : {}),
    author: owner?.name ?? (locale === "zh" ? "你" : "You"),
    glyph: "@",
    accent: "slate",
    time: locale === "zh" ? "现在" : "now",
    text,
    kind: "message",
  };
}

export function appendOfficeUserOnlyMessage(params: {
  clientUserMessageId?: string;
  locale: Locale;
  rawText: string;
  workspace: OfficeWorkspace;
}): OfficeWorkspace {
  const { clientUserMessageId, locale, rawText, workspace } = params;
  const message = buildOfficeUserMessage({
    clientUserMessageId,
    locale,
    rawText,
    workspace,
  });
  if (!message) {
    return workspace;
  }
  return {
    ...workspace,
    messages:
      clientUserMessageId &&
      workspace.messages.some(
        (candidate) =>
          candidate.clientUserMessageId === clientUserMessageId,
      )
        ? workspace.messages.map((candidate) =>
            candidate.clientUserMessageId === clientUserMessageId
              ? message
              : candidate,
          )
        : [...workspace.messages, message],
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
    expectedIdentity: OfficeIdentity;
    workspace: OfficeWorkspace;
  },
): LibraryPanel | null {
  if (!panel?.workspace || !officePanelMatchesIdentity(panel, params.expectedIdentity)) {
    return panel;
  }
  return {
    ...panel,
    workspace: {
      ...params.workspace,
      backendStatus: params.backendStatus,
    },
  };
}

export function officeMessageTurnPrompt(params: {
  locale: Locale;
  officeTitle: string;
  text: string;
  threadId: string;
}): string {
  const { locale, officeTitle, text } = params;
  return [
    locale === "zh"
      ? `办公室「${officeTitle}」群聊消息：${text}`
      : `Office "${officeTitle}" group chat message: ${text}`,
    locale === "zh"
      ? "主控智能体：先识别这条消息是提问、状态催办、背景补充还是新的可执行目标，再决定是否规划或派发任务。"
      : "Manager agent: first decide whether this message is a question, status nudge, added context, or new actionable goal before planning or delegating tasks.",
    locale === "zh" ? "状态：消息已发送" : "Status: message sent",
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
        clientOnly: true,
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
    expectedIdentity: OfficeIdentity;
    threadId: string;
    workspace: OfficeWorkspace;
  },
): LibraryPanel | null {
  if (!panel?.workspace || !officePanelMatchesIdentity(panel, params.expectedIdentity)) {
    return panel;
  }
  return {
    ...panel,
    ...officeWorkspaceConnectedPatch(params.workspace, params.threadId),
  };
}

export function officeMessageFailurePanel(
  panel: LibraryPanel | null,
  error: unknown,
  locale: Locale,
  expectedIdentity: OfficeIdentity,
): LibraryPanel | null {
  if (!panel?.workspace || !officePanelMatchesIdentity(panel, expectedIdentity)) {
    return panel;
  }
  return {
    ...panel,
    workspace: officeWorkspaceWithMessageError({
      workspace: panel.workspace,
      error,
      locale,
    }),
  };
}

export function officeMessageSubmitResponsePanel(
  panel: LibraryPanel | null,
  response: OfficeMessageSubmitResponse,
  expectedIdentity: OfficeIdentity,
): LibraryPanel | null {
  const deliveryThreadId =
    response.delivery.type === "runStarted" ||
    response.delivery.type === "steered" ||
    response.delivery.type === "interactionStarted" ||
    response.delivery.type === "answered"
      ? response.delivery.threadId
      : null;
  if (
    !panel?.workspace ||
    !officePanelMatchesIdentity(panel, expectedIdentity) ||
    !officeResponseMatchesIdentity(
      response.config,
      response.filePath,
      expectedIdentity,
      deliveryThreadId,
      panel.workspaceCwd,
    )
  ) {
    return panel;
  }
  const threadId =
    response.config.workspace.threadId ??
    deliveryThreadId ??
    panel.workspace.threadId;
  return {
    ...panel,
    title: response.config.title,
    subtitle: response.config.subtitle,
    configPath: response.filePath,
    error: undefined,
    workspace: {
      ...response.config.workspace,
      ...(threadId ? { threadId } : {}),
      backendStatus: "connected",
    },
  };
}
