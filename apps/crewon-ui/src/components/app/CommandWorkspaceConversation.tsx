import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";

import type { Locale } from "../../lib/i18n";
import type { WorkMode } from "../../lib/workMode";
import { sidebarThreadTitle } from "../SidebarPresentation";
import { Transcript } from "../Transcript";
import { dynamicToolKindLabel } from "../transcriptToolPresentation";

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

type CommandThreadRunSummary = {
  chips: string[];
  state: "completed" | "failed" | "idle" | "interrupted" | "running";
  title: string;
};

function countableProcessItem(item: ThreadItem): boolean {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "subAgentActivity":
      return true;
    default:
      return false;
  }
}

function isRunningProcessItem(item: ThreadItem): boolean {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
      return item.status === "inProgress";
    default:
      return false;
  }
}

function chipLabel(label: string, count: number): string | null {
  return count > 0 ? `${label} ${count}` : null;
}

function workspaceDisplayName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() || normalized || path;
}

function workspaceLabel(path: string | null, locale: Locale): string {
  if (!path) {
    return locale === "zh" ? "无工作空间" : "No workspace";
  }
  const name = workspaceDisplayName(path);
  return locale === "zh" ? `工作空间 · ${name}` : `Workspace · ${name}`;
}

export function commandThreadRunSummary({
  activeTurnId,
  locale,
  streamingText,
  thread,
}: {
  activeTurnId: string | null;
  locale: Locale;
  streamingText: string;
  thread: Thread;
}): CommandThreadRunSummary {
  const lastTurn = thread.turns[thread.turns.length - 1] ?? null;
  const processItems =
    lastTurn?.items.filter((item) => countableProcessItem(item)) ?? [];
  const runningProcessCount = processItems.filter(isRunningProcessItem).length;
  const counts = processItems.reduce(
    (current, item) => {
      switch (item.type) {
        case "commandExecution":
          return { ...current, commands: current.commands + 1 };
        case "fileChange":
          return { ...current, files: current.files + 1 };
        case "mcpToolCall":
          return { ...current, mcps: current.mcps + 1 };
        case "dynamicToolCall":
          return dynamicToolKindLabel(item, locale) === "Skill"
            ? { ...current, skills: current.skills + 1 }
            : { ...current, tools: current.tools + 1 };
        case "collabAgentToolCall":
        case "subAgentActivity":
          return { ...current, agents: current.agents + 1 };
        default:
          return current;
      }
    },
    { agents: 0, commands: 0, files: 0, mcps: 0, skills: 0, tools: 0 },
  );

  const hasRunningTurn =
    Boolean(activeTurnId) || lastTurn?.status === "inProgress";
  let state: CommandThreadRunSummary["state"] = "idle";
  if (hasRunningTurn) {
    state = "running";
  } else if (lastTurn?.status === "completed") {
    state = "completed";
  } else if (lastTurn?.status === "failed") {
    state = "failed";
  } else if (lastTurn?.status === "interrupted") {
    state = "interrupted";
  }
  const title =
    locale === "zh"
      ? state === "running" && streamingText
        ? "实时渲染中"
        : state === "running" && runningProcessCount > 0
          ? `执行中 · ${runningProcessCount} 项`
          : state === "running"
            ? "Agent 正在执行"
            : state === "failed"
              ? "最近失败"
              : state === "interrupted"
                ? "已中断"
                : state === "completed"
                  ? "最近完成"
                  : "等待任务"
      : state === "running" && streamingText
        ? "Streaming live"
        : state === "running" && runningProcessCount > 0
          ? `Running · ${runningProcessCount} item${runningProcessCount === 1 ? "" : "s"}`
          : state === "running"
            ? "Agent running"
            : state === "failed"
              ? "Latest failed"
              : state === "interrupted"
                ? "Interrupted"
                : state === "completed"
                  ? "Latest completed"
                  : "Waiting";

  const chips = [
    chipLabel("MCP", counts.mcps),
    chipLabel("Skill", counts.skills),
    chipLabel(locale === "zh" ? "工具" : "Tool", counts.tools),
    chipLabel(locale === "zh" ? "命令" : "Command", counts.commands),
    chipLabel(locale === "zh" ? "文件" : "Files", counts.files),
    chipLabel(locale === "zh" ? "Agent" : "Agent", counts.agents),
  ].filter((chip): chip is string => Boolean(chip));

  return {
    chips:
      chips.length > 0
        ? chips
        : [locale === "zh" ? "对话就绪" : "Conversation ready"],
    state,
    title,
  };
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
  const runSummary = commandThreadRunSummary({
    activeTurnId,
    locale,
    streamingText,
    thread: selectedThread,
  });
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
          <p>{isRunning ? "Agent 正在执行" : "Agent 对话"}</p>
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
        {variant === "default" ? (
          <div className="command-thread-toolbar">
            <div className="command-thread-identity">
              <span>{contextLabel}</span>
              <strong>{title}</strong>
              <em
                className="command-thread-cwd"
                title={workspacePath ?? undefined}
              >
                {workspaceText}
              </em>
            </div>
            <div
              className="command-thread-runtime"
              role="status"
              aria-live="polite"
              data-state={runSummary.state}
            >
              <strong>{runSummary.title}</strong>
              <span>
                {runSummary.chips.map((chip) => (
                  <em key={chip}>{chip}</em>
                ))}
              </span>
            </div>
            {isRunning && onStop ? (
              <button type="button" onClick={onStop}>
                {labels.stopLabel}
              </button>
            ) : null}
          </div>
        ) : null}
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
