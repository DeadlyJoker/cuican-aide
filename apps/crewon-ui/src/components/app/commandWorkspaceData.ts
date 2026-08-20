import type {
  CommandPaletteKind,
  CommandShellView,
} from "./commandWorkspaceState";

export type ShellNavItem = {
  key: CommandShellView;
  label: string;
  en: string;
};

export type ResourceCard = {
  kind: CommandPaletteKind;
  label: string;
  title: string;
  detail: string;
};

/*
 * Nav rows carry a label only. The subtitles ("技能·连接器", "计划·提醒") restated
 * what the destination page already says while doubling every row's height, so
 * the rail lost the density the desktop design depends on.
 */
export const shellNavItems: ShellNavItem[] = [
  { key: "command", label: "新建任务", en: "New task" },
  { key: "assist", label: "助理", en: "Assistant" },
  { key: "projects", label: "项目", en: "Projects" },
  { key: "agents", label: "智能体", en: "Agents" },
  { key: "schedule", label: "日程", en: "Schedule" },
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
