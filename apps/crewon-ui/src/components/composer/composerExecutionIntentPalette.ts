import type { PaletteItemWithCommand } from "../app/CommandWorkspaceChrome";
import type { Locale } from "../../lib/i18n";

export function composerExecutionIntentPalette(
  locale: Locale,
): PaletteItemWithCommand[] {
  return [
    {
      action: "intent-goal",
      kind: "intent",
      label: locale === "zh" ? "目标" : "Goal",
      title: locale === "zh" ? "目标" : "Goal",
      detail:
        locale === "zh"
          ? "持续推进一个可追踪目标"
          : "Keep working toward a trackable goal",
    },
    {
      action: "intent-plan",
      kind: "intent",
      label: locale === "zh" ? "计划" : "Plan",
      title: locale === "zh" ? "计划" : "Plan",
      detail:
        locale === "zh"
          ? "只读制定计划，确认后再执行"
          : "Draft a read-only plan before execution",
    },
  ];
}
