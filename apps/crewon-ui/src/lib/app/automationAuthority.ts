import type {
  LibraryItem,
  LibraryPanel,
  LibraryPanelAction,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import type { AutomationRunTurnRecord } from "./appTurnCompletionNotificationHandler";

export type AutomationAuthority = "control" | "legacy";

export function selectAutomationAuthority(
  controlConfigured: boolean,
): AutomationAuthority {
  return controlConfigured ? "control" : "legacy";
}

export function selectAutomationCompletionAuthority(params: {
  authority: AutomationAuthority;
  automationRunByTurnRef: {
    current: Record<string, AutomationRunTurnRecord>;
  };
  readAutomationRunItems: (
    threadId: string | null | undefined,
  ) => Promise<LibraryItem[]>;
  syncAutomationRun: (
    filePath: string,
    status: string,
    completedAt: number | null,
  ) => Promise<void>;
}) {
  if (params.authority === "legacy") {
    return {
      automationRunByTurnRef: params.automationRunByTurnRef,
      readAutomationRunItems: params.readAutomationRunItems,
      syncAutomationRun: params.syncAutomationRun,
    };
  }
  return {
    automationRunByTurnRef: {
      current: {} as Record<string, AutomationRunTurnRecord>,
    },
    readAutomationRunItems: async (_threadId: string | null | undefined) =>
      [] as LibraryItem[],
    syncAutomationRun: async (
      _filePath: string,
      _status: string,
      _completedAt: number | null,
    ) => undefined,
  };
}

export function controlAutomationLibraryPanel(locale: Locale): LibraryPanel {
  return {
    kind: "automation",
    title: locale === "zh" ? "日程已升级" : "Schedule upgraded",
    subtitle:
      locale === "zh"
        ? "日程安排已迁移到新版调度"
        : "Scheduling moved to the new scheduler",
    body:
      locale === "zh"
        ? "旧的自动化记录仍保留在原位置，这里不会读取、修改或执行它们。请从左侧“日程安排”创建和管理日程；旧记录的迁移工具会在后续版本提供。"
        : "Legacy automation records remain in place; this entry does not read, mutate, or run them. Use Schedule to create and manage schedules. A legacy import tool will be added later.",
    actions: [],
    items: [
      {
        accent: "slate",
        description:
          locale === "zh"
            ? "支持定时自动执行，也可以随时手动运行。"
            : "Run on a schedule or manually at any time.",
        glyph: "◷",
        meta: locale === "zh" ? "新版日程" : "New schedule",
        title:
          locale === "zh"
            ? "请从“日程安排”管理日程"
            : "Manage schedules in Schedule",
      },
    ],
  };
}

export function isLegacyAutomationLibraryItem(item: LibraryItem): boolean {
  return item.action?.type === "automation-detail";
}

export function isLegacyAutomationLibraryMutation(
  action: LibraryPanelAction,
): boolean {
  return (
    action.id === "create-automation" ||
    action.id === "run-automation" ||
    (action.id === "delete-config-file" &&
      action.domainConfigKind === "automation")
  );
}
