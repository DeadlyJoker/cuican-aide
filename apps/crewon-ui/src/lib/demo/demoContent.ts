import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { ThreadGoalView } from "@crewon/contracts";
import type {
  AccountStatus,
  GitRemoteDiffSummary,
} from "../shared/statusTypes";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type {
  ActivityData,
  AgentCapabilityOption,
  AgentConfig,
  ApprovalRequest,
  KnowledgeData,
  LibraryItem,
  LibraryKind,
  LibraryPanel,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import type { SettingsSection } from "../settings/settingsCatalog";
import type { Locale } from "../i18n";

const zh = (locale: Locale) => locale === "zh";

// [INSPECTOR]
export function demoAccountStatus(locale: Locale): AccountStatus {
  return {
    account: {
      type: "chatgpt",
      email: zh(locale) ? "demo@crewon.ai" : "demo@crewon.ai",
      planType: "plus",
    },
    requiresOpenaiAuth: false,
  };
}

export function demoGitRemoteDiff(): GitRemoteDiffSummary {
  return {
    status: "ready",
    added: 128,
    removed: 34,
    files: 6,
    sha: "a1c9f4e2",
  };
}

export function demoThreadGoal(locale: Locale): ThreadGoalView {
  const now = Date.now();
  return {
    goalId: "demo-goal-1",
    revision: 1,
    threadId: "demo-1",
    objective: zh(locale)
      ? "今天交付一版可发给甲方的 demo 截图"
      : "Ship a client-ready demo screenshot set today",
    status: "active",
    tokenBudget: 200000,
    tokensUsed: 86400,
    timeUsedSeconds: 5400,
    createdAt: new Date(now - 5_400_000).toISOString(),
    updatedAt: new Date(now - 120_000).toISOString(),
  };
}

export function demoConversationSummary(locale: Locale): ConversationSummary {
  return {
    conversationId: "demo-1",
    path: "/Users/me/work/crewon",
    preview: zh(locale)
      ? "把 Crewon 前端收敛为命令中心：左侧导航、中间对话流、右侧能力面板，并补全各页面动线。"
      : "Shaped the Crewon front end into a command center: left nav, center chat flow, right capability dock, with full page flows.",
    timestamp: null,
    updatedAt: null,
    modelProvider: "openai",
    cwd: "/Users/me/work/crewon",
    cliVersion: "0.1.0",
    source: "mcp",
    gitInfo: null,
  };
}

// [LIBRARY]
export function demoLibraryTitle(kind: LibraryKind, locale: Locale): string {
  if (zh(locale)) {
    return kind === "plugins"
      ? "插件"
      : kind === "tools"
        ? "工具"
        : kind === "agents"
          ? "智能体"
          : kind === "office"
            ? "办公室"
            : kind === "knowledge"
              ? "知识库"
              : "自动化";
  }
  return kind === "plugins"
    ? "Plugins"
    : kind === "tools"
      ? "Tools"
      : kind === "agents"
        ? "Agents"
        : kind === "office"
          ? "Office"
          : kind === "knowledge"
            ? "Knowledge"
            : "Automations";
}

export function demoLibraryPanel(
  kind: LibraryKind,
  locale: Locale,
): LibraryPanel {
  const title = demoLibraryTitle(kind, locale);
  if (kind === "tools") return demoToolsPanel(title, locale);
  if (kind === "office") return unavailableDemoOfficePanel(title, locale);
  if (kind === "automation") return demoAutomationPanel(title, locale);
  if (kind === "agents") return demoAgentsPanel(title, locale);
  if (kind === "knowledge") return demoKnowledgePanel(title, locale);
  return demoPluginsPanel(title, locale);
}

function unavailableDemoOfficePanel(
  title: string,
  locale: Locale,
): LibraryPanel {
  return {
    kind: "office",
    title,
    subtitle: zh(locale) ? "需要真实 App Server" : "Real App Server required",
    body: zh(locale)
      ? "办公室只展示当前工作空间中由 App Server 返回的真实配置、成员、消息和运行状态。演示模式不会创建或展示虚构办公室。"
      : "Office only shows real configurations, members, messages, and runtime state returned by the App Server for the current workspace. Demo mode does not create or display fictional offices.",
    actions: [],
    items: [],
  };
}

// [LIBRARY_TOOLS]
function demoToolsPanel(title: string, locale: Locale): LibraryPanel {
  const mcpItems: LibraryItem[] = [
    {
      title: "GitHub",
      meta: zh(locale) ? "MCP 连接器 · OAuth" : "MCP connector · OAuth",
      description: zh(locale)
        ? "拉取 PR、Issue、CI 状态，供工程师和审查者调用。"
        : "Pulls PRs, issues, and CI status for engineers and reviewers.",
      glyph: "GH",
      accent: "slate",
      badge: { label: zh(locale) ? "已连接" : "connected", tone: "running" },
      tags: zh(locale)
        ? ["8 工具", "3 资源", "只读+评论"]
        : ["8 tools", "3 resources", "read+comment"],
      action: {
        type: "mcp-detail",
        title: "GitHub MCP",
        subtitle: "github · oauth",
        body: zh(locale)
          ? "状态：已连接\n授权：OAuth（demo@crewon.ai）\n\n工具：\n- list_pull_requests\n- get_pull_request_diff\n- list_issues\n- create_issue_comment\n- get_workflow_runs\n\n权限：仅读取 + 评论，禁止合并。\n分配：前端交付办公室、PR/CI 监控自动化。"
          : "Status: connected\nAuth: OAuth (demo@crewon.ai)\n\nTools:\n- list_pull_requests\n- get_pull_request_diff\n- list_issues\n- create_issue_comment\n- get_workflow_runs\n\nScope: read + comment, no merge.\nAssigned to: Frontend office, PR/CI monitor automation.",
      },
    },
  ];
  // [TOOLS_MCP_MORE]
  mcpItems.push(
    {
      title: zh(locale) ? "浏览器" : "Browser",
      meta: zh(locale) ? "MCP 连接器 · 本地" : "MCP connector · local",
      description: zh(locale)
        ? "打开页面、截图、抓取 DOM，供研究员收集资料。"
        : "Opens pages, screenshots, and scrapes DOM for researchers.",
      glyph: "◍",
      accent: "cyan",
      badge: { label: zh(locale) ? "已连接" : "connected", tone: "running" },
      tags: zh(locale) ? ["5 工具", "Playwright"] : ["5 tools", "Playwright"],
      action: {
        type: "mcp-detail",
        title: zh(locale) ? "浏览器 MCP" : "Browser MCP",
        subtitle: "playwright · local",
        body: zh(locale)
          ? "状态：已连接\n运行方式：本地 Playwright\n\n工具：navigate / screenshot / read_dom / click / extract_text\n\n分配：研究员、演示报告生成自动化。"
          : "Status: connected\nRuntime: local Playwright\n\nTools: navigate / screenshot / read_dom / click / extract_text\n\nAssigned to: Researcher, demo report automation.",
      },
    },
    {
      title: zh(locale) ? "数据库" : "Database",
      meta: zh(locale) ? "MCP 连接器 · 只读" : "MCP connector · read-only",
      description: zh(locale)
        ? "只读查询业务库，配置连接串后启用。"
        : "Read-only business queries, enabled after configuring the DSN.",
      glyph: "▤",
      accent: "amber",
      badge: { label: zh(locale) ? "需授权" : "needs auth", tone: "warning" },
      tags: zh(locale) ? ["4 工具", "Postgres"] : ["4 tools", "Postgres"],
      action: {
        type: "mcp-detail",
        title: zh(locale) ? "数据库 MCP" : "Database MCP",
        subtitle: "postgres · read-only",
        body: zh(locale)
          ? "状态：待授权\n需要：连接串与只读凭证\n\n工具：list_tables / describe / run_select / explain\n\n说明：连接后才会出现在工程师可用工具里。"
          : "Status: needs auth\nRequires: DSN + read-only credentials\n\nTools: list_tables / describe / run_select / explain\n\nNote: appears in the engineer toolset once connected.",
      },
    },
  );
  // [TOOLS_SKILLS]
  const skillBody = (name: string) =>
    zh(locale)
      ? `Skill：${name}\n来源：内置\n状态：可招募\n\n用途：把一段可复用流程固化成方法，招募到办公室后由智能体按步骤执行。\n输入：任务上下文\n产物：结构化结论 + 可发送材料`
      : `Skill: ${name}\nSource: built-in\nStatus: recruitable\n\nPurpose: package a reusable workflow that agents execute step by step inside an office.\nInput: task context\nOutput: structured result + shareable material`;
  const skillItems: LibraryItem[] = [
    {
      title: zh(locale) ? "代码审查" : "Code review",
      meta: zh(locale) ? "Skill · 内置" : "Skill · built-in",
      description: zh(locale)
        ? "按 bug、回归、测试缺口、交付风险输出审查结论。"
        : "Reviews bugs, regressions, test gaps, and delivery risk.",
      glyph: "✓",
      accent: "green",
      badge: { label: zh(locale) ? "可招募" : "recruitable", tone: "idle" },
      action: {
        type: "mcp-detail",
        title: zh(locale) ? "代码审查" : "Code review",
        subtitle: "Skill",
        body: skillBody(zh(locale) ? "代码审查" : "Code review"),
      },
    },
    {
      title: zh(locale) ? "演示截图" : "Demo screenshots",
      meta: zh(locale) ? "Skill · 内置" : "Skill · built-in",
      description: zh(locale)
        ? "为甲方准备成套截图、讲解路径和风险说明。"
        : "Prepares client screenshot sets, talk tracks, and risk notes.",
      glyph: "▣",
      accent: "violet",
      badge: { label: zh(locale) ? "可招募" : "recruitable", tone: "idle" },
      action: {
        type: "mcp-detail",
        title: zh(locale) ? "演示截图" : "Demo screenshots",
        subtitle: "Skill",
        body: skillBody(zh(locale) ? "演示截图" : "Demo screenshots"),
      },
    },
    {
      title: zh(locale) ? "表格分析" : "Spreadsheet analysis",
      meta: zh(locale) ? "Skill · 内置" : "Skill · built-in",
      description: zh(locale)
        ? "读取表格、做透视和摘要，输出业务结论。"
        : "Reads sheets, pivots, and summarizes into business conclusions.",
      glyph: "∑",
      accent: "blue",
      badge: { label: zh(locale) ? "可招募" : "recruitable", tone: "idle" },
      action: {
        type: "mcp-detail",
        title: zh(locale) ? "表格分析" : "Spreadsheet analysis",
        subtitle: "Skill",
        body: skillBody(zh(locale) ? "表格分析" : "Spreadsheet analysis"),
      },
    },
  ];
  // [TOOLS_RETURN]
  return {
    kind: "tools",
    title,
    subtitle: zh(locale)
      ? `${mcpItems.length} 个 MCP · ${skillItems.length} 个 Skill`
      : `${mcpItems.length} MCP · ${skillItems.length} skills`,
    body: zh(locale)
      ? "工具库是智能体和办公室的能力市场。MCP 负责连接外部系统，Skill 负责沉淀可复用流程；新建后可以分配给某个智能体或办公室。"
      : "The tool library is the capability market for agents and offices. MCP connects external systems, while Skills package reusable workflows for assignment.",
    actions: [
      {
        id: "create-mcp",
        label: zh(locale) ? "新建 MCP" : "New MCP",
        tone: "primary",
      },
      { id: "create-skill", label: zh(locale) ? "新建 Skill" : "New Skill" },
      { id: "reload-tools", label: zh(locale) ? "刷新工具" : "Refresh tools" },
    ],
    items: [
      {
        title: "MCP",
        meta: zh(locale)
          ? `${mcpItems.length} 个服务器`
          : `${mcpItems.length} servers`,
        description: zh(locale)
          ? "运行态连接：浏览器、GitHub、数据库、内部 API、文件系统。可被智能体按权限调用。"
          : "Runtime connectors: browser, GitHub, databases, internal APIs, and filesystems.",
        section: true,
      },
      ...mcpItems,
      {
        title: "Skill",
        meta: zh(locale)
          ? `${skillItems.length} 个技能`
          : `${skillItems.length} skills`,
        description: zh(locale)
          ? "方法库：代码审查、演示截图、表格分析等流程，招募到办公室后可复用。"
          : "Method library for review, demo screenshots, and spreadsheet analysis.",
        section: true,
      },
      ...skillItems,
    ],
  };
}

// [LIBRARY_OFFICE]
function demoClientOfficeWorkspace(locale: Locale): OfficeWorkspace {
  return {
    goal: zh(locale)
      ? "今天交付一版可发给甲方的 demo 截图"
      : "Ship a client-ready demo screenshot set today",
    members: zh(locale)
      ? [
          {
            name: "晓白",
            role: "规划者",
            glyph: "◆",
            accent: "blue",
            status: "正在拆解任务",
            online: true,
          },
          {
            name: "阿码",
            role: "工程师",
            glyph: "⚙",
            accent: "violet",
            status: "调整页面视觉层级",
            online: true,
          },
          {
            name: "审审",
            role: "审查者",
            glyph: "✓",
            accent: "green",
            status: "等待截图复核",
            online: true,
          },
          {
            name: "小研",
            role: "研究员",
            glyph: "◎",
            accent: "amber",
            status: "整理三端布局参考",
            online: false,
          },
          {
            name: "你",
            role: "人工负责人",
            glyph: "@",
            accent: "slate",
            status: "在线旁听",
            online: true,
          },
        ]
      : [
          {
            name: "Bai",
            role: "Planner",
            glyph: "◆",
            accent: "blue",
            status: "Breaking down tasks",
            online: true,
          },
          {
            name: "Ma",
            role: "Engineer",
            glyph: "⚙",
            accent: "violet",
            status: "Tuning visual hierarchy",
            online: true,
          },
          {
            name: "Shen",
            role: "Reviewer",
            glyph: "✓",
            accent: "green",
            status: "Waiting to review shots",
            online: true,
          },
          {
            name: "Yan",
            role: "Researcher",
            glyph: "◎",
            accent: "amber",
            status: "Gathering layout refs",
            online: false,
          },
          {
            name: "You",
            role: "Human owner",
            glyph: "@",
            accent: "slate",
            status: "Watching live",
            online: true,
          },
        ],
    messages: zh(locale)
      ? [
          {
            author: "系统",
            glyph: "⌗",
            accent: "slate",
            time: "09:30",
            kind: "system",
            text: "办公室已创建 · 目标：今天交付甲方 demo 截图",
          },
          {
            author: "晓白",
            glyph: "◆",
            accent: "blue",
            time: "09:31",
            text: "我把目标拆成五张截图：对话、工具、智能体、办公室、自动化。@阿码 你先从工具和办公室入手。",
          },
          {
            author: "阿码",
            glyph: "⚙",
            accent: "violet",
            time: "09:33",
            text: "收到。我先把列表卡片换成有层级的设计，办公室这页做成真正的群聊工作区。",
          },
          {
            author: "审审",
            glyph: "✓",
            accent: "green",
            time: "09:40",
            text: "提醒一下：截图要像真实产品，不要只是一排静态清单，主次要分明。",
          },
          {
            author: "阿码",
            glyph: "⚙",
            accent: "violet",
            time: "10:02",
            kind: "task",
            text: "已提交：工具页改版（MCP/Skill 分区 + 状态标签）。@审审 可以复核了。",
          },
          {
            author: "小研",
            glyph: "◎",
            accent: "amber",
            time: "10:15",
            text: "补了 macOS / Windows / web 三端的布局参考，放进产物区。",
          },
          {
            author: "晓白",
            glyph: "◆",
            accent: "blue",
            time: "10:20",
            text: "进度不错，剩下自动化页的截图，今天内能收口。",
          },
        ]
      : [
          {
            author: "System",
            glyph: "⌗",
            accent: "slate",
            time: "09:30",
            kind: "system",
            text: "Office created · Goal: ship the client demo screenshots today",
          },
          {
            author: "Bai",
            glyph: "◆",
            accent: "blue",
            time: "09:31",
            text: "I split the goal into five shots: chat, tools, agents, office, automation. @Ma start with tools and office.",
          },
          {
            author: "Ma",
            glyph: "⚙",
            accent: "violet",
            time: "09:33",
            text: "On it. I'll replace the flat cards with a hierarchy and make the office page a real group-chat workspace.",
          },
          {
            author: "Shen",
            glyph: "✓",
            accent: "green",
            time: "09:40",
            text: "Reminder: shots should look like a real product, not a static list. Clear visual priority.",
          },
          {
            author: "Ma",
            glyph: "⚙",
            accent: "violet",
            time: "10:02",
            kind: "task",
            text: "Submitted: tools redesign (MCP/Skill sections + status tags). @Shen ready for review.",
          },
          {
            author: "Yan",
            glyph: "◎",
            accent: "amber",
            time: "10:15",
            text: "Added macOS / Windows / web layout references to the artifacts panel.",
          },
          {
            author: "Bai",
            glyph: "◆",
            accent: "blue",
            time: "10:20",
            text: "Good pace. Only the automation shot left, we can close it today.",
          },
        ],
    tasks: zh(locale)
      ? [
          { title: "工具页改版", owner: "阿码", status: "done" },
          { title: "办公室群聊视图", owner: "阿码", status: "doing" },
          { title: "截图复核", owner: "审审", status: "doing" },
          { title: "三端布局参考", owner: "小研", status: "done" },
          { title: "自动化页截图", owner: "晓白", status: "todo" },
          { title: "甲方讲解路径", owner: "晓白", status: "todo" },
        ]
      : [
          { title: "Tools redesign", owner: "Ma", status: "done" },
          { title: "Office group-chat view", owner: "Ma", status: "doing" },
          { title: "Screenshot review", owner: "Shen", status: "doing" },
          { title: "Cross-platform refs", owner: "Yan", status: "done" },
          { title: "Automation shot", owner: "Bai", status: "todo" },
          { title: "Client talk track", owner: "Bai", status: "todo" },
        ],
    activity: demoActivityData(locale),
  };
}

function demoOfficePanel(title: string, locale: Locale): LibraryPanel {
  const workspace = demoClientOfficeWorkspace(locale);
  const items: LibraryItem[] = zh(locale)
    ? [
        {
          title: "甲方 Demo 办公室",
          meta: "群聊协作 · 5 名成员",
          description: "围绕本次演示准备截图、讲解路径、风险说明和后续计划。",
          glyph: "⌗",
          accent: "blue",
          badge: { label: "运行中", tone: "running" },
          tags: ["6 任务", "12 消息", "5 产物"],
          action: {
            type: "office-detail",
            title: "甲方 Demo 办公室",
            subtitle: "群聊协作 · 规划者 / 工程师 / 审查者 / 研究员 + 你",
            body: "",
            workspace,
            items: [],
          },
        },
        {
          title: "前端交付办公室",
          meta: "群聊协作 · 3 名成员",
          description:
            "已招募工程师和审查者，默认工具为浏览器、文件、代码审查 Skill。",
          glyph: "⌘",
          accent: "violet",
          badge: { label: "草稿", tone: "draft" },
          tags: ["8 任务", "工程师", "审查者"],
          action: {
            type: "office-detail",
            title: "前端交付办公室",
            subtitle: "群聊协作 · 工程师 / 审查者 / 你",
            body: "",
            workspace: demoClientOfficeWorkspace(locale),
            items: [],
          },
        },
        {
          title: "后端能力办公室",
          meta: "群聊协作 · 5 名成员",
          description:
            "准备接入 app-server、MCP、自动化和多智能体编排，产物进入协作日志。",
          glyph: "⌥",
          accent: "cyan",
          badge: { label: "规划中", tone: "planning" },
          tags: ["12 任务", "MCP", "自动化"],
          action: {
            type: "office-detail",
            title: "后端能力办公室",
            subtitle: "群聊协作 · 规划者 / 工程师 / 审查者 / 你",
            body: "",
            workspace: demoClientOfficeWorkspace(locale),
            items: [],
          },
        },
      ]
    : [
        {
          title: "Client demo office",
          meta: "Group chat · 5 members",
          description:
            "Prepares screenshots, talk tracks, risk notes, and next steps for the demo.",
          glyph: "⌗",
          accent: "blue",
          badge: { label: "Running", tone: "running" },
          tags: ["6 tasks", "12 messages", "5 artifacts"],
          action: {
            type: "office-detail",
            title: "Client demo office",
            subtitle:
              "Group chat · planner / engineer / reviewer / researcher + you",
            body: "",
            workspace,
            items: [],
          },
        },
        {
          title: "Frontend delivery office",
          meta: "Group chat · 3 members",
          description:
            "Recruits engineer and reviewer roles with browser, file, and review skills.",
          glyph: "⌘",
          accent: "violet",
          badge: { label: "Draft", tone: "draft" },
          tags: ["8 tasks", "engineer", "reviewer"],
          action: {
            type: "office-detail",
            title: "Frontend delivery office",
            subtitle: "Group chat · engineer / reviewer / you",
            body: "",
            workspace: demoClientOfficeWorkspace(locale),
            items: [],
          },
        },
        {
          title: "Backend capability office",
          meta: "Group chat · 5 members",
          description:
            "Prepares app-server, MCP, automation, and multi-agent orchestration work.",
          glyph: "⌥",
          accent: "cyan",
          badge: { label: "Planning", tone: "planning" },
          tags: ["12 tasks", "MCP", "automation"],
          action: {
            type: "office-detail",
            title: "Backend capability office",
            subtitle: "Group chat · planner / engineer / reviewer / you",
            body: "",
            workspace: demoClientOfficeWorkspace(locale),
            items: [],
          },
        },
      ];
  const templates: LibraryItem[] = zh(locale)
    ? [
        {
          title: "办公室模板",
          meta: "一键起一个协作场景",
          description: "预置成员、默认工具和系统提示词，创建后直接进入群聊。",
          section: true,
        },
        {
          title: "PR 审查办公室",
          meta: "工程师 + 审查者",
          description:
            "预置 GitHub MCP、代码审查 Skill，自动拉 PR 并产出审查结论。",
          glyph: "✓",
          accent: "green",
          badge: { label: "模板", tone: "idle" },
          tags: ["GitHub", "代码审查"],
          action: {
            type: "office-detail",
            title: "PR 审查办公室",
            subtitle: "模板 · 工程师 + 审查者",
            body: "",
            workspace: demoClientOfficeWorkspace(locale),
            items: [],
          },
        },
        {
          title: "竞品调研办公室",
          meta: "研究员 + 规划者",
          description:
            "预置浏览器 MCP、文档 Skill，抓取竞品并整理成结构化对比。",
          glyph: "◎",
          accent: "amber",
          badge: { label: "模板", tone: "idle" },
          tags: ["浏览器", "文档"],
          action: {
            type: "office-detail",
            title: "竞品调研办公室",
            subtitle: "模板 · 研究员 + 规划者",
            body: "",
            workspace: demoClientOfficeWorkspace(locale),
            items: [],
          },
        },
        {
          title: "发布准备办公室",
          meta: "规划者 + 工程师 + 审查者",
          description: "预置测试、变更摘要和风险清单，覆盖发布前的检查动线。",
          glyph: "◆",
          accent: "blue",
          badge: { label: "模板", tone: "idle" },
          tags: ["测试", "风险清单"],
          action: {
            type: "office-detail",
            title: "发布准备办公室",
            subtitle: "模板 · 规划者 + 工程师 + 审查者",
            body: "",
            workspace: demoClientOfficeWorkspace(locale),
            items: [],
          },
        },
      ]
    : [
        {
          title: "Office templates",
          meta: "Spin up a collaboration scenario",
          description:
            "Preset members, default tools, and system prompts; enter group chat right away.",
          section: true,
        },
        {
          title: "PR review office",
          meta: "Engineer + reviewer",
          description:
            "Preset GitHub MCP and review skill; pulls PRs and produces review verdicts.",
          glyph: "✓",
          accent: "green",
          badge: { label: "Template", tone: "idle" },
          tags: ["GitHub", "review"],
          action: {
            type: "office-detail",
            title: "PR review office",
            subtitle: "Template · engineer + reviewer",
            body: "",
            workspace: demoClientOfficeWorkspace(locale),
            items: [],
          },
        },
        {
          title: "Competitor research office",
          meta: "Researcher + planner",
          description:
            "Preset browser MCP and doc skill; scrapes competitors into structured comparisons.",
          glyph: "◎",
          accent: "amber",
          badge: { label: "Template", tone: "idle" },
          tags: ["browser", "docs"],
          action: {
            type: "office-detail",
            title: "Competitor research office",
            subtitle: "Template · researcher + planner",
            body: "",
            workspace: demoClientOfficeWorkspace(locale),
            items: [],
          },
        },
        {
          title: "Release prep office",
          meta: "Planner + engineer + reviewer",
          description:
            "Preset tests, change summary, and risk list to cover the pre-release flow.",
          glyph: "◆",
          accent: "blue",
          badge: { label: "Template", tone: "idle" },
          tags: ["tests", "risk list"],
          action: {
            type: "office-detail",
            title: "Release prep office",
            subtitle: "Template · planner + engineer + reviewer",
            body: "",
            workspace: demoClientOfficeWorkspace(locale),
            items: [],
          },
        },
      ];
  return {
    kind: "office",
    title,
    subtitle: zh(locale)
      ? `${items.length} 个办公室`
      : `${items.length} offices`,
    body: zh(locale)
      ? "办公室不是普通对话列表，而是多智能体协作空间。进入办公室后是群聊工作区：招募智能体、共享工具、拆任务、沉淀产物。"
      : "Offices are not chat threads. They are multi-agent collaboration spaces with group chat, recruited agents, shared tools, tasks, and artifacts.",
    actions: [
      {
        id: "create-office",
        label: zh(locale) ? "新建办公室" : "New office",
        tone: "primary",
      },
    ],
    items: [...items, ...templates],
  };
}

// [LIBRARY_AUTOMATION]
function demoAutomationPanel(title: string, locale: Locale): LibraryPanel {
  const items: LibraryItem[] = zh(locale)
    ? [
        {
          title: "运行中",
          meta: "后台托管",
          description:
            "这些任务已经绑定办公室和执行智能体，会按触发条件自动运行。",
          section: true,
        },
        {
          title: "每日项目巡检",
          meta: "定时 · 每天 09:30",
          description:
            "绑定后端能力办公室，由规划者汇总仓库、测试和阻塞项，生成办公室日报。",
          glyph: "◷",
          accent: "blue",
          badge: { label: "启用", tone: "running" },
          tags: ["定时", "规划者"],
          action: {
            type: "automation-detail",
            title: "每日项目巡检",
            subtitle: "定时 · 每天 09:30",
            body: "触发器：每天 09:30\n目标办公室：后端能力办公室\n执行智能体：规划者\n动作：汇总仓库状态、测试结果和阻塞项，生成办公室日报。",
            prompt:
              "运行自动化「每日项目巡检」：汇总当前仓库状态、测试结果和阻塞项，向后端能力办公室生成日报。",
          },
        },
        {
          title: "PR / CI 监控",
          meta: "事件触发 · GitHub",
          description:
            "绑定工程师和审查者，失败后自动创建修复任务并同步到群聊。",
          glyph: "⟳",
          accent: "green",
          badge: { label: "运行中", tone: "running" },
          tags: ["事件", "GitHub", "修复任务"],
          action: {
            type: "automation-detail",
            title: "PR / CI 监控",
            subtitle: "事件触发 · GitHub",
            body: "触发器：GitHub PR / CI 事件\n目标办公室：前端交付办公室\n执行智能体：工程师 + 审查者\n动作：CI 失败后创建修复任务，并同步群聊。",
            prompt:
              "运行自动化「PR / CI 监控」：检查最近 PR 和 CI 状态，如有失败则创建修复任务并同步办公室群聊。",
          },
        },
        {
          title: "待配置",
          meta: "需要授权或人工确认",
          description: "创建后先进入草稿，补齐触发器、权限和目标办公室后启用。",
          section: true,
        },
        {
          title: "客户材料同步",
          meta: "文件触发",
          description:
            "监听需求目录变化，调用文档 Skill 建索引，并通知规划者更新任务树。",
          glyph: "▤",
          accent: "amber",
          badge: { label: "待授权", tone: "warning" },
          tags: ["文件触发", "文档 Skill"],
          action: {
            type: "automation-detail",
            title: "客户材料同步",
            subtitle: "文件触发",
            body: "触发器：需求目录文件变化\n目标办公室：甲方 Demo 办公室\n执行智能体：研究员 + 规划者\n动作：调用文档 Skill 建索引，并更新任务树。",
            prompt:
              "运行自动化「客户材料同步」：扫描需求目录变化，调用文档 Skill 建索引，并让规划者更新任务树。",
          },
        },
        {
          title: "演示报告生成",
          meta: "手动触发 · 2 小时前",
          description:
            "绑定甲方 Demo 办公室，汇总群聊、工具调用、产物和风险，生成客户摘要。",
          glyph: "▣",
          accent: "violet",
          badge: { label: "草稿", tone: "draft" },
          tags: ["手动", "甲方办公室"],
          action: {
            type: "automation-detail",
            title: "演示报告生成",
            subtitle: "手动触发",
            body: "触发器：手动\n目标办公室：甲方 Demo 办公室\n执行智能体：规划者 + 研究员\n动作：汇总群聊、工具调用、产物和风险，生成客户摘要。",
            prompt:
              "运行自动化「演示报告生成」：汇总甲方 Demo 办公室的群聊、工具调用、产物和风险，生成客户摘要。",
          },
        },
      ]
    : [
        {
          title: "Running",
          meta: "Hosted in background",
          description:
            "These jobs already bind an office and execution agents, then run on their triggers.",
          section: true,
        },
        {
          title: "Daily project check",
          meta: "Schedule · 09:30 daily",
          description:
            "Binds the backend office and planner to summarize repositories, tests, and blockers.",
          glyph: "◷",
          accent: "blue",
          badge: { label: "enabled", tone: "running" },
          tags: ["schedule", "planner"],
          action: {
            type: "automation-detail",
            title: "Daily project check",
            subtitle: "Schedule · 09:30 daily",
            body: "Trigger: 09:30 daily\nTarget office: Backend capability office\nAgent: Planner\nAction: summarize repository status, tests, and blockers into a daily office report.",
            prompt:
              'Run automation "Daily project check": summarize repository status, test results, and blockers into a daily office report.',
          },
        },
        {
          title: "PR / CI monitor",
          meta: "Event trigger · GitHub",
          description:
            "Binds engineer and reviewer roles, then creates fix tasks and posts updates to group chat.",
          glyph: "⟳",
          accent: "green",
          badge: { label: "running", tone: "running" },
          tags: ["event", "GitHub", "fix tasks"],
          action: {
            type: "automation-detail",
            title: "PR / CI monitor",
            subtitle: "Event trigger · GitHub",
            body: "Trigger: GitHub PR / CI events\nTarget office: Frontend delivery office\nAgents: Engineer + Reviewer\nAction: create fix tasks after CI failures and post updates to group chat.",
            prompt:
              'Run automation "PR / CI monitor": inspect recent PR and CI state, create fix tasks for failures, and post updates to the office chat.',
          },
        },
        {
          title: "Draft",
          meta: "Needs auth or confirmation",
          description:
            "New automations stay as drafts until trigger, permissions, and target office are configured.",
          section: true,
        },
        {
          title: "Client material sync",
          meta: "File trigger",
          description:
            "Watches requirement folders, calls document skills, and asks the planner to update tasks.",
          glyph: "▤",
          accent: "amber",
          badge: { label: "needs auth", tone: "warning" },
          tags: ["file trigger", "docs skill"],
          action: {
            type: "automation-detail",
            title: "Client material sync",
            subtitle: "File trigger",
            body: "Trigger: requirement folder changes\nTarget office: Client demo office\nAgents: Researcher + Planner\nAction: call document skills, build an index, and update the task tree.",
            prompt:
              'Run automation "Client material sync": scan requirement folder changes, call document skills, and ask the planner to update the task tree.',
          },
        },
        {
          title: "Demo report generator",
          meta: "Manual trigger · 2h ago",
          description:
            "Binds the client demo office and summarizes chat, tool calls, artifacts, and risks.",
          glyph: "▣",
          accent: "violet",
          badge: { label: "draft", tone: "draft" },
          tags: ["manual", "client office"],
          action: {
            type: "automation-detail",
            title: "Demo report generator",
            subtitle: "Manual trigger",
            body: "Trigger: manual\nTarget office: Client demo office\nAgents: Planner + Researcher\nAction: summarize chat, tool calls, artifacts, and risks into a client brief.",
            prompt:
              'Run automation "Demo report generator": summarize the client demo office chat, tool calls, artifacts, and risks into a client brief.',
          },
        },
      ];
  return {
    kind: "automation",
    title,
    subtitle: zh(locale)
      ? "4 条自动化 · 2 条运行中"
      : "4 automations · 2 running",
    body: zh(locale)
      ? "自动化把重复工作交给后台执行。它可以绑定办公室、智能体和工具，在指定时间或事件触发后自动创建任务、发消息或生成产物。"
      : "Automations move recurring work into the background. They bind offices, agents, and tools to create tasks, send messages, or generate artifacts on triggers.",
    actions: [
      {
        id: "create-automation",
        label: zh(locale) ? "新建自动化" : "New automation",
        tone: "primary",
      },
    ],
    items,
  };
}

// [LIBRARY_AGENTS]
function buildAgentMcp(
  locale: Locale,
  enabledIds: string[],
): AgentCapabilityOption[] {
  const all: Array<Omit<AgentCapabilityOption, "enabled">> = zh(locale)
    ? [
        {
          id: "github",
          name: "GitHub",
          glyph: "GH",
          accent: "slate",
          description: "拉取 PR、Issue、CI 状态",
        },
        {
          id: "browser",
          name: "浏览器",
          glyph: "◍",
          accent: "cyan",
          description: "打开页面、截图、抓取 DOM",
        },
        {
          id: "database",
          name: "数据库",
          glyph: "▤",
          accent: "amber",
          description: "只读查询业务库",
        },
        {
          id: "filesystem",
          name: "文件系统",
          glyph: "▦",
          accent: "blue",
          description: "读取与写入工作区文件",
        },
      ]
    : [
        {
          id: "github",
          name: "GitHub",
          glyph: "GH",
          accent: "slate",
          description: "Pull PRs, issues, CI status",
        },
        {
          id: "browser",
          name: "Browser",
          glyph: "◍",
          accent: "cyan",
          description: "Open pages, screenshot, scrape DOM",
        },
        {
          id: "database",
          name: "Database",
          glyph: "▤",
          accent: "amber",
          description: "Read-only business queries",
        },
        {
          id: "filesystem",
          name: "Filesystem",
          glyph: "▦",
          accent: "blue",
          description: "Read and write workspace files",
        },
      ];
  return all.map((option) => ({
    ...option,
    enabled: enabledIds.includes(option.id),
  }));
}

function buildAgentSkills(
  locale: Locale,
  enabledIds: string[],
): AgentCapabilityOption[] {
  const all: Array<Omit<AgentCapabilityOption, "enabled">> = zh(locale)
    ? [
        {
          id: "review",
          name: "代码审查",
          glyph: "✓",
          accent: "green",
          description: "bug、回归、测试缺口、交付风险",
        },
        {
          id: "screenshots",
          name: "演示截图",
          glyph: "▣",
          accent: "violet",
          description: "成套截图、讲解路径、风险说明",
        },
        {
          id: "spreadsheet",
          name: "表格分析",
          glyph: "∑",
          accent: "blue",
          description: "透视、摘要、业务结论",
        },
        {
          id: "docs",
          name: "文档检索",
          glyph: "▤",
          accent: "amber",
          description: "建索引、检索、生成摘要",
        },
      ]
    : [
        {
          id: "review",
          name: "Code review",
          glyph: "✓",
          accent: "green",
          description: "Bugs, regressions, test gaps, risk",
        },
        {
          id: "screenshots",
          name: "Demo screenshots",
          glyph: "▣",
          accent: "violet",
          description: "Screenshot sets, talk tracks, notes",
        },
        {
          id: "spreadsheet",
          name: "Spreadsheet analysis",
          glyph: "∑",
          accent: "blue",
          description: "Pivots, summaries, conclusions",
        },
        {
          id: "docs",
          name: "Doc retrieval",
          glyph: "▤",
          accent: "amber",
          description: "Index, retrieve, summarize",
        },
      ];
  return all.map((option) => ({
    ...option,
    enabled: enabledIds.includes(option.id),
  }));
}

const MODEL_OPTIONS = ["gpt-5-codex", "gpt-5", "o4-mini", "claude-opus-4.8"];
const PERMISSION_OPTIONS = (locale: Locale) =>
  zh(locale)
    ? ["只读 + 评论", "工作区可写", "完全访问"]
    : ["read + comment", "workspace-write", "full-access"];

type RoleSpec = {
  name: string;
  glyph: string;
  accent: "blue" | "violet" | "amber" | "green";
  duties: string;
  tags: string[];
  model: string;
  permission: string;
  prompt: string;
  mcp: string[];
  skills: string[];
};

function demoAgentsPanel(title: string, locale: Locale): LibraryPanel {
  const perms = PERMISSION_OPTIONS(locale);
  const roles: RoleSpec[] = zh(locale)
    ? [
        {
          name: "规划者",
          glyph: "◆",
          accent: "blue",
          duties: "把目标拆成任务、选择工具和分配智能体。",
          tags: ["任务拆解", "文件", "搜索"],
          model: "gpt-5",
          permission: perms[0],
          prompt:
            "你是办公室的规划者。把目标拆成可执行任务，明确每个任务的负责人、所需工具和验收标准。优先澄清歧义，再开始派活。保持简洁、结构化。",
          mcp: ["filesystem"],
          skills: ["docs"],
        },
        {
          name: "工程师",
          glyph: "⚙",
          accent: "violet",
          duties: "实现、运行命令、读取文件、生成变更摘要。",
          tags: ["代码", "终端", "MCP"],
          model: "gpt-5-codex",
          permission: perms[1],
          prompt:
            "你是办公室的工程师。负责实现、运行命令、读取与修改文件。改动要小步可回滚，完成后给出变更摘要和验证方式。",
          mcp: ["github", "filesystem"],
          skills: ["review"],
        },
        {
          name: "审查者",
          glyph: "✓",
          accent: "green",
          duties: "按 bug、回归、测试缺口和交付风险输出结论。",
          tags: ["风险复核", "代码审查"],
          model: "gpt-5",
          permission: perms[0],
          prompt:
            "你是办公室的审查者。从 bug、回归、测试缺口和交付风险四个维度审查，给出阻塞项和建议，不直接改代码。",
          mcp: ["github"],
          skills: ["review"],
        },
        {
          name: "研究员",
          glyph: "◎",
          accent: "amber",
          duties: "做外部资料、竞品、文档和上下文的前置调研。",
          tags: ["信息收集", "浏览器", "文档"],
          model: "o4-mini",
          permission: perms[0],
          prompt:
            "你是办公室的研究员。围绕外部资料、竞品和文档做前置调研，输出有出处的结论，标注不确定项。",
          mcp: ["browser"],
          skills: ["docs", "screenshots"],
        },
      ]
    : [
        {
          name: "Planner",
          glyph: "◆",
          accent: "blue",
          duties: "Breaks goals into tasks, picks tools, assigns agents.",
          tags: ["breakdown", "files", "search"],
          model: "gpt-5",
          permission: perms[0],
          prompt:
            "You are the office planner. Break goals into actionable tasks with owners, required tools, and acceptance criteria. Clarify ambiguity before dispatching. Keep it concise and structured.",
          mcp: ["filesystem"],
          skills: ["docs"],
        },
        {
          name: "Engineer",
          glyph: "⚙",
          accent: "violet",
          duties: "Implements, runs commands, reads files, summarizes changes.",
          tags: ["code", "terminal", "MCP"],
          model: "gpt-5-codex",
          permission: perms[1],
          prompt:
            "You are the office engineer. Implement, run commands, read and edit files. Make small reversible changes and report a summary plus how to verify.",
          mcp: ["github", "filesystem"],
          skills: ["review"],
        },
        {
          name: "Reviewer",
          glyph: "✓",
          accent: "green",
          duties: "Reviews bugs, regressions, test gaps, delivery risk.",
          tags: ["risk", "review"],
          model: "gpt-5",
          permission: perms[0],
          prompt:
            "You are the office reviewer. Review across bugs, regressions, test gaps, and delivery risk. Surface blockers and suggestions; do not edit code directly.",
          mcp: ["github"],
          skills: ["review"],
        },
        {
          name: "Researcher",
          glyph: "◎",
          accent: "amber",
          duties: "Collects references, competitor notes, docs, context.",
          tags: ["research", "browser", "docs"],
          model: "o4-mini",
          permission: perms[0],
          prompt:
            "You are the office researcher. Do upfront research on references, competitors, and docs. Output sourced conclusions and flag uncertainty.",
          mcp: ["browser"],
          skills: ["docs", "screenshots"],
        },
      ];

  const designedItems: LibraryItem[] = roles.map((role) => {
    const config: AgentConfig = {
      name: role.name,
      glyph: role.glyph,
      accent: role.accent,
      role: zh(locale) ? "智能体角色 · 可招募" : "Agent role · recruitable",
      model: role.model,
      models: MODEL_OPTIONS,
      permission: role.permission,
      permissions: perms,
      systemPrompt: role.prompt,
      mcp: buildAgentMcp(locale, role.mcp),
      skills: buildAgentSkills(locale, role.skills),
    };
    return {
      title: role.name,
      meta: zh(locale)
        ? "内置角色 · 可配置 MCP / Skill / 提示词"
        : "Built-in role · configurable MCP / skills / prompt",
      description: role.duties,
      glyph: role.glyph,
      accent: role.accent,
      badge: { label: zh(locale) ? "可招募" : "recruitable", tone: "idle" },
      tags: role.tags,
      action: { type: "agent-config", config },
    };
  });

  return {
    kind: "agents",
    title,
    subtitle: zh(locale)
      ? `${designedItems.length} 个设计角色`
      : `${designedItems.length} designed roles`,
    body: zh(locale)
      ? "智能体是可招募的执行角色。点开任意角色即可配置它的模型、权限、MCP 连接器、Skill 和系统提示词。"
      : "Agents are recruitable execution roles. Open any role to configure its model, permissions, MCP connectors, skills, and system prompt.",
    actions: [
      {
        id: "create-agent",
        label: zh(locale) ? "新建智能体" : "New agent",
        tone: "primary",
      },
    ],
    items: [
      {
        title: zh(locale) ? "内置角色" : "Built-in roles",
        meta: zh(locale) ? "可直接招募进办公室" : "Ready to recruit",
        description: zh(locale)
          ? "点开角色配置 MCP、Skill 和系统提示词，再招募进办公室。"
          : "Open a role to configure MCP, skills, and the system prompt, then recruit it.",
        section: true,
      },
      ...designedItems,
    ],
  };
}

// [LIBRARY_PLUGINS]
function demoPluginsPanel(title: string, locale: Locale): LibraryPanel {
  const pluginDetail = (name: string, summary: string) =>
    zh(locale)
      ? `插件：${name}\n来源：Crewon 市场\n状态：已安装 · 已启用\n\n${summary}\n\n包含：1 个 MCP 连接器 + 2 个 Skill\n权限：按需授权，安装后可分配给办公室。`
      : `Plugin: ${name}\nSource: Crewon marketplace\nStatus: installed · enabled\n\n${summary}\n\nIncludes: 1 MCP connector + 2 skills\nPermissions: granted on demand, assignable to offices after install.`;
  const entries: Array<{
    name: string;
    glyph: string;
    accent: "slate" | "cyan" | "amber";
    installed: boolean;
    keywords: string;
    summary: string;
  }> = zh(locale)
    ? [
        {
          name: "GitHub 工作流",
          glyph: "GH",
          accent: "slate",
          installed: true,
          keywords: "review, ci, pull-request",
          summary: "把 PR、Issue、CI 状态接入办公室，支持审查与修复闭环。",
        },
        {
          name: "浏览器自动化",
          glyph: "◍",
          accent: "cyan",
          installed: true,
          keywords: "browser, scrape, screenshot",
          summary: "提供网页打开、截图和抓取能力，研究员常用。",
        },
        {
          name: "文档助手",
          glyph: "▤",
          accent: "amber",
          installed: false,
          keywords: "docs, index, search",
          summary: "对文档目录建索引，支持检索和摘要，安装后可启用。",
        },
      ]
    : [
        {
          name: "GitHub workflow",
          glyph: "GH",
          accent: "slate",
          installed: true,
          keywords: "review, ci, pull-request",
          summary:
            "Brings PRs, issues, and CI into offices for a review-and-fix loop.",
        },
        {
          name: "Browser automation",
          glyph: "◍",
          accent: "cyan",
          installed: true,
          keywords: "browser, scrape, screenshot",
          summary:
            "Adds page open, screenshot, and scrape used by researchers.",
        },
        {
          name: "Docs assistant",
          glyph: "▤",
          accent: "amber",
          installed: false,
          keywords: "docs, index, search",
          summary:
            "Indexes doc folders for search and summary; enable after install.",
        },
      ];
  const items: LibraryItem[] = entries.map((entry) => ({
    title: entry.name,
    meta: zh(locale) ? "Crewon 市场" : "Crewon marketplace",
    description: entry.summary,
    glyph: entry.glyph,
    accent: entry.accent,
    badge: entry.installed
      ? { label: zh(locale) ? "已安装" : "installed", tone: "running" }
      : { label: zh(locale) ? "未安装" : "not installed", tone: "idle" },
    tags: entry.keywords.split(", "),
    action: {
      type: "mcp-detail",
      title: entry.name,
      subtitle: zh(locale) ? "插件详情" : "Plugin details",
      body: pluginDetail(entry.name, entry.summary),
    },
  }));
  return {
    kind: "plugins",
    title,
    subtitle: zh(locale) ? `${items.length} 个插件` : `${items.length} plugins`,
    body: zh(locale)
      ? "插件把 MCP 连接器和 Skill 打包成可安装的能力包。安装后即可分配给智能体和办公室。"
      : "Plugins bundle MCP connectors and skills into installable capability packs that can be assigned to agents and offices.",
    actions: [
      {
        id: "install-plugin",
        label: zh(locale) ? "浏览市场" : "Browse marketplace",
        tone: "primary",
      },
    ],
    items,
  };
}

// [SETTINGS]
/**
 * Demo copy for the model access page.
 *
 * The live panel is built from config, so the demo has to restate the same
 * caveats (Responses-only, cleartext key) rather than let the reader assume
 * they only apply once connected.
 */
function demoModelProvidersSettingsPanel(locale: Locale): CapabilityPanel {
  return {
    title: zh(locale) ? "模型接入" : "Model access",
    subtitle: zh(locale) ? "演示模式" : "Demo mode",
    body: zh(locale)
      ? "已配置的模型服务\n- 我的模型网关 (my-gateway) · https://api.example.com/v1 · 已保存密钥 · 当前使用\n- 本地模型 (local-llm) · http://127.0.0.1:11434/v1 · 无需密钥\n\n说明\n- 只支持 Responses 兼容接口，不支持 Chat Completions 格式的服务。\n- 直接填写的 API Key 会以明文保存在本机 ~/.crewon/config.toml（权限 600）。\n- 连接本地 app-server 后，这里可以新增、编辑、删除并测试模型服务。"
      : "Configured model services\n- My model gateway (my-gateway) · https://api.example.com/v1 · key stored · in use\n- Local model (local-llm) · http://127.0.0.1:11434/v1 · no credential\n\nNotes\n- Responses-compatible APIs only; Chat Completions endpoints are not supported.\n- An API key entered here is stored in cleartext in ~/.crewon/config.toml on this machine (mode 600).\n- Connect the local app-server to add, edit, delete, and test model services here.",
    actions: [
      {
        id: "refresh-model-providers",
        label: zh(locale) ? "刷新" : "Refresh",
      },
    ],
  };
}

export function demoSettingsPanel(
  section: SettingsSection,
  locale: Locale,
): CapabilityPanel {
  if (section === "config") {
    return {
      title: zh(locale) ? "配置" : "Config",
      subtitle: "/Users/me/work/crewon",
      body: zh(locale)
        ? "模型：gpt-5-codex（默认）\n推理强度：medium\n审批策略：on-request\n沙箱：workspace-write\n网络：受控放行\n\n工作区覆盖：\n- 测试命令：just test\n- 格式化：just fmt\n\n配置来源：~/.crewon/config.toml + 项目 .crewon/"
        : "Model: gpt-5-codex (default)\nReasoning: medium\nApproval policy: on-request\nSandbox: workspace-write\nNetwork: controlled allow\n\nWorkspace overrides:\n- test: just test\n- format: just fmt\n\nSources: ~/.crewon/config.toml + project .crewon/",
      fields: [
        {
          id: "config-model",
          label: zh(locale) ? "默认模型" : "Default model",
          placeholder: "gpt-5-codex",
          value: "gpt-5-codex",
        },
        {
          id: "config-approval-policy",
          label: zh(locale) ? "审批策略" : "Approval policy",
          placeholder: "on-request",
          value: "on-request",
        },
        {
          id: "config-sandbox-mode",
          label: zh(locale) ? "沙箱模式" : "Sandbox mode",
          placeholder: "workspace-write",
          value: "workspace-write",
        },
      ],
      actions: [
        {
          id: "save-config",
          label: zh(locale) ? "保存配置" : "Save config",
          tone: "primary",
        },
        {
          id: "refresh-config",
          label: zh(locale) ? "刷新配置" : "Refresh config",
        },
      ],
    };
  }
  if (section === "appearance") {
    return {
      title: zh(locale) ? "外观" : "Appearance",
      subtitle: "/Users/me/work/crewon",
      body: zh(locale)
        ? "外观\n语言: zh\n主题: dark\n配置层: 2\n外观设置会写入桌面端配置，并立即应用到当前界面。"
        : "Appearance\nLanguage: en\nTheme: dark\nConfig layers: 2\nAppearance settings are written to desktop config and applied immediately.",
      fields: [
        {
          id: "appearance-locale",
          label: zh(locale) ? "语言" : "Language",
          value: zh(locale) ? "zh" : "en",
          options: [
            { label: "中文", value: "zh" },
            { label: "English", value: "en" },
          ],
        },
        {
          id: "appearance-theme",
          label: zh(locale) ? "主题" : "Theme",
          value: "dark",
          options: [
            { label: zh(locale) ? "深色" : "Dark", value: "dark" },
            { label: zh(locale) ? "浅色" : "Light", value: "light" },
          ],
        },
      ],
      actions: [
        {
          id: "save-appearance",
          label: zh(locale) ? "保存外观" : "Save appearance",
          tone: "primary",
        },
        {
          id: "refresh-appearance",
          label: zh(locale) ? "刷新外观" : "Refresh appearance",
        },
      ],
    };
  }
  if (section === "personalization") {
    return {
      title: zh(locale) ? "助理人格与记忆" : "Assistant profile & memory",
      subtitle: "/Users/me/work/crewon",
      body: zh(locale)
        ? "助理人格与记忆\n角色定位: 已配置\n灵魂与原则: 已配置\n长期记忆: 生成并使用（推荐）\n配置层: 2\n保存后由 app-server 热重载。角色和灵魂影响新会话；长期记忆会在对话空闲后异步沉淀，并按相关性有限检索。"
        : "Assistant profile & memory\nRole: configured\nSoul & principles: configured\nLong-term memory: Learn and use (recommended)\nConfig layers: 2\nThe app-server hot-reloads these settings. Role and soul affect new sessions; long-term memory is consolidated asynchronously after conversations become idle and retrieved with bounded relevance.",
      fields: [
        {
          id: "personalization-instructions",
          label: zh(locale) ? "角色定位" : "Role",
          description: zh(locale)
            ? "定义助理是谁、负责什么、以什么视角工作。保存为系统指令。"
            : "Define who the assistant is, what it owns, and the perspective it works from. Saved as system instructions.",
          multiline: true,
          rows: 6,
          value: zh(locale)
            ? "你是我的产品与工程助理，负责把模糊想法推进为可验证的交付。"
            : "You are my product and engineering assistant, turning ambiguous ideas into verified deliverables.",
        },
        {
          id: "personalization-developer-instructions",
          label: zh(locale) ? "灵魂与原则" : "Soul & principles",
          description: zh(locale)
            ? "定义价值取向、表达方式、边界和长期行为原则。保存为开发者指令。"
            : "Define values, voice, boundaries, and durable behavior principles. Saved as developer instructions.",
          multiline: true,
          rows: 7,
          value: zh(locale)
            ? "诚实标注未验证边界；主动推进，但不越过权限；优先使用真实证据。"
            : "Mark unverified boundaries honestly, move work forward without crossing authority, and prefer real evidence.",
        },
        {
          id: "personalization-memory-mode",
          label: zh(locale) ? "长期记忆" : "Long-term memory",
          description: zh(locale)
            ? "控制是否从对话形成长期记忆，以及是否在新任务中检索已有记忆。"
            : "Control whether conversations form long-term memories and whether existing memories are retrieved in new tasks.",
          value: "on",
          options: zh(locale)
            ? [
                { label: "生成并使用（推荐）", value: "on" },
                { label: "仅使用已有记忆", value: "read-only" },
                { label: "仅沉淀，不主动引用", value: "learn-only" },
                { label: "关闭长期记忆", value: "off" },
              ]
            : [
                { label: "Learn and use (recommended)", value: "on" },
                { label: "Use existing memories only", value: "read-only" },
                { label: "Learn without retrieval", value: "learn-only" },
                { label: "Turn off long-term memory", value: "off" },
              ],
        },
      ],
      actions: [
        {
          id: "save-personalization",
          label: zh(locale) ? "保存助理设置" : "Save assistant settings",
          tone: "primary",
        },
        {
          id: "refresh-personalization",
          label: zh(locale) ? "刷新助理设置" : "Refresh assistant settings",
        },
      ],
    };
  }
  if (section === "keyboard") {
    return {
      title: zh(locale) ? "键盘快捷键" : "Keyboard shortcuts",
      subtitle: "/Users/me/work/crewon",
      body: zh(locale)
        ? "键盘快捷键\n- 新对话: ⌘N / Ctrl N\n- 搜索: ⌘K / Ctrl K\n- 发送: ⌘ Enter / Ctrl Enter\n- 审查: ⌃⇧G\n- 浏览器: ⌘T\n- 文件: ⌘P\n- 侧边聊天: ⌥⌘S\n配置层: 2\n当前 app-server 协议尚未暴露快捷键写入 API；此页读取配置状态并展示当前桌面端绑定。"
        : "Keyboard shortcuts\n- New chat: ⌘N / Ctrl N\n- Search: ⌘K / Ctrl K\n- Send: ⌘ Enter / Ctrl Enter\n- Review: ⌃⇧G\n- Browser: ⌘T\n- Files: ⌘P\n- Side chat: ⌥⌘S\nConfig layers: 2\nThe current app-server protocol does not expose shortcut-write APIs yet. This page reads config state and shows the active desktop bindings.",
      actions: [
        {
          id: "refresh-keyboard",
          label: zh(locale) ? "刷新快捷键" : "Refresh shortcuts",
        },
      ],
    };
  }
  if (section === "hooks") {
    return {
      title: zh(locale) ? "钩子" : "Hooks",
      subtitle: zh(locale)
        ? "2 Hook · 0 警告 · 0 错误"
        : "2 hooks · 0 warnings · 0 errors",
      body: zh(locale)
        ? "Hook 总数: 2 · 启用: 1 · 托管: 1\n\n- userPromptSubmit · command · 启用\n  matcher: *\n  command: pnpm lint\n  source: project\n  path: /Users/me/work/crewon/.crewon/hooks.toml\n\n- postToolUse · agent · 停用\n  matcher: fs.writeFile\n  status: 更新知识索引\n  source: plugin:knowledge-sync\n  path: /Users/me/.crewon/plugins/knowledge-sync/plugin.json"
        : "Hooks: 2 · enabled: 1 · managed: 1\n\n- userPromptSubmit · command · enabled\n  matcher: *\n  command: pnpm lint\n  source: project\n  path: /Users/me/work/crewon/.crewon/hooks.toml\n\n- postToolUse · agent · disabled\n  matcher: fs.writeFile\n  status: update knowledge index\n  source: plugin:knowledge-sync\n  path: /Users/me/.crewon/plugins/knowledge-sync/plugin.json",
      actions: [
        {
          id: "refresh-hooks",
          label: zh(locale) ? "刷新 Hook" : "Refresh hooks",
        },
      ],
    };
  }
  if (section === "model-providers") {
    return demoModelProvidersSettingsPanel(locale);
  }
  if (section === "mcp-servers") {
    return {
      title: zh(locale) ? "MCP 服务器" : "MCP servers",
      subtitle: zh(locale)
        ? "3 服务器 · 18 工具 · 6 资源"
        : "3 servers · 18 tools · 6 resources",
      body: zh(locale)
        ? "MCP 服务器: 3 · 工具: 18 · 资源: 6\n认证状态: oauth: 1 · bearerToken: 1 · unsupported: 1\n\n- GitHub\n  name: github\n  auth: oauth\n  version: 1.2.0\n  tools: 8 · search_issues, create_pr, read_file\n  resources: 2\n\n- Browser\n  name: browser\n  auth: bearerToken\n  tools: 6 · open, click, screenshot\n  resources: 1\n\n- Filesystem\n  name: filesystem\n  auth: unsupported\n  tools: 4 · read_file, write_file, list_directory\n  resources: 3"
        : "MCP servers: 3 · tools: 18 · resources: 6\nAuth status: oauth: 1 · bearerToken: 1 · unsupported: 1\n\n- GitHub\n  name: github\n  auth: oauth\n  version: 1.2.0\n  tools: 8 · search_issues, create_pr, read_file\n  resources: 2\n\n- Browser\n  name: browser\n  auth: bearerToken\n  tools: 6 · open, click, screenshot\n  resources: 1\n\n- Filesystem\n  name: filesystem\n  auth: unsupported\n  tools: 4 · read_file, write_file, list_directory\n  resources: 3",
      actions: [
        {
          id: "refresh-mcp-settings",
          label: zh(locale) ? "刷新 MCP" : "Refresh MCP",
        },
        {
          id: "reload-tools",
          label: zh(locale) ? "重载 MCP 配置" : "Reload MCP config",
        },
      ],
    };
  }
  if (section === "browser") {
    return {
      title: zh(locale) ? "浏览器" : "Browser",
      subtitle: zh(locale)
        ? "4 应用 · 3 启用 · 3 可访问"
        : "4 apps · 3 enabled · 3 accessible",
      body: zh(locale)
        ? "应用: 4 · 启用: 3 · 可访问: 3\n插件来源: Browser, GitHub, Docs\n\n- GitHub · 可访问 · 启用\n  id: github\n  description: 访问仓库、Issue 和 PR\n  plugins: GitHub\n  install: https://github.com/apps/crewon\n\n- 浏览器 · 可访问 · 启用\n  id: browser\n  description: 打开网页、截图和点击页面\n  plugins: Browser\n\n- 文档 · 可访问 · 启用\n  id: docs\n  description: 读取和生成文档材料\n  plugins: Docs\n\n- 数据库 · 需授权 · 停用\n  id: database\n  description: 查询客户业务数据\n  plugins: Data"
        : "Apps: 4 · enabled: 3 · accessible: 3\nPlugin sources: Browser, GitHub, Docs\n\n- GitHub · accessible · enabled\n  id: github\n  description: Access repos, issues, and pull requests\n  plugins: GitHub\n  install: https://github.com/apps/crewon\n\n- Browser · accessible · enabled\n  id: browser\n  description: Open pages, capture screenshots, and click UI\n  plugins: Browser\n\n- Docs · accessible · enabled\n  id: docs\n  description: Read and generate document materials\n  plugins: Docs\n\n- Database · needs auth · disabled\n  id: database\n  description: Query client business data\n  plugins: Data",
      actions: [
        {
          id: "refresh-browser-apps",
          label: zh(locale) ? "刷新应用" : "Refresh apps",
        },
      ],
    };
  }
  if (section === "environment") {
    return {
      title: zh(locale) ? "环境" : "Environment",
      subtitle: "/Users/me/work/crewon",
      body: zh(locale)
        ? "运行环境\n沙箱模式: read-only, workspace-write, danger-full-access\nWindows 沙箱实现: elevated, unelevated\nWindows 沙箱状态: ready\n锁屏电脑控制: no\n网页搜索模式: disabled, enabled\n数据驻留: none\n特性要求: appshots, browser"
        : "Runtime environment\nSandbox modes: read-only, workspace-write, danger-full-access\nWindows sandbox implementations: elevated, unelevated\nWindows sandbox status: ready\nLocked computer use: no\nWeb search modes: disabled, enabled\nResidency: none\nFeature requirements: appshots, browser",
      actions: [
        {
          id: "refresh-environment",
          label: zh(locale) ? "刷新环境" : "Refresh environment",
        },
        {
          id: "setup-windows-sandbox-unelevated",
          label: zh(locale)
            ? "配置 Windows 沙箱：unelevated"
            : "Set up Windows sandbox: unelevated",
        },
      ],
    };
  }
  if (section === "computer-control") {
    return {
      title: zh(locale) ? "电脑操控" : "Computer control",
      subtitle: zh(locale) ? "connected · 2 设备" : "connected · 2 clients",
      body: zh(locale)
        ? "电脑操控\n状态: connected\n服务: remote.crewon.ai\n安装 ID: demo-installation\n环境 ID: demo-environment\n已配对设备: 2\n\n- MacBook Pro\n  clientId: client-macbook\n  type: desktop\n  platform: macOS\n  os: 15.2\n  app: 0.1.0\n  lastSeen: 刚刚\n\n- Windows Workstation\n  clientId: client-windows\n  type: desktop\n  platform: Windows\n  os: 11\n  app: 0.1.0\n  lastSeen: 5 分钟前"
        : "Computer control\nStatus: connected\nServer: remote.crewon.ai\nInstallation ID: demo-installation\nEnvironment ID: demo-environment\nPaired clients: 2\n\n- MacBook Pro\n  clientId: client-macbook\n  type: desktop\n  platform: macOS\n  os: 15.2\n  app: 0.1.0\n  lastSeen: just now\n\n- Windows Workstation\n  clientId: client-windows\n  type: desktop\n  platform: Windows\n  os: 11\n  app: 0.1.0\n  lastSeen: 5m ago",
      fields: [
        {
          id: "remote-control-revoke-client",
          label: zh(locale) ? "撤销设备 ID" : "Client ID to revoke",
          value: "client-windows",
        },
      ],
      actions: [
        {
          id: "refresh-computer-control",
          label: zh(locale) ? "刷新电脑操控" : "Refresh computer control",
        },
        {
          id: "disable-remote-control",
          label: zh(locale) ? "停用远程控制" : "Disable remote control",
          tone: "danger",
        },
        {
          id: "start-remote-pairing",
          label: zh(locale) ? "开始配对" : "Start pairing",
        },
        {
          id: "revoke-remote-client",
          label: zh(locale) ? "撤销设备" : "Revoke client",
          tone: "danger",
        },
      ],
    };
  }
  if (section === "app-snapshots") {
    return {
      title: zh(locale) ? "应用快照" : "App snapshots",
      subtitle: zh(locale) ? "策略允许" : "Policy allowed",
      body: zh(locale)
        ? "应用快照\n状态: 允许\n用途: 为应用、浏览器和电脑操控能力提供可审计的状态快照。\n数据驻留: none\n相关特性要求: appshots, browser\n仅托管 Hook: no"
        : "App snapshots\nStatus: allowed\nPurpose: Provide auditable state snapshots for apps, browser, and computer-control capabilities.\nResidency: none\nRelated feature requirements: appshots, browser\nManaged hooks only: no",
      actions: [
        {
          id: "refresh-app-snapshots",
          label: zh(locale) ? "刷新应用快照" : "Refresh app snapshots",
        },
      ],
    };
  }
  if (section === "connections") {
    return {
      title: zh(locale) ? "连接" : "Connections",
      subtitle: zh(locale)
        ? "4 应用 · 3 市场 · chatgpt"
        : "4 apps · 3 marketplaces · chatgpt",
      body: zh(locale)
        ? "连接状态\n账号: demo@crewon.ai\nPlus\n认证方式: chatgpt\n需要 OpenAI 授权: no\n模型供应商能力\n- namespaceTools: yes\n- imageGeneration: yes\n- webSearch: yes\n插件市场: 3 · 插件: 12\n市场: Official, Team, Local\n应用连接器: 4 · 启用: 3 · 可访问: 3\n应用: GitHub (可访问), Browser (可访问), Docs (可访问), Database (需授权)\n网页搜索策略: enabled\n数据驻留: none"
        : "Connection status\nAccount: demo@crewon.ai\nPlus\nAuth method: chatgpt\nRequires OpenAI auth: no\nProvider capabilities\n- namespaceTools: yes\n- imageGeneration: yes\n- webSearch: yes\nPlugin marketplaces: 3 · plugins: 12\nMarketplaces: Official, Team, Local\nApp connectors: 4 · enabled: 3 · accessible: 3\nApps: GitHub (accessible), Browser (accessible), Docs (accessible), Database (needs auth)\nWeb search policy: enabled\nResidency: none",
      actions: [
        {
          id: "refresh-connections",
          label: zh(locale) ? "刷新连接" : "Refresh connections",
        },
      ],
    };
  }
  if (section === "git") {
    return {
      title: "Git",
      subtitle: "/Users/me/work/crewon · +128 -34",
      body: zh(locale)
        ? "Git 工作区\n路径: /Users/me/work/crewon\n分支: demo/cards\nSHA: abc1234\n远端: git@github.com:team/crewon.git\n远端差异: 6 files · +128 -34\n审批策略: on-request\n沙箱: workspace-write\n配置层: 2"
        : "Git workspace\nPath: /Users/me/work/crewon\nBranch: demo/cards\nSHA: abc1234\nRemote: git@github.com:team/crewon.git\nRemote diff: 6 files · +128 -34\nApproval policy: on-request\nSandbox: workspace-write\nConfig layers: 2",
      actions: [
        {
          id: "refresh-git",
          label: zh(locale) ? "刷新 Git" : "Refresh Git",
        },
      ],
    };
  }
  if (section === "worktrees") {
    return {
      title: zh(locale) ? "工作树" : "Worktrees",
      subtitle: zh(locale)
        ? "3 个会话 · /Users/me/work/crewon"
        : "3 sessions · /Users/me/work/crewon",
      body: zh(locale)
        ? "工作树\n工作区路径: /Users/me/work/crewon\n当前会话: 开发跨平台前端\n会话 ID: demo-1\n来源: app_server\n分支: demo/cards\nSHA: abc1234\n远端差异: 6 files · +128 -34\n同工作区会话: 3\n- 开发跨平台前端 · running\n- 设置页与后端能力联通 · idle · 分叉\n- 客户演示截图整理 · complete\n\n新建会话会在当前工作区打开独立对话；分叉会话会保留当前上下文，适合并行验证不同方案。"
        : "Worktrees\nWorkspace: /Users/me/work/crewon\nCurrent session: Cross-platform frontend\nThread ID: demo-1\nSource: app_server\nBranch: demo/cards\nSHA: abc1234\nRemote diff: 6 files · +128 -34\nSessions in workspace: 3\n- Cross-platform frontend · running\n- Settings and backend integration · idle · fork\n- Client demo screenshot prep · complete\n\nNew sessions open an independent conversation in this workspace. Forked sessions keep the current context for parallel exploration.",
      actions: [
        {
          id: "create-worktree-session",
          label: zh(locale) ? "新建会话" : "New session",
          tone: "primary",
        },
        {
          id: "fork-worktree",
          label: zh(locale) ? "分叉当前会话" : "Fork current session",
        },
        {
          id: "refresh-worktrees",
          label: zh(locale) ? "刷新工作树" : "Refresh worktrees",
        },
      ],
    };
  }
  return {
    title: zh(locale) ? "账号" : "Account",
    subtitle: zh(locale)
      ? "认证、模型、权限与用量"
      : "Auth, models, permissions, and usage",
    body: zh(locale)
      ? "账号：demo@crewon.ai\n套餐：Plus\n认证：模型账号登录（演示）\n\n可用模型：gpt-5-codex · gpt-5 · claude-opus-4.8 · qwen-max · glm-4.6\n权限档案：workspace-write（默认）· read-only · full-access\n\n本月用量：86.4K / 200K tokens\n速率：充足"
      : "Account: demo@crewon.ai\nPlan: Plus\nAuth: model account login (demo)\n\nModels: gpt-5-codex · gpt-5 · claude-opus-4.8 · qwen-max · glm-4.6\nPermission profiles: workspace-write (default) · read-only · full-access\n\nUsage this month: 86.4K / 200K tokens\nRate: healthy",
    actions: [
      {
        id: "login-chatgpt",
        label: zh(locale) ? "模型账号登录" : "Model login",
        tone: "primary",
      },
      { id: "refresh-account", label: zh(locale) ? "刷新" : "Refresh" },
    ],
  };
}

// [CAPABILITY]
export function demoCapabilityPanel(
  tool: "review" | "terminal" | "files" | "web" | "sidechat",
  locale: Locale,
): CapabilityPanel {
  if (tool === "terminal") {
    return {
      title: zh(locale) ? "终端" : "Terminal",
      subtitle: "/Users/me/work/crewon · exit 0",
      commandInput: true,
      body: "$ just test -p crewon-app-server\n   Compiling crewon-app-server v0.1.0\n    Finished test profile\n     Running 42 tests\ntest result: ok. 42 passed; 0 failed",
    };
  }
  if (tool === "files") {
    return {
      title: zh(locale) ? "文件" : "Files",
      subtitle: "/Users/me/work/crewon",
      body: zh(locale)
        ? "目录 · 6 项 · 更新于 2 分钟前"
        : "directory · 6 items · updated 2m ago",
      items: [
        {
          label: "> apps",
          path: "/Users/me/work/crewon/apps",
          kind: "directory",
        },
        {
          label: "> rust-backend",
          path: "/Users/me/work/crewon/backend",
          kind: "directory",
        },
        {
          label: "  AGENTS.md",
          path: "/Users/me/work/crewon/AGENTS.md",
          kind: "file",
        },
        {
          label: "  README.md",
          path: "/Users/me/work/crewon/README.md",
          kind: "file",
        },
      ],
    };
  }
  if (tool === "web") {
    return {
      title: zh(locale) ? "浏览器" : "Browser",
      subtitle: zh(locale) ? "3 应用 · 2 Hook" : "3 apps · 2 hooks",
      items: [
        {
          label: zh(locale)
            ? "应用 · GitHub · 可访问 · 已启用"
            : "App · GitHub · accessible · enabled",
        },
        {
          label: zh(locale)
            ? "应用 · 浏览器 · 可访问 · 已启用"
            : "App · Browser · accessible · enabled",
        },
        {
          label: zh(locale)
            ? "应用 · 数据库 · 需连接 · 已停用"
            : "App · Database · needs auth · disabled",
        },
        {
          label: zh(locale)
            ? "Hook · on_turn_complete · notify · 启用"
            : "Hook · on_turn_complete · notify · enabled",
        },
      ],
    };
  }
  if (tool === "sidechat") {
    return {
      title: zh(locale) ? "侧边聊天" : "Side chat",
      subtitle: zh(locale) ? "分叉自当前会话" : "Forked from current session",
      body: zh(locale)
        ? "已创建分叉会话（演示）。\n\n侧边聊天复制当前上下文，可在不打断主线的情况下探索另一种方案，结论可合并回主会话。"
        : "Forked side chat created (demo).\n\nA side chat copies the current context so you can explore an alternative without interrupting the main thread, then merge findings back.",
    };
  }
  return {
    title: zh(locale) ? "审查" : "Review",
    subtitle: zh(locale) ? "代码审查 · demo-1" : "Code review · demo-1",
    body: zh(locale)
      ? "审查结论（演示）\n\n范围：6 个文件 · +128 / -34\n\n- 阻塞：无\n- 风险：库页面与设置依赖连接态，演示模式下需补全 fallback（本次已处理）\n- 建议：为空态补充引导文案\n- 测试：建议补一条三端布局快照\n\n结论：可作为 demo 交付。"
      : "Review result (demo)\n\nScope: 6 files · +128 / -34\n\n- Blocking: none\n- Risk: library/settings depend on connection; demo needs fallbacks (handled here)\n- Suggestion: add guidance copy for empty states\n- Tests: add a cross-platform layout snapshot\n\nVerdict: ready for demo.",
  };
}

// [ACTIVITY]
function demoActivityData(locale: Locale): ActivityData {
  const trace = zh(locale)
    ? [
        {
          time: "10:02",
          actor: "规划者",
          glyph: "◆",
          accent: "blue" as const,
          action: "拆解目标",
          detail: "把「甲方 demo」拆成 6 个任务并分配",
          tokens: 1240,
          status: "done" as const,
        },
        {
          time: "10:05",
          actor: "工程师",
          glyph: "⚙",
          accent: "violet" as const,
          action: "调用 文件系统 MCP",
          detail: "读取 apps/crewon-ui/src 共 42 个文件",
          tokens: 3180,
          status: "done" as const,
        },
        {
          time: "10:09",
          actor: "工程师",
          glyph: "⚙",
          accent: "violet" as const,
          action: "运行命令",
          detail: "just test -p crewon-app-server · exit 0",
          tokens: 880,
          status: "done" as const,
        },
        {
          time: "10:12",
          actor: "审查者",
          glyph: "✓",
          accent: "green" as const,
          action: "调用 GitHub MCP",
          detail: "拉取 PR #128 diff，复核 6 个文件",
          tokens: 2050,
          status: "running" as const,
        },
        {
          time: "10:13",
          actor: "工程师",
          glyph: "⚙",
          accent: "violet" as const,
          action: "请求写入",
          detail: "写入 styles/app.css，等待审批",
          status: "waiting" as const,
        },
      ]
    : [
        {
          time: "10:02",
          actor: "Planner",
          glyph: "◆",
          accent: "blue" as const,
          action: "Break down goal",
          detail: "Split the client demo into 6 tasks and assigned",
          tokens: 1240,
          status: "done" as const,
        },
        {
          time: "10:05",
          actor: "Engineer",
          glyph: "⚙",
          accent: "violet" as const,
          action: "Call Filesystem MCP",
          detail: "Read 42 files under apps/crewon-ui/src",
          tokens: 3180,
          status: "done" as const,
        },
        {
          time: "10:09",
          actor: "Engineer",
          glyph: "⚙",
          accent: "violet" as const,
          action: "Run command",
          detail: "just test -p crewon-app-server · exit 0",
          tokens: 880,
          status: "done" as const,
        },
        {
          time: "10:12",
          actor: "Reviewer",
          glyph: "✓",
          accent: "green" as const,
          action: "Call GitHub MCP",
          detail: "Fetch PR #128 diff, reviewing 6 files",
          tokens: 2050,
          status: "running" as const,
        },
        {
          time: "10:13",
          actor: "Engineer",
          glyph: "⚙",
          accent: "violet" as const,
          action: "Request write",
          detail: "Write styles/app.css, awaiting approval",
          status: "waiting" as const,
        },
      ];
  const approvals: ApprovalRequest[] = zh(locale)
    ? [
        {
          id: "apr-1",
          actor: "工程师",
          glyph: "⚙",
          accent: "violet",
          action: "写入文件",
          detail: "styles/app.css（+86 / -12）",
          risk: "medium",
          time: "10:13",
        },
        {
          id: "apr-2",
          actor: "研究员",
          glyph: "◎",
          accent: "amber",
          action: "外部网络请求",
          detail: "GET https://competitor.example/pricing",
          risk: "high",
          time: "10:14",
        },
        {
          id: "apr-3",
          actor: "工程师",
          glyph: "⚙",
          accent: "violet",
          action: "运行命令",
          detail: "git push origin demo/cards",
          risk: "high",
          time: "10:15",
        },
      ]
    : [
        {
          id: "apr-1",
          actor: "Engineer",
          glyph: "⚙",
          accent: "violet",
          action: "Write file",
          detail: "styles/app.css (+86 / -12)",
          risk: "medium",
          time: "10:13",
        },
        {
          id: "apr-2",
          actor: "Researcher",
          glyph: "◎",
          accent: "amber",
          action: "External request",
          detail: "GET https://competitor.example/pricing",
          risk: "high",
          time: "10:14",
        },
        {
          id: "apr-3",
          actor: "Engineer",
          glyph: "⚙",
          accent: "violet",
          action: "Run command",
          detail: "git push origin demo/cards",
          risk: "high",
          time: "10:15",
        },
      ];
  const budget = zh(locale)
    ? [
        {
          name: "甲方 Demo 办公室",
          glyph: "⌗",
          accent: "blue" as const,
          usedTokens: 86400,
          budgetTokens: 200000,
          costUsd: 1.73,
        },
        {
          name: "工程师",
          glyph: "⚙",
          accent: "violet" as const,
          usedTokens: 41200,
          budgetTokens: 80000,
          costUsd: 0.82,
        },
        {
          name: "审查者",
          glyph: "✓",
          accent: "green" as const,
          usedTokens: 18600,
          budgetTokens: 60000,
          costUsd: 0.37,
        },
        {
          name: "研究员",
          glyph: "◎",
          accent: "amber" as const,
          usedTokens: 9800,
          budgetTokens: 40000,
          costUsd: 0.2,
        },
      ]
    : [
        {
          name: "Client demo office",
          glyph: "⌗",
          accent: "blue" as const,
          usedTokens: 86400,
          budgetTokens: 200000,
          costUsd: 1.73,
        },
        {
          name: "Engineer",
          glyph: "⚙",
          accent: "violet" as const,
          usedTokens: 41200,
          budgetTokens: 80000,
          costUsd: 0.82,
        },
        {
          name: "Reviewer",
          glyph: "✓",
          accent: "green" as const,
          usedTokens: 18600,
          budgetTokens: 60000,
          costUsd: 0.37,
        },
        {
          name: "Researcher",
          glyph: "◎",
          accent: "amber" as const,
          usedTokens: 9800,
          budgetTokens: 40000,
          costUsd: 0.2,
        },
      ];
  const runs = zh(locale)
    ? [
        {
          id: "office-run-demo-1",
          title: "整理甲方 demo 交付状态",
          status: "running" as const,
          threadId: "thread-demo-office",
          turnId: "turn-demo-office-1",
          createdAt: "10:12",
          updatedAt: "10:14",
          goal: "把办公室小队执行做成可恢复、可审计的真实工作台。",
          promptPreview: "汇总当前任务、审批和产物，给出下一步。",
          plan: [
            { step: "索引办公室执行记录", status: "completed" as const },
            {
              step: "接入取消、重试和结构化 reducer",
              status: "inProgress" as const,
            },
            { step: "补 ActivityBoard 快照测试", status: "pending" as const },
          ],
          delegations: [
            {
              member: "Reviewer",
              agentId: "agent-reviewer",
              task: "审查 reducer 和状态机边界",
              status: "running",
            },
          ],
        },
      ]
    : [
        {
          id: "office-run-demo-1",
          title: "Summarize client demo delivery status",
          status: "running" as const,
          threadId: "thread-demo-office",
          turnId: "turn-demo-office-1",
          createdAt: "10:12",
          updatedAt: "10:14",
          goal: "Make Office team execution recoverable, auditable, and usable.",
          promptPreview:
            "Summarize current tasks, approvals, artifacts, and next steps.",
          plan: [
            {
              step: "Index office execution records",
              status: "completed" as const,
            },
            {
              step: "Wire cancel, retry, and structured reducer",
              status: "inProgress" as const,
            },
            {
              step: "Add ActivityBoard snapshot coverage",
              status: "pending" as const,
            },
          ],
          delegations: [
            {
              member: "Reviewer",
              agentId: "agent-reviewer",
              task: "Review reducer and state-machine boundaries",
              status: "running",
            },
          ],
        },
      ];
  const artifacts = zh(locale)
    ? [
        {
          title: "工具页改版.png",
          kind: "截图",
          glyph: "▣",
          accent: "violet" as const,
          meta: "2 分钟前 · 工程师",
        },
        {
          title: "办公室群聊.png",
          kind: "截图",
          glyph: "▣",
          accent: "violet" as const,
          meta: "5 分钟前 · 工程师",
        },
        {
          title: "app.css diff",
          kind: "变更",
          glyph: "⌥",
          accent: "green" as const,
          meta: "+86 / -12 · 待审批",
        },
        {
          title: "甲方演示摘要.md",
          kind: "文档",
          glyph: "▤",
          accent: "amber" as const,
          meta: "草稿 · 规划者",
        },
      ]
    : [
        {
          title: "tools-redesign.png",
          kind: "Screenshot",
          glyph: "▣",
          accent: "violet" as const,
          meta: "2m ago · Engineer",
        },
        {
          title: "office-chat.png",
          kind: "Screenshot",
          glyph: "▣",
          accent: "violet" as const,
          meta: "5m ago · Engineer",
        },
        {
          title: "app.css diff",
          kind: "Change",
          glyph: "⌥",
          accent: "green" as const,
          meta: "+86 / -12 · pending",
        },
        {
          title: "client-summary.md",
          kind: "Doc",
          glyph: "▤",
          accent: "amber" as const,
          meta: "Draft · Planner",
        },
      ];
  return { trace, approvals, budget, budgetCapUsd: 8, artifacts, runs };
}

// [KNOWLEDGE]
function demoKnowledgeData(locale: Locale): KnowledgeData {
  const memories = zh(locale)
    ? [
        {
          title: "甲方偏好",
          glyph: "★",
          accent: "amber" as const,
          kind: "偏好",
          preview: "甲方更看重「像真实产品」的演示，反感静态清单式截图。",
          meta: "已置顶 · 更新于今天",
          pinned: true,
        },
        {
          title: "命名约定",
          glyph: "◆",
          accent: "blue" as const,
          kind: "规则",
          preview:
            "新 crate 用 crewon- 前缀；format! 内联变量；UI 逻辑留在客户端包。",
          meta: "来自 AGENTS.md",
        },
        {
          title: "测试方式",
          glyph: "✓",
          accent: "green" as const,
          kind: "流程",
          preview:
            "用 just test，不直接 cargo test；改了 core/protocol 才跑全量。",
          meta: "工程师沉淀",
        },
        {
          title: "演示结论",
          glyph: "▣",
          accent: "violet" as const,
          kind: "决策",
          preview: "办公室=多智能体群聊；卡片要有图标/徽章/标签层级。",
          meta: "本次会话沉淀",
        },
      ]
    : [
        {
          title: "Client preference",
          glyph: "★",
          accent: "amber" as const,
          kind: "Preference",
          preview:
            "Client values demos that look like a real product, dislikes static list shots.",
          meta: "Pinned · updated today",
          pinned: true,
        },
        {
          title: "Naming conventions",
          glyph: "◆",
          accent: "blue" as const,
          kind: "Rule",
          preview:
            "New crates use crewon- prefix; inline format! args; UI logic stays in client packages.",
          meta: "From AGENTS.md",
        },
        {
          title: "Testing",
          glyph: "✓",
          accent: "green" as const,
          kind: "Process",
          preview:
            "Use just test, not cargo test; run full suite only when core/protocol changes.",
          meta: "Engineer note",
        },
        {
          title: "Demo decisions",
          glyph: "▣",
          accent: "violet" as const,
          kind: "Decision",
          preview:
            "Office = multi-agent group chat; cards need glyph/badge/tag hierarchy.",
          meta: "From this session",
        },
      ];
  const sources = zh(locale)
    ? [
        {
          name: "项目仓库",
          glyph: "▦",
          accent: "blue" as const,
          status: "indexed" as const,
          meta: "1,284 文件 · 嵌入完成",
        },
        {
          name: "AGENTS.md / 文档",
          glyph: "▤",
          accent: "amber" as const,
          status: "indexed" as const,
          meta: "32 篇 · 嵌入完成",
        },
        {
          name: "Figma 设计稿",
          glyph: "◍",
          accent: "violet" as const,
          status: "indexing" as const,
          meta: "正在嵌入 18 / 40 帧",
        },
        {
          name: "Notion 知识库",
          glyph: "◎",
          accent: "cyan" as const,
          status: "needs-auth" as const,
          meta: "待授权连接",
        },
      ]
    : [
        {
          name: "Project repo",
          glyph: "▦",
          accent: "blue" as const,
          status: "indexed" as const,
          meta: "1,284 files · embedded",
        },
        {
          name: "AGENTS.md / docs",
          glyph: "▤",
          accent: "amber" as const,
          status: "indexed" as const,
          meta: "32 docs · embedded",
        },
        {
          name: "Figma designs",
          glyph: "◍",
          accent: "violet" as const,
          status: "indexing" as const,
          meta: "Embedding 18 / 40 frames",
        },
        {
          name: "Notion workspace",
          glyph: "◎",
          accent: "cyan" as const,
          status: "needs-auth" as const,
          meta: "Needs auth",
        },
      ];
  return { memories, sources };
}

export function demoKnowledgePanel(
  title: string,
  locale: Locale,
): LibraryPanel {
  return {
    kind: "knowledge",
    title,
    subtitle: zh(locale)
      ? "智能体记忆 · 知识源索引"
      : "Agent memory · indexed knowledge sources",
    items: [],
    knowledge: demoKnowledgeData(locale),
  };
}
