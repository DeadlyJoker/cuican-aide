import type { AgentConfig, OfficeConfig } from "../domain/domainTypes";
import type { Locale } from "../i18n";

export type CommandScene = "office" | "code" | "design";

export type SceneInteractionMode =
  | "auto"
  | "organize"
  | "write"
  | "analyze"
  | "coordinate"
  | "ask"
  | "plan"
  | "implement"
  | "review"
  | "explore"
  | "refine"
  | "produce"
  | "inspect";

export type ExecutionTargetKind = "crewon" | "agent" | "team" | "experts";

export type ExecutionTargetOption = {
  detail: string;
  disabled?: boolean;
  /**
   * Section this target appears under in the composer selector. Derived from
   * where the definition lives rather than from its execution strategy, since
   * that is the distinction users pick along: local, cloud, or expert team.
   */
  group?: ExecutionTargetGroup;
  kind: ExecutionTargetKind;
  label: string;
  strategy: "single" | "team";
  value: string;
};

export type ExecutionTargetGroup = "single" | "experts";

/**
 * Section order and labels for the execution target selector.
 *
 * The split follows what actually differs when running a task: one agent that
 * completes it alone, or a team of experts reporting to a lead. Where the
 * definition happens to live -- on this machine or on the platform -- does not
 * change how the task runs, so it is not a section.
 *
 * CrewON itself carries no group and stays above these as the default choice.
 */
export function executionTargetGroups(
  locale: Locale = "zh",
): Array<{ id: ExecutionTargetGroup; label: string }> {
  return locale === "zh"
    ? [
        { id: "single", label: "单智能体" },
        { id: "experts", label: "专家团" },
      ]
    : [
        { id: "single", label: "Single agent" },
        { id: "experts", label: "Expert teams" },
      ];
}

export type SceneModeOption = {
  detail: string;
  label: string;
  value: SceneInteractionMode;
};

/**
 * Icon shown on a quick-action card. The name is resolved to a component by the
 * view, so the catalog stays free of React imports.
 */
export type SceneQuickActionIcon =
  | "clipboardList"
  | "presentation"
  | "fileText"
  | "bookMarked"
  | "sparkles"
  | "bug"
  | "searchCheck"
  | "flaskConical"
  | "compass"
  | "layoutTemplate"
  | "image"
  | "scanEye";

export type SceneQuickAction = {
  /** Short line under the label, mirroring the intent of the prompt. */
  hint: string;
  icon: SceneQuickActionIcon;
  label: string;
  mode: SceneInteractionMode;
  prompt: string;
};

export type ScenePreset = {
  capabilitySummary: string;
  contextSummary: string;
  deliverableSummary: string;
  modes: SceneModeOption[];
  placeholder: string;
  quickActions: SceneQuickAction[];
  scene: CommandScene;
  subtitle: string;
  tabLabel: string;
};

const autoMode: SceneModeOption = {
  detail: "根据任务对象、交付物和风险自动判断",
  label: "自动判断",
  value: "auto",
};

export const scenePresets: Record<CommandScene, ScenePreset> = {
  office: {
    capabilitySummary: "Word / PPT / Excel · 知识库",
    contextSummary: "文档 / 日历 / 知识库",
    deliverableSummary: "文档与行动项",
    modes: [
      autoMode,
      { detail: "整理事项、来源与行动项", label: "整理", value: "organize" },
      { detail: "生成面向受众的可用成稿", label: "撰写", value: "write" },
      { detail: "基于来源说明方法与结论", label: "分析", value: "analyze" },
      {
        detail: "准备消息、会议或共享写入草稿",
        label: "协同",
        value: "coordinate",
      },
    ],
    placeholder:
      "例如：整理今天的项目事项，安排会议、跟进阻塞，并把结论写入知识库",
    quickActions: [
      {
        hint: "待办、会议与阻塞项",
        icon: "clipboardList",
        label: "整理今日工作",
        mode: "organize",
        prompt:
          "整理今天的项目事项，列出待办、会议、负责人、阻塞项和截止时间。",
      },
      {
        hint: "议题、背景与决策项",
        icon: "presentation",
        label: "生成会议材料",
        mode: "write",
        prompt:
          "结合现有资料和日程生成会议材料，包含议题、背景、待决策项和行动项。",
      },
      {
        hint: "进度、风险与下一步",
        icon: "fileText",
        label: "撰写项目汇报",
        mode: "write",
        prompt:
          "基于项目资料撰写可直接使用的项目汇报，说明进度、风险、结论和下一步。",
      },
      {
        hint: "结论、来源与维护人",
        icon: "bookMarked",
        label: "沉淀知识库",
        mode: "organize",
        prompt:
          "把这次讨论沉淀成知识库条目，包含结论、来源、适用范围和维护人。",
      },
    ],
    scene: "office",
    subtitle: "整理、撰写和推进你的工作",
    tabLabel: "日常办公",
  },
  code: {
    capabilitySummary: "Workspace · Terminal · Test · Git",
    contextSummary: "仓库 / Issue / 日志",
    deliverableSummary: "回答、计划、Diff 与测试",
    modes: [
      autoMode,
      { detail: "只读回答并引用仓库证据", label: "询问", value: "ask" },
      { detail: "只读输出可执行实施计划", label: "计划", value: "plan" },
      { detail: "修改工作区并运行适用验证", label: "生码", value: "implement" },
      { detail: "只读输出可定位的审阅发现", label: "审阅", value: "review" },
    ],
    placeholder: "例如：读取当前仓库规则，实现这个功能并运行适用测试",
    quickActions: [
      {
        hint: "遵循仓库规则并验证",
        icon: "sparkles",
        label: "实现一个功能",
        mode: "implement",
        prompt:
          "读取当前仓库规则，实现这个功能，并运行适用的格式化、测试和构建验证。",
      },
      {
        hint: "定位根因并验证回归",
        icon: "bug",
        label: "修复一个 Bug",
        mode: "implement",
        prompt: "结合问题描述、日志和仓库证据定位根因，完成修复并验证回归。",
      },
      {
        hint: "只读输出可定位问题",
        icon: "searchCheck",
        label: "审阅当前改动",
        mode: "review",
        prompt:
          "只读审阅当前改动，按严重程度输出可定位的问题、证据和修复建议。",
      },
      {
        hint: "补齐覆盖与流水线",
        icon: "flaskConical",
        label: "补齐测试与 CI",
        mode: "implement",
        prompt: "检查当前改动的测试与 CI 缺口，补齐覆盖并运行适用验证。",
      },
    ],
    scene: "code",
    subtitle: "围绕仓库完成询问、计划、实现与审阅",
    tabLabel: "生码",
  },
  design: {
    capabilitySummary: "HTML 产物 · 截图渲染 · 设计走查",
    contextSummary: "Brief / 设计系统 / 品牌与参考",
    deliverableSummary: "方向、视觉产物与交付说明",
    modes: [
      autoMode,
      { detail: "给出有明显差异的设计方向", label: "探索", value: "explore" },
      { detail: "深化选定方向并复用设计系统", label: "收敛", value: "refine" },
      {
        detail: "生成可预览、可交付的设计产物",
        label: "制作",
        value: "produce",
      },
      { detail: "只诊断并输出可定位问题", label: "走查", value: "inspect" },
    ],
    placeholder: "例如：基于这个 Brief 探索三个方向，并制作可预览的页面方案",
    quickActions: [
      {
        hint: "三个方向与取舍",
        icon: "compass",
        label: "探索设计方向",
        mode: "explore",
        prompt: "基于当前 Brief 探索三个有明显差异的设计方向，并说明各自取舍。",
      },
      {
        hint: "覆盖关键状态",
        icon: "layoutTemplate",
        label: "设计页面或组件",
        mode: "produce",
        prompt:
          "结合 Brief、品牌与目标画布，设计可预览的页面或组件并覆盖关键状态。",
      },
      {
        hint: "可预览、可导出",
        icon: "image",
        label: "生成视觉资产",
        mode: "produce",
        prompt: "根据 Brief 和品牌约束生成可预览、可导出的视觉资产。",
      },
      {
        hint: "状态覆盖与交付建议",
        icon: "scanEye",
        label: "走查并交付",
        mode: "inspect",
        prompt:
          "走查当前设计，输出可定位问题、状态覆盖、响应式风险和交付建议。",
      },
    ],
    scene: "design",
    subtitle: "从 Brief 完成探索、制作与走查",
    tabLabel: "设计创意",
  },
};

export const scenePresetsEn: Record<CommandScene, ScenePreset> = {
  office: {
    capabilitySummary: "Word / PPT / Excel · Knowledge",
    contextSummary: "Documents / calendar / knowledge base",
    deliverableSummary: "Documents and action items",
    modes: [
      {
        detail: "Choose from the task, deliverable, and risk",
        label: "Auto",
        value: "auto",
      },
      {
        detail: "Organize items, sources, and actions",
        label: "Organize",
        value: "organize",
      },
      {
        detail: "Produce a ready-to-use draft for its audience",
        label: "Write",
        value: "write",
      },
      {
        detail: "Explain the method and conclusions from sources",
        label: "Analyze",
        value: "analyze",
      },
      {
        detail: "Prepare messages, meetings, or shared drafts",
        label: "Coordinate",
        value: "coordinate",
      },
    ],
    placeholder:
      "For example: organize today's project work, schedule meetings, follow up on blockers, and save conclusions to the knowledge base",
    quickActions: [
      {
        hint: "Tasks, meetings, and blockers",
        icon: "clipboardList",
        label: "Organize today's work",
        mode: "organize",
        prompt:
          "Organize today's project work with tasks, meetings, owners, blockers, and deadlines.",
      },
      {
        hint: "Agenda, context, and decisions",
        icon: "presentation",
        label: "Prepare meeting materials",
        mode: "write",
        prompt:
          "Prepare meeting materials from the available sources and calendar, including agenda, context, decisions, and action items.",
      },
      {
        hint: "Progress, risks, and next steps",
        icon: "fileText",
        label: "Write a project update",
        mode: "write",
        prompt:
          "Write a ready-to-use project update covering progress, risks, conclusions, and next steps.",
      },
      {
        hint: "Conclusions, sources, and owner",
        icon: "bookMarked",
        label: "Save to the knowledge base",
        mode: "organize",
        prompt:
          "Turn this discussion into a knowledge-base entry with conclusions, sources, scope, and owner.",
      },
    ],
    scene: "office",
    subtitle: "Organize, write, and move your work forward",
    tabLabel: "Office",
  },
  code: {
    capabilitySummary: "Workspace · Terminal · Test · Git",
    contextSummary: "Repository / issue / logs",
    deliverableSummary: "Answers, plans, diffs, and tests",
    modes: [
      {
        detail: "Choose from the task, deliverable, and risk",
        label: "Auto",
        value: "auto",
      },
      {
        detail: "Answer read-only with repository evidence",
        label: "Ask",
        value: "ask",
      },
      {
        detail: "Create an actionable plan without changing files",
        label: "Plan",
        value: "plan",
      },
      {
        detail: "Change the workspace and run relevant checks",
        label: "Code",
        value: "implement",
      },
      {
        detail: "Return read-only, locatable review findings",
        label: "Review",
        value: "review",
      },
    ],
    placeholder:
      "For example: read the repository rules, implement this feature, and run the relevant tests",
    quickActions: [
      {
        hint: "Follow repo rules and verify",
        icon: "sparkles",
        label: "Implement a feature",
        mode: "implement",
        prompt:
          "Read the repository rules, implement this feature, and run the relevant formatting, tests, and build checks.",
      },
      {
        hint: "Find the root cause and verify",
        icon: "bug",
        label: "Fix a bug",
        mode: "implement",
        prompt:
          "Use the issue description, logs, and repository evidence to find the root cause, fix it, and verify the regression.",
      },
      {
        hint: "Read-only, locatable findings",
        icon: "searchCheck",
        label: "Review current changes",
        mode: "review",
        prompt:
          "Review the current changes without modifying files. Return locatable findings, evidence, and suggested fixes by severity.",
      },
      {
        hint: "Close coverage and pipeline gaps",
        icon: "flaskConical",
        label: "Complete tests and CI",
        mode: "implement",
        prompt:
          "Find gaps in tests and CI for the current changes, add coverage, and run the relevant checks.",
      },
    ],
    scene: "code",
    subtitle: "Ask, plan, implement, and review in your repository",
    tabLabel: "Code",
  },
  design: {
    capabilitySummary: "HTML artifacts · Rendered previews · Design audit",
    contextSummary: "Brief / design system / brand and references",
    deliverableSummary: "Directions, visual assets, and handoff notes",
    modes: [
      {
        detail: "Choose from the task, deliverable, and risk",
        label: "Auto",
        value: "auto",
      },
      {
        detail: "Create clearly differentiated directions",
        label: "Explore",
        value: "explore",
      },
      {
        detail: "Develop a direction using the design system",
        label: "Refine",
        value: "refine",
      },
      {
        detail: "Create previewable, deliverable design assets",
        label: "Produce",
        value: "produce",
      },
      {
        detail: "Diagnose and return locatable issues only",
        label: "Inspect",
        value: "inspect",
      },
    ],
    placeholder:
      "For example: explore three directions from this brief and produce previewable page concepts",
    quickActions: [
      {
        hint: "Three directions with tradeoffs",
        icon: "compass",
        label: "Explore design directions",
        mode: "explore",
        prompt:
          "Explore three clearly differentiated design directions from the current brief and explain their tradeoffs.",
      },
      {
        hint: "Cover the key states",
        icon: "layoutTemplate",
        label: "Design a page or component",
        mode: "produce",
        prompt:
          "Use the brief, brand, and target canvas to design a previewable page or component with key states.",
      },
      {
        hint: "Previewable and exportable",
        icon: "image",
        label: "Generate visual assets",
        mode: "produce",
        prompt:
          "Generate previewable, exportable visual assets that follow the brief and brand constraints.",
      },
      {
        hint: "State coverage and handoff",
        icon: "scanEye",
        label: "Inspect and hand off",
        mode: "inspect",
        prompt:
          "Inspect the current design and report locatable issues, state coverage, responsive risks, and handoff guidance.",
      },
    ],
    scene: "design",
    subtitle: "Explore, produce, and inspect from a brief",
    tabLabel: "Design",
  },
};

type ExecutionTargetConfigRecord<TConfig> = {
  config: TConfig;
  filePath: string;
};

export function executionTargetOptionsFromDomain({
  agents,
  locale = "zh",
  offices,
  status,
}: {
  agents: Array<ExecutionTargetConfigRecord<AgentConfig>>;
  locale?: Locale;
  offices: Array<ExecutionTargetConfigRecord<OfficeConfig>>;
  status: "loading" | "ready" | "unavailable";
}): ExecutionTargetOption[] {
  const agentOptions = agents.flatMap((record) => {
    const id = record.config.agentId?.trim();
    if (!id) {
      return [];
    }
    return [
      {
        detail:
          record.config.role?.trim() ||
          (locale === "zh"
            ? "使用该智能体的模型与能力配置"
            : "Use this agent's model and capability configuration"),
        // The section header already says these run as a single agent, so the
        // label carries the name only.
        group: "single" as const,
        kind: "agent" as const,
        label: record.config.name,
        strategy: "single" as const,
        value: `agent:${id}`,
      },
    ];
  });
  const officeTitleCounts = offices.reduce((counts, record) => {
    const title = record.config.title.trim();
    counts.set(title, (counts.get(title) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const teamOptions = offices.map((record) => {
    const members = record.config.workspace?.members ?? [];
    const title = record.config.title.trim();
    const duplicateTitle = (officeTitleCounts.get(title) ?? 0) > 1;
    const ready = members.length > 0 && !duplicateTitle;
    const unavailableId = encodeURIComponent(
      record.config.workspace.recordId?.trim() || record.filePath,
    );
    return {
      detail: duplicateTitle
        ? locale === "zh"
          ? "存在同名办公室，需先在办公室配置中改为唯一名称"
          : "Duplicate office names must be made unique first"
        : ready
          ? locale === "zh"
            ? `${members.length} 名成员 · 服务端有界 Team Runtime`
            : `${members.length} members · bounded server Team Runtime`
          : locale === "zh"
            ? "小队尚未配置成员，不能开始任务"
            : "This team has no configured members and cannot start",
      disabled: !ready,
      // A bounded Team Runtime is a team of agents reporting to a lead, which is
      // the same choice users make when picking an expert team.
      group: "experts" as const,
      kind: "team" as const,
      label: title,
      strategy: "team" as const,
      value: duplicateTitle
        ? `team:unavailable:${unavailableId}`
        : `team:${title}`,
    };
  });
  const fallback =
    status === "loading"
      ? locale === "zh"
        ? "正在读取本地 Agent 与小队定义"
        : "Loading local agent and team definitions"
      : locale === "zh"
        ? "未读取到可用的本地 Agent 或小队定义"
        : "No available local agent or team definitions were found";

  const options: ExecutionTargetOption[] = [
    {
      detail:
        locale === "zh"
          ? "本地 Agent，独立完成任务"
          : "Local agent that completes the task independently",
      kind: "crewon",
      label: "CrewON",
      strategy: "single",
      value: "crewon",
    },
    ...agentOptions,
    ...teamOptions,
    ...(agentOptions.length === 0 && teamOptions.length === 0
      ? [
          {
            detail: fallback,
            disabled: true,
            group: "single" as const,
            kind: "agent" as const,
            label:
              locale === "zh"
                ? "暂无可选智能体或小队"
                : "No agent or team available",
            strategy: "single" as const,
            value: "target:unavailable",
          },
        ]
      : []),
  ];
  return options.filter(
    (option, index) =>
      options.findIndex(
        (candidate) =>
          executionTargetIdentity(candidate.value) ===
          executionTargetIdentity(option.value),
      ) === index,
  );
}

/**
 * Collapse the two saved shapes of a platform agent target to one identity.
 *
 * The same cloud agent can be saved twice on disk -- once as the resource id
 * `agent-platform:agents:<id>` and once as a bare `agent-platform:<id>` -- which
 * listed it twice in the selector under the same name. Any other target is its
 * own identity.
 */
function executionTargetIdentity(value: string): string {
  const platformAgent = /^agent:agent-platform:(?:agents:)?(\d+)$/.exec(value);
  return platformAgent === null
    ? value
    : `agent:agent-platform:${platformAgent[1]}`;
}

export function modeMayWrite(mode: SceneInteractionMode): boolean {
  return ["coordinate", "implement", "refine", "produce"].includes(mode);
}
