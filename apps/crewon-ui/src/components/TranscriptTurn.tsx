import { memo } from "react";
import { TranscriptProjectPlanningSuggestions } from "./project-planning/TranscriptProjectPlanningSuggestions";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import type { Locale } from "../lib/i18n";
import { formatRelativeTime } from "../lib/shared/text";
import { MessageActions } from "./messages/MessageActions";
import { TranscriptProcessGroup } from "./TranscriptProcessGroup";
import {
  TranscriptMessage,
  TranscriptFailureMessage,
  combineAgentMessages,
  type TranscriptItemLabels,
} from "./TranscriptMessage";
import {
  aggregateReasoningItems,
  hasDisplayableReasoning,
  hasProcessReasoning,
} from "./transcriptReasoning";

export function hasFinalAgentResponse(turn: Turn): boolean {
  return turn.items.some(
    (item) =>
      item.type === "agentMessage" &&
      item.text.trim().length > 0 &&
      (turn.status === "completed" || item.phase === "final_answer"),
  );
}

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
  durableMessageId: string | null;
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
    .filter((entry): entry is { item: AgentMessageItem; index: number } =>
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
    durableMessageId:
      turn.status === "completed" && finalMessages.length === 1
        ? finalMessages[0]!.id
        : null,
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
  if (item.type === "userMessage" || item.type === "plan") {
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

type TranscriptTurnProps = {
  turn: Turn;
  turnIndex: number;
  locale: Locale;
  itemLabels: TranscriptItemLabels;
  crewonLabel: string;
  hasWorkbench: boolean;
  shouldShowThinking: boolean;
  hidesDurableFinalWhileStreaming: boolean;
  isLatestResponse: boolean;
};

// Stable historical turns keep their combined final message and Markdown tree
// when only the active response receives another streaming delta.
export const TranscriptTurn = memo(function TranscriptTurn({
  turn,
  turnIndex,
  locale,
  itemLabels,
  crewonLabel,
  hasWorkbench,
  shouldShowThinking,
  hidesDurableFinalWhileStreaming,
  isLatestResponse,
}: TranscriptTurnProps) {
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
      data-workbench-origin={hasWorkbench ? turn.id : undefined}
      tabIndex={hasWorkbench ? -1 : undefined}
      data-status={turn.status}
      aria-label={`${dividerLabel} ${turnIndex + 1}`}
      key={turn.id}
    >
      {processItems.length === 0 &&
      shouldShowTurnDivider(turn) &&
      !shouldShowThinking ? (
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
            hidesDurableFinalWhileStreaming ||
            !finalAgentMessage ||
            !finalAgentMessage.sourceIds.has(item.id) ||
            itemIndex !== finalAgentMessage.insertionIndex
          ) {
            return null;
          }

          return (
            <TranscriptMessage
              durableMessageId={finalAgentMessage.durableMessageId}
              item={finalAgentMessage.item}
              itemLabels={itemLabels}
              key={finalAgentMessage.item.id}
              locale={locale}
              actions={
                turn.status !== "inProgress" ? (
                  <MessageActions
                    text={finalAgentMessage.item.text}
                    locale={locale}
                    visibility={isLatestResponse ? "always" : "on-hover"}
                  />
                ) : undefined
              }
            />
          );
        }

        return (
          <TranscriptMessage
            item={item}
            itemLabels={itemLabels}
            key={item.id}
            locale={locale}
            actions={
              item.type === "userMessage" ? (
                <MessageActions
                  text={item.content
                    .filter((input) => input.type === "text")
                    .map((input) => input.text)
                    .join("\n\n")}
                  locale={locale}
                  user
                  userMessageId={item.id}
                />
              ) : undefined
            }
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
      <TranscriptProjectPlanningSuggestions
        items={turn.items}
        locale={locale}
      />
    </section>
  );
});
