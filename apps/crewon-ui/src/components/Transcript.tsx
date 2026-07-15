import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { Code2, Sparkles } from "lucide-react";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { Locale } from "../lib/i18n";
import { formatRelativeTime } from "../lib/shared/text";
import type { WorkMode } from "../lib/workMode";
import {
  TranscriptMessage,
  TranscriptFailureMessage,
  TranscriptStreamingMessage,
  TranscriptThinkingMessage,
  combineAgentMessages,
  type TranscriptItemLabels,
} from "./TranscriptMessage";
import { hasDisplayableReasoning } from "./transcriptReasoning";

type TranscriptProps = {
  activeTurnId?: string | null;
  commandLabel: string;
  crewonLabel: string;
  emptyDescription: string;
  emptyThreadDescription: string;
  emptyThreadTitle: string;
  emptyTitle: string;
  filesLabel: string;
  locale: Locale;
  modeCodeLabel: string;
  modeCodeDescription: string;
  modeOfficeLabel: string;
  modeOfficeDescription: string;
  modeTitleLabel: string;
  mode: WorkMode;
  onModeChange: (mode: WorkMode) => void;
  onStop: () => void;
  planLabel: string;
  reasoningLabel: string;
  stopLabel: string;
  thread: Thread | null;
  streamingText: string;
  youLabel: string;
};

function turnLabel(turn: Turn, locale: Locale): string {
  switch (turn.status) {
    case "completed":
      return locale === "zh" ? "已处理" : "Processed";
    case "failed":
      return locale === "zh" ? "失败" : "Failed";
    case "interrupted":
      return locale === "zh" ? "已中断" : "Interrupted";
    case "inProgress":
      return locale === "zh" ? "正在处理" : "Processing";
  }
}

function shouldShowTurnDivider(turn: Turn): boolean {
  return turn.status !== "completed";
}

function shouldShowFailureResponse(turn: Turn): boolean {
  return (
    turn.status === "failed" &&
    !turn.items.some(
      (item) => item.type === "agentMessage" && item.text.trim().length > 0,
    )
  );
}

type AgentMessageItem = Extract<ThreadItem, { type: "agentMessage" }>;

type FinalAgentMessageRender = {
  insertionIndex: number;
  item: AgentMessageItem;
  sourceIds: Set<string>;
};

type TurnProcessRender = {
  firstIndex: number;
  items: ThreadItem[];
};

function isAgentMessageItem(item: ThreadItem): item is AgentMessageItem {
  return item.type === "agentMessage" && item.text.trim().length > 0;
}

function finalAgentMessageForTurn(turn: Turn): FinalAgentMessageRender | null {
  const agentEntries = turn.items
    .map((item, index) => ({ item, index }))
    .filter(
      (entry): entry is { item: AgentMessageItem; index: number } =>
        isAgentMessageItem(entry.item),
    );

  if (agentEntries.length === 0) {
    return null;
  }

  const explicitFinalEntries = agentEntries.filter(
    (entry) => entry.item.phase === "final_answer",
  );
  const finalEntries =
    explicitFinalEntries.length > 0
      ? explicitFinalEntries
      : turn.status === "completed"
        ? [agentEntries[agentEntries.length - 1]]
        : [];

  if (finalEntries.length === 0) {
    return null;
  }

  const finalMessages = finalEntries.map((entry) => entry.item);
  const sourceIds = new Set(finalMessages.map((item) => item.id));
  return {
    insertionIndex: finalEntries[0].index,
    item: combineAgentMessages({
      id: `${turn.id}-final-agent-message`,
      messages: finalMessages,
      phase:
        explicitFinalEntries.length > 0
          ? "final_answer"
          : finalMessages[0].phase,
    }),
    sourceIds,
  };
}

function isTurnProcessSourceItem(
  item: ThreadItem,
  finalAgentSourceIds: Set<string>,
): boolean {
  if (item.type === "userMessage") {
    return false;
  }

  if (item.type === "agentMessage") {
    return item.text.trim().length > 0 && !finalAgentSourceIds.has(item.id);
  }

  if (item.type === "reasoning") {
    return hasDisplayableReasoning(item);
  }

  return true;
}

function turnProcessRenderItems(
  turn: Turn,
  finalAgentSourceIds: Set<string>,
): TurnProcessRender {
  const processEntries: Array<{ index: number; item: ThreadItem }> = [];
  const progressAgentEntries: Array<{
    index: number;
    item: AgentMessageItem;
  }> = [];

  turn.items.forEach((item, index) => {
    if (!isTurnProcessSourceItem(item, finalAgentSourceIds)) {
      return;
    }

    if (isAgentMessageItem(item)) {
      progressAgentEntries.push({ index, item });
      return;
    }

    processEntries.push({ index, item });
  });

  if (progressAgentEntries.length > 0) {
    processEntries.push({
      index: progressAgentEntries[0].index,
      item: combineAgentMessages({
        id: `${turn.id}-progress-agent-messages`,
        messages: progressAgentEntries.map((entry) => entry.item),
        phase: "commentary",
      }),
    });
  }

  processEntries.sort((left, right) => left.index - right.index);

  return {
    firstIndex: processEntries[0]?.index ?? -1,
    items: processEntries.map((entry) => entry.item),
  };
}

function hasFinalAgentOutput(turn: Turn, streamingText: string): boolean {
  return (
    streamingText.trim().length > 0 || Boolean(finalAgentMessageForTurn(turn))
  );
}

function itemActivityKey(item: ThreadItem): string {
  switch (item.type) {
    case "userMessage":
      return `${item.type}:${JSON.stringify(item.content).length}`;
    case "agentMessage":
      return `${item.type}:${item.text.length}:${item.phase ?? ""}`;
    case "commandExecution":
      return `${item.type}:${item.status}:${
        item.aggregatedOutput?.length ?? 0
      }:${item.exitCode ?? ""}`;
    case "fileChange":
      return `${item.type}:${item.status}:${item.changes.length}`;
    case "mcpToolCall":
      return `${item.type}:${item.status}:${
        JSON.stringify(item.result ?? item.error ?? "").length
      }`;
    case "dynamicToolCall": {
      const contentKey =
        item.contentItems
          ?.map((content) =>
            content.type === "inputText"
              ? content.text.length
              : content.imageUrl.length,
          )
          .join(",") ?? "";
      return `${item.type}:${item.status}:${contentKey}:${item.success ?? ""}`;
    }
    case "collabAgentToolCall":
      return `${item.type}:${item.status}:${
        JSON.stringify(item.agentsStates).length
      }`;
    case "reasoning":
      return `${item.type}:${item.summary.join("\n").length}:${item.content.join("\n").length}`;
    case "plan":
      return `${item.type}:${item.text.length}`;
    default:
      return `${item.type}:${JSON.stringify(item).length}`;
  }
}

export function transcriptActivityKey(
  thread: Thread | null,
  streamingText: string,
  thinking: boolean,
): string {
  const lastTurn = thread?.turns[thread.turns.length - 1] ?? null;
  const lastItem = lastTurn?.items[lastTurn.items.length - 1] ?? null;
  return [
    thread?.id ?? "no-thread",
    thread?.turns.length ?? 0,
    lastTurn?.id ?? "no-turn",
    lastTurn?.status ?? "idle",
    lastTurn?.items.length ?? 0,
    lastItem ? itemActivityKey(lastItem) : "no-item",
    streamingText.length,
    thinking ? "thinking" : "ready",
  ].join("|");
}

export function shouldFollowTranscriptUpdate({
  isActive,
  isNearBottom,
  isThreadChange,
}: {
  isActive: boolean;
  isNearBottom: boolean;
  isThreadChange: boolean;
}): boolean {
  return isThreadChange || isNearBottom || isActive;
}

function transcriptScroller(anchor: HTMLDivElement): HTMLElement | null {
  const scroller = anchor.closest(".message-list");
  return scroller instanceof HTMLElement ? scroller : null;
}

function scrollTranscriptToBottom(anchor: HTMLDivElement) {
  const scroller = transcriptScroller(anchor);
  if (scroller) {
    scroller.scrollTop = scroller.scrollHeight;
    return;
  }
  anchor.scrollIntoView({ block: "end" });
}

function cancelTranscriptFollowFrames(frameIds: MutableRefObject<number[]>) {
  for (const frameId of frameIds.current) {
    window.cancelAnimationFrame(frameId);
  }
  frameIds.current = [];
}

function scheduleTranscriptFollow(
  anchor: HTMLDivElement,
  frameIds: MutableRefObject<number[]>,
) {
  cancelTranscriptFollowFrames(frameIds);
  scrollTranscriptToBottom(anchor);
  const firstFrame = window.requestAnimationFrame(() => {
    scrollTranscriptToBottom(anchor);
    const secondFrame = window.requestAnimationFrame(() => {
      scrollTranscriptToBottom(anchor);
    });
    frameIds.current = [secondFrame];
  });
  frameIds.current = [firstFrame];
}

function turnTimeLabel(turn: Turn, locale: Locale): string {
  if (turn.completedAt) {
    return formatRelativeTime(turn.completedAt, locale);
  }

  if (turn.startedAt) {
    return formatRelativeTime(turn.startedAt, locale);
  }

  return locale === "zh" ? "未开始" : "Not started";
}

function turnDurationLabel(durationMs: number | null, locale: Locale): string | null {
  if (!durationMs) {
    return null;
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));

  if (totalSeconds < 60) {
    return locale === "zh" ? `${totalSeconds} 秒` : `${totalSeconds}s`;
  }

  const totalMinutes = Math.round(totalSeconds / 60);

  if (totalMinutes < 60) {
    return locale === "zh" ? `${totalMinutes} 分钟` : `${totalMinutes}m`;
  }

  const totalHours = Math.round(totalMinutes / 60);

  return locale === "zh" ? `${totalHours} 小时` : `${totalHours}h`;
}

function processItemBucketLabel(item: ThreadItem, locale: Locale): string {
  switch (item.type) {
    case "reasoning":
      return locale === "zh" ? "推理" : "Reasoning";
    case "plan":
      return locale === "zh" ? "计划" : "Plan";
    case "commandExecution":
      return locale === "zh" ? "命令" : "Command";
    case "fileChange":
      return locale === "zh" ? "文件" : "Files";
    case "mcpToolCall":
      return "MCP";
    case "dynamicToolCall":
      return locale === "zh" ? "技能" : "Skill";
    case "collabAgentToolCall":
    case "subAgentActivity":
      return "Agent";
    case "webSearch":
      return locale === "zh" ? "搜索" : "Search";
    case "imageView":
    case "imageGeneration":
      return locale === "zh" ? "图片" : "Image";
    case "hookPrompt":
      return "Hook";
    case "enteredReviewMode":
    case "exitedReviewMode":
      return locale === "zh" ? "审查" : "Review";
    case "contextCompaction":
      return locale === "zh" ? "压缩" : "Compact";
    case "userMessage":
    case "agentMessage":
      return locale === "zh" ? "进展" : "Progress";
  }
}

function turnProcessBuckets(items: ThreadItem[], locale: Locale): string {
  const buckets = new Map<string, number>();

  for (const item of items) {
    const label = processItemBucketLabel(item, locale);
    buckets.set(label, (buckets.get(label) ?? 0) + 1);
  }

  return Array.from(buckets)
    .map(([label, count]) => `${label} ${count}`)
    .join(" · ");
}

function processDetailsLabel(items: ThreadItem[], locale: Locale): string {
  if (locale === "zh") {
    return `执行过程 · ${items.length} 项`;
  }

  return `Run process · ${items.length} item${items.length === 1 ? "" : "s"}`;
}

function processToggleLabel(isExpanded: boolean, locale: Locale): string {
  if (locale === "zh") {
    return isExpanded ? "收起过程" : "展开过程";
  }

  return isExpanded ? "Collapse process" : "Expand process";
}

type TurnProcessPanelState = "collapsed" | "collapsing" | "expanded";

const TURN_PROCESS_COLLAPSE_MS = 260;

function TranscriptProcessGroup({
  hasFinalOutput,
  itemLabels,
  items,
  locale,
  turnId,
}: {
  hasFinalOutput: boolean;
  itemLabels: TranscriptItemLabels;
  items: ThreadItem[];
  locale: Locale;
  turnId: string;
}) {
  const [panelState, setPanelState] = useState<TurnProcessPanelState>(() =>
    hasFinalOutput ? "collapsed" : "expanded",
  );
  const [isAutoCollapsed, setIsAutoCollapsed] = useState(hasFinalOutput);
  const hadFinalOutputRef = useRef(hasFinalOutput);
  const collapseTimerRef = useRef<number | null>(null);
  const processId = `turn-process-${turnId}`;
  const isExpanded = panelState === "expanded";
  const isRendered = panelState !== "collapsed";

  const clearCollapseTimer = () => {
    if (collapseTimerRef.current === null) {
      return;
    }

    window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
  };

  const collapseWithAnimation = () => {
    clearCollapseTimer();
    setPanelState((current) =>
      current === "collapsed" ? "collapsed" : "collapsing",
    );
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      setPanelState("collapsed");
    }, TURN_PROCESS_COLLAPSE_MS);
  };

  useEffect(() => {
    if (hasFinalOutput && !hadFinalOutputRef.current) {
      setIsAutoCollapsed(true);
      collapseWithAnimation();
    }
    hadFinalOutputRef.current = hasFinalOutput;
  }, [hasFinalOutput]);

  useEffect(
    () => () => {
      clearCollapseTimer();
    },
    [],
  );

  const handleToggle = () => {
    if (isRendered) {
      setIsAutoCollapsed(false);
      collapseWithAnimation();
      return;
    }

    clearCollapseTimer();
    setPanelState("expanded");
    if (isAutoCollapsed) {
      setIsAutoCollapsed(false);
    }
  };

  return (
    <section
      className="turn-process-details"
      data-auto-collapsed={isAutoCollapsed ? "true" : "false"}
      data-state={panelState}
    >
      <button
        type="button"
        className="turn-process-summary"
        aria-controls={processId}
        aria-expanded={isRendered}
        onClick={handleToggle}
      >
        <span className="turn-process-summary-main">
          <span className="turn-process-title">
            {processDetailsLabel(items, locale)}
          </span>
        </span>
        <em>{turnProcessBuckets(items, locale)}</em>
        <strong>{processToggleLabel(isExpanded, locale)}</strong>
      </button>
      <div
        className="turn-process-items-shell"
        hidden={!isRendered}
        id={processId}
      >
        <div className="turn-process-items">
          {items.map((item) => (
            <TranscriptMessage
              item={item}
              itemLabels={itemLabels}
              key={item.id}
              locale={locale}
              variant="process"
            />
          ))}
        </div>
      </div>
    </section>
  );
}

export function Transcript({
  commandLabel,
  crewonLabel,
  emptyDescription,
  emptyThreadDescription,
  emptyThreadTitle,
  emptyTitle,
  filesLabel,
  locale,
  modeCodeLabel,
  modeCodeDescription,
  modeOfficeLabel,
  modeOfficeDescription,
  modeTitleLabel,
  mode,
  onModeChange,
  onStop,
  planLabel,
  reasoningLabel,
  stopLabel,
  thread,
  streamingText,
  youLabel,
}: TranscriptProps) {
  const followAnchorRef = useRef<HTMLDivElement>(null);
  const followFrameIdsRef = useRef<number[]>([]);
  const previousThreadIdRef = useRef<string | null>(null);
  const shouldFollowRef = useRef(true);
  const items = thread?.turns.flatMap((turn) => turn.items) ?? [];
  const lastTurn = thread?.turns[thread.turns.length - 1] ?? null;
  const hasVisibleInProgressItem = Boolean(
    lastTurn?.items.some((item) => {
      if (
        item.type === "commandExecution" ||
        item.type === "fileChange" ||
        item.type === "mcpToolCall" ||
        item.type === "dynamicToolCall" ||
        item.type === "collabAgentToolCall"
      ) {
        return item.status === "inProgress";
      }

      return (
        item.type === "reasoning" &&
        item.summary.length === 0 &&
        item.content.length === 0
      );
    }),
  );
  const shouldShowThinking =
    Boolean(thread) &&
    !streamingText &&
    lastTurn?.status === "inProgress" &&
    !hasVisibleInProgressItem;
  const itemLabels: TranscriptItemLabels = {
    commandLabel,
    crewonLabel,
    filesLabel,
    planLabel,
    reasoningLabel,
    youLabel,
  };
  const activityKey = transcriptActivityKey(
    thread,
    streamingText,
    shouldShowThinking,
  );

  useEffect(
    () => () => {
      cancelTranscriptFollowFrames(followFrameIdsRef);
    },
    [],
  );

  useEffect(() => {
    const anchor = followAnchorRef.current;
    if (!thread || !anchor) {
      return;
    }

    const previousThreadId = previousThreadIdRef.current;
    const isThreadChange = previousThreadId !== thread.id;
    previousThreadIdRef.current = thread.id;

    const scroller = transcriptScroller(anchor);
    let isNearBottom = true;
    if (scroller) {
      const distanceFromBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      isNearBottom = distanceFromBottom < 180;
    }
    const isActive =
      Boolean(streamingText) ||
      shouldShowThinking ||
      lastTurn?.status === "inProgress";
    const shouldFollow = shouldFollowTranscriptUpdate({
      isActive,
      isNearBottom,
      isThreadChange,
    });
    shouldFollowRef.current = shouldFollow;
    if (!shouldFollow) {
      return;
    }

    scheduleTranscriptFollow(anchor, followFrameIdsRef);
  }, [
    activityKey,
    lastTurn?.status,
    shouldShowThinking,
    streamingText,
    thread?.id,
  ]);

  useEffect(() => {
    const anchor = followAnchorRef.current;
    if (!thread || !anchor) {
      return;
    }

    const scroller = transcriptScroller(anchor);
    if (!scroller) {
      return;
    }

    const updateFollowState = () => {
      const distanceFromBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      shouldFollowRef.current = distanceFromBottom < 180;
    };
    scroller.addEventListener("scroll", updateFollowState, { passive: true });

    if (typeof ResizeObserver === "undefined") {
      return () => {
        scroller.removeEventListener("scroll", updateFollowState);
      };
    }

    const observer = new ResizeObserver(() => {
      if (shouldFollowRef.current) {
        scheduleTranscriptFollow(anchor, followFrameIdsRef);
      }
    });
    for (const child of Array.from(scroller.children)) {
      observer.observe(child);
    }

    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", updateFollowState);
    };
  }, [activityKey, thread?.id]);

  if (!thread) {
    return (
      <main className="empty-state">
        <div className="empty-hero">
          <h1>{emptyTitle}</h1>
          <p>{emptyDescription}</p>
          <div className="mode-switch" aria-label={modeTitleLabel}>
            <button type="button" aria-pressed={mode === "code"} data-active={mode === "code"} onClick={() => onModeChange("code")}>
              <Code2 size={15} />
              {modeCodeLabel}
            </button>
            <button
              type="button"
              aria-pressed={mode === "office"}
              data-active={mode === "office"}
              onClick={() => onModeChange("office")}
            >
              <Sparkles size={15} />
              {modeOfficeLabel}
            </button>
          </div>
          <div className="mode-description">{mode === "code" ? modeCodeDescription : modeOfficeDescription}</div>
        </div>
      </main>
    );
  }

  return (
    <main className="transcript">
      <div className="message-list" role="log" aria-busy={Boolean(streamingText) || shouldShowThinking} aria-live="polite" aria-relevant="additions text">
        {items.length === 0 && !streamingText && !shouldShowThinking ? (
          <div className="message-empty-state" aria-label={`${emptyThreadTitle}. ${emptyThreadDescription}`} role="status">
            <span className="message-empty-icon" aria-hidden="true">
              <Sparkles size={18} />
            </span>
            <strong>{emptyThreadTitle}</strong>
            <p>{emptyThreadDescription}</p>
          </div>
        ) : null}
        {thread.turns.map((turn, turnIndex) => {
          const durationLabel = turnDurationLabel(turn.durationMs, locale);
          const dividerDetailLabel = durationLabel ?? turnTimeLabel(turn, locale);
          const dividerLabel = turnLabel(turn, locale);
          const finalAgentMessage = finalAgentMessageForTurn(turn);
          const finalAgentSourceIds = finalAgentMessage?.sourceIds ?? new Set<string>();
          const processRender = turnProcessRenderItems(turn, finalAgentSourceIds);
          const processItems = processRender.items;
          const firstProcessIndex = processRender.firstIndex;
          const turnStreamingText = turn.id === lastTurn?.id ? streamingText : "";
          const processHasFinalOutput = hasFinalAgentOutput(
            turn,
            turnStreamingText,
          );
          const processGroup =
            processItems.length > 0 ? (
              <TranscriptProcessGroup
                hasFinalOutput={processHasFinalOutput}
                itemLabels={itemLabels}
                items={processItems}
                key={`${turn.id}-process`}
                locale={locale}
                turnId={turn.id}
              />
            ) : null;
          return (
            <section
              className="turn-group"
              data-status={turn.status}
              aria-label={`${dividerLabel} ${turnIndex + 1}`}
              key={turn.id}
            >
              {shouldShowTurnDivider(turn) ? (
                <div className="turn-divider" data-status={turn.status}>
                  <span>{dividerLabel}</span>
                  <em>{dividerDetailLabel}</em>
                </div>
              ) : null}
              {turn.items.map((item, itemIndex) => {
                if (isTurnProcessSourceItem(item, finalAgentSourceIds)) {
                  if (itemIndex !== firstProcessIndex) {
                    return null;
                  }

                  return processGroup;
                }

                if (item.type === "agentMessage") {
                  if (
                    !finalAgentMessage ||
                    !finalAgentMessage.sourceIds.has(item.id) ||
                    itemIndex !== finalAgentMessage.insertionIndex
                  ) {
                    return null;
                  }

                  return (
                    <TranscriptMessage
                      item={finalAgentMessage.item}
                      itemLabels={itemLabels}
                      key={finalAgentMessage.item.id}
                      locale={locale}
                    />
                  );
                }

                return (
                  <TranscriptMessage
                    item={item}
                    itemLabels={itemLabels}
                    key={item.id}
                    locale={locale}
                  />
                );
              })}
              {shouldShowFailureResponse(turn) ? (
                <TranscriptFailureMessage
                  crewonLabel={crewonLabel}
                  error={turn.error}
                  locale={locale}
                />
              ) : null}
            </section>
          );
        })}
        {streamingText ? (
          <TranscriptStreamingMessage
            crewonLabel={crewonLabel}
            locale={locale}
            streamingText={streamingText}
          />
        ) : null}
        {shouldShowThinking ? (
          <TranscriptThinkingMessage
            crewonLabel={crewonLabel}
            locale={locale}
            stopLabel={stopLabel}
            onStop={onStop}
          />
        ) : null}
        <div
          aria-hidden="true"
          className="transcript-follow-anchor"
          data-testid="transcript-follow-anchor"
          ref={followAnchorRef}
        />
      </div>
    </main>
  );
}
