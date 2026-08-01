import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { ArrowDown, Code2, ListTree, Sparkles, Terminal } from "lucide-react";
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
import {
  aggregateReasoningItems,
  hasDisplayableReasoning,
  hasProcessReasoning,
  isActionProcessItem,
} from "./transcriptReasoning";

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
    return hasProcessReasoning(item);
  }

  return true;
}

type ProcessEntry = { index: number; item: ThreadItem };

function collapseReasoningEntries(entries: ProcessEntry[]): ProcessEntry[] {
  const collapsed: ProcessEntry[] = [];
  let reasoningBatch: Array<Extract<ThreadItem, { type: "reasoning" }>> = [];
  let batchStart = -1;

  const flushReasoning = () => {
    if (reasoningBatch.length === 0) {
      return;
    }

    collapsed.push({
      index: batchStart,
      item: aggregateReasoningItems(
        reasoningBatch,
        `${reasoningBatch[0].id}-process-thought`,
      ),
    });
    reasoningBatch = [];
    batchStart = -1;
  };

  for (const entry of entries) {
    if (entry.item.type === "reasoning") {
      if (batchStart < 0) {
        batchStart = entry.index;
      }
      reasoningBatch.push(entry.item);
      continue;
    }

    flushReasoning();
    collapsed.push(entry);
  }

  flushReasoning();
  return collapsed;
}

function turnProcessRenderItems(
  turn: Turn,
  finalAgentSourceIds: Set<string>,
): TurnProcessRender {
  const processEntries: ProcessEntry[] = [];

  turn.items.forEach((item, index) => {
    if (!isTurnProcessSourceItem(item, finalAgentSourceIds)) {
      return;
    }

    processEntries.push({ index, item });
  });

  processEntries.sort((left, right) => left.index - right.index);

  // Merge consecutive reasoning breadcrumbs into one "Thought · N steps" row so
  // the process pill stays visible without flooding the log.
  const visibleEntries = collapseReasoningEntries(processEntries).filter(
    (entry) =>
      entry.item.type !== "reasoning" || hasDisplayableReasoning(entry.item),
  );

  return {
    firstIndex: visibleEntries[0]?.index ?? -1,
    items: visibleEntries.map((entry) => entry.item),
  };
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

function turnTimeLabel(turn: Turn, locale: Locale): string | null {
  if (turn.completedAt) {
    return formatRelativeTime(turn.completedAt, locale);
  }

  if (turn.startedAt) {
    return formatRelativeTime(turn.startedAt, locale);
  }

  return null;
}

function turnDurationLabel(durationMs: number | null): string | null {
  if (!durationMs) {
    return null;
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    seconds > 0 || (hours === 0 && minutes === 0) ? `${seconds}s` : null,
  ];

  return parts.filter(Boolean).join(" ");
}

function processActionStatus(item: ThreadItem): "completed" | "failed" | "inProgress" {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
      return item.status === "inProgress"
        ? "inProgress"
        : item.status === "failed" || item.status === "declined"
          ? "failed"
          : "completed";
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
      return item.status;
    case "imageGeneration":
      return item.status === "completed" || item.status === "succeeded"
        ? "completed"
        : "inProgress";
    default:
      return "completed";
  }
}

function isFileReadAction(item: ThreadItem): boolean {
  if (item.type !== "mcpToolCall") {
    return false;
  }

  const server = item.server.toLowerCase();
  const tool = item.tool.toLowerCase();
  return (
    (server.includes("file") || server.includes("filesystem")) &&
    tool.includes("read") &&
    (tool.includes("file") || tool === "read")
  );
}

function processActionGroupLabel(items: ThreadItem[], locale: Locale): string {
  const counts = items.reduce(
    (current, item) => ({
      commands: current.commands + (item.type === "commandExecution" ? 1 : 0),
      fileChanges: current.fileChanges + (item.type === "fileChange" ? 1 : 0),
      fileReads: current.fileReads + (isFileReadAction(item) ? 1 : 0),
      searches: current.searches + (item.type === "webSearch" ? 1 : 0),
      other:
        current.other +
        (item.type !== "commandExecution" &&
        item.type !== "fileChange" &&
        item.type !== "webSearch" &&
        !isFileReadAction(item)
          ? 1
          : 0),
    }),
    { commands: 0, fileChanges: 0, fileReads: 0, other: 0, searches: 0 },
  );

  if (locale === "zh") {
    return [
      counts.fileReads > 0
        ? counts.fileReads === 1
          ? "读取了文件"
          : `读取了 ${counts.fileReads} 个文件`
        : null,
      counts.commands > 0
        ? counts.commands === 1
          ? "运行了命令"
          : "运行了多个命令"
        : null,
      counts.searches > 0
        ? counts.searches === 1
          ? "完成了搜索"
          : `完成了 ${counts.searches} 次搜索`
        : null,
      counts.fileChanges > 0
        ? counts.fileChanges === 1
          ? "编辑了文件"
          : `编辑了 ${counts.fileChanges} 批文件`
        : null,
      counts.other > 0
        ? counts.other === 1
          ? "调用了工具"
          : `调用了 ${counts.other} 个工具`
        : null,
    ]
      .filter(Boolean)
      .join("、");
  }

  return [
    counts.fileReads > 0
      ? counts.fileReads === 1
        ? "Read a file"
        : `Read ${counts.fileReads} files`
      : null,
    counts.commands > 0
      ? counts.commands === 1
        ? "Ran a command"
        : "Ran multiple commands"
      : null,
    counts.searches > 0
      ? counts.searches === 1
        ? "Searched the web"
        : `Ran ${counts.searches} searches`
      : null,
    counts.fileChanges > 0
      ? counts.fileChanges === 1
        ? "Edited files"
        : `Edited ${counts.fileChanges} file batches`
      : null,
    counts.other > 0
      ? counts.other === 1
        ? "Called a tool"
        : `Called ${counts.other} tools`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

type ProcessTimelineEntry =
  | { item: ThreadItem; type: "item" }
  | { id: string; items: ThreadItem[]; type: "actionGroup" };

function processTimelineEntries(items: ThreadItem[]): ProcessTimelineEntry[] {
  const entries: ProcessTimelineEntry[] = [];
  let actionItems: ThreadItem[] = [];

  const flushActions = () => {
    if (actionItems.length === 0) {
      return;
    }

    if (actionItems.length === 1) {
      entries.push({ item: actionItems[0], type: "item" });
    } else {
      entries.push({
        id: `${actionItems[0].id}-action-group`,
        items: actionItems,
        type: "actionGroup",
      });
    }
    actionItems = [];
  };

  for (const item of items) {
    if (isActionProcessItem(item)) {
      actionItems.push(item);
      continue;
    }

    flushActions();
    entries.push({ item, type: "item" });
  }

  flushActions();
  return entries;
}

function TranscriptProcessActionGroup({
  itemLabels,
  items,
  locale,
}: {
  itemLabels: TranscriptItemLabels;
  items: ThreadItem[];
  locale: Locale;
}) {
  const status = items.reduce<"completed" | "failed" | "inProgress">(
    (current, item) => {
      const itemStatus = processActionStatus(item);
      if (current === "inProgress" || itemStatus === "inProgress") {
        return "inProgress";
      }
      if (current === "failed" || itemStatus === "failed") {
        return "failed";
      }
      return "completed";
    },
    "completed",
  );
  const commandOnly = items.every((item) => item.type === "commandExecution");

  return (
    <details
      className="process-action-group"
      data-status={status}
      {...(status === "inProgress" ? { open: true } : {})}
    >
      <summary>
        <span className="process-action-group-icon" aria-hidden="true">
          {commandOnly ? <Terminal size={16} /> : <ListTree size={16} />}
        </span>
        <span>{processActionGroupLabel(items, locale)}</span>
      </summary>
      <div className="process-action-group-items">
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
    </details>
  );
}

type TurnProcessPanelState = "collapsed" | "collapsing" | "expanded";

const TURN_PROCESS_COLLAPSE_MS = 260;

function TranscriptProcessGroup({
  detailLabel,
  itemLabels,
  items,
  label,
  locale,
  status,
  turnId,
}: {
  detailLabel: string | null;
  itemLabels: TranscriptItemLabels;
  items: ThreadItem[];
  label: string;
  locale: Locale;
  status: Turn["status"];
  turnId: string;
}) {
  const [panelState, setPanelState] = useState<TurnProcessPanelState>(() =>
    status === "inProgress" ? "expanded" : "collapsed",
  );
  const collapseTimerRef = useRef<number | null>(null);
  const processId = `turn-process-${turnId}`;
  const isExpanded = panelState === "expanded";
  const isRendered = panelState !== "collapsed";
  const timelineEntries = processTimelineEntries(items);

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

  useEffect(
    () => () => {
      clearCollapseTimer();
    },
    [],
  );

  const handleToggle = () => {
    if (isRendered) {
      collapseWithAnimation();
      return;
    }

    clearCollapseTimer();
    setPanelState("expanded");
  };

  return (
    <section
      className="turn-process-details"
      data-state={panelState}
      data-status={status}
    >
      <button
        type="button"
        className="turn-process-summary"
        aria-controls={processId}
        aria-expanded={isExpanded}
        onClick={handleToggle}
      >
        <span className="turn-process-summary-main">
          <span className="turn-process-title">{label}</span>
          {detailLabel ? <em>{detailLabel}</em> : null}
        </span>
      </button>
      <div
        className="turn-process-items-shell"
        hidden={!isRendered}
        id={processId}
      >
        <div className="turn-process-items">
          {timelineEntries.map((entry) =>
            entry.type === "actionGroup" ? (
              <TranscriptProcessActionGroup
                itemLabels={itemLabels}
                items={entry.items}
                key={entry.id}
                locale={locale}
              />
            ) : (
              <TranscriptMessage
                item={entry.item}
                itemLabels={itemLabels}
                key={entry.item.id}
                locale={locale}
                variant="process"
              />
            ),
          )}
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
  onStop: _onStop,
  planLabel,
  reasoningLabel,
  stopLabel: _stopLabel,
  thread,
  streamingText,
  youLabel,
}: TranscriptProps) {
  const followAnchorRef = useRef<HTMLDivElement>(null);
  const followFrameIdsRef = useRef<number[]>([]);
  const previousThreadIdRef = useRef<string | null>(null);
  const shouldFollowRef = useRef(true);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const items = thread?.turns.flatMap((turn) => turn.items) ?? [];
  const lastTurn = thread?.turns[thread.turns.length - 1] ?? null;
  const hasVisibleProcessActivity = Boolean(
    lastTurn?.items.some((item) => {
      if (isActionProcessItem(item)) {
        return true;
      }

      if (item.type !== "reasoning") {
        return false;
      }

      return hasDisplayableReasoning(item);
    }),
  );
  const shouldShowThinking =
    Boolean(thread) &&
    !streamingText &&
    lastTurn?.status === "inProgress" &&
    !hasVisibleProcessActivity;
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
    if (isThreadChange) {
      setIsScrolledUp(false);
    }

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
      setIsScrolledUp(distanceFromBottom >= 180);
    };
    scroller.addEventListener("scroll", updateFollowState, { passive: true });
    updateFollowState();

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
          const durationLabel = turnDurationLabel(turn.durationMs);
          const dividerDetailLabel = durationLabel ?? turnTimeLabel(turn, locale);
          const dividerLabel = turnLabel(turn, locale);
          const finalAgentMessage = finalAgentMessageForTurn(turn);
          const finalAgentSourceIds = finalAgentMessage?.sourceIds ?? new Set<string>();
          const processRender = turnProcessRenderItems(turn, finalAgentSourceIds);
          const processItems = processRender.items;
          const firstProcessIndex = processRender.firstIndex;
          const processGroup =
            processItems.length > 0 ? (
              <TranscriptProcessGroup
                detailLabel={dividerDetailLabel}
                itemLabels={itemLabels}
                items={processItems}
                key={`${turn.id}-process`}
                label={dividerLabel}
                locale={locale}
                status={turn.status}
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
              {processItems.length === 0 && shouldShowTurnDivider(turn) ? (
                <div className="turn-divider" data-status={turn.status}>
                  <span>{dividerLabel}</span>
                  {dividerDetailLabel ? <em>{dividerDetailLabel}</em> : null}
                </div>
              ) : null}
              {turn.items.map((item, itemIndex) => {
                // Empty / markup-only reasoning must not leak outside the
                // process group as a fake "Thinking" message.
                if (item.type === "reasoning" && !hasProcessReasoning(item)) {
                  return null;
                }

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
          />
        ) : null}
        <div
          aria-hidden="true"
          className="transcript-follow-anchor"
          data-testid="transcript-follow-anchor"
          ref={followAnchorRef}
        />
      </div>
      {isScrolledUp ? (
        <button
          aria-label={locale === "zh" ? "回到底部" : "Scroll to bottom"}
          className="transcript-scroll-bottom"
          data-testid="transcript-scroll-bottom"
          onClick={() => {
            shouldFollowRef.current = true;
            setIsScrolledUp(false);
            const anchor = followAnchorRef.current;
            if (anchor) {
              scheduleTranscriptFollow(anchor, followFrameIdsRef);
            }
          }}
          title={locale === "zh" ? "回到底部" : "Scroll to bottom"}
          type="button"
        >
          <ArrowDown size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      ) : null}
    </main>
  );
}
