import { Pause, Pencil, Play, Target, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Locale } from "../../lib/i18n";
import type { ComposerGoalBarState } from "./composerGoalBarState";

export function ComposerGoalBar({
  busy = false,
  goal,
  locale,
  onClear,
  onEdit,
  onTogglePause,
}: {
  busy?: boolean;
  goal: ComposerGoalBarState;
  locale: Locale;
  onClear: () => void;
  onEdit: (objective: string) => void;
  onTogglePause: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = draft !== null;

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commit() {
    const nextObjective = draft?.trim() ?? "";
    setDraft(null);
    if (nextObjective && nextObjective !== goal.objective) {
      onEdit(nextObjective);
    }
  }

  const pauseLabel = goal.running
    ? locale === "zh"
      ? "暂停目标"
      : "Pause goal"
    : locale === "zh"
      ? "继续目标"
      : "Resume goal";

  return (
    <div className="composer-goal-bar" data-od-id="composer-goal-bar">
      <Target aria-hidden="true" className="composer-goal-icon" />
      <strong className="composer-goal-status">{goal.statusLabel}</strong>
      {editing ? (
        <input
          aria-label={locale === "zh" ? "编辑目标" : "Edit goal"}
          className="composer-goal-input"
          ref={inputRef}
          value={draft ?? ""}
          onBlur={commit}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(null);
            }
          }}
        />
      ) : (
        <span className="composer-goal-objective" title={goal.objective}>
          {goal.objective}
        </span>
      )}
      <span aria-hidden="true" className="composer-goal-separator">
        ·
      </span>
      <span className="composer-goal-elapsed">{goal.elapsedLabel}</span>
      <span className="composer-goal-actions">
        <button
          aria-label={locale === "zh" ? "编辑目标" : "Edit goal"}
          className="icon-action composer-goal-action"
          disabled={busy}
          title={locale === "zh" ? "编辑目标" : "Edit goal"}
          type="button"
          onClick={() => setDraft(goal.objective)}
        >
          <Pencil aria-hidden="true" />
        </button>
        <button
          aria-label={pauseLabel}
          aria-pressed={goal.pauseToggleEnabled ? !goal.running : undefined}
          className="icon-action composer-goal-action"
          disabled={busy || !goal.pauseToggleEnabled}
          title={pauseLabel}
          type="button"
          onClick={onTogglePause}
        >
          {goal.running ? (
            <Pause aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
        </button>
        <button
          aria-label={locale === "zh" ? "删除目标" : "Delete goal"}
          className="icon-action composer-goal-action"
          disabled={busy}
          title={locale === "zh" ? "删除目标" : "Delete goal"}
          type="button"
          onClick={onClear}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
