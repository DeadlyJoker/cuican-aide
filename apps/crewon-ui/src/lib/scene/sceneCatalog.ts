import type { AgentPlatformSnapshot } from "../agent-platform/agentPlatformClient";
import type { AgentConfig, OfficeConfig } from "../domain/domainTypes";

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

export type ExecutionTargetKind = "crewon" | "agent" | "team";

export type ExecutionTargetOption = {
  detail: string;
  disabled?: boolean;
  kind: ExecutionTargetKind;
  label: string;
  strategy: "single" | "team";
  value: string;
};

export type SceneModeOption = {
  detail: string;
  label: string;
  value: SceneInteractionMode;
};

export type SceneQuickAction = {
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

function explicitlyEnabled(value: unknown): boolean {
  return value === true || value === 1;
}

const autoMode: SceneModeOption = {
  detail: "根据任务对象、交付物和风险自动判断",
  label: "自动判断",
  value: "auto",
};

export const scenePresets: Record<CommandScene, ScenePreset> = {
  office: {
    capabilitySummary: "文档整理 · Calendar · Knowledge",
    contextSummary: "文档 / 日历 / 知识库",
    deliverableSummary: "文档与行动项",
    modes: [
      autoMode,
      { detail: "整理事项、来源与行动项", label: "整理", value: "organize" },
      { detail: "生成面向受众的可用成稿", label: "撰写", value: "write" },
      { detail: "基于来源说明方法与结论", label: "分析", value: "analyze" },
      { detail: "准备消息、会议或共享写入草稿", label: "协同", value: "coordinate" },
    ],
    placeholder: "例如：整理今天的项目事项，安排会议、跟进阻塞，并把结论写入知识库",
    quickActions: [
      {
        label: "整理今日工作",
        mode: "organize",
        prompt: "整理今天的项目事项，列出待办、会议、负责人、阻塞项和截止时间。",
      },
      {
        label: "生成会议材料",
        mode: "write",
        prompt: "结合现有资料和日程生成会议材料，包含议题、背景、待决策项和行动项。",
      },
      {
        label: "撰写项目汇报",
        mode: "write",
        prompt: "基于项目资料撰写可直接使用的项目汇报，说明进度、风险、结论和下一步。",
      },
      {
        label: "沉淀知识库",
        mode: "organize",
        prompt: "把这次讨论沉淀成知识库条目，包含结论、来源、适用范围和维护人。",
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
        label: "实现一个功能",
        mode: "implement",
        prompt: "读取当前仓库规则，实现这个功能，并运行适用的格式化、测试和构建验证。",
      },
      {
        label: "修复一个 Bug",
        mode: "implement",
        prompt: "结合问题描述、日志和仓库证据定位根因，完成修复并验证回归。",
      },
      {
        label: "审阅当前改动",
        mode: "review",
        prompt: "只读审阅当前改动，按严重程度输出可定位的问题、证据和修复建议。",
      },
      {
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
    capabilitySummary: "Vision · Figma · Image Generation",
    contextSummary: "Brief / Figma / 品牌与参考",
    deliverableSummary: "方向、视觉产物与交付说明",
    modes: [
      autoMode,
      { detail: "给出有明显差异的设计方向", label: "探索", value: "explore" },
      { detail: "深化选定方向并复用设计系统", label: "收敛", value: "refine" },
      { detail: "生成可预览、可交付的设计产物", label: "制作", value: "produce" },
      { detail: "只诊断并输出可定位问题", label: "走查", value: "inspect" },
    ],
    placeholder: "例如：基于这个 Brief 探索三个方向，并制作可预览的页面方案",
    quickActions: [
      {
        label: "探索设计方向",
        mode: "explore",
        prompt: "基于当前 Brief 探索三个有明显差异的设计方向，并说明各自取舍。",
      },
      {
        label: "设计页面或组件",
        mode: "produce",
        prompt: "结合 Brief、品牌与目标画布，设计可预览的页面或组件并覆盖关键状态。",
      },
      {
        label: "生成视觉资产",
        mode: "produce",
        prompt: "根据 Brief 和品牌约束生成可预览、可导出的视觉资产。",
      },
      {
        label: "走查并交付",
        mode: "inspect",
        prompt: "走查当前设计，输出可定位问题、状态覆盖、响应式风险和交付建议。",
      },
    ],
    scene: "design",
    subtitle: "从 Brief 完成探索、制作与走查",
    tabLabel: "设计创意",
  },
};

export function executionTargetOptions(
  snapshot: AgentPlatformSnapshot,
  runtimeAvailability: { agent: boolean; team: boolean } = {
    agent: false,
    team: false,
  },
): ExecutionTargetOption[] {
  const agents = snapshot.agents
    .filter((agent) => explicitlyEnabled(agent.is_active))
    .map((agent) => {
      const apiEnabled = explicitlyEnabled(agent.api_enabled);
      const available = apiEnabled && runtimeAvailability.agent;
      return {
        detail: !apiEnabled
          ? "Agent 尚未开放 Open API"
          : runtimeAvailability.agent
            ? agent.description?.trim() || "使用该智能体的模型与能力配置"
            : "智能体定义已同步，Execution Target Runtime 尚未接入",
        disabled: !available,
        kind: "agent" as const,
        label: `${agent.name} · 单 Agent`,
        strategy: "single" as const,
        value: `agent:${agent.id}`,
      };
    });

  return [
    {
      detail: "本地 Agent，独立完成任务",
      kind: "crewon",
      label: "CrewON",
      strategy: "single",
      value: "crewon",
    },
    ...agents,
    {
      detail: runtimeAvailability.team
        ? "使用服务端解析的小队定义和有界 Team Runtime"
        : "服务端 Team Runtime 与小队目录尚未接入",
      disabled: !runtimeAvailability.team,
      kind: "team",
      label: "选择已有小队 · 暂不可用",
      strategy: "team",
      value: runtimeAvailability.team ? "team:select" : "team:unavailable",
    },
  ];
}

type ExecutionTargetConfigRecord<TConfig> = {
  config: TConfig;
  filePath: string;
};

export function executionTargetOptionsFromDomain({
  agents,
  offices,
  platformAgents = [],
  status,
}: {
  agents: Array<ExecutionTargetConfigRecord<AgentConfig>>;
  offices: Array<ExecutionTargetConfigRecord<OfficeConfig>>;
  platformAgents?: AgentPlatformSnapshot["agents"];
  status: "loading" | "ready" | "unavailable";
}): ExecutionTargetOption[] {
  const agentOptions = agents.flatMap((record) => {
    const id = record.config.agentId?.trim();
    if (!id) {
      return [];
    }
    return [{
      detail: record.config.role?.trim() || "使用该智能体的模型与能力配置",
      kind: "agent" as const,
      label: `${record.config.name} · 单 Agent`,
      strategy: "single" as const,
      value: `agent:${id}`,
    }];
  });
  const teamOptions = offices.map((record) => {
    const members = record.config.workspace?.members ?? [];
    const ready = members.length > 0;
    return {
      detail: ready
        ? `${members.length} 名成员 · 服务端有界 Team Runtime`
        : "小队尚未配置成员，不能开始任务",
      disabled: !ready,
      kind: "team" as const,
      label: `${record.config.title} · Team`,
      strategy: "team" as const,
      value: `team:${record.config.title}`,
    };
  });
  const platformAgentOptions = platformAgents.flatMap((agent) => {
    const active = explicitlyEnabled(agent.is_active);
    const apiEnabled = explicitlyEnabled(agent.api_enabled);
    if (!active || !apiEnabled) {
      return [];
    }
    return [{
      detail: agent.description?.trim() || "通过 Agent Platform Open API 执行",
      kind: "agent" as const,
      label: `${agent.name} · 在线 Agent`,
      strategy: "single" as const,
      value: `agent-platform:agents:${agent.id}`,
    }];
  });
  const fallback = status === "loading"
    ? "正在读取本地 Agent 与小队定义"
    : "未读取到可用的本地 Agent 或小队定义";

  const options: ExecutionTargetOption[] = [
    {
      detail: "本地 Agent，独立完成任务",
      kind: "crewon",
      label: "CrewON",
      strategy: "single",
      value: "crewon",
    },
    ...platformAgentOptions,
    ...agentOptions,
    ...teamOptions,
    ...(platformAgentOptions.length === 0 && agentOptions.length === 0 && teamOptions.length === 0
      ? [{
          detail: fallback,
          disabled: true,
          kind: "agent" as const,
          label: "暂无可选智能体或小队",
          strategy: "single" as const,
          value: "target:unavailable",
        }]
      : []),
  ];
  return options.filter(
    (option, index) => options.findIndex((candidate) => candidate.value === option.value) === index,
  );
}

export function modeMayWrite(mode: SceneInteractionMode): boolean {
  return ["coordinate", "implement", "refine", "produce"].includes(mode);
}
