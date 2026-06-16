import { useEffect, useRef, useState, type ReactNode } from "react";

import { ActivityBoard } from "../activity/ActivityBoard";
import type { Locale } from "../../lib/i18n";
import type {
  ArtifactItem,
  LibraryPanel,
  LibraryPanelAction,
  OfficeTask,
} from "../../lib/crewonDomain";

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

export function OfficeWorkspaceView({
  panel,
  locale,
  onBack,
  onPanelAction,
  onSendMessage,
  onDecision,
  onArtifact,
}: {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onPanelAction: (action: LibraryPanelAction) => void;
  onSendMessage: (text: string) => void;
  onDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
}) {
  const workspace = panel.workspace;
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"chat" | "activity">("chat");
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.scrollTop = stream.scrollHeight;
    }
  }, [workspace?.messages.length, tab]);

  if (!workspace) {
    return null;
  }

  const memberNames = workspace.members.map((member) => member.name);

  function submit() {
    const text = draft.trim();
    if (!text) {
      return;
    }
    onSendMessage(text);
    setDraft("");
  }

  const statusLabel = (status: OfficeTask["status"]) =>
    locale === "zh"
      ? status === "done"
        ? "完成"
        : status === "doing"
          ? "进行中"
          : "待办"
      : status === "done"
        ? "Done"
        : status === "doing"
          ? "In progress"
          : "To do";

  return (
    <main className="office-workspace" aria-label={panel.title}>
      <header className="office-top">
        <button type="button" className="office-back" onClick={onBack}>
          {locale === "zh" ? "返回办公室" : "Back to offices"}
        </button>
        <div className="office-top-main">
          <div className="office-top-title">
            <span className="office-top-glyph" aria-hidden="true">
              ⌗
            </span>
            <div>
              <h1>{panel.title}</h1>
              <p>{panel.subtitle}</p>
            </div>
          </div>
          <div className="office-avatars" aria-hidden="true">
            {workspace.members.map((member) => (
              <span
                className="office-avatar"
                data-accent={member.accent}
                key={member.name}
                title={member.name}
              >
                {member.glyph}
              </span>
            ))}
          </div>
        </div>
        <div className="office-goal">
          <span>{locale === "zh" ? "办公室目标" : "Office goal"}</span>
          <strong>{workspace.goal}</strong>
          <em data-status={workspace.backendStatus ?? "local"}>
            {locale === "zh"
              ? workspace.backendStatus === "connected"
                ? "后端线程已连接"
                : workspace.backendStatus === "binding"
                  ? "正在绑定后端线程"
                  : workspace.backendStatus === "error"
                    ? "后端连接异常"
                    : "本地演示"
              : workspace.backendStatus === "connected"
                ? "Backend thread connected"
                : workspace.backendStatus === "binding"
                  ? "Binding backend thread"
                  : workspace.backendStatus === "error"
                    ? "Backend connection error"
                    : "Local demo"}
          </em>
        </div>
      </header>

      <div
        className="office-tabs"
        role="tablist"
        aria-label={locale === "zh" ? "办公室视图" : "Office views"}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "chat"}
          data-active={tab === "chat"}
          onClick={() => setTab("chat")}
        >
          {locale === "zh" ? "群聊" : "Group chat"}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "activity"}
          data-active={tab === "activity"}
          onClick={() => setTab("activity")}
        >
          {locale === "zh" ? "运行台" : "Activity"}
        </button>
      </div>

      {tab === "activity" ? (
        workspace.activity ? (
          <ActivityBoard
            data={workspace.activity}
            locale={locale}
            onDecision={onDecision}
            onArtifact={onArtifact}
          />
        ) : (
          <p className="activity-empty">
            {locale === "zh" ? "暂无运行记录。" : "No activity yet."}
          </p>
        )
      ) : (
        <div className="office-grid">
          <aside
            className="office-members"
            aria-label={locale === "zh" ? "成员" : "Members"}
          >
            <div className="office-rail-head">
              <strong>{locale === "zh" ? "成员" : "Members"}</strong>
              <span>{workspace.members.length}</span>
            </div>
            {workspace.members.map((member) => (
              <div className="office-member" key={member.name}>
                <span
                  className="office-avatar"
                  data-accent={member.accent}
                  aria-hidden="true"
                >
                  {member.glyph}
                  <i
                    className="office-presence"
                    data-online={member.online ?? true}
                  />
                </span>
                <span className="office-member-text">
                  <strong>{member.name}</strong>
                  <span>{member.role}</span>
                  <em>{member.status}</em>
                </span>
              </div>
            ))}
            {panel.actions ? (
              <div className="office-rail-actions">
                {panel.actions.map((action) => (
                  <button
                    type="button"
                    data-tone={action.tone}
                    key={action.id}
                    onClick={() => onPanelAction(action)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </aside>

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
                      <p>
                        {renderOfficeMessageText(message.text, memberNames)}
                      </p>
                    </div>
                  </div>
                ),
              )}
            </div>
            <form
              className="office-composer"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <input
                value={draft}
                spellCheck={false}
                placeholder={
                  locale === "zh"
                    ? "在群聊里 @ 成员派发任务…"
                    : "@mention a member to dispatch a task…"
                }
                aria-label={locale === "zh" ? "群聊输入" : "Group chat input"}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="submit" disabled={!draft.trim()}>
                {locale === "zh" ? "发送" : "Send"}
              </button>
            </form>
          </section>

          <aside
            className="office-tasks"
            aria-label={locale === "zh" ? "任务" : "Tasks"}
          >
            <div className="office-rail-head">
              <strong>{locale === "zh" ? "任务看板" : "Task board"}</strong>
              <span>{workspace.tasks.length}</span>
            </div>
            {workspace.tasks.map((task, index) => (
              <div
                className="office-task"
                data-status={task.status}
                key={`${task.title}:${index}`}
              >
                <span className="office-task-dot" aria-hidden="true" />
                <span className="office-task-text">
                  <strong>{task.title}</strong>
                  <span>{task.owner}</span>
                </span>
                <span className="office-task-status" data-status={task.status}>
                  {statusLabel(task.status)}
                </span>
              </div>
            ))}
          </aside>
        </div>
      )}
    </main>
  );
}
