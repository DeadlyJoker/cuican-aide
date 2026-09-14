import type { Locale } from "../../lib/i18n";
import type { CommandExecutionIntent } from "../../lib/thread/threadRuntimeSettings";
import {
  isControlOfficeDefinitionRecord,
  type OfficeConfigRecordReference,
} from "../../lib/office/officePanelFromRecord";
import type { PaletteItemWithCommand } from "../app/CommandWorkspaceChrome";

export function composerExecutionIntentMenuItems({
  locale,
  value,
  disabled,
  planDisabledReason,
  hasActiveGoal = false,
}: {
  locale: Locale;
  value: CommandExecutionIntent;
  disabled: boolean;
  planDisabledReason: string | null;
  hasActiveGoal?: boolean;
}): PaletteItemWithCommand[] {
  const zh = locale === "zh";
  return [
    {
      action: "intent-goal",
      kind: "intent",
      label: zh ? "执行方式" : "Execution intent",
      title: zh ? "目标" : "Goal",
      detail: zh
        ? "发送后创建或更新目标，持续推进"
        : "Create or update a goal when you send, then keep working toward it",
      active: value === "goal",
      disabled,
    },
    {
      action: "intent-plan",
      kind: "intent",
      label: zh ? "执行方式" : "Execution intent",
      title: zh ? "计划" : "Plan",
      detail:
        planDisabledReason ??
        (hasActiveGoal
          ? zh
            ? "本次只制定计划；发送后将清除当前目标"
            : "Plan only this turn; sending clears the active goal"
          : zh
            ? "本次先制定计划，不执行写操作"
            : "Plan only this turn, without making changes"),
      active: value === "plan",
      disabled: disabled || planDisabledReason !== null,
    },
  ];
}

export function executionIntentForMenuItem(
  item: PaletteItemWithCommand,
): Exclude<CommandExecutionIntent, "none"> | null {
  if (item.disabled) return null;
  if (item.action === "intent-goal") return "goal";
  if (item.action === "intent-plan") return "plan";
  return null;
}

export function teamPlanDisabledReason({
  memberCount,
  hasDirectMember = false,
  locale,
}: {
  memberCount: number;
  hasDirectMember?: boolean;
  locale: Locale;
}): string | null {
  if (memberCount === 1 || (memberCount > 1 && hasDirectMember)) return null;
  return locale === "zh"
    ? "多成员团队暂不支持计划，请选择单个成员"
    : "Plan is unavailable for multi-member teams. Select a single member.";
}

/** UI preflight only; the runtime still validates the latest team revision. */
export function commandPlanDisabledReason({
  authority,
  executionTarget,
  offices,
  locale,
}: {
  authority: "control" | "legacy";
  executionTarget: string;
  offices: readonly OfficeConfigRecordReference[];
  locale: Locale;
}): string | null {
  if (authority !== "control") return null;
  if (executionTarget.startsWith("experts:")) {
    return locale === "zh"
      ? "专家团暂不支持计划，请选择单智能体"
      : "Plan is unavailable for expert teams. Select a single agent.";
  }
  if (!executionTarget.startsWith("team:")) return null;
  const id = executionTarget.slice("team:".length);
  const matches = offices
    .filter(isControlOfficeDefinitionRecord)
    .filter((record) => record.definition.officeVersionId === id);
  if (matches.length !== 1) {
    return locale === "zh"
      ? "暂时无法确认团队能力，请刷新后重试"
      : "Team capabilities could not be confirmed. Refresh and try again.";
  }
  return teamPlanDisabledReason({
    memberCount: matches[0].definition.members.length,
    locale,
  });
}
