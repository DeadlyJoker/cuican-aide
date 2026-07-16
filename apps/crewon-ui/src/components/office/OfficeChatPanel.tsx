import type { ReactNode, RefObject } from "react";

import type {
  OfficeMessage,
  OfficeWorkspace,
} from "../../lib/domain/crewonDomain";
import type {
  OfficeMessageSubmitMention,
  PendingOfficeMessageDelivery,
} from "../../lib/domain/officeMessageDelivery";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { Locale } from "../../lib/i18n";
import type { OfficeComposerRuntimeMode } from "../../lib/office/officeComposerRuntime";
import { OfficeComposer } from "./OfficeComposer";

export function isLegacyOfficeRuntimePrompt(message: OfficeMessage): boolean {
  if (
    message.kind ||
    message.clientOnly ||
    message.clientUserMessageId ||
    message.text.length < 1_000
  ) {
    return false;
  }
  const author = message.author.trim().toLocaleLowerCase();
  return (
    (author === "you" || author === "你") &&
    message.text.includes("runtimeThreadId=") &&
    message.text.includes("contextPolicy=") &&
    message.text.includes("memoryScope=") &&
    message.text.includes("officeUpdate")
  );
}

function isRoutineOfficeRunStatus(message: OfficeMessage): boolean {
  if (message.kind !== "system") {
    return false;
  }
  const text = message.text.trimStart();
  if (
    text.startsWith("已启动团队执行：") ||
    text.startsWith("Started team run:")
  ) {
    return true;
  }
  if (message.event !== "runSync") {
    return false;
  }
  return (
    message.accent === "green" ||
    text.startsWith("团队执行已完成：") ||
    text.startsWith("Team run completed:")
  );
}

export function visibleOfficeMessages(
  messages: OfficeMessage[],
): OfficeMessage[] {
  return messages.filter(
    (message) =>
      !isLegacyOfficeRuntimePrompt(message) &&
      !isRoutineOfficeRunStatus(message),
  );
}

function renderOfficeMessageText(
  text: string,
  memberNames: string[],
): ReactNode {
  const sorted = [...memberNames]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const escaped = sorted.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const namePattern = escaped.length > 0 ? `(?:${escaped.join("|")})` : "";
  const fallback = "[\\w\\u4e00-\\u9fa5]+";
  const mentionRegex = new RegExp(
    `@(${namePattern ? `${namePattern}|` : ""}${fallback})`,
    "g",
  );
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = mentionRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(
      <span className="office-mention" key={`m${key}`}>
        @{match[1]}
      </span>,
    );
    key += 1;
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : text;
}

export function OfficeChatPanel({
  workspace,
  locale,
  draft,
  streamRef,
  isSubmitting,
  isStopping,
  onDraftChange,
  onAttachContext,
  onStop,
  onSubmit,
  pendingDelivery,
  runtimeMode,
  slashCommands,
}: {
  workspace: OfficeWorkspace;
  locale: Locale;
  draft: string;
  streamRef: RefObject<HTMLDivElement | null>;
  isSubmitting?: boolean;
  isStopping?: boolean;
  onDraftChange: (draft: string) => void;
  onAttachContext?: (onSelectPath: (path: string) => void) => void;
  onStop?: () => void | Promise<void>;
  onSubmit: (
    draft: string,
    mentions: OfficeMessageSubmitMention[],
  ) => void | Promise<void>;
  pendingDelivery: PendingOfficeMessageDelivery | null;
  runtimeMode: OfficeComposerRuntimeMode;
  slashCommands?: ComposerSlashCommand[];
}) {
  const memberNames = workspace.members.map((member) => member.name);
  const visibleMessages = visibleOfficeMessages(workspace.messages);

  return (
    <section
      className="office-chat"
      aria-label={locale === "zh" ? "群聊" : "Group chat"}
    >
      <div
        aria-live="polite"
        aria-relevant="additions text"
        className="office-chat-stream"
        ref={streamRef}
        role="log"
      >
        {visibleMessages.map((message, index) =>
          message.kind === "system" ? (
            <div className="office-system" key={index}>
              {message.text}
            </div>
          ) : (
            <div
              className="office-bubble"
              data-kind={message.kind ?? "message"}
              data-self={message.glyph === "@"}
              key={index}
            >
              <span
                className="office-avatar office-avatar-sm"
                data-accent={message.accent}
                aria-hidden="true"
              >
                {message.glyph === "@"
                  ? locale === "zh"
                    ? "你"
                    : "You"
                  : message.glyph}
              </span>
              <div className="office-bubble-body">
                <div className="office-bubble-head">
                  <strong>{message.author}</strong>
                  <span>{message.time}</span>
                </div>
                <p>{renderOfficeMessageText(message.text, memberNames)}</p>
              </div>
            </div>
          ),
        )}
      </div>
      <OfficeComposer
        draft={draft}
        isSubmitting={Boolean(isSubmitting)}
        isStopping={Boolean(isStopping)}
        locale={locale}
        members={workspace.members}
        onAttachContext={onAttachContext}
        onDraftChange={onDraftChange}
        onStop={onStop}
        onSubmit={onSubmit}
        pendingDelivery={pendingDelivery}
        runtimeMode={runtimeMode}
        slashCommands={slashCommands}
      />
    </section>
  );
}
