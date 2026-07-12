import type {
  CommandPaletteKind,
  CommandShellView,
} from "./commandWorkspaceState";

export type ShellNavItem = {
  key: CommandShellView;
  label: string;
  en: string;
  meta?: string;
};

export type ResourceCard = {
  kind: CommandPaletteKind;
  label: string;
  title: string;
  detail: string;
};

export const shellNavItems: ShellNavItem[] = [
  { key: "command", label: "新建任务", en: "New task" },
  { key: "assist", label: "助理", en: "Assistant" },
  { key: "projects", label: "项目", en: "Projects" },
  { key: "agents", label: "智能体", en: "Agents", meta: "技能·连接器" },
  { key: "schedule", label: "日程安排", en: "Schedule", meta: "计划·提醒" },
  { key: "team", label: "团队", en: "Team" },
];

export const fallbackResources: ResourceCard[] = [
  {
    kind: "agent",
    label: "Agent",
    title: "产品审阅智能体",
    detail: "引用左侧智能体配置与权限边界",
  },
  {
    kind: "skill",
    label: "Skill",
    title: "页面审阅 Skill",
    detail: "检查层级、文案、交互和验收点",
  },
  {
    kind: "mcp",
    label: "MCP",
    title: "Filesystem MCP",
    detail: "读取和写入当前项目文件",
  },
  {
    kind: "knowledge",
    label: "Knowledge",
    title: "Agent 小队交付空间",
    detail: "默认创建新小队任务的位置",
  },
  {
    kind: "workflow",
    label: "Workflow",
    title: "项目交付清单",
    detail: "验收点、负责人和风险记录",
  },
];

export const projectCards = [
  {
    title: "当前任务",
    detail: "主页 Agent 对话、静态 UI 迁移、React 状态化交互",
    status: "进行中",
  },
  {
    title: "Workflow 执行队列",
    detail: "Stage Gate、验证命令、浏览器核验和交付清单",
    status: "排队",
  },
  {
    title: "执行状态机",
    detail: "发送、steer、stop、失败恢复和 transcript 落地",
    status: "待验收",
  },
];

export const agentCards = [
  {
    title: "技能·连接器",
    detail: "Skill、MCP、Knowledge 和 Workflow 能力统一呈现。",
    filter: "agent skill mcp",
  },
  {
    title: "产品审阅智能体",
    detail: "负责需求澄清、界面走查、验收点和风险摘要。",
    filter: "agent skill",
  },
  {
    title: "交付检查 Skill",
    detail: "生成测试点、上线清单和阻塞项复核。",
    filter: "skill workflow",
  },
  {
    title: "Filesystem MCP",
    detail: "读取项目文件、写入迁移结果并辅助验证。",
    filter: "mcp",
  },
];

export const scheduleCards = [
  {
    title: "团队交付日历",
    detail: "关联办公室成员、Workflow Gate 和验收节点。",
    filter: "calendar teamflow",
    odId: "schedule-calendar-team",
  },
  {
    title: "个人跟进日历",
    detail: "整理今天的项目事项、提醒和阻塞复盘。",
    filter: "calendar personal",
  },
  {
    title: "小队执行安排",
    detail: "把 Agent 小队任务安排到可追踪的执行节奏。",
    filter: "arrangement teamflow",
    odId: "schedule-arrangement-catalog",
  },
  {
    title: "个人任务安排",
    detail: "从主页 composer 生成个人计划和提醒。",
    filter: "arrangement personal",
  },
];

export const officeRooms = [
  {
    current: "当前：PRD 风险与界面打磨",
    id: "office-design-delivery",
    messages: [
      "@产品审阅智能体 先把 PRD 里的风险点列出来，@开发交付智能体 准备拆实现任务。",
      "已派发：产品审阅负责风险清单，开发交付负责实现拆解；不 @ 指定员工时，我会先接收并分派。",
      "中间产物已生成：核心风险集中在权限边界、执行结果可追溯和人工确认 Gate。",
    ],
    status: "运行中",
    statusTone: "success" as const,
    subtitle: "组长 · 产品审阅智能体 · 4 成员",
    title: "设计交付办公室",
  },
  {
    current: "当前：接口卡点与变更追踪",
    id: "office-project-integration",
    messages: [
      "请同步接口卡点和变更影响。",
      "项目联调办公室已把阻塞拆成接口确认、回归范围和发布 Gate 三段。",
    ],
    status: "待确认",
    statusTone: "warn" as const,
    subtitle: "组长 · 开发交付智能体 · 3 成员",
    title: "项目联调办公室",
  },
  {
    current: "当前：议题整理与材料补齐",
    id: "office-meeting-prep",
    messages: [
      "准备下一次评审会议材料。",
      "会议准备办公室已整理议题、参会人上下文和待确认材料清单。",
    ],
    status: "草稿",
    subtitle: "组长 · 会议准备智能体 · 3 成员",
    title: "会议准备办公室",
  },
];

export const workflowRooms = [
  {
    id: "workflow-page-delivery",
    members: ["组", "产", "交", "人"],
    messages: [
      "@开发交付智能体 下一步把执行阶段拆成可验收任务，保留人工确认节点。",
      "已按节点推进到 02：产品审阅智能体负责界面风险审阅，后续会自动交给开发交付智能体拆解实现。",
      "中间产物：当前页面风险集中在协作流入口状态、执行阶段可读性和人工 Gate 的确认口径。",
    ],
    progress: ["is-done", "is-running", "", ""],
    stage: "当前阶段：02 产品审阅智能体 · 界面风险审阅",
    status: "运行中",
    statusTone: "warn" as const,
    title: "页面交付协作流",
  },
  {
    id: "workflow-code-review",
    members: ["交", "审", "服", "人"],
    messages: [
      "扫描最近变更并把高风险结果送到 Gate。",
      "代码审查协作流正在等待开发交付智能体完成变更扫描。",
    ],
    progress: ["is-running", "", "", ""],
    stage: "当前阶段：01 开发交付智能体 · 变更扫描",
    status: "待启动",
    title: "代码审查协作流",
  },
  {
    id: "workflow-release-prep",
    members: ["会", "交", "频", "人"],
    messages: [
      "准备发布前人工确认和 Channel 草稿。",
      "发布准备协作流已进入会议准备智能体的人工 Gate 确认阶段。",
    ],
    progress: ["is-done", "is-done", "is-running", ""],
    stage: "当前阶段：03 会议准备智能体 · 人工 Gate 确认",
    status: "Gate",
    statusTone: "success" as const,
    title: "发布准备协作流",
  },
];
