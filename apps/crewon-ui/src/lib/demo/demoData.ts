import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { Turn } from "@crewon-ui-model/v2/Turn";
import type { Locale } from "../i18n";
import { promptPreview } from "../shared/text";

type DemoCopy = {
  firstName: string;
  firstPreview: string;
  firstUserMessage: string;
  firstPlan: string;
  firstCommandOutput: string;
  firstAgentMessage: string;
  secondName: string;
  secondPreview: string;
};

const demoCopy: Record<Locale, DemoCopy> = {
  zh: {
    firstName: "桌面端 UI 架构",
    firstPreview: "设计跨平台 Crewon 客户端",
    firstUserMessage:
      "开发一个跨平台 Crewon 前端，先适配 macOS、Windows 和 web。",
    firstPlan:
      "### 执行计划\n1. 搭建共享 React 工作台\n2. 接入 CrewON Control HTTP/SSE\n3. 校验桌面与 web 响应式布局",
    firstCommandOutput:
      "apps/crewon-ui/src/App.tsx\napps/crewon-ui/src/components/Transcript.tsx\napps/crewon-ui/src/styles/app.css",
    firstAgentMessage:
      "### 当前结论\n已把 Crewon 前端收敛为一套 **command center**：\n\n- 左侧管理项目、会话、工具、智能体和办公室\n- 中间保留 Markdown 对话流与任务执行记录\n- 右侧承载审查、终端、浏览器和文件能力\n\n下一步可以继续接入办公室编排后端。",
    secondName: "协议事件映射",
    secondPreview: "审查 Control 协议事件",
  },
  en: {
    firstName: "Desktop UI architecture",
    firstPreview: "Design a cross-platform Crewon client",
    firstUserMessage:
      "Build a cross-platform Crewon front end for macOS, Windows, and web.",
    firstPlan:
      "### Plan\n1. Build a shared React workbench\n2. Connect CrewON Control over HTTP/SSE\n3. Validate desktop and web responsive layouts",
    firstCommandOutput:
      "apps/crewon-ui/src/App.tsx\napps/crewon-ui/src/components/Transcript.tsx\napps/crewon-ui/src/styles/app.css",
    firstAgentMessage:
      "### Current result\nCrewon is shaped as a **command center**:\n\n- Sidebar for projects, sessions, tools, agents, and office\n- Markdown conversation flow with execution records in the center\n- Review, terminal, browser, and file capabilities on the right\n\nNext we can wire the office orchestration backend.",
    secondName: "Protocol mapping",
    secondPreview: "Review Control protocol events",
  },
};

export function getDemoThreads(locale: Locale): Thread[] {
  const now = Math.floor(Date.now() / 1000);
  const copy = demoCopy[locale];

  return [
    {
      id: "demo-1",
      sessionId: "demo-session-1",
      forkedFromId: null,
      parentThreadId: null,
      preview: copy.firstPreview,
      ephemeral: true,
      modelProvider: "openai",
      createdAt: now - 5400,
      updatedAt: now - 120,
      status: { type: "notLoaded" },
      path: null,
      cwd: "/Users/me/work/crewon",
      clientVersion: "0.1.0",
      source: "appServer",
      threadSource: "app_server",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: copy.firstName,
      turns: [
        {
          id: "demo-turn-1",
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: now - 5400,
          completedAt: now - 5100,
          durationMs: 300000,
          items: [
            {
              type: "userMessage",
              id: "demo-user-1",
              clientId: null,
              content: [
                {
                  type: "text",
                  text: copy.firstUserMessage,
                  text_elements: [],
                },
              ],
            },
            {
              type: "plan",
              id: "demo-plan-1",
              text: copy.firstPlan,
            },
            {
              type: "commandExecution",
              id: "demo-command-1",
              command: "rg --files apps/crewon-ui/src",
              cwd: "/Users/me/work/crewon",
              processId: null,
              source: "agent",
              status: "completed",
              commandActions: [
                {
                  type: "search",
                  command: "rg --files apps/crewon-ui/src",
                  query: null,
                  path: "apps/crewon-ui/src",
                },
              ],
              aggregatedOutput: copy.firstCommandOutput,
              exitCode: 0,
              durationMs: 820,
            },
            {
              type: "fileChange",
              id: "demo-file-change-1",
              status: "completed",
              changes: [
                {
                  path: "apps/crewon-ui/src/components/Transcript.tsx",
                  kind: { type: "update", move_path: null },
                  diff: "@@\n+function renderMessageContent(item) {\n+  return renderCard(item);\n-  return renderItemText(item);\n",
                },
                {
                  path: "apps/crewon-ui/src/styles/app.css",
                  kind: { type: "update", move_path: null },
                  diff: "@@\n+.command-card { display: grid; }\n+.file-change-card { display: grid; }\n-.message-card { box-shadow: var(--shadow); }\n",
                },
              ],
            },
            {
              type: "agentMessage",
              id: "demo-agent-1",
              text: copy.firstAgentMessage,
              phase: null,
              memoryCitation: null,
            },
          ],
        },
      ],
    },
    {
      id: "demo-3",
      sessionId: "demo-session-3",
      forkedFromId: null,
      parentThreadId: null,
      preview:
        locale === "zh"
          ? "规划多模型能力接入"
          : "Plan multi-model provider support",
      ephemeral: true,
      modelProvider: "openai",
      createdAt: now - 7200,
      updatedAt: now - 300,
      status: { type: "notLoaded" },
      path: null,
      cwd: "/Users/me/work/crewon",
      clientVersion: "0.1.0",
      source: "appServer",
      threadSource: "app_server",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name:
        locale === "zh"
          ? "接入 Claude、Qwen 与 GLM"
          : "Add Claude, Qwen, and GLM providers",
      turns: [],
    },
    {
      id: "demo-2",
      sessionId: "demo-session-2",
      forkedFromId: null,
      parentThreadId: null,
      preview: copy.secondPreview,
      ephemeral: true,
      modelProvider: "openai",
      createdAt: now - 18000,
      updatedAt: now - 2600,
      status: { type: "notLoaded" },
      path: null,
      cwd: "",
      clientVersion: "0.1.0",
      source: "appServer",
      threadSource: "app_server",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: locale === "zh" ? "获取 showcase 数据" : "Fetch showcase data",
      turns: [],
    },
  ];
}

export function createDraftDemoThread({
  initialPrompt,
  locale,
  newDraftPreview,
  newDraftThread,
  nowMs = Date.now(),
}: {
  initialPrompt?: string;
  locale: Locale;
  newDraftPreview: string;
  newDraftThread: string;
  nowMs?: number;
}): Thread {
  const preview = initialPrompt
    ? promptPreview(initialPrompt)
    : newDraftPreview;
  const [demoTemplate] = getDemoThreads(locale);
  const nowSeconds = Math.floor(nowMs / 1000);

  return {
    ...demoTemplate,
    id: `demo-${nowMs}`,
    sessionId: `demo-session-${nowMs}`,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    name: initialPrompt ? preview : newDraftThread,
    preview,
    turns: [],
  };
}

export function createDemoTurn({
  text,
  responseText,
  nowMs = Date.now(),
}: {
  text: string;
  responseText: string;
  nowMs?: number;
}): Turn {
  const nowSeconds = Math.floor(nowMs / 1000);

  return {
    id: `demo-turn-${nowMs}`,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: nowSeconds,
    completedAt: nowSeconds,
    durationMs: 0,
    items: [
      {
        type: "userMessage",
        id: `demo-user-${nowMs}`,
        clientId: null,
        content: [{ type: "text", text, text_elements: [] }],
      },
      {
        type: "agentMessage",
        id: `demo-agent-${nowMs}`,
        text: responseText,
        phase: null,
        memoryCitation: null,
      },
    ],
  };
}
