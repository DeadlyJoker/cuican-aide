export type Locale = "zh" | "en";
export type ToolId = "review" | "terminal" | "web" | "files" | "sidechat";

export type ToolOption = {
  id: ToolId;
  label: string;
};

type Messages = {
  account: string;
  askPlaceholder: string;
  attachContext: string;
  autoMode: string;
  clearSearch: string;
  command: string;
  connected: string;
  connecting: string;
  connectionHints: {
    connected: string;
    connecting: string;
    disconnected: string;
    demo: string;
  };
  connectionLost: string;
  crewon: string;
  demo: string;
  demoResponse: string;
  dismiss: string;
  draftUnsaved: string;
  emptyDescription: string;
  emptyThreadDescription: string;
  emptyThreadTitle: string;
  emptyTitle: string;
  modeCode: string;
  modeCodeDescription: string;
  modeOffice: string;
  modeOfficeDescription: string;
  modeTitle: string;
  files: string;
  hideSidebar: string;
  language: string;
  loadingThreads: string;
  newDraftPreview: string;
  newDraftThread: string;
  newThread: string;
  noThreadsFound: string;
  noWorkspaceSelected: string;
  plan: string;
  reasoning: string;
  retryConnection: string;
  searchThreads: string;
  selectedToolsSummary: (tools: ToolOption[]) => string;
  send: string;
  sending: string;
  settings: string;
  showSidebar: string;
  threadSettings: string;
  themeDark: string;
  themeLight: string;
  threadsSection: string;
  tools: ToolOption[];
  untitledThread: string;
  workspaceLabel: string;
  you: string;
};

const messages: Record<Locale, Messages> = {
  zh: {
    account: "账号",
    askPlaceholder: "让 Crewon 检查、编辑、运行或解释...",
    attachContext: "添加上下文",
    autoMode: "自动选择工具和上下文",
    clearSearch: "清除搜索",
    command: "命令",
    connected: "已连接",
    connecting: "连接中",
    connectionHints: {
      connected: "已连接到本地 app-server",
      connecting: "正在连接本地 app-server",
      disconnected: "未连接本地 app-server，请求暂不发送",
      demo: "演示模式",
    },
    connectionLost: "无法连接本地 app-server，已保留当前会话，等待重连。",
    crewon: "Crewon",
    demo: "演示",
    demoResponse: "当前处于演示模式。启动 crewon app-server 的 WebSocket 监听后，这条请求会发送给真实代理。",
    dismiss: "关闭",
    draftUnsaved: "草稿未发送",
    emptyDescription: "连接本地 app-server 后即可浏览项目会话、继续对话，并在 macOS、Windows 和 web 使用同一套体验。",
    emptyThreadDescription: "从下方输入一条消息，Crewon 会把这个会话接着推进。",
    emptyThreadTitle: "这个会话还没有消息",
    emptyTitle: "开始构建",
    files: "文件",
    hideSidebar: "隐藏侧栏",
    language: "语言",
    loadingThreads: "正在加载会话…",
    modeCode: "单体对话",
    modeCodeDescription: "和一个智能体连续对话，适合审查、修复、测试和运行项目命令。",
    modeOffice: "群聊对话",
    modeOfficeDescription: "进入办公室群聊，选择已有智能体协作并沉淀任务、审批和交付物。",
    modeTitle: "切换对话类型",
    newDraftPreview: "为 Crewon 起草一个新任务",
    newDraftThread: "新的草稿会话",
    newThread: "新对话",
    noThreadsFound: "没有匹配的会话",
    noWorkspaceSelected: "未选择工作区",
    plan: "计划",
    reasoning: "推理",
    retryConnection: "重试连接",
    searchThreads: "搜索",
    selectedToolsSummary: (tools) => `已启用：${tools.map((tool) => tool.label).join("、")}`,
    send: "发送",
    sending: "发送中",
    settings: "设置",
    showSidebar: "显示侧栏",
    threadSettings: "会话设置",
    themeDark: "切换深色主题",
    themeLight: "切换浅色主题",
    threadsSection: "会话",
    tools: [
      { id: "review", label: "审查" },
      { id: "terminal", label: "终端" },
      { id: "web", label: "浏览器" },
      { id: "files", label: "文件" },
      { id: "sidechat", label: "侧边聊天" },
    ],
    untitledThread: "未命名会话",
    workspaceLabel: "本地工作区",
    you: "你",
  },
  en: {
    account: "Account",
    askPlaceholder: "Ask Crewon to inspect, edit, run, or explain...",
    attachContext: "Attach context",
    autoMode: "Auto-pick tools and context",
    clearSearch: "Clear search",
    command: "Command",
    connected: "Connected",
    connecting: "Connecting",
    connectionHints: {
      connected: "Connected to local app-server",
      connecting: "Connecting to local app-server",
      disconnected: "Local app-server disconnected; requests are paused",
      demo: "Demo mode",
    },
    connectionLost: "Could not connect to local app-server. Current sessions are preserved for retry.",
    crewon: "Crewon",
    demo: "Demo",
    demoResponse: "Demo mode is active. Start crewon app-server with a WebSocket listener to run this request against the real agent.",
    dismiss: "Dismiss",
    draftUnsaved: "Draft not sent",
    emptyDescription: "Connect to local app-server to browse project sessions, continue chats, and use the same workspace across macOS, Windows, and web.",
    emptyThreadDescription: "Send a message below and Crewon will continue this session.",
    emptyThreadTitle: "No messages in this session yet",
    emptyTitle: "Let's build",
    files: "Files",
    hideSidebar: "Hide sidebar",
    language: "Language",
    loadingThreads: "Loading sessions...",
    modeCode: "Direct chat",
    modeCodeDescription: "Talk with one agent for review, fixes, tests, and project commands.",
    modeOffice: "Group chat",
    modeOfficeDescription: "Open an office group chat, choose existing agents, and track tasks, approvals, and artifacts.",
    modeTitle: "Switch conversation type",
    newDraftPreview: "Draft a new task for Crewon",
    newDraftThread: "New draft session",
    newThread: "New chat",
    noThreadsFound: "No matching sessions",
    noWorkspaceSelected: "No workspace selected",
    plan: "Plan",
    reasoning: "Reasoning",
    retryConnection: "Retry connection",
    searchThreads: "Search",
    selectedToolsSummary: (tools) => `Enabled: ${tools.map((tool) => tool.label).join(", ")}`,
    send: "Send",
    sending: "Sending",
    settings: "Settings",
    showSidebar: "Show sidebar",
    threadSettings: "Session settings",
    themeDark: "Switch to dark theme",
    themeLight: "Switch to light theme",
    threadsSection: "Sessions",
    tools: [
      { id: "review", label: "Review" },
      { id: "terminal", label: "Terminal" },
      { id: "web", label: "Browser" },
      { id: "files", label: "Files" },
      { id: "sidechat", label: "Side chat" },
    ],
    untitledThread: "Untitled session",
    workspaceLabel: "Local workspace",
    you: "You",
  },
};

export function getInitialLocale(): Locale {
  const storedLocale = localStorage.getItem("crewon-ui-locale");

  if (storedLocale === "zh" || storedLocale === "en") {
    return storedLocale;
  }

  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function persistLocale(locale: Locale): void {
  localStorage.setItem("crewon-ui-locale", locale);
}

export function translate(locale: Locale): Messages {
  return messages[locale];
}
