import type {
  LibraryItem,
  LibraryItemAction,
  LibraryPanel,
  LibraryPanelAction,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";

type AutomationDetailAction = Extract<
  LibraryItemAction,
  { type: "automation-detail" }
>;

export function buildAutomationDetailPanel(
  action: AutomationDetailAction,
  locale: Locale,
  items = automationDetailInitialItems(action, locale),
): Partial<LibraryPanel> {
  return {
    title: action.title,
    subtitle: action.subtitle,
    body: action.body,
    actions: automationDetailActions(action, locale),
    fields: [
      {
        id: "automation-run-note",
        label: locale === "zh" ? "运行补充说明" : "Run note",
        placeholder:
          locale === "zh"
            ? "可选：本次运行要重点检查什么"
            : "Optional: what should this run focus on",
        value: "",
      },
    ],
    items,
  };
}

export function automationDetailPanelPatch(
  panel: Partial<LibraryPanel>,
): Partial<LibraryPanel> {
  return {
    ...panel,
    error: undefined,
  };
}

export function automationDetailPanel(
  panel: LibraryPanel | null,
  detailPanel: Partial<LibraryPanel>,
): LibraryPanel | null {
  return patchAutomationDetailPanelIfCurrentPanel(
    panel,
    automationDetailPanelPatch(detailPanel),
  );
}

export function matchingAutomationDetailPanel(
  panel: LibraryPanel | null,
  titles: string[],
  detailPanel: Partial<LibraryPanel>,
): LibraryPanel | null {
  return patchAutomationDetailPanelIfCurrent(
    panel,
    titles,
    automationDetailPanelPatch(detailPanel),
  );
}

export function automationDetailItemsPatch(
  items: LibraryItem[],
): Partial<LibraryPanel> {
  return {
    items,
    error: undefined,
  };
}

export function matchingAutomationDetailItemsPanel(
  panel: LibraryPanel | null,
  titles: string[],
  items: LibraryItem[],
): LibraryPanel | null {
  return patchAutomationDetailPanelIfCurrent(
    panel,
    titles,
    automationDetailItemsPatch(items),
  );
}

export function automationDetailFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取自动化运行记录失败"
          : "Unable to read automation run history",
  };
}

export function matchingAutomationDetailFailurePanel(
  panel: LibraryPanel | null,
  titles: string[],
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return patchAutomationDetailPanelIfCurrent(
    panel,
    titles,
    automationDetailFailurePatch(error, locale),
  );
}

export function matchingAutomationRunSyncedPanel(
  panel: LibraryPanel | null,
  params: {
    items: LibraryItem[];
    lifecycleLines: string[];
    threadId: string;
  },
): LibraryPanel | null {
  const { items, lifecycleLines, threadId } = params;
  return panel?.actions?.some(
    (action) =>
      action.id === "run-automation" && action.automationThreadId === threadId,
  )
    ? {
        ...panel,
        body: [panel.body, "", ...lifecycleLines].filter(Boolean).join("\n"),
        items,
        error: undefined,
      }
    : panel;
}

export function patchAutomationDetailPanelIfCurrent(
  panel: LibraryPanel | null,
  titles: string[],
  patch: Partial<LibraryPanel>,
): LibraryPanel | null {
  return panel && titles.includes(panel.title)
    ? {
        ...panel,
        ...patch,
      }
    : panel;
}

function patchAutomationDetailPanelIfCurrentPanel(
  panel: LibraryPanel | null,
  patch: Partial<LibraryPanel>,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        ...patch,
      }
    : panel;
}

function automationDetailActions(
  action: AutomationDetailAction,
  locale: Locale,
): LibraryPanelAction[] {
  const actions: LibraryPanelAction[] = [];

  if (action.threadId) {
    actions.push({
      id: "open-thread",
      label: locale === "zh" ? "打开后端线程" : "Open backend thread",
      threadId: action.threadId,
    });
  }

  actions.push({
    id: "run-automation",
    label: locale === "zh" ? "立即运行" : "Run now",
    ...(action.config ? { automationConfig: action.config } : {}),
    automationConfigPath: action.configPath,
    automationTitle: action.title,
    automationThreadId: action.threadId,
    automationPrompt: action.prompt,
    controlAutomationId: action.controlAutomationId,
    controlAutomationRevision: action.controlAutomationRevision,
    tone: "primary",
  });

  if (action.configPath) {
    actions.push(
      {
        id: "open-path",
        label: locale === "zh" ? "打开后端记录" : "Open backend record",
        pathToOpen: action.configPath,
        pathKind: "file",
      },
      {
        id: "delete-config-file",
        label: locale === "zh" ? "删除后端记录" : "Delete backend record",
        pathToOpen: action.configPath,
        pathKind: "file",
        domainConfigKind: "automation",
        tone: "danger",
      },
    );
  }

  return actions;
}

function automationDetailInitialItems(
  action: AutomationDetailAction,
  locale: Locale,
): LibraryItem[] {
  if (action.items) {
    return action.items;
  }

  if (action.threadId) {
    return [
      {
        title: locale === "zh" ? "正在读取运行记录" : "Reading run history",
        meta: "app-server",
        description:
          locale === "zh"
            ? "正在从 app-server automation/runs/list 读取最近运行记录。"
            : "Loading recent runs from app-server automation/runs/list.",
        glyph: "◷",
        accent: "blue",
      },
    ];
  }

  return [
    {
      title: locale === "zh" ? "暂无后端线程" : "No backend thread",
      meta: locale === "zh" ? "首次运行后创建" : "Created after the first run",
      description:
        locale === "zh"
          ? "点击立即运行后会创建真实执行线程并写入运行记录。"
          : "Run now to create a real execution thread and write the run history.",
      glyph: "◷",
      accent: "slate",
    },
  ];
}
