import { ListChecks, ShieldCheck, Target, X } from "lucide-react";
import { useId } from "react";

import type { Locale } from "../../lib/i18n";
import type { CommandExecutionIntent } from "../../lib/thread/threadRuntimeSettings";
import "./ComposerExecutionIntentControl.css";

export function ComposerExecutionIntentControl({
  disabled = false,
  hasActiveGoal = false,
  locale,
  value,
  blockedReason = null,
  onClear,
}: {
  disabled?: boolean;
  hasActiveGoal?: boolean;
  locale: Locale;
  value: CommandExecutionIntent;
  blockedReason?: string | null;
  onClear: () => void;
}) {
  const activeGoalNoticeId = `composer-plan-active-goal-notice-${useId()}`;
  const copy =
    locale === "zh"
      ? {
          activeGoalNotice: "发送后将清除当前目标",
          goal: "目标",
          goalTitle: "发送后创建或更新目标，持续推进",
          group: "执行方式",
          plan: "计划",
          planTitle: "本次发送先制定计划，不执行写操作",
        }
      : {
          activeGoalNotice: "Sending will clear the active goal",
          goal: "Goal",
          goalTitle:
            "Create or update a goal when you send, then keep working toward it",
          group: "Execution intent",
          plan: "Plan",
          planTitle: "Draft a read-only plan before execution",
        };
  return value === "none" ? null : (
    <>
      <span
        aria-label={`${copy.group}：${value === "goal" ? copy.goal : copy.plan}`}
        className="composer-intent-chip"
        aria-describedby={
          hasActiveGoal && value === "plan" ? activeGoalNoticeId : undefined
        }
        data-execution-intent={value}
        data-blocked={blockedReason ? "true" : undefined}
        title={value === "goal" ? copy.goalTitle : copy.planTitle}
      >
        {value === "goal" ? (
          <Target aria-hidden="true" />
        ) : (
          <ListChecks aria-hidden="true" />
        )}
        <span>{value === "goal" ? copy.goal : copy.plan}</span>
        <button
          aria-label={
            locale === "zh"
              ? `取消${value === "goal" ? copy.goal : copy.plan}`
              : `Remove ${value === "goal" ? copy.goal : copy.plan}`
          }
          disabled={disabled}
          type="button"
          onClick={() => onClear()}
        >
          <X aria-hidden="true" />
        </button>
      </span>
      {blockedReason ? (
        <span className="composer-intent-error" role="alert">
          {blockedReason}
        </span>
      ) : null}
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
