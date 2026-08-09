import type { Thread } from "@crewon-protocol/v2/Thread";

import type { Locale } from "../../lib/i18n";
import type { WorkMode } from "../../lib/workMode";
import { sidebarThreadTitle } from "../SidebarPresentation";
import { Transcript } from "../Transcript";

type CommandThreadRoomProps = {
  activeTurnId: string | null;
  cwd: string;
  locale: Locale;
  selectedThread: Thread;
  streamingText: string;
  variant?: "assistant" | "default";
  workMode: WorkMode;
  onModeChange: (mode: WorkMode) => void;
  onStop?: () => void;
};

function transcriptLabels(locale: Locale) {
  return locale === "zh"
    ? {
        commandLabel: "命令",
        crewonLabel: "Crewon",
        emptyDescription: "选择左侧会话或从下方输入开始。",
        emptyThreadDescription:
          "发送任务后，Agent 回复、工具调用、MCP 和 Skill 输出会在这里实时渲染。",
        emptyThreadTitle: "还没有消息",
        emptyTitle: "新建 Agent 对话",
        filesLabel: "文件",
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
        emptyThreadDescription:
          "Agent replies, tool calls, MCP, and Skill output render here in real time.",
        emptyThreadTitle: "No messages yet",
        emptyTitle: "New agent conversation",
        filesLabel: "Files",
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
  activeTurnId,
  cwd,
  locale,
  selectedThread,
  streamingText,
  variant = "default",
  workMode,
  onModeChange,
  onStop,
}: CommandThreadRoomProps) {
  const labels = transcriptLabels(locale);
  const isRunning =
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

  return (
    <>
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
          commandLabel={labels.commandLabel}
          crewonLabel={labels.crewonLabel}
          emptyDescription={labels.emptyDescription}
          emptyThreadDescription={labels.emptyThreadDescription}
          emptyThreadTitle={labels.emptyThreadTitle}
          emptyTitle={labels.emptyTitle}
          filesLabel={labels.filesLabel}
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
    </>
  );
}
