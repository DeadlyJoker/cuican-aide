import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";

import type { Locale } from "../../lib/i18n";
import type { WorkMode } from "../../lib/workMode";
import { Transcript } from "../Transcript";
import { dynamicToolKindLabel } from "../transcriptToolPresentation";

type CommandThreadRoomProps = {
  activeTurnId: string | null;
  locale: Locale;
  selectedThread: Thread;
  streamingText: string;
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

  const hasRunningTurn = Boolean(activeTurnId);
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
    chips,
    state,
    title,
  };
}

export function CommandThreadRoom({
  activeTurnId,
  locale,
  selectedThread,
  streamingText,
  workMode,
  onModeChange,
  onStop,
}: CommandThreadRoomProps) {
  const labels = transcriptLabels(locale);
  const runSummary = commandThreadRunSummary({
    activeTurnId,
    locale,
    streamingText,
    thread: selectedThread,
  });
  const showRunSummary =
    runSummary.state === "failed" || runSummary.state === "interrupted";
  return (
    <>
      <section
        className="command-thread-room conversation-frame"
        data-od-id="command-thread-room"
      >
        {showRunSummary ? (
          <div className="command-thread-toolbar">
            <div
              className="command-thread-runtime"
              role="status"
              aria-live="polite"
              data-state={runSummary.state}
            >
              <strong>{runSummary.title}</strong>
              {runSummary.chips.length > 0 ? (
                <span>
                  {runSummary.chips.map((chip) => (
                    <em key={chip}>{chip}</em>
                  ))}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
        <Transcript
          activeTurnId={activeTurnId}
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
