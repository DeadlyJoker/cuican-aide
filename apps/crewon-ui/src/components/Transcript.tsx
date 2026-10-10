import { controlPendingReplyDraft } from "../lib/control-runtime/controlRunTerminalPresentation";
import { useStreamingTextPreview } from "./StreamingTextScope";
import { ProjectPlanningRunScope } from "./project-planning/ProjectPlanningScope";
import { useHasTaskWorkbench } from "./workbench/TaskWorkbenchContext";
import { useMessageReplay } from "./messages/MessageReplayScope";
import { MessageActions } from "./messages/MessageActions";
import { usePendingThreadSubmissionsPresentation } from "./messages/PendingThreadSubmissionScope";
import {
  transcriptWindow,
  transcriptRowTurn,
  type ControlTranscriptRow,
} from "../lib/control-runtime/controlTranscriptWindow";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { ArrowDown, Code2, Sparkles } from "lucide-react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { Locale } from "../lib/i18n";
import type { WorkMode } from "../lib/workMode";
import type { ControlTeamProgress } from "../lib/control-runtime/controlTeamProgress";
import {
  TranscriptTeamProgress,
  teamProgressForThread,
} from "./TranscriptTeamProgress";
import {
  TranscriptStreamingMessage,
  TranscriptMessage,
  TranscriptThinkingMessage,
  TranscriptFailureMessage,
  type TranscriptItemLabels,
} from "./TranscriptMessage";
import {
  hasDisplayableReasoning,
  isActionProcessItem,
} from "./transcriptReasoning";

import { TranscriptTurn, hasFinalAgentResponse } from "./TranscriptTurn";

type TranscriptProps = {
  teamProgress?: ControlTeamProgress | null;
  activeTurnId?: string | null;
  commandLabel: string;
  crewonLabel: string;
  emptyDescription: string;
  emptyTitle: string;
  filesLabel: string;
  loadingLabel: string;
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
  isNearBottom,
  isThreadChange,
  isEditingMessage = false,
}: {
  isNearBottom: boolean;
  isThreadChange: boolean;
  isEditingMessage?: boolean;
}): boolean {
  return !isEditingMessage && (isThreadChange || isNearBottom);
}

export function transcriptObserverStructureKey(
  thread: Thread | null,
  streamingText: string,
): string {
  return [
    thread?.id ?? "no-thread",
    thread?.turns.length ?? 0,
    streamingText.length > 0 ? "streaming" : "settled",
  ].join("|");
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

function cancelTranscriptFollowFrame(frameId: MutableRefObject<number | null>) {
  if (frameId.current !== null) {
    window.cancelAnimationFrame(frameId.current);
    frameId.current = null;
  }
}

function scheduleTranscriptFollow(
  anchor: HTMLDivElement,
  frameId: MutableRefObject<number | null>,
) {
  if (frameId.current !== null) {
    return;
  }

  frameId.current = window.requestAnimationFrame(() => {
    frameId.current = null;
    scrollTranscriptToBottom(anchor);
  });
}

export function Transcript({
  teamProgress,
  activeTurnId,
  commandLabel,
  crewonLabel,
  emptyDescription,
  emptyTitle,
  filesLabel,
  loadingLabel,
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
  const pendingSubmissions = usePendingThreadSubmissionsPresentation({ thread });
  const streamingPreview = useStreamingTextPreview(thread?.id ?? null);
  const hasWorkbench = useHasTaskWorkbench();
  const pendingTeam = teamProgressForThread(thread, teamProgress);
  const followAnchorRef = useRef<HTMLDivElement>(null);
  const followFrameRef = useRef<number | null>(null);
  const previousThreadIdRef = useRef<string | null>(null);
  const shouldFollowRef = useRef(true);
  const isEditingMessage = Boolean(useMessageReplay()?.selection);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const historyWindow = transcriptWindow(thread);
  const browsingHistory = historyWindow?.newerCursor != null;
  const pageKey = historyWindow
    ? `${thread?.id}:${historyWindow.firstSequence}:${historyWindow.lastSequence}`
    : thread?.id;
  const previousPage = useRef(pageKey);
  const rows = useMemo<ControlTranscriptRow[]>(() => {
    const turns = thread?.turns ?? [];
    const rows = [...(historyWindow?.rows ?? [])];
    const included = new Set(
      rows.flatMap((row) => (row.kind === "run" ? [row.runId] : [])),
    );
    for (const turn of turns)
      if (!included.has(turn.id))
        rows.push({
          kind: "run",
          runId: turn.id,
          itemIds: turn.items.map((item) => item.id),
          firstFragment: true,
          continuation: false,
        });
    return rows;
  }, [thread, historyWindow]);
  const turnsById = useMemo(
    () => new Map(thread?.turns.map((turn) => [turn.id, turn]) ?? []),
    [thread],
  );
  const hasItems = rows.length > 0 || pendingSubmissions.length > 0;
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
  const streamOwnedByPendingReply =
    !activeTurnId &&
    lastTurn !== null &&
    lastTurn.status !== "inProgress" &&
    controlPendingReplyDraft(lastTurn) !== null;
  const showsLiveStream = Boolean(streamingText) && !streamOwnedByPendingReply;
  const latestResponseTurnId = thread?.turns.findLast(
    (turn) => turn.status !== "inProgress" && hasFinalAgentResponse(turn),
  )?.id;
  const shouldShowThinking =
    !pendingTeam &&
    Boolean(thread) &&
    !streamingText &&
    lastTurn?.status === "inProgress" &&
    !hasVisibleProcessActivity;
  const shouldShowLoading =
    !pendingTeam &&
    Boolean(thread) &&
    thread?.status?.type === "notLoaded" &&
    !hasItems &&
    !streamingText &&
    !shouldShowThinking;
  const itemLabels = useMemo<TranscriptItemLabels>(
    () => ({
      commandLabel,
      crewonLabel,
      filesLabel,
      planLabel,
      reasoningLabel,
      youLabel,
    }),
    [
      commandLabel,
      crewonLabel,
      filesLabel,
      planLabel,
      reasoningLabel,
      youLabel,
    ],
  );
  const activityKey = useMemo(
    () =>
      `${transcriptActivityKey(thread, "", shouldShowThinking)}|${pendingSubmissions.map((pending) => pending.id).join(",")}`,
    [shouldShowThinking, thread, pendingSubmissions],
  );
  const observerStructureKey = transcriptObserverStructureKey(
    thread,
    streamingText,
  );
  useEffect(() => {
    if (previousPage.current === pageKey) return;
    previousPage.current = pageKey;
    if (!browsingHistory || !followAnchorRef.current) return;
    cancelTranscriptFollowFrame(followFrameRef);
    shouldFollowRef.current = false;
    const scroller = transcriptScroller(followAnchorRef.current);
    if (scroller) scroller.scrollTop = 0;
  }, [pageKey, browsingHistory]);
  const streamingFollowKey =
    typeof ResizeObserver === "undefined"
      ? streamingText.length
      : streamingText.length > 0;

  useEffect(
    () => () => {
      cancelTranscriptFollowFrame(followFrameRef);
    },
    [],
  );

  useEffect(() => {
    const anchor = followAnchorRef.current;
    if ((!thread && pendingSubmissions.length === 0) || !anchor) {
      return;
    }

    const previousThreadId = previousThreadIdRef.current;
    const isThreadChange = previousThreadId !== (thread?.id ?? null);
    previousThreadIdRef.current = thread?.id ?? null;
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
    const shouldFollow =
      !browsingHistory &&
      shouldFollowTranscriptUpdate({
        isNearBottom,
        isThreadChange,
        isEditingMessage,
      });
    shouldFollowRef.current = shouldFollow;
    if (!shouldFollow) {
      cancelTranscriptFollowFrame(followFrameRef);
      return;
    }

    scheduleTranscriptFollow(anchor, followFrameRef);
  }, [
    activityKey,
    isEditingMessage,
    lastTurn?.status,
    shouldShowThinking,
    streamingFollowKey,
    pendingTeam,
    thread?.id,
    browsingHistory,
    pageKey,
  ]);

  useEffect(() => {
    const anchor = followAnchorRef.current;
    if ((!thread && pendingSubmissions.length === 0) || !anchor) {
      return;
    }

    const scroller = transcriptScroller(anchor);
    if (!scroller) {
      return;
    }

    const commitFollowState = () => {
      const distanceFromBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      shouldFollowRef.current =
        !browsingHistory &&
        shouldFollowTranscriptUpdate({
          isNearBottom: distanceFromBottom < 180,
          isThreadChange: false,
          isEditingMessage,
        });
      setIsScrolledUp(distanceFromBottom >= 180);
    };
    let scrollFrame: number | null = null;
    const updateFollowState = () => {
      if (scrollFrame !== null) {
        return;
      }
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = null;
        commitFollowState();
      });
    };
    scroller.addEventListener("scroll", updateFollowState, { passive: true });
    commitFollowState();

    if (typeof ResizeObserver === "undefined") {
      return () => {
        if (scrollFrame !== null) {
          window.cancelAnimationFrame(scrollFrame);
        }
        scroller.removeEventListener("scroll", updateFollowState);
      };
    }

    const observer = new ResizeObserver(() => {
      if (shouldFollowRef.current) {
        scheduleTranscriptFollow(anchor, followFrameRef);
      }
    });
    for (const child of Array.from(scroller.children)) {
      observer.observe(child);
    }

    return () => {
      if (scrollFrame !== null) {
        window.cancelAnimationFrame(scrollFrame);
      }
      observer.disconnect();
      scroller.removeEventListener("scroll", updateFollowState);
    };
  }, [
    isEditingMessage,
    observerStructureKey,
    thread?.id,
    browsingHistory,
    pageKey,
    rows.length,
    pendingSubmissions.length,
  ]);

  if (!thread && pendingSubmissions.length === 0) {
    return (
      <main className="empty-state">
        <div className="empty-hero">
          <h1>{emptyTitle}</h1>
          <p>{emptyDescription}</p>
          <div className="mode-switch" aria-label={modeTitleLabel}>
            <button
              type="button"
              aria-pressed={mode === "code"}
              data-active={mode === "code"}
              onClick={() => onModeChange("code")}
            >
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
          <div className="mode-description">
            {mode === "code" ? modeCodeDescription : modeOfficeDescription}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="transcript">
      <div
        className="message-list"
        role="log"
        aria-busy={
          shouldShowLoading ||
          (showsLiveStream &&
            Boolean(activeTurnId || lastTurn?.status === "inProgress")) ||
          shouldShowThinking ||
          Boolean(pendingTeam && pendingTeam.phase !== "failed")
        }
        aria-live="polite"
        aria-relevant="additions text"
      >
        {shouldShowLoading ? (
          <div
            className="message-loading-state"
            aria-label={loadingLabel}
            role="status"
          >
            <span className="message-loading-spinner" aria-hidden="true" />
          </div>
        ) : null}
        {rows.map((row, turnIndex) => {
          if (row.kind === "unassociated") {
            const item = row.item;
            const text =
              item.type === "userMessage"
                ? item.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n\n")
                : item.type === "agentMessage" || item.type === "plan"
                  ? item.text
                  : "";
            return (
              <section key={`legacy:${item.id}`}>
                <TranscriptMessage
                  item={item}
                  durableMessageId={item.id}
                  itemLabels={itemLabels}
                  locale={locale}
                  actions={
                    <MessageActions
                      text={text}
                      locale={locale}
                      user={item.type === "userMessage"}
                      userMessageId={
                        item.type === "userMessage" ? item.id : undefined
                      }
                    />
                  }
                />
              </section>
            );
          }
          const sourceTurn = turnsById.get(row.runId);
          if (!sourceTurn) return null;
          const turn = historyWindow
            ? transcriptRowTurn(sourceTurn, row)
            : sourceTurn;
          if (
            pendingTeam?.messageId &&
            turn.items.some(
              (item) =>
                item.type === "userMessage" &&
                item.id === pendingTeam.messageId,
            )
          )
            return null;
          return (
            <ProjectPlanningRunScope runId={turn.id} key={`${turn.id}:${row.itemIds[0] ?? "active"}`}>
              <TranscriptTurn
                turn={turn}
                turnIndex={turnIndex}
                locale={locale}
                itemLabels={itemLabels}
                crewonLabel={crewonLabel}
                hasWorkbench={hasWorkbench}
                shouldShowThinking={
                  shouldShowThinking && turn.id === lastTurn?.id
                }
                hidesDurableFinalWhileStreaming={
                  Boolean(streamingText) &&
                  (activeTurnId
                    ? turn.id === activeTurnId
                    : turn.id === lastTurn?.id && turn.status === "inProgress")
                }
                isLatestResponse={turn.id === latestResponseTurnId}
              />
              {row.firstFragment && controlPendingReplyDraft(sourceTurn) ? (
                <section
                  data-pending-reply-run={sourceTurn.id}
                  data-local-preview={controlPendingReplyDraft(sourceTurn)!.localId}
                >
                  <TranscriptStreamingMessage
                    crewonLabel={crewonLabel}
                    locale={locale}
                    streamingText={controlPendingReplyDraft(sourceTurn)!.text}
                    partial={controlPendingReplyDraft(sourceTurn)!.partial}
                  />
                </section>
              ) : null}
            </ProjectPlanningRunScope>
          );
        })}
        {pendingSubmissions.map((pending) => (
          <section key={pending.id} data-pending-user-message={pending.phase}>
            <TranscriptMessage
              item={pending.item}
              itemLabels={itemLabels}
              locale={locale}
            />
            {pending.phase === "failed" ? (
              <TranscriptFailureMessage
                crewonLabel={crewonLabel}
                locale={locale}
                error={{
                  message: pending.error ?? "Unable to send message",
                  codexErrorInfo: null,
                  additionalDetails: null,
                }}
              />
            ) : pending.phase === "sending" ? (
              <p className="message-loading-state" role="status">
                {locale === "zh" ? "发送中" : "Sending"}
              </p>
            ) : null}
          </section>
        ))}
        {pendingTeam ? (
          <TranscriptTeamProgress
            progress={pendingTeam}
            showUserMessage={
              !pendingSubmissions.some(
                (pending) => pending.id === pendingTeam.clientSubmissionId,
              )
            }
            locale={locale}
            itemLabels={itemLabels}
          />
        ) : null}
        {!streamingText &&
        streamingPreview.unavailable &&
        (activeTurnId || lastTurn?.status === "inProgress") ? (
          <p className="transcript-streaming-notice" role="status">
            {locale === "zh"
              ? "实时预览暂未保留，任务仍在运行。已保存内容可在会话历史中查看。"
              : "Live preview is not retained. The task is still running; saved content is available in conversation history."}
          </p>
        ) : null}
        {showsLiveStream ? (
          <TranscriptStreamingMessage
            crewonLabel={crewonLabel}
            locale={locale}
            streamingText={streamingText}
            partial={streamingPreview.partial}
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
              scheduleTranscriptFollow(anchor, followFrameRef);
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
