import type {
  AgentConfig,
  AutomationConfig,
  LibraryItem,
  LibraryPanel,
  LibraryPanelAction,
  LibraryPanelField,
  OfficeConfig,
} from "./crewonDomain";
import type { Locale } from "../i18n";
import type { NoticeState } from "../shared/noticeState";

type DomainConfigRecord<TConfig> = {
  filePath: string;
  config: TConfig;
};

type AutomationSelectionPanelContent = Pick<
  LibraryPanel,
  "actions" | "body" | "error" | "fields" | "items" | "subtitle" | "title"
>;

type AutomationCreateSuccessPanelContent = {
  body: string;
  items: LibraryItem[];
  error: undefined;
};

export type AutomationCreateFieldValues = {
  selectedAgentPath: string;
  selectedOfficePath: string;
  selectedPrompt: string;
  selectedTrigger: string;
  title: string;
};

export function automationCapabilitySummary(
  agent: AgentConfig | null | undefined,
  locale: Locale,
): { enabledMcp: string; enabledSkills: string } {
  const fallback = locale === "zh" ? "未配置" : "not configured";
  return {
    enabledMcp:
      agent?.mcp
        ?.filter((option) => option.enabled)
        .map((option) => option.name)
        .join(", ") || fallback,
    enabledSkills:
      agent?.skills
        ?.filter((option) => option.enabled)
        .map((option) => option.name)
        .join(", ") || fallback,
  };
}

export function automationBindingSubtitle(params: {
  targetOffice: OfficeConfig | null | undefined;
  executionAgent: AgentConfig | null | undefined;
  locale: Locale;
  includeTrigger?: boolean;
}): string {
  const { targetOffice, executionAgent, locale, includeTrigger = false } = params;
  const prefix = includeTrigger
    ? locale === "zh"
      ? "手动触发 · "
      : "Manual trigger · "
    : "";
  return locale === "zh"
    ? `${prefix}${targetOffice?.title ?? "未绑定办公室"} · ${executionAgent?.name ?? "未绑定智能体"}`
    : `${prefix}${targetOffice?.title ?? "No office"} · ${executionAgent?.name ?? "No agent"}`;
}

export function automationBodyText(params: {
  title: string;
  targetOffice: OfficeConfig | null | undefined;
  executionAgent: AgentConfig | null | undefined;
  triggerType: string;
  locale: Locale;
}): string {
  const { title, targetOffice, executionAgent, triggerType, locale } = params;
  const { enabledMcp, enabledSkills } = automationCapabilitySummary(
    executionAgent,
    locale,
  );
  return locale === "zh"
    ? [
        `触发器：${triggerType}`,
        `目标办公室：${targetOffice?.title ?? "待选择"}`,
        `执行智能体：${executionAgent?.name ?? "待选择"}`,
        `模型：${executionAgent?.model ?? "未配置"}`,
        `MCP：${enabledMcp}`,
        `Skill：${enabledSkills}`,
        `动作：通过 office/run 运行目标办公室「${title}」，并把执行记录写入 automation/run。`,
      ].join("\n")
    : [
        `Trigger: ${triggerType}`,
        `Target office: ${targetOffice?.title ?? "pending"}`,
        `Agent: ${executionAgent?.name ?? "pending"}`,
        `Model: ${executionAgent?.model ?? "not configured"}`,
        `MCP: ${enabledMcp}`,
        `Skills: ${enabledSkills}`,
        `Action: run target Office "${title}" through office/run and write the execution record through automation/run.`,
      ].join("\n");
}

export function automationRunPrompt(params: {
  title: string;
  targetOffice: OfficeConfig | null | undefined;
  executionAgent: AgentConfig | null | undefined;
  locale: Locale;
  immediate?: boolean;
}): string {
  const { title, targetOffice, executionAgent, locale, immediate = false } = params;
  if (locale === "zh") {
    return `${immediate ? "立即运行" : "运行"}自动化「${title}」。目标办公室：${targetOffice?.title ?? "待选择"}。执行智能体：${executionAgent?.name ?? "待选择"}。请记录运行结果、下一步任务和风险。`;
  }
  return `${immediate ? "Run" : "Run"} automation "${title}"${immediate ? " now" : ""}. Target office: ${targetOffice?.title ?? "pending"}. Agent: ${executionAgent?.name ?? "pending"}. Record results, next tasks, and risks.`;
}

export function automationCreateTitle(timeLabel: string, locale: Locale): string {
  return locale === "zh"
    ? `自动化 ${timeLabel}`
    : `Automation ${timeLabel}`;
}

export function automationCreateFieldValues(params: {
  defaultTitle: string;
  fields: LibraryPanelField[] | null | undefined;
}): AutomationCreateFieldValues {
  const { defaultTitle, fields } = params;
  const fieldValue = (fieldId: string) =>
    fields?.find((field) => field.id === fieldId)?.value.trim() ?? "";
  return {
    title: fieldValue("automation-title") || defaultTitle,
    selectedOfficePath: fieldValue("automation-office"),
    selectedAgentPath: fieldValue("automation-agent"),
    selectedTrigger: fieldValue("automation-trigger") || "manual",
    selectedPrompt: fieldValue("automation-prompt"),
  };
}

export function automationCreateRequiresBindingsMessage(
  locale: Locale,
): string {
  return locale === "zh"
    ? "创建自动化需要已保存的办公室和后端智能体。请先创建办公室，并在智能体库中新建/保存智能体。"
    : "Creating an automation requires a saved office and backend agent. Create an office and create/save an agent first.";
}

export function automationCreateRequiresBindingsNotice(
  locale: Locale,
): NoticeState {
  return {
    text: automationCreateRequiresBindingsMessage(locale),
    tone: "warning",
  };
}

export function automationCreateRequiresBindingsPanel(
  panel: LibraryPanel | null,
  locale: Locale,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        error: automationCreateRequiresBindingsMessage(locale),
      }
    : panel;
}

export function automationCreateSelectionPanelContent(params: {
  agentRecords: Array<DomainConfigRecord<AgentConfig>>;
  locale: Locale;
  officeRecords: Array<DomainConfigRecord<OfficeConfig>>;
  title: string;
}): AutomationSelectionPanelContent {
  const { agentRecords, locale, officeRecords, title } = params;
  const defaultOffice = officeRecords[0];
  const defaultAgent = agentRecords[0];
  return {
    title: locale === "zh" ? "新建自动化" : "New automation",
    subtitle:
      locale === "zh"
        ? `${officeRecords.length} 个办公室 · ${agentRecords.length} 个智能体`
        : `${officeRecords.length} offices · ${agentRecords.length} agents`,
    body:
      locale === "zh"
        ? "选择触发方式、目标办公室和执行智能体。保存后会写入后端自动化配置，可立即运行并沉淀运行记录。"
        : "Choose a trigger, target office, and execution agent. Saving writes a backend automation config that can run immediately and keep run history.",
    fields: [
      {
        id: "automation-title",
        label: locale === "zh" ? "名称" : "Name",
        value: title,
      },
      {
        id: "automation-trigger",
        label: locale === "zh" ? "触发方式" : "Trigger",
        value: "manual",
        options: [
          {
            label: locale === "zh" ? "手动" : "Manual",
            value: "manual",
          },
          {
            label: locale === "zh" ? "定时" : "Schedule",
            value: "schedule",
          },
          {
            label: locale === "zh" ? "事件" : "Event",
            value: "event",
          },
          {
            label: locale === "zh" ? "文件" : "File",
            value: "file",
          },
        ],
      },
      {
        id: "automation-office",
        label: locale === "zh" ? "目标办公室" : "Target office",
        value: defaultOffice?.filePath ?? "",
        options: officeRecords.map((record) => ({
          label: record.config.title,
          value: record.filePath,
        })),
      },
      {
        id: "automation-agent",
        label: locale === "zh" ? "执行智能体" : "Execution agent",
        value: defaultAgent?.filePath ?? "",
        options: agentRecords.map((record) => ({
          label: record.config.name,
          value: record.filePath,
        })),
      },
      {
        id: "automation-prompt",
        label: locale === "zh" ? "运行提示" : "Run prompt",
        value: automationRunPrompt({
          title,
          targetOffice: defaultOffice?.config,
          executionAgent: defaultAgent?.config,
          locale,
        }),
      },
    ],
    actions: [
      {
        id: "create-automation",
        label: locale === "zh" ? "保存自动化" : "Save automation",
        tone: "primary",
      },
    ],
    items: [],
    error: undefined,
  };
}

export function automationCreateSelectionPanel(
  panel: LibraryPanel | null,
  params: {
    agentRecords: Array<DomainConfigRecord<AgentConfig>>;
    locale: Locale;
    officeRecords: Array<DomainConfigRecord<OfficeConfig>>;
    title: string;
  },
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        ...automationCreateSelectionPanelContent(params),
      }
    : panel;
}

export function automationConfigForCreate(params: {
  executionAgent: AgentConfig;
  locale: Locale;
  prompt: string;
  selectedTrigger: string;
  targetOffice: OfficeConfig;
  threadId: string;
  title: string;
}): AutomationConfig {
  const {
    executionAgent,
    locale,
    prompt,
    selectedTrigger,
    targetOffice,
    threadId,
    title,
  } = params;
  return {
    threadId,
    title,
    subtitle: automationBindingSubtitle({
      targetOffice,
      executionAgent,
      locale,
      includeTrigger: true,
    }),
    body: automationBodyText({
      title,
      targetOffice,
      executionAgent,
      triggerType: automationTriggerLabel(selectedTrigger, locale),
      locale,
    }),
    prompt:
      prompt ||
      automationRunPrompt({
        title,
        targetOffice,
        executionAgent,
        locale,
      }),
    trigger: {
      type: automationTriggerType(selectedTrigger),
    },
    targetOffice,
    executionAgent,
    enabled: true,
    status: "enabled",
  };
}

export function automationCreateTurnPrompt(params: {
  configPath: string | null | undefined;
  executionAgent: AgentConfig;
  locale: Locale;
  prompt: string;
  targetOffice: OfficeConfig;
  title: string;
}): string {
  const { configPath, executionAgent, locale, prompt, targetOffice, title } =
    params;
  return [
    locale === "zh" ? `创建自动化：${title}` : `Create automation: ${title}`,
    configPath
      ? locale === "zh"
        ? `后端记录：${configPath}`
        : `Backend record: ${configPath}`
      : locale === "zh"
        ? "后端记录：已提交到 automation/create"
        : "Backend record: submitted to automation/create",
    locale === "zh"
      ? `目标办公室：${targetOffice.title}`
      : `Target office: ${targetOffice.title}`,
    locale === "zh"
      ? `执行智能体：${executionAgent.name}`
      : `Execution agent: ${executionAgent.name}`,
    "",
    prompt,
  ].join("\n");
}

export function automationCreateSuccessPanelContent(params: {
  config: AutomationConfig;
  configPath: string | null | undefined;
  currentItems: LibraryItem[];
  locale: Locale;
  threadId: string;
}): AutomationCreateSuccessPanelContent {
  const { config, configPath, currentItems, locale, threadId } = params;
  return {
    body:
      locale === "zh"
        ? `已创建后端自动化：${config.title}\n已绑定：${config.targetOffice?.title ?? "未绑定办公室"} · ${config.executionAgent?.name ?? "未绑定智能体"}${configPath ? `\n后端记录：${configPath}` : ""}`
        : `Created backend automation: ${config.title}\nBound to: ${config.targetOffice?.title ?? "No office"} · ${config.executionAgent?.name ?? "No agent"}${configPath ? `\nBackend record: ${configPath}` : ""}`,
    items: [
      {
        title: config.title,
        meta:
          locale === "zh"
            ? "automation/create · 可立即运行"
            : "automation/create · ready to run",
        description:
          locale === "zh"
            ? "已写入目标办公室、执行智能体和运行提示，可立即运行并沉淀记录。"
            : "Target office, execution agent, and run prompt are written; it can run now and keep records.",
        glyph: "⏱",
        accent: "blue",
        badge: {
          label: locale === "zh" ? "已创建" : "created",
          tone: "running",
        },
        action: {
          type: "automation-detail",
          title: config.title,
          subtitle: config.subtitle,
          body: config.body,
          prompt: config.prompt,
          threadId,
          configPath: configPath ?? undefined,
        },
      },
      ...currentItems,
    ],
    error: undefined,
  };
}

export function automationCreateSuccessPanel(
  panel: LibraryPanel | null,
  params: {
    config: AutomationConfig;
    configPath: string | null | undefined;
    locale: Locale;
    threadId: string;
  },
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        ...automationCreateSuccessPanelContent({
          ...params,
          currentItems: panel.items,
        }),
      }
    : panel;
}

export function automationCreateFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "创建自动化失败"
      : "Unable to create automation";
}

export function automationCreateFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text: automationCreateFailureMessage(error, locale),
    tone: "warning",
  };
}

export function automationCreateFailurePanel(
  panel: LibraryPanel | null,
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        error: automationCreateFailureMessage(error, locale),
      }
    : panel;
}

export function automationRunLifecycleText(params: {
  threadId: string;
  runId?: string | null;
  runFilePath?: string | null;
  configPath?: string | null;
  locale: Locale;
  phase: "started" | "completed";
}): string[] {
  const { threadId, runId, runFilePath, configPath, locale, phase } = params;
  const isZh = locale === "zh";
  return [
    isZh
      ? `执行：turn/start 已发送到线程 ${threadId}`
      : `Execution: turn/start sent to thread ${threadId}`,
    runId
      ? isZh
        ? `运行记录：automation/run 已创建 ${runId}`
        : `Run record: automation/run created ${runId}`
      : isZh
        ? "运行记录：当前 app-server 未返回 automation/run 记录"
        : "Run record: automation/run did not return a record from this app-server",
    phase === "completed"
      ? isZh
        ? "状态同步：automation/run/update 已提交完成状态"
        : "Status sync: automation/run/update submitted the completed status"
      : isZh
        ? "状态同步：等待 turn/completed 后写入 automation/run/update"
        : "Status sync: waiting for turn/completed before automation/run/update",
    runFilePath
      ? isZh
        ? `运行文件：${runFilePath}`
        : `Run file: ${runFilePath}`
      : null,
    configPath
      ? isZh
        ? `后端记录：${configPath}`
        : `Backend record: ${configPath}`
      : null,
  ].filter((line): line is string => Boolean(line));
}

type AutomationRunActionInput = Pick<
  LibraryPanelAction,
  | "automationConfig"
  | "automationConfigPath"
  | "automationPrompt"
  | "automationThreadId"
  | "automationTitle"
>;

type AutomationRunPreparation =
  | {
      type: "error";
      message: string;
    }
  | {
      type: "ok";
      body: string;
      executionAgent: AgentConfig;
      initialThreadId: string | undefined;
      prompt: string;
      targetOffice: OfficeConfig;
      title: string;
    };

export function prepareAutomationRun(params: {
  action: AutomationRunActionInput;
  latestAgent: AgentConfig | null | undefined;
  latestOffice: OfficeConfig | null | undefined;
  locale: Locale;
  runNote: string;
}): AutomationRunPreparation {
  const { action, latestAgent, latestOffice, locale, runNote } = params;
  const savedAutomationConfig = action.automationConfig;
  const title =
    savedAutomationConfig?.title ??
    action.automationTitle ??
    (locale === "zh" ? "自动化任务" : "Automation job");
  const targetOffice =
    savedAutomationConfig?.targetOffice ?? latestOffice ?? null;
  const executionAgent =
    savedAutomationConfig?.executionAgent ?? latestAgent ?? null;

  if (!targetOffice || !executionAgent?.agentId) {
    return {
      type: "error",
      message: automationRunMissingBindingMessage(locale),
    };
  }

  const triggerType =
    savedAutomationConfig?.trigger?.type ??
    (locale === "zh" ? "手动" : "manual");
  const body = automationBodyText({
    title,
    targetOffice,
    executionAgent,
    triggerType,
    locale,
  });
  const prompt = [
    action.automationPrompt ?? savedAutomationConfig?.prompt,
    automationRunPrompt({
      title,
      targetOffice,
      executionAgent,
      locale,
      immediate: true,
    }),
    runNote ? automationRunNoteText(runNote, locale) : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    type: "ok",
    body,
    executionAgent,
    initialThreadId:
      action.automationThreadId ?? savedAutomationConfig?.threadId,
    prompt,
    targetOffice,
    title,
  };
}

export function automationRunNoteFromFields(
  fields: LibraryPanelField[] | null | undefined,
): string {
  return (
    fields
      ?.find((field) => field.id === "automation-run-note")
      ?.value.trim() ?? ""
  );
}

export function automationRunMissingBindingMessage(locale: Locale): string {
  return locale === "zh"
    ? "运行自动化需要已保存的目标办公室和后端智能体。请先创建办公室，并在智能体库中新建/保存智能体。"
    : "Running an automation requires a saved target office and backend agent. Create an office and create/save an agent first.";
}

export function automationRunErrorPanel(
  panel: LibraryPanel | null,
  message: string,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        error: message,
      }
    : panel;
}

export function automationRunErrorNotice(message: string): NoticeState {
  return {
    text: message,
    tone: "warning",
  };
}

export function automationTurnStartPrompt(params: {
  automationConfig: AutomationConfig;
  configPath: string | null | undefined;
  locale: Locale;
  runNote: string;
  threadId: string;
}): string {
  const { automationConfig, configPath, locale, runNote, threadId } = params;
  return [
    automationConfig.prompt,
    configPath
      ? locale === "zh"
        ? `后端记录：${configPath}`
        : `Backend record: ${configPath}`
      : locale === "zh"
        ? "后端记录：已提交到 automation/save"
        : "Backend record: submitted to automation/save",
    runNote ? automationRunNoteText(runNote, locale) : null,
    "",
    locale === "zh" ? `执行线程：${threadId}` : `Execution thread: ${threadId}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function automationRunPanelBody(params: {
  automationConfig: AutomationConfig;
  configPath: string | null | undefined;
  locale: Locale;
  phase: "started" | "completed";
  runFilePath?: string | null;
  runId?: string | null;
  threadId: string;
  warning?: string | null;
}): string {
  const {
    automationConfig,
    configPath,
    locale,
    phase,
    runFilePath,
    runId,
    threadId,
    warning,
  } = params;
  return [
    automationConfig.body,
    ...automationRunLifecycleText({
      threadId,
      runId,
      runFilePath,
      configPath,
      locale,
      phase,
    }),
    warning,
  ]
    .filter(Boolean)
    .join("\n");
}

export function automationRunUpdatedActions(params: {
  actions: LibraryPanelAction[] | undefined;
  automationConfig: AutomationConfig;
  configPath: string | null | undefined;
  locale: Locale;
  threadId: string;
}): LibraryPanelAction[] | undefined {
  const { actions, automationConfig, configPath, locale, threadId } = params;
  return actions
    ?.map((currentAction) =>
      currentAction.id === "run-automation"
        ? {
            ...currentAction,
            automationConfig: {
              ...automationConfig,
              threadId,
            },
            automationConfigPath: configPath ?? undefined,
            automationThreadId: threadId,
            label: locale === "zh" ? "再次运行" : "Run again",
          }
        : currentAction,
    )
    .concat(
      configPath &&
        !actions?.some(
          (currentAction) =>
            currentAction.id === "open-path" &&
            currentAction.pathToOpen === configPath,
        )
        ? [
            {
              id: "open-path",
              label: locale === "zh" ? "打开后端记录" : "Open backend record",
              pathToOpen: configPath,
              pathKind: "file",
            },
            {
              id: "delete-config-file",
              label: locale === "zh" ? "删除后端记录" : "Delete backend record",
              pathToOpen: configPath,
              pathKind: "file",
              domainConfigKind: "automation",
              tone: "danger",
            },
          ]
        : [],
    );
}

export function automationRunUpdatedPanel(
  panel: LibraryPanel | null,
  params: {
    automationConfig: AutomationConfig;
    configPath: string | null | undefined;
    fallbackItems: LibraryItem[] | undefined;
    locale: Locale;
    phase: "started" | "completed";
    runFilePath?: string | null;
    runId?: string | null;
    threadId: string;
    warning?: string | null;
  },
): LibraryPanel | null {
  if (!panel) {
    return panel;
  }
  return {
    ...panel,
    subtitle:
      params.locale === "zh"
        ? "已写入后端执行线程"
        : "Written to backend execution thread",
    body: automationRunPanelBody(params),
    items: params.fallbackItems ?? panel.items,
    actions: automationRunUpdatedActions({
      actions: panel.actions,
      automationConfig: params.automationConfig,
      configPath: params.configPath,
      locale: params.locale,
      threadId: params.threadId,
    }),
    error: params.warning ?? undefined,
  };
}

export function automationConfigForRun(params: {
  baseConfig: AutomationConfig | null | undefined;
  title: string;
  threadId: string;
  targetOffice: OfficeConfig;
  executionAgent: AgentConfig;
  prompt: string;
  body: string;
  locale: Locale;
}): AutomationConfig {
  const {
    baseConfig,
    title,
    threadId,
    targetOffice,
    executionAgent,
    prompt,
    body,
    locale,
  } = params;
  return {
    ...baseConfig,
    threadId,
    title,
    subtitle:
      baseConfig?.subtitle ||
      automationBindingSubtitle({ targetOffice, executionAgent, locale }),
    body: baseConfig?.body || body,
    prompt,
    trigger: baseConfig?.trigger ?? { type: "manual" },
    targetOffice,
    executionAgent,
  };
}

function automationRunNoteText(runNote: string, locale: Locale): string {
  return locale === "zh"
    ? `本次运行补充说明：${runNote}`
    : `Run note: ${runNote}`;
}

function automationTriggerLabel(selectedTrigger: string, locale: Locale): string {
  if (locale !== "zh") {
    return selectedTrigger;
  }
  switch (selectedTrigger) {
    case "schedule":
      return "定时";
    case "event":
      return "事件";
    case "file":
      return "文件";
    default:
      return "手动";
  }
}

function automationTriggerType(
  selectedTrigger: string,
): "event" | "file" | "manual" | "schedule" {
  switch (selectedTrigger) {
    case "schedule":
      return "schedule";
    case "event":
      return "event";
    case "file":
      return "file";
    default:
      return "manual";
  }
}
