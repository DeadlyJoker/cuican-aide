import type { Thread } from "@crewon-ui-model/v2/Thread";
import { Bot, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { CommandThreadRoom } from "./CommandWorkspaceConversation";
import { classNames } from "./commandWorkspaceUtils";
import type { Locale } from "../../lib/i18n";
import type { WorkMode } from "../../lib/workMode";

export function CommandWorkspaceAssistant({
  active,
  activeTurnId,
  clearAvailable,
  composer,
  locale,
  streamingText,
  thread,
  workMode,
  onClearThread,
  onModeChange,
  onStop,
}: {
  active: boolean;
  activeTurnId: string | null;
  clearAvailable: boolean;
  composer: ReactNode;
  locale: Locale;
  streamingText: string;
  thread: Thread | null;
  workMode: WorkMode;
  onClearThread?: () => void | Promise<void>;
  onModeChange: (mode: WorkMode) => void;
  onStop?: () => void;
}) {
  const [clearing, setClearing] = useState(false);
  const threadIsRunning =
    Boolean(activeTurnId) ||
    Boolean(thread?.turns.some((turn) => turn.status === "inProgress"));
  const clearDisabled =
    clearing || threadIsRunning || !clearAvailable || !onClearThread;
  const clearLabel = locale === "zh" ? "清理会话" : "Clear conversation";
  const clearTitle = threadIsRunning
    ? locale === "zh"
      ? "请先停止当前回复"
      : "Stop the current response first"
    : !clearAvailable
      ? locale === "zh"
        ? "连接 CrewON Control 后可清理会话"
        : "Connect to CrewON Control to clear the conversation"
      : clearLabel;

  const handleClear = async () => {
    if (clearDisabled || !onClearThread) {
      return;
    }
    setClearing(true);
    try {
      await onClearThread();
    } finally {
      setClearing(false);
    }
  };

  return (
    <section
      className={classNames(
        "shell-view shell-page-view assistant-only-view",
        active && "active",
      )}
      data-od-id="shell-view-assist"
      data-shell-view="assist"
      hidden={!active}
    >
      <div
        className="assistant-single-conversation"
        data-od-id="assistant-single-conversation"
      >
        {thread ? (
          <div
            className="assistant-conversation-actions"
            data-od-id="assistant-conversation-actions"
          >
            <button
              aria-label={clearLabel}
              className="assistant-clear-conversation"
              disabled={clearDisabled}
              title={clearTitle}
              type="button"
              onClick={() => void handleClear()}
            >
              <Trash2 aria-hidden="true" />
              <span>
                {clearing
                  ? locale === "zh"
                    ? "清理中"
                    : "Clearing"
                  : clearLabel}
              </span>
            </button>
          </div>
        ) : null}
        {thread ? (
          <CommandThreadRoom
            activeTurnId={activeTurnId}
            cwd=""
            locale={locale}
            selectedThread={thread}
            streamingText={streamingText}
            variant="assistant"
            workMode={workMode}
            onModeChange={onModeChange}
            onStop={onStop}
          />
        ) : (
          <section
            className="assistant-empty-state"
            data-od-id="assistant-empty-state"
          >
            <span aria-hidden="true">
              <Bot />
            </span>
            <strong>
              {locale === "zh"
                ? "从这里开始长期对话"
                : "Start a long-running conversation"}
            </strong>
            <p>
              {locale === "zh"
                ? "助理会持续保留这条会话，并在上下文接近上限时自动压缩。"
                : "The assistant keeps this conversation and automatically compacts context near its limit."}
            </p>
          </section>
        )}
        <div className="assistant-composer-zone">{composer}</div>
      </div>
    </section>
  );
}
