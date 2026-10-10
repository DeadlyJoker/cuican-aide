import type { ControlTeamProgress } from "../lib/control-runtime/controlTeamProgress";
import type { Locale } from "../lib/i18n";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import {
  TranscriptMessage,
  type TranscriptItemLabels,
} from "./TranscriptMessage";
import "./TranscriptTeamProgress.css";

export function teamProgressForThread(
  thread: Thread | null,
  progress: ControlTeamProgress | null | undefined,
) {
  if (!thread || progress?.threadId !== thread.id) return null;
  // Recovered durable output takes precedence over a stale presentation failure.
  const recovered = thread.turns?.some(
    (turn) =>
      turn.items.some(
        (item) => item.type === "userMessage" && item.id === progress.messageId,
      ) && turn.items.some((item) => item.type === "agentMessage"),
  );
  return recovered ? null : progress;
}

export function TranscriptTeamProgress({
  progress,
  locale,
  itemLabels,
  showUserMessage = true,
}: {
  progress: ControlTeamProgress;
  locale: Locale;
  itemLabels: TranscriptItemLabels;
  showUserMessage?: boolean;
}) {
  const zh = locale === "zh";
  const phase =
    progress.phase === "failed"
      ? zh
        ? "团队协调中断"
        : "Team coordination interrupted"
      : progress.phase === "preparing"
        ? zh
          ? "正在准备团队任务"
          : "Preparing team task"
        : zh
          ? "团队正在协作"
          : "Team working";
  const statusLabels = zh
    ? {
        queued: "排队中",
        running: "执行中",
        waiting: "等待处理",
        completed: "已完成",
        failed: "执行失败",
        canceled: "已取消",
      }
    : {
        queued: "Queued",
        running: "Running",
        waiting: "Waiting",
        completed: "Completed",
        failed: "Failed",
        canceled: "Canceled",
      };
  return (
    <section
      className="turn-group team-progress-turn"
      aria-label={zh ? "团队任务进度" : "Team task progress"}
    >
      {showUserMessage ? (
        <TranscriptMessage
          item={{
            type: "userMessage",
            clientId: null,
            id: progress.messageId ?? `team-pending:${progress.threadId}`,
            content: [
              { type: "text", text: progress.content, text_elements: [] },
            ],
          }}
          itemLabels={itemLabels}
          locale={locale}
        />
      ) : null}
      <div
        className="team-progress-status"
        role="status"
        data-phase={progress.phase}
      >
        <strong>{phase}</strong>
        <ul>
          {progress.runs.map((run) => (
            <li key={run.runId} data-status={run.status}>
              <span>
                {run.memberName}
                {run.kind === "workerRecovery"
                  ? zh
                    ? " · 恢复"
                    : " · Recovery"
                  : ""}
              </span>
              <span>
                {run.reconnecting
                  ? zh
                    ? "正在重连，状态待确认"
                    : "Reconnecting; status unconfirmed"
                  : statusLabels[run.status]}
              </span>
            </li>
          ))}
        </ul>
        <p>
          {progress.phase === "failed"
            ? zh
              ? "协调未完成，已提交的成员任务可能仍在执行；请检查状态，避免重复提交。"
              : "Coordination did not finish. Accepted member tasks may still be running; check before resubmitting."
            : zh
              ? "成员完成不代表最终结论已就绪。当前页面负责协调，完成前请勿刷新。"
              : "Member completion is not the final answer. This page coordinates the team; avoid reloading until finished."}
        </p>
      </div>
    </section>
  );
}
