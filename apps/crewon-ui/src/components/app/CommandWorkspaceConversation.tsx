import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { useMemo } from "react";
import { TaskWorkbenchScope } from "../workbench/TaskWorkbenchContext";
import { projectThreadWorkbench } from "../../lib/workbench/taskWorkbenchProjection";

import type { Locale } from "../../lib/i18n";
import type { WorkMode } from "../../lib/workMode";
import { sidebarThreadTitle } from "../SidebarPresentation";
import { Transcript } from "../Transcript";
import type { ControlTeamProgress } from "../../lib/control-runtime/controlTeamProgress";
import {
  MessageReplayScope,
  type ReplayMessage,
} from "../messages/MessageReplayScope";

type CommandThreadRoomProps = {
  active?: boolean;
  teamProgress?: ControlTeamProgress | null;
  activeTurnId: string | null;
  cwd: string;
  locale: Locale;
  selectedThread: Thread;
  streamingText: string;
  variant?: "assistant" | "default";
  workMode: WorkMode;
  onModeChange: (mode: WorkMode) => void;
  onStop?: () => void;
  onReplayMessage?: ReplayMessage;
  isSending?: boolean;
};

function transcriptLabels(locale: Locale) {
  return locale === "zh"
    ? {
        commandLabel: "命令",
        crewonLabel: "Crewon",
        emptyDescription: "选择左侧会话或从下方输入开始。",
        emptyTitle: "新建 Agent 对话",
        filesLabel: "文件",
        loadingLabel: "正在加载消息",
        modeCodeDescription: "适合代码、项目交付和工具调用。",
        modeCodeLabel: "单体对话",
        modeOfficeDescription: "适合多 Agent 办公室协作。",
        modeOfficeLabel: "群聊对话",
        modeTitleLabel: "工作模式",
        planLabel: "计划",
        reasoningLabel: "推理",
        stopLabel: "停止",
        youLabel: "你",
      }
    : {
        commandLabel: "Command",
        crewonLabel: "Crewon",
        emptyDescription: "Select a thread on the left or start below.",
        emptyTitle: "New agent conversation",
        filesLabel: "Files",
        loadingLabel: "Loading messages",
        modeCodeDescription: "For code, delivery, and tools.",
        modeCodeLabel: "Solo chat",
        modeOfficeDescription: "For multi-agent office work.",
        modeOfficeLabel: "Group chat",
        modeTitleLabel: "Work mode",
        planLabel: "Plan",
        reasoningLabel: "Reasoning",
        stopLabel: "Stop",
        youLabel: "You",
      };
}

function workspaceDisplayName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() || normalized || path;
}

function workspaceLabel(path: string | null, locale: Locale): string {
  if (!path) {
    return locale === "zh" ? "无工作空间" : "No workspace";
  }
  return workspaceDisplayName(path);
}

export function CommandThreadRoom({
  active = true,
  teamProgress = null,
  activeTurnId,
  cwd,
  locale,
  selectedThread,
  streamingText,
  variant = "default",
  workMode,
  onModeChange,
  onStop,
  onReplayMessage,
  isSending = false,
}: CommandThreadRoomProps) {
  const labels = transcriptLabels(locale);
  const isRunning =
    (teamProgress?.threadId === selectedThread.id &&
      teamProgress.phase !== "failed") ||
    Boolean(activeTurnId) ||
    selectedThread.turns.some((turn) => turn.status === "inProgress");
  const title =
    variant === "assistant"
      ? locale === "zh"
        ? "CrewON 助理"
        : "CrewON Assistant"
      : sidebarThreadTitle(
          selectedThread,
          locale === "zh" ? "未命名会话" : "Untitled thread",
        );
  const contextLabel =
    variant === "assistant"
      ? locale === "zh"
        ? "单一会话 · 自动压缩上下文"
        : "Single conversation · automatic context compaction"
      : isRunning
        ? locale === "zh"
          ? "Agent 正在执行"
          : "Agent running"
        : locale === "zh"
          ? "Agent 对话"
          : "Agent conversation";
  const workspacePath =
    variant === "assistant" ? null : selectedThread.cwd || cwd || null;
  const workspaceText = workspaceLabel(workspacePath, locale);
  const workbench = useMemo(
    () => projectThreadWorkbench(selectedThread, title),
    [selectedThread, title],
  );

  return (
    <MessageReplayScope
      key={selectedThread.id}
      thread={selectedThread}
      busy={isRunning || isSending || !active}
      locale={locale}
      onReplay={onReplayMessage}
    >
      <TaskWorkbenchScope snapshot={workbench} active={active}>
        {variant === "default" ? (
          <header
            className="home-title thread-home-title"
            data-od-id="desktop-command-header"
          >
            <p>{contextLabel}</p>
            <h1>
              <span>{title}</span>
            </h1>
          </header>
        ) : null}

        <section
          className={
            variant === "assistant"
              ? "command-thread-room assistant-thread-room"
              : "command-thread-room"
          }
          data-od-id="command-thread-room"
        >
          <Transcript
            teamProgress={teamProgress}
            activeTurnId={activeTurnId}
            commandLabel={labels.commandLabel}
            crewonLabel={labels.crewonLabel}
            emptyDescription={labels.emptyDescription}
            emptyTitle={labels.emptyTitle}
            filesLabel={labels.filesLabel}
            loadingLabel={labels.loadingLabel}
            locale={locale}
            mode={workMode}
            modeCodeDescription={labels.modeCodeDescription}
            modeCodeLabel={labels.modeCodeLabel}
            modeOfficeDescription={labels.modeOfficeDescription}
            modeOfficeLabel={labels.modeOfficeLabel}
            modeTitleLabel={labels.modeTitleLabel}
            onModeChange={onModeChange}
            onStop={onStop ?? (() => {})}
            planLabel={labels.planLabel}
            reasoningLabel={labels.reasoningLabel}
            stopLabel={labels.stopLabel}
            streamingText={streamingText}
            thread={selectedThread}
            youLabel={labels.youLabel}
          />
        </section>
      </TaskWorkbenchScope>
    </MessageReplayScope>
  );
}

/** A conversation surface before a real thread exists; it cannot dispatch tools. */
export function PendingCommandThreadRoom({
  locale,
  workMode,
  onModeChange,
  variant = "default",
}: {
  locale: Locale;
  workMode: WorkMode;
  onModeChange: (mode: WorkMode) => void;
  variant?: "assistant" | "default";
}) {
  const labels = transcriptLabels(locale);
  return (
    <>
      {variant === "default" ? (
        <header
          className="home-title thread-home-title"
          data-od-id="desktop-command-header"
        >
          <p>{locale === "zh" ? "Agent 对话" : "Agent conversation"}</p>
          <h1>
            <span>{locale === "zh" ? "新建对话" : "New conversation"}</span>
          </h1>
        </header>
      ) : null}
      <section
        className={
          variant === "assistant"
            ? "command-thread-room assistant-thread-room"
            : "command-thread-room"
        }
        data-od-id="command-thread-room"
      >
        <Transcript
          {...labels}
          locale={locale}
          mode={workMode}
          onModeChange={onModeChange}
          onStop={() => {}}
          streamingText=""
          thread={null}
        />
      </section>
    </>
  );
}
