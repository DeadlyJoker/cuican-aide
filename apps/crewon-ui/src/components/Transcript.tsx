import { Fragment } from "react";
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
  type TranscriptItemLabels,
} from "./TranscriptMessage";

type TranscriptProps = {
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

function finalAgentMessageIndex(items: ThreadItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "agentMessage" && item.text.trim().length > 0) {
      return index;
    }
  }

  return -1;
}

function shouldCollapseTurnProcess(turn: Turn): boolean {
  if (turn.status !== "completed") {
    return false;
  }

  const finalIndex = finalAgentMessageIndex(turn.items);
  if (finalIndex < 0) {
    return false;
  }

  return turn.items.some(
    (item, index) => index !== finalIndex && item.type !== "userMessage",
  );
}

function shouldShowFailureResponse(turn: Turn): boolean {
  return (
    turn.status === "failed" &&
    !turn.items.some(
      (item) => item.type === "agentMessage" && item.text.trim().length > 0,
    )
  );
}

function turnProcessBuckets(items: ThreadItem[], locale: Locale): string {
  const buckets = new Map<string, number>();

  for (const item of items) {
    const label =
      item.type === "reasoning"
        ? locale === "zh"
          ? "推理"
          : "reasoning"
        : item.type === "commandExecution"
          ? locale === "zh"
            ? "命令"
            : "commands"
          : item.type === "fileChange"
            ? locale === "zh"
              ? "文件"
              : "files"
            : item.type === "mcpToolCall" || item.type === "dynamicToolCall"
              ? locale === "zh"
                ? "工具"
                : "tools"
              : locale === "zh"
                ? "过程"
                : "steps";
    buckets.set(label, (buckets.get(label) ?? 0) + 1);
  }

  return Array.from(buckets)
    .map(([label, count]) => `${label} ${count}`)
    .join(" · ");
}

function processDetailsLabel(items: ThreadItem[], locale: Locale): string {
  const itemCount = items.length;
  if (locale === "zh") {
    return `执行过程 · ${itemCount} 项`;
  }

  return `Work details · ${itemCount} item${itemCount === 1 ? "" : "s"}`;
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

function TranscriptProcessDetails({
  itemLabels,
  items,
  locale,
}: {
  itemLabels: TranscriptItemLabels;
  items: ThreadItem[];
  locale: Locale;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <details className="turn-process-details">
      <summary>
        <span>{processDetailsLabel(items, locale)}</span>
        <em>{turnProcessBuckets(items, locale)}</em>
      </summary>
      <div className="turn-process-items">
        {items.map((item) => (
          <TranscriptMessage
            item={item}
            itemLabels={itemLabels}
            key={item.id}
            locale={locale}
          />
        ))}
      </div>
    </details>
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
  const items = thread?.turns.flatMap((turn) => turn.items) ?? [];
  const lastTurn = thread?.turns[thread.turns.length - 1] ?? null;
  const hasVisibleInProgressItem = Boolean(
    lastTurn?.items.some((item) => {
      if (item.type === "commandExecution" || item.type === "fileChange") {
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
          const collapseProcess = shouldCollapseTurnProcess(turn);
          const finalIndex = collapseProcess
            ? finalAgentMessageIndex(turn.items)
            : -1;
          const visibleItems = collapseProcess
            ? turn.items.filter(
                (item, itemIndex) =>
                  item.type === "userMessage" || itemIndex === finalIndex,
              )
            : turn.items;
          const processItems = collapseProcess
            ? turn.items.filter(
                (item, itemIndex) =>
                  item.type !== "userMessage" && itemIndex !== finalIndex,
              )
            : [];

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
              {visibleItems.map((item) =>
                item.type === "agentMessage" && collapseProcess ? (
                  <Fragment key={item.id}>
                    <TranscriptProcessDetails
                      itemLabels={itemLabels}
                      items={processItems}
                      locale={locale}
                    />
                    <TranscriptMessage
                      item={item}
                      itemLabels={itemLabels}
                      key={item.id}
                      locale={locale}
                    />
                  </Fragment>
                ) : (
                  <TranscriptMessage
                    item={item}
                    itemLabels={itemLabels}
                    key={item.id}
                    locale={locale}
                  />
                ),
              )}
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
      </div>
    </main>
  );
}
