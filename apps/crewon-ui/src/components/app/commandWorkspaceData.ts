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
