import { Code2, Sparkles } from "lucide-react";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { Locale } from "../lib/i18n";
import { formatRelativeTime } from "../lib/shared/text";
import type { WorkMode } from "../lib/workMode";
import {
  TranscriptMessage,
  TranscriptStreamingMessage,
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
  planLabel: string;
  reasoningLabel: string;
  thread: Thread | null;
  streamingText: string;
  youLabel: string;
};

function turnLabel(locale: Locale): string {
  return locale === "zh" ? "已处理" : "Processed";
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
  planLabel,
  reasoningLabel,
  thread,
  streamingText,
  youLabel,
}: TranscriptProps) {
  const items = thread?.turns.flatMap((turn) => turn.items) ?? [];
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
      <div className="message-list" role="log" aria-busy={Boolean(streamingText)} aria-live="polite" aria-relevant="additions text">
        {items.length === 0 && !streamingText ? (
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

          return (
            <section className="turn-group" aria-label={`${turnLabel(locale)} ${turnIndex + 1}`} key={turn.id}>
              <div className="turn-divider">
                <span>{turnLabel(locale)}</span>
                <em>{dividerDetailLabel}</em>
              </div>
              {turn.items.map((item) => (
                <TranscriptMessage
                  item={item}
                  itemLabels={itemLabels}
                  key={item.id}
                  locale={locale}
                />
              ))}
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
      </div>
    </main>
  );
}
