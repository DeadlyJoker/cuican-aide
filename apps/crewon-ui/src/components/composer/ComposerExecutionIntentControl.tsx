import { ListChecks, ShieldCheck, Target, X } from "lucide-react";
import { useId } from "react";

import type { Locale } from "../../lib/i18n";
import type { CommandExecutionIntent } from "../../lib/thread/threadRuntimeSettings";

type SelectableExecutionIntent = Exclude<CommandExecutionIntent, "none">;

export function ComposerExecutionIntentControl({
  disabled = false,
  hasActiveGoal = false,
  locale,
  value,
  onSelect,
}: {
  disabled?: boolean;
  hasActiveGoal?: boolean;
  locale: Locale;
  value: CommandExecutionIntent;
  onSelect: (intent: SelectableExecutionIntent) => void;
}) {
  const activeGoalNoticeId = `composer-plan-active-goal-notice-${useId()}`;
  const copy =
    locale === "zh"
      ? {
          activeGoalNotice: "发送后将清除当前目标",
          goal: "目标",
          goalTitle: "持续推进一个可追踪目标",
          group: "执行方式",
          plan: "计划",
          planTitle: "只读制定计划，确认后再执行",
        }
      : {
          activeGoalNotice: "Sending will clear the active goal",
          goal: "Goal",
          goalTitle: "Keep working toward a trackable goal",
          group: "Execution intent",
          plan: "Plan",
          planTitle: "Draft a read-only plan before execution",
        };
  if (value === "none") return null;
  const Icon = value === "goal" ? Target : ListChecks;
  const label = value === "goal" ? copy.goal : copy.plan;
  return (
    <>
      <div
        aria-label={copy.group}
        className="execution-intent-segmented"
        role="group"
      >
        <button
          aria-describedby={
            hasActiveGoal && value === "plan" ? activeGoalNoticeId : undefined
          }
          aria-label={locale === "zh" ? `取消${label}` : `Remove ${label}`}
          aria-pressed="true"
          className="execution-intent-option"
          data-execution-intent={value}
          disabled={disabled}
          title={value === "goal" ? copy.goalTitle : copy.planTitle}
          type="button"
          onClick={() => onSelect(value)}
        >
          <Icon aria-hidden="true" />
          <span>{label}</span>
          <X aria-hidden="true" />
        </button>
      </div>
      {hasActiveGoal && value === "plan" ? (
        <span
          className="execution-intent-notice"
          id={activeGoalNoticeId}
          role="status"
        >
          {copy.activeGoalNotice}
        </span>
      ) : null}
    </>
  );
}

export function ComposerPlanReadonlyStatus({ locale }: { locale: Locale }) {
  const label = locale === "zh" ? "强制只读" : "Forced read-only";
  const title =
    locale === "zh"
      ? "计划模式不允许执行写操作"
      : "Plan mode does not allow write operations";

  return (
    <span
      aria-label={locale === "zh" ? `权限：${label}` : `Permission: ${label}`}
      className="plan-readonly-status"
      data-permission-mode="plan-read-only"
      role="status"
      title={title}
    >
      <ShieldCheck aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
