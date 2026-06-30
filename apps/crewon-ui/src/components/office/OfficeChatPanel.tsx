import type { ReactNode, RefObject } from "react";

import type { OfficeWorkspace } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

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
  onDraftChange,
  onSubmit,
}: {
  workspace: OfficeWorkspace;
  locale: Locale;
  draft: string;
  streamRef: RefObject<HTMLDivElement | null>;
  isSubmitting?: boolean;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
}) {
  const memberNames = workspace.members.map((member) => member.name);

  return (
    <section
      className="office-chat"
      aria-label={locale === "zh" ? "群聊" : "Group chat"}
    >
      <div className="office-chat-head">
        <strong>{locale === "zh" ? "群聊协作" : "Group chat"}</strong>
        <span>
          {locale === "zh"
            ? `${workspace.messages.length} 条消息`
            : `${workspace.messages.length} messages`}
        </span>
      </div>
      <div className="office-chat-stream" ref={streamRef}>
        {workspace.messages.map((message, index) =>
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
                {message.glyph}
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
      <form
        className="office-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <textarea
          value={draft}
          rows={2}
          disabled={isSubmitting}
          spellCheck={false}
          placeholder={
            locale === "zh"
              ? "告诉主控智能体目标、背景或下一步…"
              : "Tell the manager agent the goal, context, or next step…"
          }
          aria-label={locale === "zh" ? "群聊输入" : "Group chat input"}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <button
          type="button"
          disabled={isSubmitting || !draft.trim()}
          onClick={onSubmit}
        >
          {isSubmitting
            ? locale === "zh"
              ? "发送中"
              : "Sending"
            : locale === "zh"
              ? "发送"
              : "Send"}
        </button>
      </form>
    </section>
  );
}
