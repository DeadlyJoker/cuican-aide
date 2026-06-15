import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle } from "lucide-react";
import type { JsonValue } from "@crewon-protocol/serde_json/JsonValue";
import type { AppsListResponse } from "@crewon-protocol/v2/AppsListResponse";
import type { ConfigReadResponse } from "@crewon-protocol/v2/ConfigReadResponse";
import type { ConfigRequirementsReadResponse } from "@crewon-protocol/v2/ConfigRequirementsReadResponse";
import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { ExternalAgentConfigMigrationItem } from "@crewon-protocol/v2/ExternalAgentConfigMigrationItem";
import type { FsGetMetadataResponse } from "@crewon-protocol/v2/FsGetMetadataResponse";
import type { GetAuthStatusResponse } from "@crewon-protocol/GetAuthStatusResponse";
import type { GetAccountResponse } from "@crewon-protocol/v2/GetAccountResponse";
import type { GetAccountRateLimitsResponse } from "@crewon-protocol/v2/GetAccountRateLimitsResponse";
import type { GetAccountTokenUsageResponse } from "@crewon-protocol/v2/GetAccountTokenUsageResponse";
import type { HooksListResponse } from "@crewon-protocol/v2/HooksListResponse";
import type { ModelListResponse } from "@crewon-protocol/v2/ModelListResponse";
import type { ModelProviderCapabilitiesReadResponse } from "@crewon-protocol/v2/ModelProviderCapabilitiesReadResponse";
import type { McpServerStatus } from "@crewon-protocol/v2/McpServerStatus";
import type { PermissionProfileListResponse } from "@crewon-protocol/v2/PermissionProfileListResponse";
import type { PluginListResponse } from "@crewon-protocol/v2/PluginListResponse";
import type { PluginReadResponse } from "@crewon-protocol/v2/PluginReadResponse";
import type { RateLimitSnapshot } from "@crewon-protocol/v2/RateLimitSnapshot";
import type { SkillMetadata } from "@crewon-protocol/v2/SkillMetadata";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";
import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";
import type { Turn } from "@crewon-protocol/v2/Turn";
import {
  CapabilityDock,
  type CapabilityPanel,
  type CapabilityPanelItem,
} from "./components/CapabilityDock";
import { Composer } from "./components/Composer";
import {
  Inspector,
  type AccountStatus,
  type GitRemoteDiffSummary,
} from "./components/Inspector";
import { AgentConfigView } from "./components/agents/AgentConfigView";
import { Sidebar } from "./components/Sidebar";
import { SettingsSidebar, SettingsView, type SettingsSection } from "./components/SettingsView";
import { TitleBar } from "./components/TitleBar";
import { Transcript, type WorkMode } from "./components/Transcript";
import {
  AppServerClient,
  AppServerRpcError,
  type BackgroundTerminal,
  type AppServerNotification,
  type AppServerRequest,
  type RemoteControlClient,
  type RemoteControlStatusResponse,
} from "./lib/appServer";
import { getDemoThreads } from "./lib/demoData";
import {
  appendOfficeUserMessage,
  demoAccountStatus,
  demoCapabilityPanel,
  demoConversationSummary,
  demoGitRemoteDiff,
  demoLibraryPanel,
  demoSettingsPanel,
  demoThreadGoal,
} from "./lib/demoContent";
import {
  getInitialLocale,
  persistLocale,
  translate,
  type Locale,
  type ToolId,
} from "./lib/i18n";
import { defaultServerUrl, detectPlatform } from "./lib/platform";
import { itemPreview } from "./lib/text";
import { getInitialTheme, persistTheme, type Theme } from "./lib/theme";
import {
  AGENT_CONFIG_MARKER,
  AUTOMATION_CONFIG_MARKER,
  OFFICE_CONFIG_MARKER,
  agentConfigPayload,
  automationConfigPayload,
  officeConfigForThread,
  officeConfigPayload,
  type ActivityData,
  type AgentCapabilityOption,
  type AgentConfig,
  type ApprovalRequest,
  type ArtifactItem,
  type AutomationConfig,
  type LibraryAccent,
  type LibraryItem,
  type LibraryKind,
  type LibraryPanel,
  type LibraryPanelAction,
  type OfficeConfig,
  type OfficeMember,
  type OfficeMessage,
  type OfficeTask,
  type OfficeWorkspace,
  type ToolConfig,
  type TraceStep,
  type KnowledgeData,
  type KnowledgeEntry,
  type KnowledgeSource,
} from "./lib/crewonDomain";
import {
  deleteDomainConfigFile,
  readAgentConfigFiles as readStoredAgentConfigFiles,
  readAutomationConfigFiles as readStoredAutomationConfigFiles,
  readOfficeConfigFiles as readStoredOfficeConfigFiles,
  readToolConfigFiles as readStoredToolConfigFiles,
  writeAgentConfigFile as writeStoredAgentConfigFile,
  writeAutomationConfigFile as writeStoredAutomationConfigFile,
  writeOfficeConfigFile as writeStoredOfficeConfigFile,
  writeToolConfigFile as writeStoredToolConfigFile,
} from "./lib/domainPersistence";
export type {
  ActivityData,
  AgentCapabilityOption,
  AgentConfig,
  ApprovalRequest,
  ArtifactItem,
  BudgetRow,
  KnowledgeData,
  KnowledgeEntry,
  KnowledgeSource,
  LibraryAccent,
  LibraryBadgeTone,
  LibraryItem,
  LibraryKind,
  LibraryPanel,
  LibraryPanelAction,
  LibraryPanelField,
  OfficeMember,
  OfficeMessage,
  OfficeTask,
  OfficeWorkspace,
  ToolConfig,
  TraceStep,
} from "./lib/crewonDomain";

type ConnectionState = "connecting" | "connected" | "demo";
type AppView = "chat" | "settings" | "library";
type NoticeState = {
  text: string;
  tone: "warning" | "success";
};
const DESKTOP_LOCALE_KEY_PATH = "desktop.uiLocale";
const DESKTOP_THEME_KEY_PATH = "desktop.appearanceTheme";
type PendingApprovalRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};
type PendingUserInputRequest = {
  id: number | string;
  questionIds: string[];
};
type PendingDynamicToolRequest = {
  id: number | string;
  fieldId: string;
};
type PendingMcpElicitationRequest = {
  id: number | string;
  fieldId: string;
};
type PendingExternalSecretRequest = {
  id: number | string;
  kind: "chatgptAuthTokens" | "attestation";
};

function upsertThread(threads: Thread[], nextThread: Thread): Thread[] {
  const existingIndex = threads.findIndex(
    (thread) => thread.id === nextThread.id,
  );

  if (existingIndex === -1) {
    return [nextThread, ...threads];
  }

  const nextThreads = [...threads];
  nextThreads[existingIndex] = nextThread;
  return nextThreads;
}

function slugifySkillName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "client-demo-skill"
  );
}

function appMentionSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

function createDefaultAgentConfig(locale: Locale): AgentConfig {
  const permissions =
    locale === "zh"
      ? ["只读", "工作区写入", "完全访问"]
      : ["read-only", "workspace-write", "full-access"];
  return {
    name: locale === "zh" ? "新智能体" : "New Agent",
    glyph: "✦",
    accent: "cyan",
    role:
      locale === "zh"
        ? "自定义执行角色 · 可招募"
        : "Custom execution role · recruitable",
    model: "gpt-5-codex",
    models: ["gpt-5-codex", "gpt-5", "o4-mini", "claude-opus-4.8"],
    permission: permissions[1],
    permissions,
    systemPrompt:
      locale === "zh"
        ? "你是办公室中的自定义智能体。先理解目标，再列出计划，必要时调用已授权工具，并把结果沉淀为可复用交付物。"
        : "You are a custom agent in an office. Understand the goal, outline a plan, use authorized tools when needed, and turn results into reusable deliverables.",
    mcp: [
      {
        id: "filesystem",
        name: locale === "zh" ? "文件系统" : "Filesystem",
        glyph: "⌁",
        accent: "blue",
        description:
          locale === "zh"
            ? "读取和整理工作区文件"
            : "Read and organize workspace files",
        enabled: true,
      },
      {
        id: "browser",
        name: locale === "zh" ? "浏览器" : "Browser",
        glyph: "◎",
        accent: "amber",
        description:
          locale === "zh"
            ? "打开网页、抓取页面和截图"
            : "Open pages, inspect content, and capture screenshots",
        enabled: false,
      },
    ],
    skills: [
      {
        id: "review",
        name: locale === "zh" ? "代码审查" : "Code review",
        glyph: "✓",
        accent: "green",
        description:
          locale === "zh"
            ? "检查风险、缺陷和测试缺口"
            : "Check risks, defects, and test gaps",
        enabled: true,
      },
      {
        id: "client-demo",
        name: locale === "zh" ? "甲方 Demo" : "Client demo",
        glyph: "◈",
        accent: "rose",
        description:
          locale === "zh"
            ? "整理演示材料和截图"
            : "Prepare demo material and screenshots",
        enabled: false,
      },
    ],
  };
}

const CAPABILITY_ACCENTS: LibraryAccent[] = [
  "blue",
  "cyan",
  "green",
  "amber",
  "violet",
  "rose",
  "slate",
];
const MCP_GLYPHS = ["⌁", "◎", "⌘", "◈", "◇"];
const SKILL_GLYPHS = ["✓", "✦", "⌗", "◌", "◇"];

function createMcpAgentOption(
  server: McpServerStatus,
  locale: Locale,
  index: number,
): AgentCapabilityOption {
  const toolCount = Object.keys(server.tools).length;
  const resourceCount = server.resources.length + server.resourceTemplates.length;
  const serverTitle =
    server.serverInfo?.title || server.serverInfo?.name || server.name;
  const authLabel =
    server.authStatus === "notLoggedIn"
      ? locale === "zh"
        ? "未登录"
        : "not logged in"
      : server.authStatus === "unsupported"
        ? locale === "zh"
          ? "无需授权"
          : "no auth"
        : locale === "zh"
          ? "已授权"
          : "authorized";

  return {
    id: server.name,
    name: serverTitle,
    glyph: MCP_GLYPHS[index % MCP_GLYPHS.length],
    accent: CAPABILITY_ACCENTS[index % CAPABILITY_ACCENTS.length],
    description:
      locale === "zh"
        ? `${authLabel} · ${toolCount} 个工具 · ${resourceCount} 个资源`
        : `${authLabel} · ${toolCount} tools · ${resourceCount} resources`,
    enabled: server.authStatus !== "notLoggedIn" && toolCount > 0,
  };
}

function createSkillAgentOption(
  skill: SkillMetadata,
  locale: Locale,
  index: number,
): AgentCapabilityOption {
  let scopeLabel: string;
  switch (skill.scope) {
    case "repo":
      scopeLabel = locale === "zh" ? "项目" : "repo";
      break;
    case "user":
      scopeLabel = locale === "zh" ? "个人" : "user";
      break;
    case "system":
      scopeLabel = locale === "zh" ? "系统" : "system";
      break;
    case "admin":
      scopeLabel = locale === "zh" ? "管理" : "admin";
      break;
  }
  return {
    id: skill.path,
    name: skill.name,
    glyph: SKILL_GLYPHS[index % SKILL_GLYPHS.length],
    accent: CAPABILITY_ACCENTS[(index + 2) % CAPABILITY_ACCENTS.length],
    description:
      skill.shortDescription ||
      skill.description ||
      (locale === "zh" ? `${scopeLabel} Skill` : `${scopeLabel} skill`),
    enabled: skill.enabled && index < 8,
  };
}

const CREWON_SKILL_EXTRA_ROOTS_STORAGE_KEY = "crewon-ui-skill-extra-roots";

function readStoredSkillExtraRoots(): string[] {
  try {
    const raw = localStorage.getItem(CREWON_SKILL_EXTRA_ROOTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function writeStoredSkillExtraRoots(roots: string[]): void {
  try {
    localStorage.setItem(
      CREWON_SKILL_EXTRA_ROOTS_STORAGE_KEY,
      JSON.stringify(roots),
    );
  } catch {
    // Persisting this registry is best-effort; app-server still receives roots.
  }
}

function mergeSkillExtraRoots(...rootGroups: string[][]): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const root of rootGroups.flat()) {
    const normalized = root.trim().replace(/[\\/]+$/, "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    roots.push(normalized);
  }
  return roots;
}

function userMessageText(item: ThreadItem): string {
  if (item.type !== "userMessage") {
    return "";
  }
  return item.content
    .map((content) => (content.type === "text" ? content.text : ""))
    .filter(Boolean)
    .join("\n");
}

function officeMessageTime(timestamp: number | null | undefined, locale: Locale): string {
  if (!timestamp) {
    return locale === "zh" ? "刚刚" : "now";
  }
  return new Date(timestamp * 1000).toLocaleString(
    locale === "zh" ? "zh-CN" : "en-US",
    {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    },
  );
}

function compactOfficeMessageText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 1600 ? `${trimmed.slice(0, 1600)}\n...` : trimmed;
}

function userOfficeMessageText(text: string, locale: Locale): string {
  const withoutConfig = text.split(`${OFFICE_CONFIG_MARKER}:`)[0].trim();
  const zhPrefixMatch = withoutConfig.match(/^办公室「.*」群聊消息：([\s\S]*)$/);
  if (zhPrefixMatch?.[1]) {
    return compactOfficeMessageText(zhPrefixMatch[1]);
  }
  const enPrefixMatch = withoutConfig.match(/^Office ".*" group chat message: ([\s\S]*)$/);
  if (enPrefixMatch?.[1]) {
    return compactOfficeMessageText(enPrefixMatch[1]);
  }
  if (
    withoutConfig.startsWith(locale === "zh" ? "绑定办公室：" : "Bind office:") ||
    withoutConfig.startsWith(locale === "zh" ? "创建办公室：" : "Create office:")
  ) {
    return "";
  }
  return compactOfficeMessageText(withoutConfig);
}

function officeMessagesFromThread(thread: Thread, locale: Locale): OfficeMessage[] {
  const messages: OfficeMessage[] = [];
  for (const turn of thread.turns) {
    const time = officeMessageTime(turn.completedAt ?? turn.startedAt, locale);
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const text = userOfficeMessageText(userMessageText(item), locale);
        if (text) {
          messages.push({
            author: locale === "zh" ? "你" : "You",
            glyph: "@",
            accent: "blue",
            time,
            text,
          });
        }
        continue;
      }
      if (item.type === "agentMessage" && item.text.trim()) {
        messages.push({
          author: locale === "zh" ? "Crewon" : "Crewon",
          glyph: "C",
          accent: "green",
          time,
          text: compactOfficeMessageText(item.text),
        });
        continue;
      }
      if (item.type === "plan" && item.text.trim()) {
        messages.push({
          author: locale === "zh" ? "计划" : "Plan",
          glyph: "✓",
          accent: "violet",
          time,
          text: compactOfficeMessageText(item.text),
          kind: "task",
        });
        continue;
      }
      if (item.type === "commandExecution") {
        messages.push({
          author: locale === "zh" ? "终端" : "Terminal",
          glyph: "$",
          accent: item.exitCode === 0 ? "green" : "amber",
          time,
          text: compactOfficeMessageText(
            [
              item.command,
              item.aggregatedOutput
                ? item.aggregatedOutput.slice(0, 800)
                : item.status,
            ].join("\n"),
          ),
          kind: "task",
        });
        continue;
      }
      if (item.type === "collabAgentToolCall") {
        messages.push({
          author: locale === "zh" ? "智能体协作" : "Agent collaboration",
          glyph: "A",
          accent: "cyan",
          time,
          text: compactOfficeMessageText(
            [
              `${locale === "zh" ? "工具" : "Tool"}: ${item.tool}`,
              `${locale === "zh" ? "状态" : "Status"}: ${item.status}`,
              item.prompt ?? "",
            ]
              .filter(Boolean)
              .join("\n"),
          ),
          kind: "task",
        });
      }
    }
  }
  return messages;
}

function mergeOfficeMessages(
  baseMessages: OfficeMessage[],
  backendMessages: OfficeMessage[],
): OfficeMessage[] {
  const seen = new Set(
    baseMessages.map(
      (message) => `${message.kind ?? "message"}:${message.author}:${message.text}`,
    ),
  );
  const merged = [...baseMessages];
  for (const message of backendMessages) {
    const key = `${message.kind ?? "message"}:${message.author}:${message.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(message);
  }
  return merged;
}

function parseAgentConfigFromThread(thread: Thread, locale: Locale): AgentConfig | null {
  for (const turn of [...thread.turns].reverse()) {
    for (const item of [...turn.items].reverse()) {
      const text = userMessageText(item);
      const markerIndex = text.indexOf(`${AGENT_CONFIG_MARKER}:`);
      if (markerIndex === -1) {
        continue;
      }
      const payload = text.slice(markerIndex + AGENT_CONFIG_MARKER.length + 1).trim();
      try {
        const parsed = JSON.parse(payload) as Partial<AgentConfig>;
        const fallback = createDefaultAgentConfig(locale);
        return {
          ...fallback,
          ...parsed,
          threadId: thread.id,
          mcp: Array.isArray(parsed.mcp) ? parsed.mcp : fallback.mcp,
          skills: Array.isArray(parsed.skills) ? parsed.skills : fallback.skills,
          models: Array.isArray(parsed.models) ? parsed.models : fallback.models,
          permissions: Array.isArray(parsed.permissions) ? parsed.permissions : fallback.permissions,
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseAutomationConfigFromThread(thread: Thread, locale: Locale): AutomationConfig | null {
  for (const turn of [...thread.turns].reverse()) {
    for (const item of [...turn.items].reverse()) {
      const text = userMessageText(item);
      const markerIndex = text.indexOf(`${AUTOMATION_CONFIG_MARKER}:`);
      if (markerIndex === -1) {
        continue;
      }
      const payload = text
        .slice(markerIndex + AUTOMATION_CONFIG_MARKER.length + 1)
        .trim();
      try {
        const parsed = JSON.parse(payload) as Partial<AutomationConfig>;
        const title = parsed.title || threadTitle(thread, locale === "zh" ? "自动化" : "Automation");
        return {
          threadId: thread.id,
          title,
          subtitle:
            parsed.subtitle ||
            (locale === "zh" ? "后端执行线程" : "Backend execution thread"),
          body:
            parsed.body ||
            (locale === "zh"
              ? `线程：${thread.id}\n状态：${thread.status}`
              : `Thread: ${thread.id}\nStatus: ${thread.status}`),
          prompt:
            parsed.prompt ||
            (locale === "zh"
              ? `继续运行自动化「${title}」。`
              : `Run automation "${title}" again.`),
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseOfficeConfigFromThread(thread: Thread, locale: Locale): OfficeConfig | null {
  for (const turn of [...thread.turns].reverse()) {
    for (const item of [...turn.items].reverse()) {
      const text = userMessageText(item);
      const markerIndex = text.indexOf(`${OFFICE_CONFIG_MARKER}:`);
      if (markerIndex === -1) {
        continue;
      }
      const payload = text.slice(markerIndex + OFFICE_CONFIG_MARKER.length + 1).trim();
      try {
        const parsed = JSON.parse(payload) as Partial<OfficeConfig>;
        if (!parsed.workspace) {
          return null;
        }
        const title = parsed.title || threadTitle(thread, locale === "zh" ? "办公室" : "Office");
        return {
          title,
          subtitle:
            parsed.subtitle ||
            (locale === "zh" ? "后端办公室" : "Backend office"),
          workspace: {
            ...workspaceFromBackendThread(thread, locale),
            ...parsed.workspace,
            threadId: thread.id,
            backendStatus: "connected",
            members: Array.isArray(parsed.workspace.members)
              ? parsed.workspace.members
              : workspaceFromBackendThread(thread, locale).members,
            messages: mergeOfficeMessages(
              Array.isArray(parsed.workspace.messages)
                ? parsed.workspace.messages
                : workspaceFromBackendThread(thread, locale).messages,
              officeMessagesFromThread(thread, locale),
            ),
            tasks: Array.isArray(parsed.workspace.tasks)
              ? parsed.workspace.tasks
              : workspaceFromBackendThread(thread, locale).tasks,
          },
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function backendThreadMeta(thread: Thread, locale: Locale): string {
  const updated = new Date(thread.updatedAt * 1000).toLocaleString(
    locale === "zh" ? "zh-CN" : "en-US",
    {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    },
  );
  return `${locale === "zh" ? "后端线程" : "Backend thread"} · ${updated}`;
}

function workspaceFromBackendThread(thread: Thread, locale: Locale): OfficeWorkspace {
  const title = threadTitle(thread, locale === "zh" ? "办公室" : "Office");
  return {
    goal:
      thread.preview ||
      (locale === "zh"
        ? `围绕「${title}」进行多智能体协作。`
        : `Coordinate multi-agent work for "${title}".`),
    threadId: thread.id,
    backendStatus: "connected",
    members: [
      {
        name: locale === "zh" ? "协调者" : "Coordinator",
        role: locale === "zh" ? "办公室调度" : "Office coordination",
        glyph: "@",
        accent: "blue",
        status: locale === "zh" ? "已连接后端线程" : "Backend thread connected",
        online: true,
      },
    ],
    messages: [
      {
        author: locale === "zh" ? "系统" : "System",
        glyph: "⌗",
        accent: "slate",
        time: locale === "zh" ? "刚刚" : "now",
        kind: "system",
        text:
          locale === "zh"
            ? `已从后端线程恢复办公室：${title}`
            : `Restored office from backend thread: ${title}`,
      },
      ...officeMessagesFromThread(thread, locale),
    ],
    tasks: [],
  };
}

function agentConfigToOfficeMember(
  config: AgentConfig,
  locale: Locale,
): OfficeMember {
  return {
    name: config.name,
    role: config.role,
    glyph: config.glyph,
    accent: config.accent,
    status: locale === "zh" ? "已从智能体库招募" : "Recruited from agents",
    online: true,
  };
}

function backendThreadLibraryItem(
  thread: Thread,
  kind: "agent" | "automation" | "office",
  locale: Locale,
  agentConfig?: AgentConfig | null,
  automationConfig?: AutomationConfig | null,
  officeConfig?: OfficeConfig | null,
): LibraryItem {
  const title = threadTitle(
    thread,
    kind === "agent"
      ? locale === "zh"
        ? "智能体"
        : "Agent"
      : kind === "automation"
        ? locale === "zh"
          ? "自动化"
          : "Automation"
        : locale === "zh"
          ? "办公室"
          : "Office",
  );

  if (kind === "office") {
    const config =
      officeConfig ?? {
        title,
        subtitle: locale === "zh" ? "后端办公室" : "Backend office",
        workspace: workspaceFromBackendThread(thread, locale),
      };
    return {
      title: config.title,
      meta: backendThreadMeta(thread, locale),
      description:
        locale === "zh"
          ? "已绑定真实 app-server 线程，可进入群聊继续协作。"
          : "Bound to a real app-server thread; open the group chat to continue.",
      glyph: "⌗",
      accent: "blue",
      badge: { label: locale === "zh" ? "已连接" : "connected", tone: "running" },
      action: {
        type: "office-detail",
        title: config.title,
        subtitle: config.subtitle,
        body: "",
        items: [],
        workspace: config.workspace,
      },
    };
  }

  if (kind === "automation") {
    const config =
      automationConfig ?? {
        title,
        subtitle: locale === "zh" ? "后端执行线程" : "Backend execution thread",
        body:
          locale === "zh"
            ? `线程：${thread.id}\n状态：${thread.status}\n预览：${thread.preview || "暂无"}`
            : `Thread: ${thread.id}\nStatus: ${thread.status}\nPreview: ${thread.preview || "None"}`,
        prompt:
          locale === "zh"
            ? `继续运行自动化「${title}」，并把执行结果记录到当前线程。`
            : `Run automation "${title}" again and record the result in this thread.`,
      };
    return {
      title: config.title,
      meta: backendThreadMeta(thread, locale),
      description:
        locale === "zh"
          ? "已创建后端执行线程，打开后可再次运行并写入运行记录。"
          : "Backend execution thread exists; open it to run again and append records.",
      glyph: "⏱",
      accent: "green",
      badge: { label: locale === "zh" ? "后端" : "backend", tone: "running" },
      action: {
        type: "automation-detail",
        title: config.title,
        subtitle: config.subtitle,
        body: config.body,
        prompt: config.prompt,
        threadId: config.threadId ?? thread.id,
      },
    };
  }

  return {
    title,
    meta: backendThreadMeta(thread, locale),
    description:
      locale === "zh"
        ? "已保存到后端 agent 线程，可继续调整配置并重新保存。"
        : "Saved as a backend agent thread; open to adjust and save again.",
    glyph: "✦",
    accent: "cyan",
    badge: { label: locale === "zh" ? "后端" : "backend", tone: "idle" },
    action: {
      type: "agent-config",
      config: agentConfig ?? {
        ...createDefaultAgentConfig(locale),
        threadId: thread.id,
        name: title,
        role:
          locale === "zh"
            ? "后端智能体 · 可招募"
            : "Backend agent · recruitable",
        systemPrompt:
          thread.preview ||
          (locale === "zh"
            ? "这个智能体配置来自后端线程。"
            : "This agent configuration is restored from a backend thread."),
      },
    },
  };
}

function appendItem(thread: Thread, turnId: string, item: ThreadItem): Thread {
  return {
    ...thread,
    turns: thread.turns.map((turn) =>
      turn.id === turnId
        ? {
            ...turn,
            items: upsertItem(turn.items, item),
          }
        : turn,
    ),
  };
}

function upsertItem(items: ThreadItem[], item: ThreadItem): ThreadItem[] {
  const existingIndex = items.findIndex(
    (existingItem) => existingItem.id === item.id,
  );

  if (existingIndex === -1) {
    return [...items, item];
  }

  const nextItems = [...items];
  nextItems[existingIndex] = item;
  return nextItems;
}

function updateItem(
  thread: Thread,
  turnId: string,
  itemId: string,
  updater: (item: ThreadItem) => ThreadItem,
): Thread {
  return {
    ...thread,
    turns: thread.turns.map((turn) =>
      turn.id === turnId
        ? {
            ...turn,
            items: turn.items.map((item) =>
              item.id === itemId ? updater(item) : item,
            ),
          }
        : turn,
    ),
  };
}

function upsertTurn(thread: Thread, nextTurn: Turn): Thread {
  const existingTurnIndex = thread.turns.findIndex(
    (turn) => turn.id === nextTurn.id,
  );

  if (existingTurnIndex === -1) {
    return { ...thread, turns: [...thread.turns, nextTurn] };
  }

  const turns = [...thread.turns];
  turns[existingTurnIndex] = nextTurn;
  return { ...thread, turns };
}

function automationItemSummary(item: ThreadItem, locale: Locale): string | null {
  if (item.type === "userMessage") {
    const text = userMessageText(item)
      .split(`${AUTOMATION_CONFIG_MARKER}:`)[0]
      .trim();
    return text
      ? `${locale === "zh" ? "请求" : "Request"}: ${compactOfficeMessageText(text)}`
      : null;
  }
  if (item.type === "agentMessage" && item.text.trim()) {
    return `${locale === "zh" ? "结果" : "Result"}: ${compactOfficeMessageText(item.text)}`;
  }
  if (item.type === "plan" && item.text.trim()) {
    return `${locale === "zh" ? "计划" : "Plan"}: ${compactOfficeMessageText(item.text)}`;
  }
  if (item.type === "commandExecution") {
    const output = item.aggregatedOutput?.trim();
    return [
      `${locale === "zh" ? "命令" : "Command"}: ${item.command}`,
      output ? compactOfficeMessageText(output.slice(0, 600)) : item.status,
    ].join("\n");
  }
  if (item.type === "mcpToolCall") {
    return `${locale === "zh" ? "MCP 调用" : "MCP call"}: ${item.server}.${item.tool} · ${item.status}`;
  }
  if (item.type === "dynamicToolCall") {
    return `${locale === "zh" ? "工具调用" : "Tool call"}: ${item.namespace ? `${item.namespace}.` : ""}${item.tool} · ${item.status}`;
  }
  if (item.type === "collabAgentToolCall") {
    return `${locale === "zh" ? "智能体协作" : "Agent collaboration"}: ${item.tool} · ${item.status}`;
  }
  if (item.type === "fileChange") {
    return `${locale === "zh" ? "文件改动" : "File changes"}: ${item.changes.length} · ${item.status}`;
  }
  if (item.type === "webSearch") {
    return `${locale === "zh" ? "搜索" : "Search"}: ${item.query}`;
  }
  return null;
}

function automationTurnMetrics(turn: Turn, locale: Locale): string {
  const commandCount = turn.items.filter(
    (item) => item.type === "commandExecution",
  ).length;
  const toolCount = turn.items.filter(
    (item) =>
      item.type === "mcpToolCall" ||
      item.type === "dynamicToolCall" ||
      item.type === "collabAgentToolCall",
  ).length;
  const fileChangeCount = turn.items.reduce(
    (count, item) =>
      item.type === "fileChange" ? count + item.changes.length : count,
    0,
  );
  const metrics = [
    commandCount
      ? `${commandCount} ${locale === "zh" ? "命令" : "commands"}`
      : null,
    toolCount ? `${toolCount} ${locale === "zh" ? "工具" : "tools"}` : null,
    fileChangeCount
      ? `${fileChangeCount} ${locale === "zh" ? "文件改动" : "file changes"}`
      : null,
  ].filter(Boolean);
  return metrics.length > 0
    ? metrics.join(" · ")
    : `${turn.items.length} ${locale === "zh" ? "项" : "items"}`;
}

function automationTurnDescription(turn: Turn, thread: Thread, locale: Locale): string {
  const summaries = turn.items
    .map((item) => automationItemSummary(item, locale))
    .filter((summary): summary is string => Boolean(summary))
    .filter((summary) => !summary.includes(`${AUTOMATION_CONFIG_MARKER}:`));
  const summary = summaries.slice(0, 3).join("\n\n") || thread.preview || "";
  return summary.length > 420 ? `${summary.slice(0, 417)}...` : summary;
}

function automationRunHistoryItems(
  thread: Thread,
  locale: Locale,
): LibraryItem[] {
  const runs = [...thread.turns]
    .reverse()
    .map((turn, index): LibraryItem => {
      const statusLabel =
        locale === "zh"
          ? turn.status === "completed"
            ? "完成"
            : turn.status === "inProgress"
              ? "运行中"
              : "失败"
          : turn.status === "completed"
            ? "Completed"
            : turn.status === "inProgress"
              ? "Running"
              : "Failed";

      return {
        title:
          locale === "zh"
            ? `运行记录 ${thread.turns.length - index}`
            : `Run ${thread.turns.length - index}`,
        meta: [
          statusLabel,
          formatUnixSeconds(turn.completedAt ?? turn.startedAt, locale),
          automationTurnMetrics(turn, locale),
        ]
          .filter(Boolean)
          .join(" · "),
        description:
          automationTurnDescription(turn, thread, locale) ||
          (locale === "zh" ? "暂无运行摘要" : "No run summary yet"),
        glyph:
          turn.status === "completed"
            ? "✓"
            : turn.status === "inProgress"
              ? "◷"
              : "!",
        accent:
          turn.status === "completed"
            ? "green"
            : turn.status === "inProgress"
              ? "blue"
              : "rose",
      };
    })
    .slice(0, 6);

  if (runs.length === 0) {
    return [
      {
        title: locale === "zh" ? "暂无运行记录" : "No run history",
        meta: locale === "zh" ? "等待首次运行" : "Waiting for first run",
        description:
          locale === "zh"
            ? "点击立即运行后，会把请求和结果写入后端执行线程。"
            : "Run it once to write the request and result into the backend execution thread.",
        glyph: "◷",
        accent: "slate",
      },
    ];
  }

  return [
    {
      title: locale === "zh" ? "后端运行记录" : "Backend run history",
      meta:
        locale === "zh"
          ? `${thread.turns.length} 次运行`
          : `${thread.turns.length} runs`,
      description:
        locale === "zh"
          ? "来自 app-server 线程的最近运行记录。"
          : "Recent runs loaded from the app-server thread.",
      section: true,
    },
    ...runs,
  ];
}

function agentItemSummary(item: ThreadItem, locale: Locale): string | null {
  if (item.type === "userMessage") {
    const text = userMessageText(item);
    const withoutConfig = text.split(`${AGENT_CONFIG_MARKER}:`)[0].trim();
    if (!withoutConfig) {
      return null;
    }
    const lines = withoutConfig
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return compactOfficeMessageText(
      lines.slice(0, 8).join("\n") || withoutConfig,
    );
  }
  if (item.type === "agentMessage" && item.text.trim()) {
    return `${locale === "zh" ? "响应" : "Response"}: ${compactOfficeMessageText(item.text)}`;
  }
  if (item.type === "plan" && item.text.trim()) {
    return `${locale === "zh" ? "计划" : "Plan"}: ${compactOfficeMessageText(item.text)}`;
  }
  if (item.type === "commandExecution") {
    return `${locale === "zh" ? "命令" : "Command"}: ${item.command}\n${item.aggregatedOutput?.trim().slice(0, 600) || item.status}`;
  }
  if (item.type === "mcpToolCall") {
    return `${locale === "zh" ? "MCP 工具" : "MCP tool"}: ${item.server}.${item.tool} · ${item.status}`;
  }
  if (item.type === "dynamicToolCall") {
    return `${locale === "zh" ? "动态工具" : "Dynamic tool"}: ${item.namespace ? `${item.namespace}.` : ""}${item.tool} · ${item.status}`;
  }
  if (item.type === "collabAgentToolCall") {
    return `${locale === "zh" ? "协作调用" : "Collaboration"}: ${item.tool} · ${item.status}`;
  }
  if (item.type === "fileChange") {
    return `${locale === "zh" ? "文件改动" : "File changes"}: ${item.changes.length} · ${item.status}`;
  }
  return null;
}

function agentTurnDescription(turn: Turn, thread: Thread, locale: Locale): string {
  const summaries = turn.items
    .map((item) => agentItemSummary(item, locale))
    .filter((summary): summary is string => Boolean(summary))
    .filter((summary) => !summary.includes(`${AGENT_CONFIG_MARKER}:`));
  const summary = summaries.slice(0, 3).join("\n\n") || thread.preview || "";
  return summary.length > 420 ? `${summary.slice(0, 417)}...` : summary;
}

function agentThreadHistoryItems(thread: Thread, locale: Locale): LibraryItem[] {
  const entries = [...thread.turns]
    .reverse()
    .map((turn, index): LibraryItem => {
      const statusLabel =
        locale === "zh"
          ? turn.status === "completed"
            ? "完成"
            : turn.status === "inProgress"
              ? "保存中"
              : turn.status === "interrupted"
                ? "已中断"
                : "失败"
          : turn.status === "completed"
            ? "Completed"
            : turn.status === "inProgress"
              ? "Saving"
              : turn.status === "interrupted"
                ? "Interrupted"
                : "Failed";

      return {
        title:
          locale === "zh"
            ? `配置记录 ${thread.turns.length - index}`
            : `Config record ${thread.turns.length - index}`,
        meta: [
          statusLabel,
          formatUnixSeconds(turn.completedAt ?? turn.startedAt, locale),
          automationTurnMetrics(turn, locale),
        ]
          .filter(Boolean)
          .join(" · "),
        description:
          agentTurnDescription(turn, thread, locale) ||
          (locale === "zh" ? "暂无配置摘要" : "No configuration summary yet"),
        glyph:
          turn.status === "completed"
            ? "✓"
            : turn.status === "inProgress"
              ? "◷"
              : "!",
        accent:
          turn.status === "completed"
            ? "green"
            : turn.status === "inProgress"
              ? "blue"
              : "rose",
      };
    })
    .slice(0, 5);

  if (entries.length === 0) {
    return [
      {
        title: locale === "zh" ? "暂无后端记录" : "No backend records",
        meta: locale === "zh" ? "等待首次保存" : "Waiting for first save",
        description:
          locale === "zh"
            ? "保存配置后，会把智能体的模型、权限、MCP、Skill 和系统提示词写入后端线程。"
            : "Save the config to write model, permissions, MCP, skills, and system prompt into the backend thread.",
        glyph: "◷",
        accent: "slate",
      },
    ];
  }

  return [
    {
      title: locale === "zh" ? "后端配置记录" : "Backend config records",
      meta:
        locale === "zh"
          ? `${thread.turns.length} 次保存`
          : `${thread.turns.length} saves`,
      description:
        locale === "zh"
          ? "来自 app-server 智能体线程的最近配置记录。"
          : "Recent configuration records loaded from the app-server agent thread.",
      section: true,
    },
    ...entries,
  ];
}

function toolThreadHistoryItems(thread: Thread, locale: Locale): LibraryItem[] {
  const entries = automationRunHistoryItems(thread, locale).filter(
    (item) => !item.section,
  );
  if (entries.length === 0) {
    return toolEmptyHistoryItems(locale);
  }

  return [
    {
      title: locale === "zh" ? "后端调用记录" : "Backend call history",
      meta:
        locale === "zh"
          ? `${thread.turns.length} 条记录`
          : `${thread.turns.length} records`,
      description:
        locale === "zh"
          ? "来自工具验证线程的最近调用与资源读取记录。"
          : "Recent calls and resource reads from the tool verification thread.",
      section: true,
    },
    ...entries,
  ];
}

function toolEmptyHistoryItems(locale: Locale): LibraryItem[] {
  return [
    {
      title: locale === "zh" ? "暂无调用记录" : "No call history",
      meta: locale === "zh" ? "等待首次调用" : "Waiting for first call",
      description:
        locale === "zh"
          ? "调用 MCP 工具或读取资源后，结果会写入后端工具验证线程。"
          : "Call an MCP tool or read a resource to write results into the backend tool verification thread.",
      glyph: "◷",
      accent: "slate",
    },
  ];
}

function promptPreview(text: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  return normalizedText.length > 72
    ? `${normalizedText.slice(0, 69)}...`
    : normalizedText;
}

function threadTitle(thread: Thread, fallback: string): string {
  return thread.name || thread.preview || fallback;
}

function getInitialSidebarOpen(): boolean {
  return window.innerWidth > 860;
}

function shouldAutoCloseSidebar(): boolean {
  return window.innerWidth <= 860;
}

function shouldAutoCloseInspector(
  sidebarOpen: boolean,
  rightSidebarOpen: boolean,
): boolean {
  const sidebarWidth = sidebarOpen ? 240 : 0;
  const rightSidebarWidth = rightSidebarOpen
    ? Math.max(320, window.innerWidth * 0.38)
    : 0;
  return window.innerWidth - sidebarWidth - rightSidebarWidth < 760;
}

function shouldUseDemoPreview(): boolean {
  return new URLSearchParams(window.location.search).get("demoItems") === "1";
}

function isDemoThreadId(threadId: string | null | undefined): boolean {
  return Boolean(threadId?.startsWith("demo-"));
}

function isMissingThreadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("thread not found") ||
      error.message.includes("invalid thread id"))
  );
}

function getInitialLibraryView(): LibraryKind | null {
  const view = new URLSearchParams(window.location.search).get("view");

  switch (view) {
    case "plugins":
      return "plugins";
    case "tools":
      return "tools";
    case "agents":
      return "agents";
    case "office":
      return "office";
    case "automation":
      return "automation";
    case "knowledge":
      return "knowledge";
    default:
      return null;
  }
}

function getInitialAppView(): AppView {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "settings") {
    return "settings";
  }
  if (getInitialLibraryView()) {
    return "library";
  }
  return "chat";
}

function getInitialSettingsSection(): SettingsSection {
  const section = new URLSearchParams(window.location.search).get("section");
  switch (section) {
    case "appearance":
    case "app-snapshots":
    case "browser":
    case "computer-control":
    case "config":
    case "connections":
    case "environment":
    case "git":
    case "hooks":
    case "keyboard":
    case "mcp-servers":
    case "personalization":
    case "worktrees":
      return section;
    default:
      return "account";
  }
}

function localizeSeedDemoThreads(
  currentThreads: Thread[],
  locale: Locale,
): Thread[] {
  const seedThreads = getDemoThreads(locale);
  const seedThreadById = new Map(
    seedThreads.map((thread) => [thread.id, thread]),
  );
  return currentThreads.map(
    (thread) => seedThreadById.get(thread.id) ?? thread,
  );
}

function getParamString(params: unknown, key: string): string | null {
  if (!params || typeof params !== "object" || !(key in params)) {
    return null;
  }

  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function getParamDisplay(params: unknown, key: string): string | null {
  if (!params || typeof params !== "object" || !(key in params)) {
    return null;
  }

  const value = (params as Record<string, unknown>)[key];
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry) => String(entry)).join(" ");
  }

  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return null;
}

function grantedPermissionsFromRequest(
  params: unknown,
): Record<string, unknown> {
  if (!params || typeof params !== "object" || !("permissions" in params)) {
    return {};
  }

  const requested = (params as { permissions?: unknown }).permissions;
  if (!requested || typeof requested !== "object") {
    return {};
  }

  const record = requested as Record<string, unknown>;
  return Object.fromEntries(
    ["network", "fileSystem"].flatMap((key) => {
      const value = record[key];
      return value && typeof value === "object" ? [[key, value]] : [];
    }),
  );
}

function getUserInputQuestions(
  params: unknown,
): Array<{ id: string; label: string; placeholder?: string; secret: boolean }> {
  if (!params || typeof params !== "object" || !("questions" in params)) {
    return [];
  }

  const questions = (params as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) {
    return [];
  }

  return questions.flatMap((question) => {
    if (!question || typeof question !== "object") {
      return [];
    }

    const record = question as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    if (!id) {
      return [];
    }

    const header = typeof record.header === "string" ? record.header : "";
    const prompt = typeof record.question === "string" ? record.question : "";
    const options = Array.isArray(record.options)
      ? record.options
          .flatMap((option) =>
            option &&
            typeof option === "object" &&
            typeof (option as Record<string, unknown>).label === "string"
              ? [(option as Record<string, string>).label]
              : [],
          )
          .join(" / ")
      : "";
    const label = [header, prompt].filter(Boolean).join(" - ") || id;
    return [
      {
        id,
        label,
        placeholder: options || undefined,
        secret: record.isSecret === true,
      },
    ];
  });
}

function getDynamicToolDetails(params: unknown): {
  title: string;
  body: string;
} {
  if (!params || typeof params !== "object") {
    return { title: "tool", body: "" };
  }

  const record = params as Record<string, unknown>;
  const namespace =
    typeof record.namespace === "string" && record.namespace
      ? `${record.namespace}.`
      : "";
  const tool =
    typeof record.tool === "string" && record.tool ? record.tool : "tool";
  const callId = typeof record.callId === "string" ? record.callId : "";
  const threadId = typeof record.threadId === "string" ? record.threadId : "";
  const turnId = typeof record.turnId === "string" ? record.turnId : "";
  const args = "arguments" in record ? record.arguments : null;
  const argsText =
    args === null || args === undefined
      ? ""
      : (() => {
          try {
            return JSON.stringify(args, null, 2);
          } catch {
            return String(args);
          }
        })();

  return {
    title: `${namespace}${tool}`,
    body: [
      callId ? `callId: ${callId}` : null,
      threadId ? `threadId: ${threadId}` : null,
      turnId ? `turnId: ${turnId}` : null,
      argsText ? `arguments:\n${argsText}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function getMcpElicitationDetails(params: unknown): {
  title: string;
  body: string;
  placeholder: string;
} {
  if (!params || typeof params !== "object") {
    return { title: "MCP", body: "", placeholder: "{}" };
  }

  const record = params as Record<string, unknown>;
  const serverName =
    typeof record.serverName === "string" ? record.serverName : "MCP";
  const mode = typeof record.mode === "string" ? record.mode : "request";
  const message = typeof record.message === "string" ? record.message : "";
  const url = typeof record.url === "string" ? record.url : "";
  const requestedSchema =
    "requestedSchema" in record ? record.requestedSchema : null;
  const schemaText =
    requestedSchema === null || requestedSchema === undefined
      ? ""
      : (() => {
          try {
            return JSON.stringify(requestedSchema, null, 2);
          } catch {
            return String(requestedSchema);
          }
        })();

  return {
    title: `${serverName} · ${mode}`,
    body: [
      message,
      url ? `url: ${url}` : null,
      schemaText ? `schema:\n${schemaText}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    placeholder: mode === "form" ? "{}" : "",
  };
}

function joinPath(basePath: string, childName: string): string {
  const separator = basePath.includes("\\") ? "\\" : "/";
  return `${basePath.replace(/[\\/]+$/, "")}${separator}${childName}`;
}

function resolveSearchPath(root: string, resultPath: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(resultPath)) {
    return resultPath;
  }

  return joinPath(root, resultPath);
}

function pathBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function pathDirName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function decodeBase64Text(dataBase64: string): string {
  const bytes = Uint8Array.from(window.atob(dataBase64), (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

function knowledgePreviewFromText(text: string, fallback: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(
        (item) =>
          item &&
          !item.startsWith("---") &&
          !item.startsWith("#") &&
          !item.startsWith("<") &&
          !item.startsWith(">"),
      ) ?? fallback;
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function knowledgeTitleFromPath(path: string): string {
  const fileName = pathBaseName(path);
  return fileName.replace(/\.(md|mdx|txt)$/i, "") || fileName;
}

function accountStatusText(
  accountStatus: AccountStatus | null,
  locale: Locale,
): string {
  if (!accountStatus) {
    return locale === "zh"
      ? "正在读取账号状态..."
      : "Reading account status...";
  }

  if (!accountStatus.account) {
    return accountStatus.requiresOpenaiAuth
      ? locale === "zh"
        ? "需要模型账号授权"
        : "Model account auth required"
      : locale === "zh"
        ? "当前未登录"
        : "Signed out";
  }

  switch (accountStatus.account.type) {
    case "apiKey":
      return "API Key";
    case "amazonBedrock":
      return "Amazon Bedrock";
    case "chatgpt":
      return `${accountStatus.account.email}\n${accountStatus.account.planType}`;
  }
}

function authStatusText(
  authStatus: GetAuthStatusResponse | null,
  locale: Locale,
): string {
  if (!authStatus) {
    return "";
  }

  return [
    locale === "zh" ? "认证状态" : "Auth status",
    `${locale === "zh" ? "方式" : "Method"}: ${authStatus.authMethod ?? (locale === "zh" ? "未设置" : "not set")}`,
    `${locale === "zh" ? "需要模型账号授权" : "Requires model account auth"}: ${
      authStatus.requiresOpenaiAuth
        ? locale === "zh"
          ? "是"
          : "yes"
        : locale === "zh"
          ? "否"
          : "no"
    }`,
  ].join("\n");
}

function stringifyNumeric(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === "bigint" ? value.toLocaleString() : String(value);
}

function formatUnixSeconds(
  value: number | null | undefined,
  locale: Locale,
): string | null {
  if (!value) {
    return null;
  }

  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1000));
}

function formatUnixMillis(
  value: number | null | undefined,
  locale: Locale,
): string | null {
  if (!value) {
    return null;
  }

  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function fileMetadataText(
  metadata: FsGetMetadataResponse | null | undefined,
  locale: Locale,
): string {
  if (!metadata) {
    return "";
  }

  const kind = metadata.isDirectory
    ? locale === "zh"
      ? "目录"
      : "directory"
    : metadata.isFile
      ? locale === "zh"
        ? "文件"
        : "file"
      : metadata.isSymlink
        ? locale === "zh"
          ? "符号链接"
          : "symlink"
        : locale === "zh"
          ? "路径"
          : "path";
  const modified = formatUnixMillis(metadata.modifiedAtMs, locale);
  const created = formatUnixMillis(metadata.createdAtMs, locale);

  return [
    `${locale === "zh" ? "类型" : "Type"}: ${kind}`,
    modified ? `${locale === "zh" ? "修改" : "Modified"}: ${modified}` : null,
    created ? `${locale === "zh" ? "创建" : "Created"}: ${created}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function filePanelSearchControls(
  locale: Locale,
  root: string,
  value = "",
): Pick<CapabilityPanel, "actions" | "fields"> {
  return {
    fields: [
      {
        id: "file-search",
        label: locale === "zh" ? "搜索文件" : "Search files",
        placeholder: locale === "zh" ? "输入文件名或路径" : "File name or path",
        value,
      },
      {
        id: "file-search-root",
        label: locale === "zh" ? "搜索范围" : "Search root",
        value: root,
      },
    ],
    actions: [
      {
        id: "create-context-note",
        label: locale === "zh" ? "新建上下文笔记" : "New context note",
      },
      {
        id: "search-files",
        label: locale === "zh" ? "搜索" : "Search",
        tone: "primary",
      },
      {
        id: "watch-current-path",
        label: locale === "zh" ? "开始监听" : "Watch",
      },
      {
        id: "unwatch-current-path",
        label: locale === "zh" ? "停止监听" : "Unwatch",
      },
      { id: "clear-file-search", label: locale === "zh" ? "清空" : "Clear" },
    ],
  };
}

function backgroundTerminalLabel(
  terminal: BackgroundTerminal,
  locale: Locale,
): string {
  const metrics = [
    terminal.osPid ? `pid ${terminal.osPid}` : null,
    terminal.cpuPercent == null
      ? null
      : `cpu ${terminal.cpuPercent.toFixed(1)}%`,
    terminal.rssKb == null ? null : `rss ${Math.round(terminal.rssKb / 1024)}MB`,
  ]
    .filter(Boolean)
    .join(" · ");
  const title = terminal.command || terminal.processId;
  const suffix = metrics ? `  ${metrics}` : "";
  const cwd = String(terminal.cwd);
  return `${title}${suffix}\n${locale === "zh" ? "目录" : "cwd"} ${cwd}`;
}

function rateLimitText(
  snapshot: RateLimitSnapshot | null | undefined,
  locale: Locale,
): string[] {
  if (!snapshot) {
    return [];
  }

  const name =
    snapshot.limitName ||
    snapshot.limitId ||
    (locale === "zh" ? "默认额度" : "Default limit");
  const lines = [`${locale === "zh" ? "额度" : "Rate limit"}: ${name}`];

  if (snapshot.primary) {
    const reset = formatUnixSeconds(snapshot.primary.resetsAt, locale);
    lines.push(
      `${locale === "zh" ? "主窗口" : "Primary"}: ${Math.round(snapshot.primary.usedPercent)}%${
        reset ? ` · ${locale === "zh" ? "重置" : "resets"} ${reset}` : ""
      }`,
    );
  }

  if (snapshot.secondary) {
    const reset = formatUnixSeconds(snapshot.secondary.resetsAt, locale);
    lines.push(
      `${locale === "zh" ? "次窗口" : "Secondary"}: ${Math.round(snapshot.secondary.usedPercent)}%${
        reset ? ` · ${locale === "zh" ? "重置" : "resets"} ${reset}` : ""
      }`,
    );
  }

  if (snapshot.credits) {
    const balance = snapshot.credits.unlimited
      ? locale === "zh"
        ? "无限"
        : "unlimited"
      : (snapshot.credits.balance ?? "0");
    lines.push(`${locale === "zh" ? "余额" : "Credits"}: ${balance}`);
  }

  if (snapshot.individualLimit) {
    lines.push(
      `${locale === "zh" ? "月度限制" : "Monthly limit"}: ${snapshot.individualLimit.used}/${snapshot.individualLimit.limit} · ${
        locale === "zh" ? "剩余" : "remaining"
      } ${Math.round(snapshot.individualLimit.remainingPercent)}%`,
    );
  }

  if (snapshot.rateLimitReachedType) {
    lines.push(
      `${locale === "zh" ? "限制状态" : "Limit state"}: ${snapshot.rateLimitReachedType}`,
    );
  }

  return lines;
}

function accountTelemetryText(
  rateLimits: GetAccountRateLimitsResponse | null,
  usage: GetAccountTokenUsageResponse | null,
  locale: Locale,
): string {
  const lines: string[] = [];

  if (rateLimits) {
    lines.push(...rateLimitText(rateLimits.rateLimits, locale));
  }

  if (usage) {
    lines.push(locale === "zh" ? "用量" : "Usage");
    const lifetimeTokens = stringifyNumeric(usage.summary.lifetimeTokens);
    const peakDailyTokens = stringifyNumeric(usage.summary.peakDailyTokens);
    const currentStreakDays = stringifyNumeric(usage.summary.currentStreakDays);
    const latestBucket =
      usage.dailyUsageBuckets?.[usage.dailyUsageBuckets.length - 1];

    if (lifetimeTokens) {
      lines.push(
        `${locale === "zh" ? "累计 Tokens" : "Lifetime tokens"}: ${lifetimeTokens}`,
      );
    }

    if (peakDailyTokens) {
      lines.push(
        `${locale === "zh" ? "单日峰值" : "Peak daily"}: ${peakDailyTokens}`,
      );
    }

    if (currentStreakDays) {
      lines.push(
        `${locale === "zh" ? "连续使用" : "Current streak"}: ${currentStreakDays} ${locale === "zh" ? "天" : "days"}`,
      );
    }

    if (latestBucket) {
      lines.push(
        `${locale === "zh" ? "最近一天" : "Latest day"}: ${latestBucket.startDate} · ${stringifyNumeric(latestBucket.tokens) ?? "0"}`,
      );
    }
  }

  return lines.join("\n");
}

function workspaceCapabilitiesText(
  models: ModelListResponse | null,
  permissionProfiles: PermissionProfileListResponse | null,
  providerCapabilities: ModelProviderCapabilitiesReadResponse | null,
  locale: Locale,
): string {
  const lines: string[] = [];

  if (models) {
    const defaultModel =
      models.data.find((model) => model.isDefault) ?? models.data[0];
    const modelNames = models.data
      .slice(0, 4)
      .map((model) => model.displayName || model.model || model.id)
      .join(", ");
    lines.push(
      `${locale === "zh" ? "模型" : "Models"}: ${models.data.length}${defaultModel ? ` · ${defaultModel.displayName}` : ""}`,
    );
    if (modelNames) {
      lines.push(modelNames);
    }
  }

  if (providerCapabilities) {
    const enabled = [
      providerCapabilities.webSearch
        ? locale === "zh"
          ? "网页搜索"
          : "web search"
        : null,
      providerCapabilities.imageGeneration
        ? locale === "zh"
          ? "图像生成"
          : "image generation"
        : null,
      providerCapabilities.namespaceTools
        ? locale === "zh"
          ? "命名空间工具"
          : "namespaced tools"
        : null,
    ].filter(Boolean);
    lines.push(
      `${locale === "zh" ? "Provider 能力" : "Provider"}: ${enabled.length > 0 ? enabled.join(", ") : locale === "zh" ? "基础能力" : "basic"}`,
    );
  }

  if (permissionProfiles) {
    const profileNames = permissionProfiles.data
      .slice(0, 5)
      .map((profile) => profile.id)
      .join(", ");
    lines.push(
      `${locale === "zh" ? "权限档案" : "Permission profiles"}: ${profileNames || (locale === "zh" ? "暂无" : "none")}`,
    );
  }

  return lines.join("\n");
}

function configSummaryText(
  configRead: ConfigReadResponse | null,
  locale: Locale,
): string {
  if (!configRead) {
    return "";
  }

  const { config } = configRead;
  const approvalPolicy =
    typeof config.approval_policy === "string"
      ? config.approval_policy
      : config.approval_policy
        ? locale === "zh"
          ? "细粒度"
          : "granular"
        : null;
  const enabledTools = [
    config.tools?.web_search
      ? locale === "zh"
        ? "网页搜索"
        : "web search"
      : null,
  ].filter(Boolean);
  const lines = [
    locale === "zh" ? "配置" : "Config",
    config.model
      ? `${locale === "zh" ? "模型" : "Model"}: ${config.model}`
      : null,
    config.model_provider ? `Provider: ${config.model_provider}` : null,
    approvalPolicy
      ? `${locale === "zh" ? "审批" : "Approval"}: ${approvalPolicy}`
      : null,
    config.sandbox_mode
      ? `${locale === "zh" ? "沙箱" : "Sandbox"}: ${config.sandbox_mode}`
      : null,
    config.web_search
      ? `${locale === "zh" ? "网页搜索" : "Web search"}: ${config.web_search}`
      : null,
    enabledTools.length > 0
      ? `${locale === "zh" ? "工具" : "Tools"}: ${enabledTools.join(", ")}`
      : null,
    `${locale === "zh" ? "配置层" : "Layers"}: ${configRead.layers?.length ?? 0}`,
    `${locale === "zh" ? "来源项" : "Origins"}: ${Object.keys(configRead.origins).length}`,
  ];

  return lines.filter(Boolean).join("\n");
}

function configRequirementsText(
  configRequirements: ConfigRequirementsReadResponse | null,
  locale: Locale,
): string {
  const requirements = configRequirements?.requirements;

  if (!requirements) {
    return locale === "zh" ? "配置约束: 无" : "Config requirements: none";
  }

  const enabledFeatureRequirements = Object.entries(
    requirements.featureRequirements ?? {},
  )
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const permissionProfiles = Object.entries(
    requirements.allowedPermissionProfiles ?? {},
  )
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const lines = [
    locale === "zh" ? "配置约束" : "Config requirements",
    requirements.allowedApprovalPolicies
      ? `${locale === "zh" ? "审批策略" : "Approval policies"}: ${requirements.allowedApprovalPolicies
          .map((policy) =>
            typeof policy === "string"
              ? policy
              : locale === "zh"
                ? "细粒度"
                : "granular",
          )
          .join(", ")}`
      : null,
    requirements.allowedSandboxModes
      ? `${locale === "zh" ? "沙箱" : "Sandbox"}: ${requirements.allowedSandboxModes.join(", ")}`
      : null,
    requirements.allowedWebSearchModes
      ? `${locale === "zh" ? "网页搜索" : "Web search"}: ${requirements.allowedWebSearchModes.join(", ")}`
      : null,
    permissionProfiles.length > 0
      ? `${locale === "zh" ? "权限档案" : "Permission profiles"}: ${permissionProfiles.join(", ")}`
      : null,
    requirements.defaultPermissions
      ? `${locale === "zh" ? "默认权限" : "Default permissions"}: ${requirements.defaultPermissions}`
      : null,
    requirements.allowManagedHooksOnly !== null
      ? `${locale === "zh" ? "仅托管 Hooks" : "Managed hooks only"}: ${requirements.allowManagedHooksOnly ? "yes" : "no"}`
      : null,
    requirements.allowAppshots !== null
      ? `Appshots: ${requirements.allowAppshots ? "yes" : "no"}`
      : null,
    requirements.computerUse?.allowLockedComputerUse !== null &&
    requirements.computerUse?.allowLockedComputerUse !== undefined
      ? `${locale === "zh" ? "锁屏电脑控制" : "Locked computer use"}: ${requirements.computerUse.allowLockedComputerUse ? "yes" : "no"}`
      : null,
    requirements.enforceResidency
      ? `${locale === "zh" ? "数据驻留" : "Residency"}: ${requirements.enforceResidency}`
      : null,
    enabledFeatureRequirements.length > 0
      ? `${locale === "zh" ? "特性要求" : "Feature requirements"}: ${enabledFeatureRequirements.join(", ")}`
      : null,
  ];

  return lines.filter(Boolean).join("\n");
}

function configDesktopValue(
  configRead: ConfigReadResponse | null,
  key: string,
): string {
  const value = configRead?.config.desktop?.[key];
  return typeof value === "string" ? value : "";
}

function appearanceSettingsText(
  configRead: ConfigReadResponse | null,
  locale: Locale,
): string {
  const configuredLocale = configDesktopValue(configRead, "uiLocale");
  const configuredTheme = configDesktopValue(configRead, "appearanceTheme");
  return [
    locale === "zh" ? "外观" : "Appearance",
    `${locale === "zh" ? "语言" : "Language"}: ${
      configuredLocale || (locale === "zh" ? "跟随当前界面" : "follow current UI")
    }`,
    `${locale === "zh" ? "主题" : "Theme"}: ${
      configuredTheme || (locale === "zh" ? "跟随系统/当前界面" : "system/current")
    }`,
    `${locale === "zh" ? "配置层" : "Config layers"}: ${configRead?.layers?.length ?? 0}`,
    locale === "zh"
      ? "外观设置会写入桌面端配置，并立即应用到当前界面。"
      : "Appearance settings are written to desktop config and applied immediately.",
  ].join("\n");
}

function personalizationSettingsText(
  configRead: ConfigReadResponse | null,
  locale: Locale,
): string {
  const instructions = configRead?.config.instructions?.trim() ?? "";
  const developerInstructions =
    configRead?.config.developer_instructions?.trim() ?? "";
  return [
    locale === "zh" ? "个性化" : "Personalization",
    `${locale === "zh" ? "个人指令" : "Instructions"}: ${
      instructions
        ? locale === "zh"
          ? "已配置"
          : "configured"
        : locale === "zh"
          ? "未配置"
          : "not configured"
    }`,
    `${locale === "zh" ? "开发者指令" : "Developer instructions"}: ${
      developerInstructions
        ? locale === "zh"
          ? "已配置"
          : "configured"
        : locale === "zh"
          ? "未配置"
          : "not configured"
    }`,
    `${locale === "zh" ? "配置层" : "Config layers"}: ${configRead?.layers?.length ?? 0}`,
    locale === "zh"
      ? "这些内容会通过 app-server 写入配置，影响新会话和后续任务的默认行为。"
      : "These values are written through app-server config and affect defaults for new sessions and future tasks.",
  ].join("\n");
}

function keyboardSettingsText(
  configRead: ConfigReadResponse | null,
  locale: Locale,
): string {
  const shortcuts =
    locale === "zh"
      ? [
          "新对话: ⌘N / Ctrl N",
          "搜索: ⌘K / Ctrl K",
          "发送: ⌘ Enter / Ctrl Enter",
          "审查: ⌃⇧G",
          "浏览器: ⌘T",
          "文件: ⌘P",
          "侧边聊天: ⌥⌘S",
        ]
      : [
          "New chat: ⌘N / Ctrl N",
          "Search: ⌘K / Ctrl K",
          "Send: ⌘ Enter / Ctrl Enter",
          "Review: ⌃⇧G",
          "Browser: ⌘T",
          "Files: ⌘P",
          "Side chat: ⌥⌘S",
        ];
  return [
    locale === "zh" ? "键盘快捷键" : "Keyboard shortcuts",
    shortcuts.map((shortcut) => `- ${shortcut}`).join("\n"),
    `${locale === "zh" ? "配置层" : "Config layers"}: ${configRead?.layers?.length ?? 0}`,
    locale === "zh"
      ? "当前 app-server 协议尚未暴露快捷键写入 API；此页读取配置状态并展示当前桌面端绑定。"
      : "The current app-server protocol does not expose shortcut-write APIs yet. This page reads config state and shows the active desktop bindings.",
  ].join("\n");
}

function environmentSettingsText(
  configRequirements: ConfigRequirementsReadResponse | null,
  windowsSandboxStatus: string | null,
  windowsSandboxError: string | null,
  locale: Locale,
): string {
  const requirements = configRequirements?.requirements;
  const allowedSandboxModes = requirements?.allowedSandboxModes ?? [];
  const allowedWindowsSandbox =
    requirements?.allowedWindowsSandboxImplementations ?? [];
  const featureRequirements = Object.entries(
    requirements?.featureRequirements ?? {},
  )
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const computerUse = requirements?.computerUse;
  const lines = [
    locale === "zh" ? "运行环境" : "Runtime environment",
    `${locale === "zh" ? "沙箱模式" : "Sandbox modes"}: ${
      allowedSandboxModes.length > 0
        ? allowedSandboxModes.join(", ")
        : locale === "zh"
          ? "未限制"
          : "not restricted"
    }`,
    `${locale === "zh" ? "Windows 沙箱实现" : "Windows sandbox implementations"}: ${
      allowedWindowsSandbox.length > 0
        ? allowedWindowsSandbox.join(", ")
        : locale === "zh"
          ? "未配置"
          : "not configured"
    }`,
    `${locale === "zh" ? "Windows 沙箱状态" : "Windows sandbox status"}: ${
      windowsSandboxStatus ??
      (windowsSandboxError
        ? locale === "zh"
          ? "读取失败"
          : "read failed"
        : locale === "zh"
          ? "未知"
          : "unknown")
    }`,
    windowsSandboxError
      ? `${locale === "zh" ? "Windows 沙箱错误" : "Windows sandbox error"}: ${windowsSandboxError}`
      : null,
    computerUse?.allowLockedComputerUse !== null &&
    computerUse?.allowLockedComputerUse !== undefined
      ? `${locale === "zh" ? "锁屏电脑控制" : "Locked computer use"}: ${computerUse.allowLockedComputerUse ? "yes" : "no"}`
      : null,
    requirements?.allowedWebSearchModes
      ? `${locale === "zh" ? "网页搜索模式" : "Web search modes"}: ${requirements.allowedWebSearchModes.join(", ")}`
      : null,
    requirements?.enforceResidency
      ? `${locale === "zh" ? "数据驻留" : "Residency"}: ${requirements.enforceResidency}`
      : null,
    featureRequirements.length > 0
      ? `${locale === "zh" ? "特性要求" : "Feature requirements"}: ${featureRequirements.join(", ")}`
      : null,
  ];

  return lines.filter(Boolean).join("\n");
}

function appSnapshotsSettingsText(
  configRequirements: ConfigRequirementsReadResponse | null,
  locale: Locale,
): string {
  const requirements = configRequirements?.requirements;
  const featureRequirements = Object.entries(
    requirements?.featureRequirements ?? {},
  )
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const allowed = requirements?.allowAppshots;
  const lines = [
    locale === "zh" ? "应用快照" : "App snapshots",
    `${locale === "zh" ? "状态" : "Status"}: ${
      allowed === null || allowed === undefined
        ? locale === "zh"
          ? "未受策略限制"
          : "not policy restricted"
        : allowed
          ? locale === "zh"
            ? "允许"
            : "allowed"
          : locale === "zh"
            ? "禁用"
            : "disabled"
    }`,
    `${locale === "zh" ? "用途" : "Purpose"}: ${
      locale === "zh"
        ? "为应用、浏览器和电脑操控能力提供可审计的状态快照。"
        : "Provide auditable state snapshots for apps, browser, and computer-control capabilities."
    }`,
    requirements?.enforceResidency
      ? `${locale === "zh" ? "数据驻留" : "Residency"}: ${requirements.enforceResidency}`
      : null,
    featureRequirements.length > 0
      ? `${locale === "zh" ? "相关特性要求" : "Related feature requirements"}: ${featureRequirements.join(", ")}`
      : null,
    requirements?.allowManagedHooksOnly !== null &&
    requirements?.allowManagedHooksOnly !== undefined
      ? `${locale === "zh" ? "仅托管 Hook" : "Managed hooks only"}: ${requirements.allowManagedHooksOnly ? "yes" : "no"}`
      : null,
  ];

  return lines.filter(Boolean).join("\n");
}

function connectionsSettingsText(
  account: GetAccountResponse | null,
  auth: GetAuthStatusResponse | null,
  providerCapabilities: ModelProviderCapabilitiesReadResponse | null,
  configRequirements: ConfigRequirementsReadResponse | null,
  plugins: PluginListResponse | null,
  apps: AppsListResponse | null,
  errors: string[],
  locale: Locale,
): string {
  const pluginCount = (plugins?.marketplaces ?? []).reduce(
    (total, marketplace) => total + marketplace.plugins.length,
    0,
  );
  const appCount = apps?.data.length ?? 0;
  const enabledApps = apps?.data.filter((app) => app.isEnabled).length ?? 0;
  const accessibleApps =
    apps?.data.filter((app) => app.isAccessible).length ?? 0;
  const marketplaceNames = (plugins?.marketplaces ?? [])
    .slice(0, 8)
    .map((marketplace) => marketplace.name);
  const appNames = (apps?.data ?? []).slice(0, 8).map((app) => {
    const status = app.isAccessible
      ? locale === "zh"
        ? "可访问"
        : "accessible"
      : locale === "zh"
        ? "需授权"
        : "needs auth";
    return `${app.name} (${status})`;
  });
  const requirements = configRequirements?.requirements;
  const capabilityLines = providerCapabilities
    ? [
        `namespaceTools: ${providerCapabilities.namespaceTools ? "yes" : "no"}`,
        `imageGeneration: ${providerCapabilities.imageGeneration ? "yes" : "no"}`,
        `webSearch: ${providerCapabilities.webSearch ? "yes" : "no"}`,
      ]
    : [];

  return [
    locale === "zh" ? "连接状态" : "Connection status",
    `${locale === "zh" ? "账号" : "Account"}: ${accountStatusText(account, locale)}`,
    `${locale === "zh" ? "认证方式" : "Auth method"}: ${auth?.authMethod ?? "unknown"}`,
    `${locale === "zh" ? "需要 OpenAI 授权" : "Requires OpenAI auth"}: ${
      auth?.requiresOpenaiAuth === null || auth?.requiresOpenaiAuth === undefined
        ? "unknown"
        : auth.requiresOpenaiAuth
          ? "yes"
          : "no"
    }`,
    capabilityLines.length > 0
      ? `${locale === "zh" ? "模型供应商能力" : "Provider capabilities"}\n- ${capabilityLines.join("\n- ")}`
      : null,
    `${locale === "zh" ? "插件市场" : "Plugin marketplaces"}: ${
      plugins?.marketplaces.length ?? 0
    } · ${locale === "zh" ? "插件" : "plugins"}: ${pluginCount}`,
    marketplaceNames.length > 0
      ? `${locale === "zh" ? "市场" : "Marketplaces"}: ${marketplaceNames.join(", ")}`
      : null,
    `${locale === "zh" ? "应用连接器" : "App connectors"}: ${appCount} · ${
      locale === "zh" ? "启用" : "enabled"
    }: ${enabledApps} · ${locale === "zh" ? "可访问" : "accessible"}: ${accessibleApps}`,
    appNames.length > 0
      ? `${locale === "zh" ? "应用" : "Apps"}: ${appNames.join(", ")}`
      : null,
    requirements?.allowedWebSearchModes
      ? `${locale === "zh" ? "网页搜索策略" : "Web search policy"}: ${requirements.allowedWebSearchModes.join(", ")}`
      : null,
    requirements?.enforceResidency
      ? `${locale === "zh" ? "数据驻留" : "Residency"}: ${requirements.enforceResidency}`
      : null,
    errors.length > 0
      ? `${locale === "zh" ? "部分连接读取失败" : "Some connection reads failed"}\n- ${errors.join("\n- ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function gitSettingsText(
  cwd: string | null,
  thread: Thread | null,
  summary: ConversationSummary | null,
  remoteDiff: GitRemoteDiffSummary | null,
  configRead: ConfigReadResponse | null,
  locale: Locale,
): string {
  const threadGit = thread?.gitInfo ?? null;
  const summaryGit = summary?.gitInfo ?? null;
  const branch = threadGit?.branch ?? summaryGit?.branch ?? null;
  const sha = threadGit?.sha ?? summaryGit?.sha ?? remoteDiff?.sha ?? null;
  const origin =
    threadGit?.originUrl ??
    (summaryGit && "origin_url" in summaryGit ? summaryGit.origin_url : null) ??
    null;
  const diffLine =
    remoteDiff?.status === "ready"
      ? `${remoteDiff.files} files · +${remoteDiff.added} -${remoteDiff.removed}`
      : remoteDiff?.status === "loading"
        ? locale === "zh"
          ? "读取中"
          : "loading"
        : remoteDiff?.status === "error"
          ? remoteDiff.error
          : locale === "zh"
            ? "未读取"
            : "not read";

  return [
    locale === "zh" ? "Git 工作区" : "Git workspace",
    `${locale === "zh" ? "路径" : "Path"}: ${cwd ?? (locale === "zh" ? "未选择" : "not selected")}`,
    branch ? `${locale === "zh" ? "分支" : "Branch"}: ${branch}` : null,
    sha ? `SHA: ${sha}` : null,
    origin ? `${locale === "zh" ? "远端" : "Remote"}: ${origin}` : null,
    `${locale === "zh" ? "远端差异" : "Remote diff"}: ${diffLine}`,
    configRead?.config?.approval_policy
      ? `${locale === "zh" ? "审批策略" : "Approval policy"}: ${
          typeof configRead.config.approval_policy === "string"
            ? configRead.config.approval_policy
            : locale === "zh"
              ? "细粒度"
              : "granular"
        }`
      : null,
    configRead?.config?.sandbox_mode
      ? `${locale === "zh" ? "沙箱" : "Sandbox"}: ${configRead.config.sandbox_mode}`
      : null,
    `${locale === "zh" ? "配置层" : "Config layers"}: ${configRead?.layers?.length ?? 0}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function worktreesSettingsText(
  cwd: string | null,
  thread: Thread | null,
  relatedThreads: Thread[],
  summary: ConversationSummary | null,
  remoteDiff: GitRemoteDiffSummary | null,
  locale: Locale,
): string {
  const threadGit = thread?.gitInfo ?? null;
  const summaryGit = summary?.gitInfo ?? null;
  const branch = threadGit?.branch ?? summaryGit?.branch ?? null;
  const sha = threadGit?.sha ?? summaryGit?.sha ?? remoteDiff?.sha ?? null;
  const diffLine =
    remoteDiff?.status === "ready"
      ? `${remoteDiff.files} files · +${remoteDiff.added} -${remoteDiff.removed}`
      : remoteDiff?.status === "error"
        ? remoteDiff.error
        : locale === "zh"
          ? "未读取"
          : "not read";
  const currentTitle = thread ? threadTitle(thread, "") : null;
  const relatedLines = relatedThreads.slice(0, 6).map((candidate) => {
    const title = threadTitle(candidate, "") || candidate.id;
    const status =
      typeof candidate.status === "string"
        ? candidate.status
        : JSON.stringify(candidate.status);
    const forked = candidate.forkedFromId
      ? locale === "zh"
        ? " · 分叉"
        : " · fork"
      : "";
    return `- ${title} · ${status}${forked}`;
  });

  return [
    locale === "zh" ? "工作树" : "Worktrees",
    `${locale === "zh" ? "工作区路径" : "Workspace"}: ${
      cwd ?? (locale === "zh" ? "未选择" : "not selected")
    }`,
    currentTitle
      ? `${locale === "zh" ? "当前会话" : "Current session"}: ${currentTitle}`
      : null,
    thread?.id ? `${locale === "zh" ? "会话 ID" : "Thread ID"}: ${thread.id}` : null,
    thread?.threadSource
      ? `${locale === "zh" ? "来源" : "Source"}: ${thread.threadSource}`
      : null,
    branch ? `${locale === "zh" ? "分支" : "Branch"}: ${branch}` : null,
    sha ? `SHA: ${sha}` : null,
    `${locale === "zh" ? "远端差异" : "Remote diff"}: ${diffLine}`,
    `${locale === "zh" ? "同工作区会话" : "Sessions in workspace"}: ${relatedThreads.length}`,
    relatedLines.length > 0 ? relatedLines.join("\n") : null,
    locale === "zh"
      ? "新建会话会在当前工作区打开独立对话；分叉会话会保留当前上下文，适合并行验证不同方案。"
      : "New sessions open an independent conversation in this workspace. Forked sessions keep the current context for parallel exploration.",
  ]
    .filter(Boolean)
    .join("\n");
}

function remoteControlSettingsText(
  status: RemoteControlStatusResponse | null,
  clients: RemoteControlClient[],
  clientError: string | null,
  locale: Locale,
): string {
  const clientLines = clients.slice(0, 12).map((client) => {
    const name =
      client.displayName ||
      client.deviceModel ||
      client.platform ||
      client.clientId;
    const lastSeen = client.lastSeenAt
      ? new Date(client.lastSeenAt * 1000).toLocaleString()
      : locale === "zh"
        ? "未知"
        : "unknown";
    return [
      `- ${name}`,
      `  clientId: ${client.clientId}`,
      client.deviceType ? `  type: ${client.deviceType}` : null,
      client.platform ? `  platform: ${client.platform}` : null,
      client.osVersion ? `  os: ${client.osVersion}` : null,
      client.appVersion ? `  app: ${client.appVersion}` : null,
      `  lastSeen: ${lastSeen}`,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    locale === "zh" ? "电脑操控" : "Computer control",
    `${locale === "zh" ? "状态" : "Status"}: ${status?.status ?? "unknown"}`,
    status?.serverName
      ? `${locale === "zh" ? "服务" : "Server"}: ${status.serverName}`
      : null,
    status?.installationId
      ? `${locale === "zh" ? "安装 ID" : "Installation ID"}: ${status.installationId}`
      : null,
    `${locale === "zh" ? "环境 ID" : "Environment ID"}: ${
      status?.environmentId ?? (locale === "zh" ? "未绑定" : "not bound")
    }`,
    `${locale === "zh" ? "已配对设备" : "Paired clients"}: ${clients.length}`,
    clientError
      ? `${locale === "zh" ? "设备读取错误" : "Client list error"}: ${clientError}`
      : null,
    "",
    clientLines.length > 0
      ? clientLines.join("\n\n")
      : locale === "zh"
        ? "暂无已配对设备。启用电脑操控后可以开始配对。"
        : "No paired clients. Enable computer control to start pairing.",
  ]
    .filter(Boolean)
    .join("\n");
}

function hooksSettingsText(
  response: HooksListResponse | null,
  locale: Locale,
): string {
  const entries = response?.data ?? [];
  const hooks = entries.flatMap((entry) =>
    entry.hooks.map((hook) => ({ ...hook, cwd: entry.cwd })),
  );
  const warnings = entries.flatMap((entry) =>
    entry.warnings.map((warning) => ({ cwd: entry.cwd, warning })),
  );
  const errors = entries.flatMap((entry) =>
    entry.errors.map((error) => ({ cwd: entry.cwd, error })),
  );
  const enabledCount = hooks.filter((hook) => hook.enabled).length;
  const managedCount = hooks.filter((hook) => hook.isManaged).length;
  const hookLines = hooks.slice(0, 16).map((hook) => {
    const status = hook.enabled
      ? locale === "zh"
        ? "启用"
        : "enabled"
      : locale === "zh"
        ? "停用"
        : "disabled";
    const source = hook.pluginId
      ? `plugin:${hook.pluginId}`
      : `${hook.source}${hook.isManaged ? " · managed" : ""}`;
    return [
      `- ${hook.eventName} · ${hook.handlerType} · ${status}`,
      hook.matcher ? `  matcher: ${hook.matcher}` : null,
      hook.command ? `  command: ${hook.command}` : null,
      hook.statusMessage ? `  status: ${hook.statusMessage}` : null,
      `  source: ${source}`,
      `  path: ${hook.sourcePath}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const warningLines = warnings
    .slice(0, 8)
    .map(({ cwd, warning }) => `- ${cwd}: ${warning}`);
  const errorLines = errors
    .slice(0, 8)
    .map(({ cwd, error }) => `- ${cwd}: ${error.path}: ${error.message}`);

  return [
    locale === "zh"
      ? `Hook 总数: ${hooks.length} · 启用: ${enabledCount} · 托管: ${managedCount}`
      : `Hooks: ${hooks.length} · enabled: ${enabledCount} · managed: ${managedCount}`,
    "",
    hookLines.length > 0
      ? hookLines.join("\n\n")
      : locale === "zh"
        ? "暂无 Hook。可以通过插件或配置文件添加 Hook。"
        : "No hooks. Add hooks through plugins or configuration files.",
    warningLines.length > 0
      ? [
          "",
          locale === "zh" ? "警告" : "Warnings",
          warningLines.join("\n"),
        ].join("\n")
      : null,
    errorLines.length > 0
      ? ["", locale === "zh" ? "错误" : "Errors", errorLines.join("\n")].join(
          "\n",
        )
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function browserAppsSettingsText(
  response: AppsListResponse | null,
  locale: Locale,
): string {
  const apps = response?.data ?? [];
  const enabledCount = apps.filter((app) => app.isEnabled).length;
  const accessibleCount = apps.filter((app) => app.isAccessible).length;
  const pluginNames = Array.from(
    new Set(apps.flatMap((app) => app.pluginDisplayNames)),
  );
  const appLines = apps.slice(0, 16).map((app) => {
    const access = app.isAccessible
      ? locale === "zh"
        ? "可访问"
        : "accessible"
      : locale === "zh"
        ? "需授权"
        : "needs auth";
    const enabled = app.isEnabled
      ? locale === "zh"
        ? "启用"
        : "enabled"
      : locale === "zh"
        ? "停用"
        : "disabled";
    const plugins =
      app.pluginDisplayNames.length > 0
        ? app.pluginDisplayNames.join(", ")
        : locale === "zh"
          ? "内置/未知"
          : "built-in/unknown";
    const labels = app.labels ? Object.values(app.labels).filter(Boolean) : [];
    return [
      `- ${app.name} · ${access} · ${enabled}`,
      `  id: ${app.id}`,
      app.description ? `  description: ${app.description}` : null,
      `  plugins: ${plugins}`,
      app.distributionChannel
        ? `  channel: ${app.distributionChannel}`
        : null,
      labels.length > 0 ? `  labels: ${labels.join(", ")}` : null,
      app.installUrl ? `  install: ${app.installUrl}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    locale === "zh"
      ? `应用: ${apps.length} · 启用: ${enabledCount} · 可访问: ${accessibleCount}`
      : `Apps: ${apps.length} · enabled: ${enabledCount} · accessible: ${accessibleCount}`,
    pluginNames.length > 0
      ? `${locale === "zh" ? "插件来源" : "Plugin sources"}: ${pluginNames.join(", ")}`
      : null,
    "",
    appLines.length > 0
      ? appLines.join("\n\n")
      : locale === "zh"
        ? "暂无可用应用。安装插件或启用 app 配置后会显示在这里。"
        : "No apps available. Install plugins or enable app config to list them here.",
  ]
    .filter(Boolean)
    .join("\n");
}

function mcpSettingsText(
  servers: McpServerStatus[],
  locale: Locale,
): string {
  const toolCount = servers.reduce(
    (total, server) => total + Object.keys(server.tools).length,
    0,
  );
  const resourceCount = servers.reduce(
    (total, server) =>
      total + server.resources.length + server.resourceTemplates.length,
    0,
  );
  const authCounts = servers.reduce<Record<string, number>>((counts, server) => {
    counts[server.authStatus] = (counts[server.authStatus] ?? 0) + 1;
    return counts;
  }, {});
  const authSummary = Object.entries(authCounts)
    .map(([status, count]) => `${status}: ${count}`)
    .join(" · ");
  const serverLines = servers.slice(0, 16).map((server) => {
    const title = server.serverInfo?.title || server.serverInfo?.name || server.name;
    const tools = Object.values(server.tools)
      .filter((tool) => tool !== undefined)
      .slice(0, 6)
      .map((tool) => tool.title || tool.name);
    const resourceTotal =
      server.resources.length + server.resourceTemplates.length;
    return [
      `- ${title}`,
      `  name: ${server.name}`,
      `  auth: ${server.authStatus}`,
      server.serverInfo?.version ? `  version: ${server.serverInfo.version}` : null,
      server.serverInfo?.websiteUrl
        ? `  website: ${server.serverInfo.websiteUrl}`
        : null,
      `  tools: ${Object.keys(server.tools).length}${tools.length > 0 ? ` · ${tools.join(", ")}` : ""}`,
      `  resources: ${resourceTotal}`,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    locale === "zh"
      ? `MCP 服务器: ${servers.length} · 工具: ${toolCount} · 资源: ${resourceCount}`
      : `MCP servers: ${servers.length} · tools: ${toolCount} · resources: ${resourceCount}`,
    authSummary
      ? `${locale === "zh" ? "认证状态" : "Auth status"}: ${authSummary}`
      : null,
    "",
    serverLines.length > 0
      ? serverLines.join("\n\n")
      : locale === "zh"
        ? "暂无 MCP 服务器。可以通过工具页新建 MCP 草稿，或在配置中添加 mcp_servers。"
        : "No MCP servers. Create an MCP draft from Tools, or add mcp_servers in config.",
  ]
    .filter(Boolean)
    .join("\n");
}

function pluginDetailText(
  response: PluginReadResponse,
  locale: Locale,
): string {
  const { plugin } = response;
  const { summary } = plugin;
  const source =
    summary.source.type === "local"
      ? summary.source.path
      : summary.source.type === "git"
        ? summary.source.url
        : locale === "zh"
          ? "远程"
          : "remote";
  const skills = plugin.skills.slice(0, 6).map((skill) => skill.name);
  const hooks = plugin.hooks.slice(0, 6).map((hook) => hook.eventName);
  const apps = plugin.apps.slice(0, 6).map((app) => app.name);
  const lines = [
    plugin.description || summary.name,
    `ID: ${summary.id}`,
    `Marketplace: ${plugin.marketplaceName}`,
    `${locale === "zh" ? "状态" : "Status"}: ${summary.enabled ? (locale === "zh" ? "启用" : "enabled") : locale === "zh" ? "停用" : "disabled"} · ${
      summary.installed
        ? locale === "zh"
          ? "已安装"
          : "installed"
        : locale === "zh"
          ? "未安装"
          : "not installed"
    }`,
    `${locale === "zh" ? "来源" : "Source"}: ${source}`,
    summary.localVersion ? `Version: ${summary.localVersion}` : null,
    summary.keywords.length > 0
      ? `Keywords: ${summary.keywords.join(", ")}`
      : null,
    `${locale === "zh" ? "技能" : "Skills"}: ${plugin.skills.length}${skills.length > 0 ? ` · ${skills.join(", ")}` : ""}`,
    `Hooks: ${plugin.hooks.length}${hooks.length > 0 ? ` · ${hooks.join(", ")}` : ""}`,
    `Apps: ${plugin.apps.length}${apps.length > 0 ? ` · ${apps.join(", ")}` : ""}`,
    `${locale === "zh" ? "MCP 服务器" : "MCP servers"}: ${
      plugin.mcpServers.length > 0
        ? plugin.mcpServers.slice(0, 6).join(", ")
        : "0"
    }`,
  ];

  return lines.filter(Boolean).join("\n");
}

function encodeCapabilityActionPayload(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

function decodeCapabilityActionPayload<T>(value: string): T | null {
  try {
    return JSON.parse(decodeURIComponent(value)) as T;
  } catch {
    return null;
  }
}

function mcpServerDetailText(server: McpServerStatus, locale: Locale): string {
  const tools = Object.values(server.tools).filter(
    (tool) => tool !== undefined,
  );
  const resources = server.resources;
  const resourceTemplates = server.resourceTemplates;
  const toolLines = tools.slice(0, 12).map((tool) => {
    const name = tool.title || tool.name;
    return `- ${name}${tool.description ? `: ${tool.description}` : ""}`;
  });
  const resourceLines = resources.slice(0, 8).map((resource) => {
    const name = resource.title || resource.name;
    return `- ${name}: ${resource.uri}`;
  });
  const templateLines = resourceTemplates.slice(0, 8).map((template) => {
    const name = template.title || template.name;
    return `- ${name}: ${template.uriTemplate}`;
  });

  return [
    server.serverInfo?.description || server.serverInfo?.title || server.name,
    `Name: ${server.name}`,
    `Auth: ${server.authStatus}`,
    server.serverInfo?.version ? `Version: ${server.serverInfo.version}` : null,
    server.serverInfo?.websiteUrl
      ? `Website: ${server.serverInfo.websiteUrl}`
      : null,
    "",
    `${locale === "zh" ? "工具" : "Tools"} (${tools.length})`,
    toolLines.length > 0
      ? toolLines.join("\n")
      : locale === "zh"
        ? "暂无工具"
        : "No tools",
    "",
    `${locale === "zh" ? "资源" : "Resources"} (${resources.length})`,
    resourceLines.length > 0
      ? resourceLines.join("\n")
      : locale === "zh"
        ? "暂无资源"
        : "No resources",
    "",
    `${locale === "zh" ? "资源模板" : "Resource templates"} (${resourceTemplates.length})`,
    templateLines.length > 0
      ? templateLines.join("\n")
      : locale === "zh"
        ? "暂无资源模板"
        : "No resource templates",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function skillSourceLabel(
  path: string | null | undefined,
  locale: Locale,
): string {
  if (!path) {
    return locale === "zh" ? "内置" : "built-in";
  }

  if (
    path.includes("/.crewon/plugins/") ||
    path.includes("/.codex/plugins/") ||
    path.includes("/plugins/cache/")
  ) {
    return "Plugin";
  }

  if (path.includes("/.crewon/skill/.system/")) {
    return locale === "zh" ? "系统" : "system";
  }

  if (path.includes("/.crewon/skill/")) {
    return "Crewon";
  }

  return locale === "zh" ? "本地" : "local";
}

function pluginSkillAction(
  skillName: string,
  pluginEntries: Array<{
    marketplaceName: string;
    pluginName: string;
    remotePluginId: string | null;
  }>,
): LibraryItem["action"] | null {
  const separatorIndex = skillName.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  const pluginName = skillName.slice(0, separatorIndex);
  const shortSkillName = skillName.slice(separatorIndex + 1);
  const pluginEntry = pluginEntries.find(
    (entry) => entry.pluginName === pluginName && entry.remotePluginId,
  );
  if (!pluginEntry?.remotePluginId) {
    return null;
  }

  return {
    type: "plugin-skill",
    skillName: shortSkillName,
    remoteMarketplaceName: pluginEntry.marketplaceName,
    remotePluginId: pluginEntry.remotePluginId,
  };
}

function externalAgentMigrationSummary(
  item: ExternalAgentConfigMigrationItem,
  locale: Locale,
): string {
  const details = item.details;
  const lines = [
    item.cwd
      ? `${locale === "zh" ? "范围" : "Scope"}: ${item.cwd}`
      : locale === "zh"
        ? "范围: Home"
        : "Scope: Home",
  ];

  if (!details) {
    return lines.join("\n");
  }

  const plugins = details.plugins.flatMap((plugin) =>
    plugin.pluginNames.map(
      (pluginName) => `${plugin.marketplaceName}/${pluginName}`,
    ),
  );
  const mcpServers = details.mcpServers.map((server) => server.name);
  const hooks = details.hooks.map((hook) => hook.name);
  const subagents = details.subagents.map((subagent) => subagent.name);
  const commands = details.commands.map((command) => command.name);
  const sessions = details.sessions.map(
    (session) => session.title || session.path,
  );

  if (plugins.length > 0) {
    lines.push(`Plugins: ${plugins.join(", ")}`);
  }
  if (mcpServers.length > 0) {
    lines.push(`MCP: ${mcpServers.join(", ")}`);
  }
  if (hooks.length > 0) {
    lines.push(`Hooks: ${hooks.join(", ")}`);
  }
  if (subagents.length > 0) {
    lines.push(`Subagents: ${subagents.join(", ")}`);
  }
  if (commands.length > 0) {
    lines.push(`Commands: ${commands.join(", ")}`);
  }
  if (sessions.length > 0) {
    lines.push(`Sessions: ${sessions.slice(0, 5).join(", ")}`);
  }

  return lines.join("\n");
}

function libraryTitle(kind: LibraryKind, locale: Locale): string {
  if (locale === "zh") {
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

function libraryLoadingFallbackPanel(
  kind: LibraryKind,
  locale: Locale,
): LibraryPanel {
  const fallback = demoLibraryPanel(kind, locale);
  return {
    ...fallback,
    subtitle:
      locale === "zh"
        ? `${fallback.subtitle} · 后端读取中`
        : `${fallback.subtitle} · backend loading`,
    body: [
      locale === "zh"
        ? "本地 app-server 响应较慢，先显示可用入口和示例结构；后端返回后会自动替换为真实数据。"
        : "The local app-server is responding slowly, so entry points and example structure are shown first. Real backend data will replace this once it returns.",
      fallback.body,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function renderLibraryCard(
  item: LibraryItem,
  onItemAction: (item: LibraryItem) => void,
) {
  const key = `${item.title}:${item.meta}`;
  const content = (
    <>
      {item.glyph ? (
        <span
          className="library-card-glyph"
          data-accent={item.accent ?? "slate"}
          aria-hidden="true"
        >
          {item.glyph}
        </span>
      ) : null}
      <span className="library-card-main">
        <span className="library-card-title-row">
          <strong>{item.title}</strong>
          {item.badge ? (
            <span
              className="library-badge"
              data-tone={item.badge.tone ?? "idle"}
            >
              {item.badge.label}
            </span>
          ) : null}
        </span>
        <span className="library-card-meta">{item.meta}</span>
        {item.description ? <p>{item.description}</p> : null}
        {item.tags && item.tags.length > 0 ? (
          <span className="library-card-tags">
            {item.tags.map((tag) => (
              <span className="library-tag" key={tag}>
                {tag}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      {item.action ? (
        <span className="library-card-chevron" aria-hidden="true">
          ›
        </span>
      ) : null}
    </>
  );

  if (item.action) {
    return (
      <button
        className="library-item"
        data-accent={item.accent ?? "slate"}
        type="button"
        key={key}
        onClick={() => onItemAction(item)}
      >
        {content}
      </button>
    );
  }

  return (
    <article
      className="library-item"
      data-accent={item.accent ?? "slate"}
      key={key}
    >
      {content}
    </article>
  );
}

function tokensLabel(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${n} tok`;
}

function ActivityBoard({
  data,
  locale,
  onDecision,
  onArtifact,
}: {
  data: ActivityData;
  locale: Locale;
  onDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
}) {
  const isZh = locale === "zh";
  const totalCost = data.budget.reduce((sum, row) => sum + row.costUsd, 0);
  const capPct = Math.min(
    100,
    Math.round((totalCost / data.budgetCapUsd) * 100),
  );
  const pendingApprovals = data.approvals.filter((a) => !a.decision);
  const riskLabel = (risk: ApprovalRequest["risk"]) =>
    isZh
      ? { low: "低风险", medium: "中风险", high: "高风险" }[risk]
      : { low: "Low", medium: "Medium", high: "High" }[risk];
  const statusLabel = (status: TraceStep["status"]) =>
    isZh
      ? { done: "完成", running: "进行中", waiting: "等待" }[status]
      : { done: "Done", running: "Running", waiting: "Waiting" }[status];

  return (
    <div className="activity-board">
      <section className="activity-card activity-trace">
        <div className="activity-card-head">
          <h2>{isZh ? "执行轨迹" : "Execution trace"}</h2>
          <span>{isZh ? "实时" : "Live"}</span>
        </div>
        <ol className="trace-timeline">
          {data.trace.map((step, idx) => (
            <li
              className="trace-step"
              data-status={step.status}
              key={`${step.time}:${idx}`}
            >
              <span
                className="trace-glyph"
                data-accent={step.accent}
                aria-hidden="true"
              >
                {step.glyph}
              </span>
              <div className="trace-body">
                <div className="trace-top">
                  <strong>{step.actor}</strong>
                  <span className="trace-action">{step.action}</span>
                  <span className="trace-time">{step.time}</span>
                </div>
                <p className="trace-detail">{step.detail}</p>
                <div className="trace-meta">
                  <span className="trace-status" data-status={step.status}>
                    {statusLabel(step.status)}
                  </span>
                  {step.tokens ? (
                    <span className="trace-tokens">
                      {tokensLabel(step.tokens)}
                    </span>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="activity-rail">
        <section className="activity-card activity-approvals">
          <div className="activity-card-head">
            <h2>{isZh ? "审批收件箱" : "Approvals inbox"}</h2>
            <span
              className="approvals-count"
              data-empty={pendingApprovals.length === 0}
            >
              {pendingApprovals.length}
            </span>
          </div>
          {pendingApprovals.length === 0 ? (
            <p className="activity-empty">
              {isZh ? "没有待处理的审批。" : "No pending approvals."}
            </p>
          ) : null}
          <div className="approval-list">
            {data.approvals.map((req) => (
              <article
                className="approval-row"
                data-risk={req.risk}
                data-decision={req.decision ?? "pending"}
                key={req.id}
              >
                <span
                  className="approval-glyph"
                  data-accent={req.accent}
                  aria-hidden="true"
                >
                  {req.glyph}
                </span>
                <div className="approval-body">
                  <div className="approval-top">
                    <strong>{req.actor}</strong>
                    <span className="approval-risk" data-risk={req.risk}>
                      {riskLabel(req.risk)}
                    </span>
                  </div>
                  <p className="approval-action">{req.action}</p>
                  <p className="approval-detail">{req.detail}</p>
                  {req.decision ? (
                    <span
                      className="approval-decided"
                      data-decision={req.decision}
                    >
                      {req.decision === "approved"
                        ? isZh
                          ? "已批准"
                          : "Approved"
                        : isZh
                          ? "已拒绝"
                          : "Denied"}
                    </span>
                  ) : (
                    <div className="approval-actions">
                      <button
                        type="button"
                        className="approval-approve"
                        onClick={() => onDecision(req.id, "approved")}
                      >
                        {isZh ? "批准" : "Approve"}
                      </button>
                      <button
                        type="button"
                        className="approval-deny"
                        onClick={() => onDecision(req.id, "denied")}
                      >
                        {isZh ? "拒绝" : "Deny"}
                      </button>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="activity-card activity-budget">
          <div className="activity-card-head">
            <h2>{isZh ? "用量与预算" : "Usage & budget"}</h2>
            <span>{`$${totalCost.toFixed(2)} / $${data.budgetCapUsd.toFixed(0)}`}</span>
          </div>
          <div className="budget-cap">
            <div className="budget-cap-bar">
              <span style={{ width: `${capPct}%` }} data-warn={capPct >= 80} />
            </div>
            <span className="budget-cap-label">
              {isZh
                ? `本日预算已用 ${capPct}%`
                : `${capPct}% of daily budget used`}
            </span>
          </div>
          <div className="budget-list">
            {data.budget.map((row) => {
              const pct = Math.min(
                100,
                Math.round((row.usedTokens / row.budgetTokens) * 100),
              );
              return (
                <div className="budget-row" key={row.name}>
                  <span
                    className="budget-glyph"
                    data-accent={row.accent}
                    aria-hidden="true"
                  >
                    {row.glyph}
                  </span>
                  <div className="budget-row-main">
                    <div className="budget-row-top">
                      <span className="budget-name">{row.name}</span>
                      <span className="budget-cost">{`$${row.costUsd.toFixed(2)}`}</span>
                    </div>
                    <div className="budget-bar">
                      <span
                        style={{ width: `${pct}%` }}
                        data-warn={pct >= 80}
                      />
                    </div>
                    <span className="budget-tokens">{`${tokensLabel(row.usedTokens)} / ${tokensLabel(row.budgetTokens)}`}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="activity-card activity-artifacts">
          <div className="activity-card-head">
            <h2>{isZh ? "产物" : "Artifacts"}</h2>
            <span>{data.artifacts.length}</span>
          </div>
          <div className="artifact-list">
            {data.artifacts.map((art) => (
              <button
                type="button"
                className="artifact-row"
                key={art.title}
                onClick={() => onArtifact(art)}
              >
                <span
                  className="artifact-glyph"
                  data-accent={art.accent}
                  aria-hidden="true"
                >
                  {art.glyph}
                </span>
                <div className="artifact-body">
                  <div className="artifact-top">
                    <strong>{art.title}</strong>
                    <span className="artifact-kind">{art.kind}</span>
                  </div>
                  <p className="artifact-meta">{art.meta}</p>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function KnowledgeView({
  panel,
  locale,
  onBack,
  onPanelAction,
  onOpenPath,
}: {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onPanelAction: (action: LibraryPanelAction) => void;
  onOpenPath: (item: CapabilityPanelItem) => void;
}) {
  const data = panel.knowledge;
  if (!data) return null;
  const isZh = locale === "zh";
  const sourceStatus = (status: KnowledgeSource["status"]) =>
    isZh
      ? { "indexed": "已索引", "indexing": "索引中", "needs-auth": "待授权" }[
          status
        ]
      : {
          "indexed": "Indexed",
          "indexing": "Indexing",
          "needs-auth": "Needs auth",
        }[status];

  return (
    <main className="library-page knowledge-page" aria-label={panel.title}>
      <header className="library-heading">
        <button type="button" onClick={onBack}>
          {isZh ? "返回对话" : "Back to chat"}
        </button>
        <div>
          <h1>{panel.title}</h1>
          <p>{panel.subtitle}</p>
        </div>
      </header>
      {panel.error ? <p className="library-error">{panel.error}</p> : null}
      <div className="library-actions knowledge-actions">
        <button
          type="button"
          data-tone="primary"
          onClick={() =>
            onPanelAction({
              id: "create-knowledge-memory",
              label: isZh ? "写入记忆" : "Write memory",
              tone: "primary",
            })
          }
        >
          {isZh ? "写入记忆" : "Write memory"}
        </button>
        <button
          type="button"
          onClick={() =>
            onPanelAction({
              id: "refresh-knowledge",
              label: isZh ? "刷新知识库" : "Refresh knowledge",
            })
          }
        >
          {isZh ? "刷新知识库" : "Refresh knowledge"}
        </button>
        <button
          type="button"
          data-tone="danger"
          onClick={() =>
            onPanelAction({
              id: "reset-memory",
              label: isZh ? "重置记忆" : "Reset memory",
              tone: "danger",
            })
          }
        >
          {isZh ? "重置记忆" : "Reset memory"}
        </button>
      </div>

      <div className="knowledge-grid">
        <section className="knowledge-col knowledge-memory">
          <div className="activity-card-head">
            <h2>{isZh ? "智能体记忆" : "Agent memory"}</h2>
            <span>{data.memories.length}</span>
          </div>
          <div className="memory-list">
            {data.memories.map((mem) => (
              <button
                type="button"
                className="memory-card"
                data-pinned={mem.pinned ? "true" : "false"}
                key={mem.title}
                onClick={() =>
                  mem.threadId
                    ? onPanelAction({
                        id: "open-thread",
                        label: isZh ? "打开后端线程" : "Open backend thread",
                        threadId: mem.threadId,
                      })
                    : mem.path
                      ? onOpenPath({
                          label: mem.title,
                          path: mem.path,
                          kind: "file",
                          intent: "attach-context",
                        })
                      : undefined
                }
              >
                <span
                  className="memory-glyph"
                  data-accent={mem.accent}
                  aria-hidden="true"
                >
                  {mem.glyph}
                </span>
                <div className="memory-body">
                  <div className="memory-top">
                    <strong>{mem.title}</strong>
                    <span className="memory-kind">{mem.kind}</span>
                    {mem.pinned ? (
                      <span className="memory-pin">
                        {isZh ? "置顶" : "Pinned"}
                      </span>
                    ) : null}
                  </div>
                  <p className="memory-preview">{mem.preview}</p>
                  <span className="memory-meta">{mem.meta}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="knowledge-col knowledge-sources">
          <div className="activity-card-head">
            <h2>{isZh ? "知识源" : "Knowledge sources"}</h2>
            <span>{data.sources.length}</span>
          </div>
          <div className="source-list">
            {data.sources.map((src) => (
              <button
                type="button"
                className="source-row"
                data-status={src.status}
                key={src.name}
                onClick={() =>
                  src.path
                    ? onOpenPath({
                        label: src.name,
                        path: src.path,
                        kind: src.isDirectory ? "directory" : "file",
                        intent: src.isDirectory ? undefined : "attach-context",
                      })
                    : undefined
                }
              >
                <span
                  className="source-glyph"
                  data-accent={src.accent}
                  aria-hidden="true"
                >
                  {src.glyph}
                </span>
                <div className="source-body">
                  <div className="source-top">
                    <strong>{src.name}</strong>
                    <span className="source-status" data-status={src.status}>
                      {sourceStatus(src.status)}
                    </span>
                  </div>
                  <p className="source-meta">{src.meta}</p>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function renderLibraryView(
  panel: LibraryPanel,
  locale: Locale,
  onBack: () => void,
  onItemAction: (item: LibraryItem) => void,
  onPanelAction: (action: LibraryPanelAction) => void,
  onPanelFieldChange: (fieldId: string, value: string) => void,
  onSendOfficeMessage: (text: string) => void,
  onUpdateAgentConfig: (patch: Partial<AgentConfig>) => void,
  onToggleAgentCapability: (group: "mcp" | "skills", id: string) => void,
  onSaveAgentConfig: () => void,
  onApprovalDecision: (id: string, decision: "approved" | "denied") => void,
  onArtifact: (artifact: ArtifactItem) => void,
  onKnowledgePath: (item: CapabilityPanelItem) => void,
) {
  if (panel.knowledge) {
    return (
      <KnowledgeView
        panel={panel}
        locale={locale}
        onBack={onBack}
        onPanelAction={onPanelAction}
        onOpenPath={onKnowledgePath}
      />
    );
  }

  if (panel.agentConfig) {
    return (
      <AgentConfigView
        panel={panel}
        locale={locale}
        onBack={onBack}
        onUpdate={onUpdateAgentConfig}
        onToggleCapability={onToggleAgentCapability}
        onSave={onSaveAgentConfig}
        onOpenThread={(threadId) =>
          onPanelAction({
            id: "open-thread",
            label: locale === "zh" ? "打开后端线程" : "Open backend thread",
            threadId,
          })
        }
      />
    );
  }

  if (panel.workspace) {
    return (
      <OfficeWorkspaceView
        panel={panel}
        locale={locale}
        onBack={onBack}
        onPanelAction={onPanelAction}
        onSendMessage={onSendOfficeMessage}
        onDecision={onApprovalDecision}
        onArtifact={onArtifact}
      />
    );
  }

  return (
    <main className="library-page" aria-label={panel.title}>
      <header className="library-heading">
        <button type="button" onClick={onBack}>
          {locale === "zh" ? "返回对话" : "Back to chat"}
        </button>
        <div>
          <h1>{panel.title}</h1>
          <p>{panel.subtitle}</p>
        </div>
      </header>
      {panel.error ? <p className="library-error">{panel.error}</p> : null}
      {panel.body ? <pre>{panel.body}</pre> : null}
      {panel.fields ? (
        <div className="library-fields">
          {panel.fields.map((field) => (
            <label key={field.id}>
              <span>{field.label}</span>
              <textarea
                spellCheck={false}
                value={field.value}
                placeholder={field.placeholder}
                onChange={(event) =>
                  onPanelFieldChange(field.id, event.target.value)
                }
              />
            </label>
          ))}
        </div>
      ) : null}
      {panel.actions ? (
        <div className="library-actions">
          {panel.actions.map((action) => (
            <button
              type="button"
              data-tone={action.tone}
              key={`${action.id}:${action.pluginId ?? action.pluginName ?? action.label}`}
              onClick={() => onPanelAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      <section className="library-list">
        {panel.items.length > 0 ? (
          panel.items.map((item) =>
            item.section ? (
              <div
                className="library-section"
                key={`${item.title}:${item.meta}`}
              >
                <strong>{item.title}</strong>
                <span>{item.meta}</span>
                {item.description ? <p>{item.description}</p> : null}
              </div>
            ) : (
              renderLibraryCard(item, onItemAction)
            ),
          )
        ) : (
          <div className="library-empty">
            {locale === "zh" ? "暂无数据" : "No data"}
          </div>
        )}
      </section>
    </main>
  );
}

function renderOfficeMessageText(
  text: string,
  memberNames: string[],
): ReactNode {
  const sorted = [...memberNames]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const escaped = sorted.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const namePattern = escaped.length > 0 ? `(?:${escaped.join("|")})` : "";
  const fallback = "[\\w\\u4e00-\\u9fa5]+";
  const mentionRegex = new RegExp(
    `@(${namePattern ? `${namePattern}|` : ""}${fallback})`,
    "g",
  );
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = mentionRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(
      <span className="office-mention" key={`m${key}`}>
        @{match[1]}
      </span>,
    );
    key += 1;
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : text;
}

function OfficeWorkspaceView({
  panel,
  locale,
  onBack,
  onPanelAction,
  onSendMessage,
  onDecision,
  onArtifact,
}: {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onPanelAction: (action: LibraryPanelAction) => void;
  onSendMessage: (text: string) => void;
  onDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
}) {
  const workspace = panel.workspace;
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"chat" | "activity">("chat");
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.scrollTop = stream.scrollHeight;
    }
  }, [workspace?.messages.length, tab]);

  if (!workspace) {
    return null;
  }

  const memberNames = workspace.members.map((member) => member.name);

  function submit() {
    const text = draft.trim();
    if (!text) {
      return;
    }
    onSendMessage(text);
    setDraft("");
  }

  const statusLabel = (status: OfficeTask["status"]) =>
    locale === "zh"
      ? status === "done"
        ? "完成"
        : status === "doing"
          ? "进行中"
          : "待办"
      : status === "done"
        ? "Done"
        : status === "doing"
          ? "In progress"
          : "To do";

  return (
    <main className="office-workspace" aria-label={panel.title}>
      <header className="office-top">
        <button type="button" className="office-back" onClick={onBack}>
          {locale === "zh" ? "返回办公室" : "Back to offices"}
        </button>
        <div className="office-top-main">
          <div className="office-top-title">
            <span className="office-top-glyph" aria-hidden="true">
              ⌗
            </span>
            <div>
              <h1>{panel.title}</h1>
              <p>{panel.subtitle}</p>
            </div>
          </div>
          <div className="office-avatars" aria-hidden="true">
            {workspace.members.map((member) => (
              <span
                className="office-avatar"
                data-accent={member.accent}
                key={member.name}
                title={member.name}
              >
                {member.glyph}
              </span>
            ))}
          </div>
        </div>
        <div className="office-goal">
          <span>{locale === "zh" ? "办公室目标" : "Office goal"}</span>
          <strong>{workspace.goal}</strong>
          <em data-status={workspace.backendStatus ?? "local"}>
            {locale === "zh"
              ? workspace.backendStatus === "connected"
                ? "后端线程已连接"
                : workspace.backendStatus === "binding"
                  ? "正在绑定后端线程"
                  : workspace.backendStatus === "error"
                    ? "后端连接异常"
                    : "本地演示"
              : workspace.backendStatus === "connected"
                ? "Backend thread connected"
                : workspace.backendStatus === "binding"
                  ? "Binding backend thread"
                  : workspace.backendStatus === "error"
                    ? "Backend connection error"
                    : "Local demo"}
          </em>
        </div>
      </header>

      <div
        className="office-tabs"
        role="tablist"
        aria-label={locale === "zh" ? "办公室视图" : "Office views"}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "chat"}
          data-active={tab === "chat"}
          onClick={() => setTab("chat")}
        >
          {locale === "zh" ? "群聊" : "Group chat"}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "activity"}
          data-active={tab === "activity"}
          onClick={() => setTab("activity")}
        >
          {locale === "zh" ? "运行台" : "Activity"}
        </button>
      </div>

      {tab === "activity" ? (
        workspace.activity ? (
          <ActivityBoard
            data={workspace.activity}
            locale={locale}
            onDecision={onDecision}
            onArtifact={onArtifact}
          />
        ) : (
          <p className="activity-empty">
            {locale === "zh" ? "暂无运行记录。" : "No activity yet."}
          </p>
        )
      ) : (
        <div className="office-grid">
          <aside
            className="office-members"
            aria-label={locale === "zh" ? "成员" : "Members"}
          >
            <div className="office-rail-head">
              <strong>{locale === "zh" ? "成员" : "Members"}</strong>
              <span>{workspace.members.length}</span>
            </div>
            {workspace.members.map((member) => (
              <div className="office-member" key={member.name}>
                <span
                  className="office-avatar"
                  data-accent={member.accent}
                  aria-hidden="true"
                >
                  {member.glyph}
                  <i
                    className="office-presence"
                    data-online={member.online ?? true}
                  />
                </span>
                <span className="office-member-text">
                  <strong>{member.name}</strong>
                  <span>{member.role}</span>
                  <em>{member.status}</em>
                </span>
              </div>
            ))}
            {panel.actions ? (
              <div className="office-rail-actions">
                {panel.actions.map((action) => (
                  <button
                    type="button"
                    data-tone={action.tone}
                    key={action.id}
                    onClick={() => onPanelAction(action)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </aside>

          <section
            className="office-chat"
            aria-label={locale === "zh" ? "群聊" : "Group chat"}
          >
            <div className="office-chat-head">
              <strong>{locale === "zh" ? "群聊协作" : "Group chat"}</strong>
              <span>
                {locale === "zh"
                  ? `${workspace.messages.length} 条消息`
                  : `${workspace.messages.length} messages`}
              </span>
            </div>
            <div className="office-chat-stream" ref={streamRef}>
              {workspace.messages.map((message, index) =>
                message.kind === "system" ? (
                  <div className="office-system" key={index}>
                    {message.text}
                  </div>
                ) : (
                  <div
                    className="office-bubble"
                    data-kind={message.kind ?? "message"}
                    data-self={message.glyph === "@"}
                    key={index}
                  >
                    <span
                      className="office-avatar office-avatar-sm"
                      data-accent={message.accent}
                      aria-hidden="true"
                    >
                      {message.glyph}
                    </span>
                    <div className="office-bubble-body">
                      <div className="office-bubble-head">
                        <strong>{message.author}</strong>
                        <span>{message.time}</span>
                      </div>
                      <p>
                        {renderOfficeMessageText(message.text, memberNames)}
                      </p>
                    </div>
                  </div>
                ),
              )}
            </div>
            <form
              className="office-composer"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <input
                value={draft}
                spellCheck={false}
                placeholder={
                  locale === "zh"
                    ? "在群聊里 @ 成员派发任务…"
                    : "@mention a member to dispatch a task…"
                }
                aria-label={locale === "zh" ? "群聊输入" : "Group chat input"}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="submit" disabled={!draft.trim()}>
                {locale === "zh" ? "发送" : "Send"}
              </button>
            </form>
          </section>

          <aside
            className="office-tasks"
            aria-label={locale === "zh" ? "任务" : "Tasks"}
          >
            <div className="office-rail-head">
              <strong>{locale === "zh" ? "任务看板" : "Task board"}</strong>
              <span>{workspace.tasks.length}</span>
            </div>
            {workspace.tasks.map((task, index) => (
              <div
                className="office-task"
                data-status={task.status}
                key={`${task.title}:${index}`}
              >
                <span className="office-task-dot" aria-hidden="true" />
                <span className="office-task-text">
                  <strong>{task.title}</strong>
                  <span>{task.owner}</span>
                </span>
                <span className="office-task-status" data-status={task.status}>
                  {statusLabel(task.status)}
                </span>
              </div>
            ))}
          </aside>
        </div>
      )}
    </main>
  );
}

function summarizeRemoteDiff(diff: string, sha: string): GitRemoteDiffSummary {
  return {
    status: "ready",
    added: diff.match(/^\+(?!\+\+)/gm)?.length ?? 0,
    removed: diff.match(/^-(?!--)/gm)?.length ?? 0,
    files: diff.match(/^diff --git /gm)?.length ?? 0,
    sha,
  };
}

export function App() {
  const platform = useMemo(detectPlatform, []);
  const serverUrl = useMemo(defaultServerUrl, []);
  const isDemoPreview = useMemo(shouldUseDemoPreview, []);
  const initialLibraryView = useMemo(getInitialLibraryView, []);
  const clientRef = useRef<AppServerClient | null>(null);
  const [locale, setLocale] = useState<Locale>(getInitialLocale);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const localeRef = useRef(locale);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [appView, setAppView] = useState<AppView>(getInitialAppView);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>(getInitialSettingsSection);
  const [libraryPanel, setLibraryPanel] = useState<LibraryPanel | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(getInitialSidebarOpen);
  const [capabilityDockOpen, setCapabilityDockOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [showArchivedThreads, setShowArchivedThreads] = useState(false);
  const showArchivedThreadsRef = useRef(false);
  const [threadSearchTerm, setThreadSearchTerm] = useState("");
  const [isSearchingThreads, setIsSearchingThreads] = useState(false);
  const threadSearchRequestRef = useRef(0);
  const libraryLoadRequestRef = useRef(0);
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(
    null,
  );
  const [conversationSummary, setConversationSummary] =
    useState<ConversationSummary | null>(null);
  const [gitRemoteDiff, setGitRemoteDiff] =
    useState<GitRemoteDiffSummary | null>(null);
  const [threadGoal, setThreadGoal] = useState<ThreadGoal | null>(null);
  const [loadedThreadIds, setLoadedThreadIds] = useState<string[]>([]);
  const [activeFileWatch, setActiveFileWatch] = useState<{
    id: string;
    path: string;
  } | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const selectedThreadIdRef = useRef<string | null>(null);
  const initialLibraryViewOpenedRef = useRef(false);
  const [activeTurnByThread, setActiveTurnByThread] = useState<
    Record<string, string>
  >({});
  const [streamingTextByThread, setStreamingTextByThread] = useState<
    Record<string, string>
  >({});
  const [workMode, setWorkMode] = useState<WorkMode>("code");
  const [busyToolId, setBusyToolId] = useState<ToolId | null>(null);
  const [capabilityPanel, setCapabilityPanel] =
    useState<CapabilityPanel | null>(null);
  const [pendingApprovalRequest, setPendingApprovalRequest] =
    useState<PendingApprovalRequest | null>(null);
  const [pendingUserInputRequest, setPendingUserInputRequest] =
    useState<PendingUserInputRequest | null>(null);
  const [pendingDynamicToolRequest, setPendingDynamicToolRequest] =
    useState<PendingDynamicToolRequest | null>(null);
  const [pendingMcpElicitationRequest, setPendingMcpElicitationRequest] =
    useState<PendingMcpElicitationRequest | null>(null);
  const [pendingExternalSecretRequest, setPendingExternalSecretRequest] =
    useState<PendingExternalSecretRequest | null>(null);
  const [terminalCommand, setTerminalCommand] = useState("git status --short");
  const terminalProcessIdRef = useRef<string | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [pendingComposerMentions, setPendingComposerMentions] = useState<
    Array<{ name: string; path: string }>
  >([]);
  const [pendingContextFile, setPendingContextFile] = useState<{
    path: string;
    text: string;
  } | null>(null);
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const t = translate(locale);

  const selectedThread =
    threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const cwd = selectedThread?.cwd ?? "";
  const isConnected = connectionState === "connected";
  const isDemo = connectionState === "demo";
  const activeTurnId = selectedThreadId
    ? (activeTurnByThread[selectedThreadId] ?? null)
    : null;
  const titlebarTitle = selectedThread
    ? threadTitle(selectedThread, t.untitledThread)
    : t.newDraftThread;
  const searchShortcutLabel = platform === "mac" ? "⌘K" : "Ctrl K";
  const newThreadShortcutLabel = platform === "mac" ? "⌘N" : "Ctrl N";
  const sendShortcutLabel = platform === "mac" ? "⌘ Enter" : "Ctrl Enter";

  function syncDesktopPreference(keyPath: string, value: string) {
    if (!isConnected) {
      return;
    }

    void clientRef.current
      ?.writeConfigBatch([{ keyPath, value, mergeStrategy: "upsert" }])
      .catch((error) => {
        setNotice({
          text:
            error instanceof Error
              ? error.message
              : localeRef.current === "zh"
                ? "同步桌面设置失败"
                : "Unable to sync desktop preference",
          tone: "warning",
        });
      });
  }

  useEffect(() => {
    localeRef.current = locale;
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    showArchivedThreadsRef.current = showArchivedThreads;
  }, [showArchivedThreads]);

  useEffect(() => {
    if (!isConnected) {
      setLoadedThreadIds([]);
      return;
    }

    let cancelled = false;
    const refreshLoadedThreads = () => {
      void clientRef.current
        ?.listLoadedThreadIds()
        .then((threadIds) => {
          if (!cancelled) {
            setLoadedThreadIds(threadIds);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLoadedThreadIds([]);
          }
        });
    };

    refreshLoadedThreads();
    const intervalId = window.setInterval(refreshLoadedThreads, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isConnected]);

  useEffect(() => {
    if (!isConnected) {
      return;
    }

    let cancelled = false;
    void clientRef.current
      ?.readConfig(cwd)
      .then((configRead) => {
        if (cancelled) {
          return;
        }

        const desktop = configRead.config.desktop as Record<string, unknown> | null;
        const configuredLocale = desktop?.uiLocale;
        const configuredTheme = desktop?.appearanceTheme;
        const themeOverride = new URLSearchParams(window.location.search).get("theme");

        if (configuredLocale === "zh" || configuredLocale === "en") {
          setLocale(configuredLocale);
          persistLocale(configuredLocale);
        }

        if (
          themeOverride !== "light" &&
          themeOverride !== "dark" &&
          (configuredTheme === "light" || configuredTheme === "dark")
        ) {
          setTheme(configuredTheme);
          persistTheme(configuredTheme);
        }
      })
      .catch(() => {
        // Desktop preferences are best-effort; config/settings panels surface detailed errors.
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, isConnected]);

  useEffect(() => {
    const searchTerm = threadSearchTerm.trim();
    const requestId = threadSearchRequestRef.current + 1;
    threadSearchRequestRef.current = requestId;

    if (isDemoPreview) {
      setIsSearchingThreads(false);
      showDemoThreads();
      return;
    }

    if (!isConnected) {
      setIsSearchingThreads(false);
      return;
    }

    if (!searchTerm) {
      setIsSearchingThreads(true);
      void clientRef.current
        ?.listThreads(showArchivedThreadsRef.current)
        .then((serverThreads) => {
          if (threadSearchRequestRef.current !== requestId) {
            return;
          }

          setThreads(serverThreads ?? []);
          setSelectedThreadId((currentThreadId) =>
            currentThreadId &&
            serverThreads?.some((thread) => thread.id === currentThreadId)
              ? currentThreadId
              : (serverThreads?.[0]?.id ?? null),
          );
        })
        .catch((error) => {
          if (threadSearchRequestRef.current === requestId) {
            setNotice({
              text:
                error instanceof Error
                  ? error.message
                  : localeRef.current === "zh"
                    ? "读取会话失败"
                    : "Unable to load sessions",
              tone: "warning",
            });
          }
        })
        .finally(() => {
          if (threadSearchRequestRef.current === requestId) {
            setIsSearchingThreads(false);
          }
        });
      return;
    }

    setIsSearchingThreads(true);
    const timeoutId = window.setTimeout(() => {
      void clientRef.current
        ?.searchThreads(searchTerm, showArchivedThreadsRef.current)
        .then((serverThreads) => {
          if (threadSearchRequestRef.current !== requestId) {
            return;
          }

          setThreads(serverThreads ?? []);
          setSelectedThreadId((currentThreadId) =>
            currentThreadId &&
            serverThreads?.some((thread) => thread.id === currentThreadId)
              ? currentThreadId
              : (serverThreads?.[0]?.id ?? null),
          );
        })
        .catch((error) => {
          if (threadSearchRequestRef.current === requestId) {
            setNotice({
              text:
                error instanceof Error
                  ? error.message
                  : localeRef.current === "zh"
                    ? "搜索会话失败"
                    : "Unable to search sessions",
              tone: "warning",
            });
          }
        })
        .finally(() => {
          if (threadSearchRequestRef.current === requestId) {
            setIsSearchingThreads(false);
          }
        });
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [isConnected, isDemoPreview, showArchivedThreads, threadSearchTerm]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (
      !initialLibraryView ||
      initialLibraryViewOpenedRef.current ||
      connectionState === "connecting"
    ) {
      return;
    }

    initialLibraryViewOpenedRef.current = true;
    void openLibrary(initialLibraryView);
  }, [connectionState, initialLibraryView]);

  useEffect(() => {
    const title = selectedThread
      ? `${threadTitle(selectedThread, t.untitledThread)} - Crewon`
      : "Crewon";
    document.title = composerValue.trim() ? `* ${title}` : title;
  }, [composerValue, selectedThread, t.untitledThread]);

  useEffect(() => {
    if (appView === "settings" && isConnected) {
      void refreshSettingsSection(settingsSection);
    } else if (appView === "settings" && isDemo) {
      setCapabilityPanel(demoSettingsPanel(settingsSection, locale));
    }
  }, [appView, isConnected, isDemo, locale, settingsSection]);

  useEffect(() => {
    if (!isConnected || !cwd) {
      if (!isDemo) {
        setGitRemoteDiff(null);
      }
      return;
    }

    let cancelled = false;
    setGitRemoteDiff({ status: "loading", added: 0, removed: 0, files: 0 });

    void clientRef.current
      ?.getGitDiffToRemote(cwd)
      .then((response) => {
        if (!cancelled) {
          setGitRemoteDiff(summarizeRemoteDiff(response.diff, response.sha));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setGitRemoteDiff({
            status: "error",
            added: 0,
            removed: 0,
            files: 0,
            error:
              error instanceof Error
                ? error.message
                : "Unable to read git diff",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, isConnected, isDemo]);

  useEffect(() => {
    if (
      !isConnected ||
      !selectedThreadId ||
      (isDemoPreview && isDemoThreadId(selectedThreadId))
    ) {
      if (!isDemo) {
        setConversationSummary(null);
      }
      return;
    }

    let cancelled = false;
    void clientRef.current
      ?.getConversationSummary(selectedThreadId)
      .then((response) => {
        if (!cancelled) {
          setConversationSummary(response.summary);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConversationSummary(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isConnected, isDemo, isDemoPreview, selectedThreadId]);

  useEffect(() => {
    if (
      !isConnected ||
      !selectedThreadId ||
      (isDemoPreview && isDemoThreadId(selectedThreadId))
    ) {
      if (!isDemo) {
        setThreadGoal(null);
      }
      return;
    }

    let cancelled = false;
    void clientRef.current
      ?.getThreadGoal(selectedThreadId)
      .then((response) => {
        if (!cancelled) {
          setThreadGoal(response.goal);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThreadGoal(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isConnected, isDemo, isDemoPreview, selectedThreadId]);

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    persistLocale(nextLocale);
    syncDesktopPreference(DESKTOP_LOCALE_KEY_PATH, nextLocale);
  }

  function toggleTheme() {
    setTheme((currentTheme) => {
      const nextTheme = currentTheme === "light" ? "dark" : "light";
      persistTheme(nextTheme);
      syncDesktopPreference(DESKTOP_THEME_KEY_PATH, nextTheme);
      return nextTheme;
    });
  }

  function toggleInspector() {
    setInspectorOpen((open) =>
      !open && shouldAutoCloseInspector(sidebarOpen, capabilityDockOpen)
        ? false
        : !open,
    );
  }

  function toggleCapabilityDock() {
    if (appView === "settings" || appView === "library") {
      setAppView("chat");
    }
    if (capabilityDockOpen && !capabilityPanel) {
      setCapabilityPanel({
        title: locale === "zh" ? "能力" : "Capabilities",
      });
      return;
    }
    if (!capabilityDockOpen && !capabilityPanel) {
      setCapabilityPanel({
        title: locale === "zh" ? "能力" : "Capabilities",
      });
    }
    setCapabilityDockOpen((open) => !open);
  }

  function openSettings() {
    setSettingsSection("account");
    setAppView("settings");
    setCapabilityDockOpen(false);
    setInspectorOpen(false);
    if (isDemo) {
      setCapabilityPanel(demoSettingsPanel("account", locale));
      return;
    }
    void refreshAccountPanel();
  }

  function openSettingsSection(section: SettingsSection) {
    setSettingsSection(section);
    if (isDemo) {
      setCapabilityPanel(demoSettingsPanel(section, locale));
      return;
    }
    void refreshSettingsSection(section);
  }

  function closeSettings() {
    setAppView("chat");
    setCapabilityPanel(null);
  }

  function closeLibrary() {
    setAppView("chat");
    setLibraryPanel(null);
  }

  function refreshSettingsSection(section: SettingsSection) {
    if (section === "config") {
      return refreshConfigPanel();
    }

    if (section === "appearance") {
      return refreshAppearanceSettingsPanel();
    }

    if (section === "personalization") {
      return refreshPersonalizationSettingsPanel();
    }

    if (section === "keyboard") {
      return refreshKeyboardSettingsPanel();
    }

    if (section === "hooks") {
      return refreshHooksPanel();
    }

    if (section === "mcp-servers") {
      return refreshMcpSettingsPanel();
    }

    if (section === "browser") {
      return refreshBrowserSettingsPanel();
    }

    if (section === "environment") {
      return refreshEnvironmentSettingsPanel();
    }

    if (section === "computer-control") {
      return refreshComputerControlSettingsPanel();
    }

    if (section === "app-snapshots") {
      return refreshAppSnapshotsSettingsPanel();
    }

    if (section === "connections") {
      return refreshConnectionsSettingsPanel();
    }

    if (section === "git") {
      return refreshGitSettingsPanel();
    }

    if (section === "worktrees") {
      return refreshWorktreesSettingsPanel();
    }

    return refreshAccountPanel();
  }

  async function openLibrary(kind: LibraryKind) {
    const title = libraryTitle(kind, locale);
    const requestId = libraryLoadRequestRef.current + 1;
    libraryLoadRequestRef.current = requestId;
    setAppView("library");
    setCapabilityDockOpen(false);
    setInspectorOpen(false);
    setLibraryPanel({
      kind,
      title,
      subtitle:
        locale === "zh"
          ? "正在读取本地 app-server..."
          : "Reading from local app-server...",
      items: [],
    });
    const loadingFallbackTimer = window.setTimeout(() => {
      if (libraryLoadRequestRef.current !== requestId) {
        return;
      }
      setLibraryPanel((currentPanel) =>
        currentPanel?.kind === kind &&
        currentPanel.items.length === 0 &&
        !currentPanel.error
          ? libraryLoadingFallbackPanel(kind, locale)
          : currentPanel,
      );
    }, 1800);

    if (!isConnected) {
      window.clearTimeout(loadingFallbackTimer);
      if (isDemo) {
        setLibraryPanel(demoLibraryPanel(kind, locale));
        return;
      }

      setLibraryPanel({
        kind,
        title,
        subtitle: t.connectionHints[connectionState],
        items: [],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    try {
      const effectiveCwd = isDemoPreview ? await resolveBackendCwd() : cwd;
      const effectiveThreadId = isDemoPreview
        ? undefined
        : (selectedThreadId ?? undefined);

      if (kind === "tools") {
        let mcpResponse;
        try {
          mcpResponse = await clientRef.current?.listMcpServerStatus(
            effectiveThreadId,
            "full",
          );
        } catch (threadScopedError) {
          if (
            !(threadScopedError instanceof Error) ||
            !threadScopedError.message.includes("thread not found")
          ) {
            throw threadScopedError;
          }
          mcpResponse = await clientRef.current?.listMcpServerStatus(
            undefined,
            "full",
          );
        }

        const [skillsResponse, pluginsResponse, workspaceToolItems] = await Promise.all([
          clientRef.current?.listSkills(effectiveCwd),
          clientRef.current?.listPlugins(effectiveCwd),
          readToolConfigFiles(),
        ]);
        const servers = mcpResponse?.data ?? [];
        const pluginEntries = (pluginsResponse?.marketplaces ?? []).flatMap(
          (marketplace) =>
            marketplace.plugins.map((plugin) => ({
              marketplaceName: marketplace.name,
              pluginName: plugin.name,
              remotePluginId: plugin.remotePluginId,
            })),
        );
        const skills = (skillsResponse?.data ?? []).flatMap((entry) =>
          entry.skills.map((skill) => skill),
        );
        const mcpItems: LibraryItem[] = servers.map((server) => {
          const tools = Object.values(server.tools).filter(
            (tool) => tool !== undefined,
          );
          const firstTool = tools[0];
          const toolCount = tools.length;
          const resourceCount =
            server.resources.length + server.resourceTemplates.length;
          const serverTitle =
            server.serverInfo?.title || server.serverInfo?.name || server.name;
          return {
            title: `MCP · ${serverTitle}`,
            meta: `${server.authStatus} · ${toolCount} ${locale === "zh" ? "工具" : "tools"} · ${resourceCount} ${
              locale === "zh" ? "资源" : "resources"
            }`,
            description:
              server.serverInfo?.description ||
              (locale === "zh"
                ? `已分配给工程师和自动化使用：${Object.keys(server.tools).slice(0, 5).join(", ")}`
                : `Assigned to engineers and automations: ${Object.keys(server.tools).slice(0, 5).join(", ")}`),
            action: {
              type: "mcp-detail",
              title: serverTitle,
              subtitle: server.name,
              body: mcpServerDetailText(server, locale),
              authStatus: server.authStatus,
              tool: firstTool
                ? {
                    server: server.name,
                    name: firstTool.name,
                    label: firstTool.title || firstTool.name,
                    inputSchema: JSON.stringify(
                      firstTool.inputSchema ?? {},
                      null,
                      2,
                    ),
                  }
                : undefined,
              resource:
                server.resources.length > 0
                  ? {
                      server: server.name,
                      uri: server.resources[0].uri,
                      label:
                        server.resources[0].title ||
                        server.resources[0].name ||
                        server.resources[0].uri,
                    }
                  : undefined,
            },
          };
        });
        const skillItems: LibraryItem[] = skills.map((skill) => {
          const source = skillSourceLabel(skill.path, locale);
          return {
            title: `Skill · ${skill.name}`,
            meta: `${source} · ${skill.enabled ? (locale === "zh" ? "可招募" : "recruitable") : locale === "zh" ? "停用" : "disabled"}`,
            description:
              skill.description ||
              skill.shortDescription ||
              (locale === "zh"
                ? `可绑定到智能体或办公室：${skill.path}`
                : `Assignable to agents or offices: ${skill.path}`) ||
              undefined,
            action: skill.path
              ? {
                  type: "skill-file",
                  skillName: skill.name,
                  path: skill.path,
                  enabled: skill.enabled,
                }
              : (pluginSkillAction(skill.name, pluginEntries) ?? undefined),
          };
        });
        setLibraryPanel({
          kind,
          title,
          subtitle:
            locale === "zh"
              ? `${servers.length} 个 MCP · ${skills.length} 个 Skill · ${workspaceToolItems.length} 个工作区配置`
              : `${servers.length} MCP · ${skills.length} skills · ${workspaceToolItems.length} workspace configs`,
          body:
            locale === "zh"
              ? "工具库是智能体和办公室的能力市场。MCP 负责连接外部系统，Skill 负责沉淀可复用流程；新建后可以分配给某个智能体或办公室。"
              : "The tool library is the capability market for agents and offices. MCP connects external systems, while Skills package reusable workflows for assignment.",
          actions: [
            {
              id: "create-mcp",
              label: locale === "zh" ? "新建 MCP" : "New MCP",
              tone: "primary",
            },
            {
              id: "create-skill",
              label: locale === "zh" ? "新建 Skill" : "New Skill",
            },
            {
              id: "reload-tools",
              label: locale === "zh" ? "刷新工具" : "Refresh tools",
            },
          ],
          items: [
            ...(workspaceToolItems.length > 0
              ? [
                  {
                    title:
                      locale === "zh"
                        ? "工作区工具配置"
                        : "Workspace tool configs",
                    meta:
                      locale === "zh"
                        ? `${workspaceToolItems.length} 个草稿`
                        : `${workspaceToolItems.length} drafts`,
                    description:
                      locale === "zh"
                        ? "这些 MCP 和 Skill 来自 app-server domain API 或 .crewon/tools，可继续编辑并分配给智能体。"
                        : "These MCP and Skill entries come from the app-server domain API or .crewon/tools and can be assigned to agents.",
                    section: true,
                  },
                  ...workspaceToolItems,
                ]
              : []),
            {
              title: "MCP",
              meta:
                locale === "zh"
                  ? `${servers.length} 个服务器`
                  : `${servers.length} servers`,
              description:
                locale === "zh"
                  ? "运行态连接：浏览器、GitHub、数据库、内部 API、文件系统。可被智能体按权限调用。"
                  : "Runtime connectors: browser, GitHub, databases, internal APIs, and filesystems. Agents call them by permission.",
              section: true,
            },
            ...mcpItems,
            {
              title: "Skill",
              meta:
                locale === "zh"
                  ? `${skills.length} 个技能`
                  : `${skills.length} skills`,
              description:
                locale === "zh"
                  ? "方法库：代码审查、甲方材料、演示截图、表格分析等流程，招募到办公室后可复用。"
                  : "Method library for review, client materials, demo screenshots, spreadsheet analysis, and reusable office workflows.",
              section: true,
            },
            ...skillItems,
          ],
        });
        return;
      }

      if (kind === "office") {
        const basePanel = demoLibraryPanel("office", locale);
        const [backendThreads, workspaceOfficeItems] = await Promise.all([
          clientRef.current?.listThreads(false),
          readOfficeConfigFiles(),
        ]);
        const threads = backendThreads ?? [];
        const officeThreads = threads.filter(
          (thread) => thread.threadSource === "office",
        );
        const officeThreadCandidates =
          officeThreads.length > 0 ? officeThreads : threads;
        const backendOfficeDetails = await Promise.allSettled(
          officeThreadCandidates.map(async (thread) => {
            const detailedThread =
              (await clientRef.current?.readThread(thread.id)) ?? thread;
            return {
              thread: detailedThread,
              config: parseOfficeConfigFromThread(detailedThread, locale),
            };
          }),
        );
        const backendOfficeItems = backendOfficeDetails.flatMap((result) => {
          if (result.status !== "fulfilled" || !result.value.config) {
            return [];
          }
          return [
            backendThreadLibraryItem(
              result.value.thread,
              "office",
              locale,
              null,
              null,
              result.value.config,
            ),
          ];
        });
        const backendOfficeThreadIds = new Set(
          backendOfficeDetails.flatMap((result) =>
            result.status === "fulfilled" &&
            result.value.config?.workspace.threadId
              ? [result.value.config.workspace.threadId]
              : [],
          ),
        );
        const uniqueWorkspaceOfficeItems = workspaceOfficeItems.filter(
          (item) =>
            item.action?.type !== "office-detail" ||
            !item.action.workspace?.threadId ||
            !backendOfficeThreadIds.has(item.action.workspace.threadId),
        );
        const storedOfficeItems = [
          ...backendOfficeItems,
          ...uniqueWorkspaceOfficeItems,
        ];
        setLibraryPanel({
          ...basePanel,
          subtitle:
            locale === "zh"
              ? `${basePanel.items.filter((item) => !item.section).length} 个模板 · ${backendOfficeItems.length} 个后端办公室 · ${workspaceOfficeItems.length} 个工作区配置`
              : `${basePanel.items.filter((item) => !item.section).length} templates · ${backendOfficeItems.length} backend offices · ${workspaceOfficeItems.length} workspace configs`,
          items:
            storedOfficeItems.length > 0
              ? [
                  {
                    title:
                      locale === "zh"
                        ? "后端与工作区办公室"
                        : "Backend and workspace offices",
                    meta:
                      locale === "zh"
                        ? `${storedOfficeItems.length} 个已创建`
                        : `${storedOfficeItems.length} created`,
                    description:
                      locale === "zh"
                        ? "这些办公室来自 app-server 线程或 .crewon/offices 配置，可继续群聊协作。"
                        : "These offices come from app-server threads or .crewon/offices configs and can continue group-chat work.",
                    section: true,
                  },
                  ...storedOfficeItems,
                  ...basePanel.items,
                ]
              : basePanel.items,
        });
        return;
      }

      if (kind === "automation") {
        const basePanel = demoLibraryPanel("automation", locale);
        const [backendThreads, workspaceAutomationItems] = await Promise.all([
          clientRef.current?.listThreads(false),
          readAutomationConfigFiles(),
        ]);
        const threads = backendThreads ?? [];
        const automationThreads = threads.filter(
          (thread) => thread.threadSource === "automation",
        );
        const automationThreadCandidates =
          automationThreads.length > 0 ? automationThreads : threads;
        const backendAutomationDetails = await Promise.allSettled(
          automationThreadCandidates.map(async (thread) => {
            const detailedThread =
              (await clientRef.current?.readThread(thread.id)) ?? thread;
            return {
              thread: detailedThread,
              config: parseAutomationConfigFromThread(detailedThread, locale),
            };
          }),
        );
        const backendAutomationItems = backendAutomationDetails.map(
          (result) => {
            if (result.status !== "fulfilled" || !result.value.config) {
              return null;
            }
            return backendThreadLibraryItem(
              result.value.thread,
              "automation",
              locale,
              null,
              result.value.config,
            );
          },
        ).filter((item): item is LibraryItem => Boolean(item));
        const backendThreadIds = new Set(
          backendAutomationDetails.flatMap((result) =>
            result.status === "fulfilled" && result.value.config?.threadId
              ? [result.value.config.threadId]
              : [],
          ),
        );
        const uniqueWorkspaceAutomationItems = workspaceAutomationItems.filter(
          (item) =>
            item.action?.type !== "automation-detail" ||
            !item.action.threadId ||
            !backendThreadIds.has(item.action.threadId),
        );
        const storedAutomationItems = [
          ...backendAutomationItems,
          ...uniqueWorkspaceAutomationItems,
        ];
        setLibraryPanel({
          ...basePanel,
          subtitle:
            locale === "zh"
              ? `4 条模板自动化 · ${backendAutomationItems.length} 条后端记录 · ${workspaceAutomationItems.length} 个工作区配置`
              : `4 automation templates · ${backendAutomationItems.length} backend records · ${workspaceAutomationItems.length} workspace configs`,
          items:
            storedAutomationItems.length > 0
              ? [
                  {
                    title:
                      locale === "zh"
                        ? "后端与工作区自动化"
                        : "Backend and workspace automations",
                    meta:
                      locale === "zh"
                        ? `${storedAutomationItems.length} 条记录`
                        : `${storedAutomationItems.length} records`,
                    description:
                      locale === "zh"
                        ? "这些自动化来自 app-server 线程或 .crewon/automations 配置，可打开后再次运行。"
                        : "These automations come from app-server threads or .crewon/automations configs and can be run again.",
                    section: true,
                  },
                  ...storedAutomationItems,
                  ...basePanel.items,
                ]
              : basePanel.items,
        });
        return;
      }

      if (kind === "knowledge") {
        const knowledge = await createBackendKnowledgeData();
        setLibraryPanel({
          kind: "knowledge",
          title,
          subtitle:
            locale === "zh"
              ? `${knowledge.memories.length} 条记忆 · ${knowledge.sources.length} 个知识源`
              : `${knowledge.memories.length} memories · ${knowledge.sources.length} sources`,
          items: [],
          knowledge,
          error:
            knowledge.memories.length === 0 && knowledge.sources.length === 0
              ? locale === "zh"
                ? "当前没有工作区路径，无法读取知识库。"
                : "No workspace path is available for reading knowledge."
              : undefined,
        });
        return;
      }

      if (kind === "agents") {
        const [response, backendThreadsResponse, workspaceAgentItems] =
          await Promise.all([
            clientRef.current?.detectExternalAgentConfig(effectiveCwd),
            clientRef.current?.listThreads(false),
            readAgentConfigFiles(),
          ]);
        const items = response?.items ?? [];
        const backendThreads = backendThreadsResponse ?? [];
        const agentThreads = backendThreads.filter(
          (thread) => thread.threadSource === "agent",
        );
        const agentThreadCandidates =
          agentThreads.length > 0 ? agentThreads : backendThreads;
        const backendAgentDetails = await Promise.allSettled(
          agentThreadCandidates.map(async (thread) => {
            const detailedThread =
              (await clientRef.current?.readThread(thread.id)) ?? thread;
            return {
              thread: detailedThread,
              config: parseAgentConfigFromThread(detailedThread, locale),
            };
          }),
        );
        const backendAgentItems = backendAgentDetails.flatMap((result) => {
          if (result.status !== "fulfilled" || !result.value.config) {
            return [];
          }
          return [
            backendThreadLibraryItem(
              result.value.thread,
              "agent",
              locale,
              result.value.config,
            ),
          ];
        });
        const backendAgentThreadIds = new Set(
          backendAgentDetails.flatMap((result) =>
            result.status === "fulfilled" && result.value.config?.threadId
              ? [result.value.config.threadId]
              : [],
          ),
        );
        const uniqueWorkspaceAgentItems = workspaceAgentItems.filter(
          (item) =>
            item.action?.type !== "agent-config" ||
            !item.action.config.threadId ||
            !backendAgentThreadIds.has(item.action.config.threadId),
        );
        const storedAgentItems = [
          ...backendAgentItems,
          ...uniqueWorkspaceAgentItems,
        ];
        const detectedItems = items.map((item) => ({
          title: item.description,
          meta: item.itemType,
          description: externalAgentMigrationSummary(item, locale),
          action: {
            type: "external-agent-import" as const,
            item,
          },
        }));
        const basePanel = demoLibraryPanel("agents", locale);
        setLibraryPanel({
          ...basePanel,
          subtitle:
            locale === "zh"
              ? `${basePanel.items.filter((entry) => !entry.section).length} 个设计角色 · ${backendAgentItems.length} 个后端智能体 · ${workspaceAgentItems.length} 个工作区配置 · ${items.length} 个可导入项`
              : `designed roles · ${backendAgentItems.length} backend agents · ${workspaceAgentItems.length} workspace configs · ${items.length} importable items`,
          items:
            storedAgentItems.length > 0 || detectedItems.length > 0
              ? [
                  ...(storedAgentItems.length > 0
                    ? [
                        {
                          title:
                            locale === "zh"
                              ? "后端与工作区智能体"
                              : "Backend and workspace agents",
                          meta:
                            locale === "zh"
                              ? `${storedAgentItems.length} 个已保存`
                              : `${storedAgentItems.length} saved`,
                          description:
                            locale === "zh"
                              ? "这些智能体来自 app-server 线程或 .crewon/agents 配置，可继续调整配置。"
                              : "These agents come from app-server threads or .crewon/agents configs and can be adjusted.",
                          section: true,
                        } satisfies LibraryItem,
                        ...storedAgentItems,
                      ]
                    : []),
                  ...basePanel.items,
                  ...(detectedItems.length > 0
                    ? [
                        {
                          title:
                            locale === "zh" ? "外部配置" : "External configs",
                          meta:
                            locale === "zh"
                              ? `${items.length} 个可导入项`
                              : `${items.length} importable items`,
                          description:
                            locale === "zh"
                              ? "可从已有 Agent 配置迁移，导入后加入智能体库。"
                              : "Migrate existing agent configs into the agent library.",
                          section: true,
                        } satisfies LibraryItem,
                        ...detectedItems,
                      ]
                    : []),
                ]
              : basePanel.items,
        });
        return;
      }

      const response = await clientRef.current?.listPlugins(effectiveCwd);
      const marketplaces = response?.marketplaces ?? [];
      const pluginEntries = marketplaces.flatMap((marketplace) =>
        marketplace.plugins.map((plugin) => ({
          marketplace,
          plugin,
        })),
      );
      const installedCount = pluginEntries.filter(
        ({ plugin }) => plugin.installed,
      ).length;
      const enabledCount = pluginEntries.filter(
        ({ plugin }) => plugin.enabled,
      ).length;
      const pluginItems: LibraryItem[] = marketplaces.flatMap((marketplace) => {
        const marketplaceTitle =
          marketplace.interface?.displayName || marketplace.name;
        const marketplaceItems = marketplace.plugins.map((plugin) => {
          const source =
            plugin.source.type === "local"
              ? locale === "zh"
                ? "本地"
                : "local"
              : plugin.source.type === "git"
                ? "Git"
                : locale === "zh"
                  ? "远程"
                  : "remote";
          const version = plugin.localVersion
            ? ` · v${plugin.localVersion}`
            : "";
          return {
            title: plugin.name,
            meta: `${source}${version} · ${
              plugin.enabled
                ? locale === "zh"
                  ? "启用"
                  : "enabled"
                : locale === "zh"
                  ? "停用"
                  : "disabled"
            } · ${plugin.installed ? (locale === "zh" ? "已安装" : "installed") : locale === "zh" ? "未安装" : "not installed"}`,
            description:
              plugin.keywords.length > 0
                ? plugin.keywords.join(", ")
                : plugin.shareContext?.creatorName
                  ? `${locale === "zh" ? "创建者" : "Creator"}: ${plugin.shareContext.creatorName}`
                  : undefined,
            action: {
              type: "plugin" as const,
              pluginName: plugin.name,
              marketplacePath: marketplace.path ?? null,
              remoteMarketplaceName: marketplace.path
                ? null
                : (marketplace.name ?? null),
            },
          };
        });

        return [
          {
            title: marketplaceTitle,
            meta:
              locale === "zh"
                ? `${marketplace.plugins.length} 个插件`
                : `${marketplace.plugins.length} plugins`,
            description: marketplace.path
              ? `${locale === "zh" ? "本地市场" : "Local marketplace"}: ${marketplace.path}`
              : locale === "zh"
                ? "远程插件市场"
                : "Remote plugin marketplace",
            section: true,
          } satisfies LibraryItem,
          ...marketplaceItems,
        ];
      });
      setLibraryPanel({
        kind,
        title,
        subtitle:
          locale === "zh"
            ? `${marketplaces.length} 个市场 · ${pluginEntries.length} 个插件 · ${enabledCount} 个启用`
            : `${marketplaces.length} marketplaces · ${pluginEntries.length} plugins · ${enabledCount} enabled`,
        body:
          locale === "zh"
            ? `已安装 ${installedCount} 个插件。插件提供 Skill、Hook、应用模板和 MCP 连接，安装后会进入工具、智能体和办公室的能力池。`
            : `${installedCount} plugins installed. Plugins provide Skills, Hooks, app templates, and MCP connectors for the tools, agents, and office capability pool.`,
        actions: [
          {
            id: "reload-plugins",
            label: locale === "zh" ? "刷新插件" : "Refresh plugins",
          },
        ],
        items:
          pluginItems.length > 0
            ? pluginItems
            : [
                {
                  title: locale === "zh" ? "暂无插件" : "No plugins",
                  meta:
                    locale === "zh"
                      ? "后端已连接"
                      : "backend connected",
                  description:
                    locale === "zh"
                      ? "当前工作区没有可用插件市场或插件条目。"
                      : "No plugin marketplace or plugin entry is available for the current workspace.",
                  section: true,
                },
              ],
        error:
          response?.marketplaceLoadErrors.length
            ? response.marketplaceLoadErrors
                .map(
                  (loadError) =>
                    `${loadError.marketplacePath}: ${loadError.message}`,
                )
                .join("\n")
            : undefined,
      });
    } catch (error) {
      if (libraryLoadRequestRef.current !== requestId) {
        return;
      }
      setLibraryPanel({
        kind,
        title,
        subtitle: locale === "zh" ? "读取失败" : "Unable to load",
        items: [],
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取失败"
              : "Unable to load",
      });
    } finally {
      window.clearTimeout(loadingFallbackTimer);
    }
  }

  async function openLibraryItem(item: LibraryItem) {
    if (!item.action || (!isConnected && !isDemo)) {
      return;
    }

    const action = item.action;

    if (
      isDemo &&
      action.type !== "mcp-detail" &&
      action.type !== "office-detail" &&
      action.type !== "agent-config"
    ) {
      return;
    }

    if (action.type === "plugin") {
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              body:
                locale === "zh"
                  ? "正在读取插件详情..."
                  : "Reading plugin details...",
              error: undefined,
            }
          : currentPanel,
      );

      try {
        const response = await clientRef.current?.readPlugin(
          action.pluginName,
          action.marketplacePath,
          action.remoteMarketplaceName,
        );

        if (!response) {
          return;
        }

        const sourceAction: LibraryPanelAction[] =
          response.plugin.summary.source.type === "local"
            ? [
                {
                  id: "open-path",
                  label:
                    locale === "zh"
                      ? "右栏打开插件目录"
                      : "Open plugin folder in sidebar",
                  pathToOpen: response.plugin.summary.source.path,
                  pathKind: "directory",
                },
              ]
            : [];
        const installActions: LibraryPanelAction[] =
          response.plugin.summary.installed
            ? [
                {
                  id: "uninstall-plugin",
                  label: locale === "zh" ? "卸载插件" : "Uninstall plugin",
                  pluginId: response.plugin.summary.id,
                  tone: "danger",
                },
              ]
            : response.plugin.summary.installPolicy === "AVAILABLE" &&
                response.plugin.summary.availability === "AVAILABLE"
              ? [
                  {
                    id: "install-plugin",
                    label: locale === "zh" ? "安装插件" : "Install plugin",
                    marketplacePath: action.marketplacePath,
                    pluginName: action.pluginName,
                    remoteMarketplaceName: action.remoteMarketplaceName,
                    tone: "primary",
                  },
                ]
              : [];

        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                title: response.plugin.summary.name,
                subtitle: locale === "zh" ? "插件详情" : "Plugin details",
                body: pluginDetailText(response, locale),
                actions:
                  sourceAction.length > 0 || installActions.length > 0
                    ? [...sourceAction, ...installActions]
                    : undefined,
              }
            : currentPanel,
        );
      } catch (error) {
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  error instanceof Error
                    ? error.message
                    : locale === "zh"
                      ? "读取插件失败"
                      : "Unable to read plugin",
              }
            : currentPanel,
        );
      }
      return;
    }

    if (action.type === "mcp-detail") {
      const tool = action.tool;
      const actions: LibraryPanelAction[] = [];
      if (action.authStatus === "notLoggedIn") {
        actions.push({
          id: "login-mcp-oauth",
          label: locale === "zh" ? "登录 MCP" : "Log in to MCP",
          mcpServerName: action.subtitle,
          tone: "primary",
        });
      }
      if (action.resource) {
        actions.push({
          id: "read-mcp-resource",
          label:
            locale === "zh"
              ? `读取资源：${action.resource.label}`
              : `Read resource: ${action.resource.label}`,
          mcpResourceServer: action.resource.server,
          mcpResourceUri: action.resource.uri,
          tone: action.authStatus === "notLoggedIn" ? undefined : "primary",
        });
      }
      if (tool) {
        actions.push({
          id: "call-mcp-tool",
          label:
            locale === "zh"
              ? `调用工具：${tool.label}`
              : `Call tool: ${tool.label}`,
          mcpServerName: tool.server,
          mcpToolName: tool.name,
          tone: action.authStatus === "notLoggedIn" ? undefined : "primary",
        });
      }
      if (action.configPath) {
        actions.push(
          {
            id: "open-path",
            label: locale === "zh" ? "打开配置文件" : "Open config file",
            pathToOpen: action.configPath,
            pathKind: "file",
          },
          {
            id: "delete-config-file",
            label: locale === "zh" ? "删除配置文件" : "Delete config file",
            pathToOpen: action.configPath,
            pathKind: "file",
            tone: "danger",
          },
        );
      }
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              title: action.title,
              subtitle: action.subtitle,
              body: [
                action.body,
                tool
                  ? [
                      "",
                      locale === "zh" ? "默认调用工具" : "Default callable tool",
                      `${tool.label} (${tool.name})`,
                      "inputSchema:",
                      tool.inputSchema,
                    ].join("\n")
                  : null,
              ]
                .filter(Boolean)
                .join("\n"),
              fields: tool
                ? [
                    {
                      id: "mcp-tool-arguments",
                      label: locale === "zh" ? "工具参数 JSON" : "Tool arguments JSON",
                      placeholder: "{\n}",
                      value: "{}",
                    },
                  ]
                : undefined,
              actions: actions.length > 0 ? actions : undefined,
              items: tool
                ? [
                    {
                      title:
                        locale === "zh"
                          ? "正在读取调用记录"
                          : "Reading call history",
                      meta: "app-server",
                      description:
                        locale === "zh"
                          ? "正在从工具验证线程读取最近调用记录。"
                          : "Loading recent calls from the tool verification thread.",
                      glyph: "◷",
                      accent: "blue",
                    },
                  ]
                : currentPanel.items,
              error: undefined,
            }
          : currentPanel,
      );
      if (tool && isConnected) {
        const toolThreadTitle =
          locale === "zh"
            ? `工具验证 · ${tool.server}.${tool.name}`
            : `Tool check · ${tool.server}.${tool.name}`;
        void (async () => {
          const backendThreads =
            (await clientRef.current?.listThreads(false)) ?? [];
          const matchingThread = backendThreads.find(
            (thread) =>
              threadTitle(thread, "") === toolThreadTitle ||
              thread.preview.includes(`${tool.server}.${tool.name}`),
          );
          if (!matchingThread) {
            setLibraryPanel((currentPanel) =>
              currentPanel?.title === action.title &&
              currentPanel.subtitle === action.subtitle
                ? { ...currentPanel, items: toolEmptyHistoryItems(locale) }
                : currentPanel,
            );
            return;
          }

          const thread =
            (await clientRef.current?.readThread(matchingThread.id)) ??
            matchingThread;
          setLibraryPanel((currentPanel) =>
            currentPanel?.title === action.title &&
            currentPanel.subtitle === action.subtitle
              ? {
                  ...currentPanel,
                  actions: [
                    {
                      id: "open-thread",
                      label:
                        locale === "zh"
                          ? "打开工具验证线程"
                          : "Open tool verification thread",
                      threadId: thread.id,
                    },
                    ...(currentPanel.actions ?? []).filter(
                      (currentAction) => currentAction.id !== "open-thread",
                    ),
                  ],
                  items: toolThreadHistoryItems(thread, locale),
                  error: undefined,
                }
              : currentPanel,
          );
        })().catch((error) => {
          setLibraryPanel((currentPanel) =>
            currentPanel?.title === action.title &&
            currentPanel.subtitle === action.subtitle
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "读取工具调用记录失败"
                        : "Unable to read tool call history",
                }
              : currentPanel,
          );
        });
      }
      return;
    }

    if (action.type === "office-detail") {
      const officePanel: LibraryPanel = {
        kind: "office",
        title: action.title,
        subtitle: action.subtitle,
        body: action.workspace ? undefined : action.body,
        actions: [
          ...(action.workspace?.threadId
            ? [
                {
                  id: "open-thread" as const,
                  label:
                    locale === "zh" ? "打开后端线程" : "Open backend thread",
                  threadId: action.workspace.threadId,
                },
              ]
            : []),
          {
            id: "recruit-agent",
            label: locale === "zh" ? "招募智能体" : "Recruit agent",
            tone: "primary",
          },
          ...(action.configPath
            ? [
                {
                  id: "open-path" as const,
                  label: locale === "zh" ? "打开配置文件" : "Open config file",
                  pathToOpen: action.configPath,
                  pathKind: "file" as const,
                },
                {
                  id: "delete-config-file" as const,
                  label:
                    locale === "zh" ? "删除配置文件" : "Delete config file",
                  pathToOpen: action.configPath,
                  pathKind: "file" as const,
                  tone: "danger" as const,
                },
              ]
            : []),
        ],
        items: action.items,
        workspace: action.workspace,
      };
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              ...officePanel,
              error: undefined,
            }
          : currentPanel,
      );
      if (action.workspace && isConnected) {
        void (async () => {
          const threadId = await ensureOfficeThread(officePanel);
          if (!threadId) {
            return;
          }
          const thread = await clientRef.current?.readThread(threadId);
          if (!thread) {
            return;
          }
          const parsed = parseOfficeConfigFromThread(thread, locale);
          const hydratedConfig =
            parsed ?? {
              title: action.title,
              subtitle: action.subtitle,
              workspace: workspaceFromBackendThread(thread, locale),
            };
          setLibraryPanel((currentPanel) =>
            currentPanel?.workspace?.threadId === threadId
              ? {
                  ...currentPanel,
                  title: hydratedConfig.title,
                  subtitle: hydratedConfig.subtitle,
                  body: undefined,
                  error: undefined,
                  workspace: hydratedConfig.workspace,
                }
              : currentPanel,
          );
        })().catch((error) => {
          setLibraryPanel((currentPanel) =>
            currentPanel?.workspace
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "绑定办公室线程失败"
                        : "Unable to bind office thread",
                  workspace: {
                    ...currentPanel.workspace,
                    backendStatus: "error",
                  },
                }
              : currentPanel,
          );
        });
      }
      return;
    }

    if (action.type === "agent-config") {
      const initialHistory: LibraryItem[] = action.config.threadId
        ? [
            {
              title:
                locale === "zh"
                  ? "正在读取后端记录"
                  : "Reading backend records",
              meta: "app-server",
              description:
                locale === "zh"
                  ? "正在从智能体线程读取最近配置记录。"
                  : "Loading recent configuration records from the agent thread.",
              glyph: "◷",
              accent: "blue",
            },
          ]
        : [];
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              title: action.config.name,
              subtitle: locale === "zh" ? "智能体配置" : "Agent configuration",
              body: undefined,
              actions: action.configPath
                ? [
                    {
                      id: "open-path" as const,
                      label:
                        locale === "zh" ? "打开配置文件" : "Open config file",
                      pathToOpen: action.configPath,
                      pathKind: "file" as const,
                    },
                    {
                      id: "delete-config-file" as const,
                      label:
                        locale === "zh" ? "删除配置文件" : "Delete config file",
                      pathToOpen: action.configPath,
                      pathKind: "file" as const,
                      tone: "danger" as const,
                    },
                  ]
                : undefined,
              items: initialHistory,
              agentConfig: action.config,
              error: undefined,
            }
          : currentPanel,
      );
      if (action.config.threadId && isConnected) {
        const agentThreadId = action.config.threadId;
        void (async () => {
          try {
            const thread = await clientRef.current?.readThread(agentThreadId);
            if (!thread) {
              return;
            }
            setLibraryPanel((currentPanel) =>
              currentPanel?.agentConfig?.threadId === agentThreadId
                ? {
                    ...currentPanel,
                    items: agentThreadHistoryItems(thread, locale),
                    error: undefined,
                  }
                : currentPanel,
            );
          } catch (error) {
            setLibraryPanel((currentPanel) =>
              currentPanel?.agentConfig?.threadId === agentThreadId
                ? {
                    ...currentPanel,
                    error:
                      error instanceof Error
                        ? error.message
                        : locale === "zh"
                          ? "读取智能体后端记录失败"
                          : "Unable to read agent backend records",
                  }
                : currentPanel,
            );
          }
        })();
      }
      return;
    }

    if (action.type === "automation-detail") {
      const initialHistory: LibraryItem[] = action.threadId
        ? [
            {
              title:
                locale === "zh"
                  ? "正在读取运行记录"
                  : "Reading run history",
              meta: locale === "zh" ? "app-server" : "app-server",
              description:
                locale === "zh"
                  ? "正在从后端执行线程读取最近运行记录。"
                  : "Loading recent runs from the backend execution thread.",
              glyph: "◷",
              accent: "blue",
            },
          ]
        : [
            {
              title: locale === "zh" ? "暂无后端线程" : "No backend thread",
              meta:
                locale === "zh"
                  ? "首次运行后创建"
                  : "Created after the first run",
              description:
                locale === "zh"
                  ? "点击立即运行后会创建真实执行线程并写入运行记录。"
                  : "Run now to create a real execution thread and write the run history.",
              glyph: "◷",
              accent: "slate",
            },
          ];
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              title: action.title,
              subtitle: action.subtitle,
              body: action.body,
              actions: [
                ...(action.threadId
                  ? [
                      {
                        id: "open-thread" as const,
                        label:
                          locale === "zh"
                            ? "打开后端线程"
                            : "Open backend thread",
                        threadId: action.threadId,
                      },
                    ]
                  : []),
                {
                  id: "run-automation",
                  label: locale === "zh" ? "立即运行" : "Run now",
                  automationTitle: action.title,
                  automationThreadId: action.threadId,
                  automationPrompt: action.prompt,
                  tone: "primary",
                },
                ...(action.configPath
                  ? [
                      {
                        id: "open-path" as const,
                        label:
                          locale === "zh" ? "打开配置文件" : "Open config file",
                        pathToOpen: action.configPath,
                        pathKind: "file" as const,
                      },
                      {
                        id: "delete-config-file" as const,
                        label:
                          locale === "zh" ? "删除配置文件" : "Delete config file",
                        pathToOpen: action.configPath,
                        pathKind: "file" as const,
                        tone: "danger" as const,
                      },
                    ]
                  : []),
              ],
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
              items: initialHistory,
              error: undefined,
            }
          : currentPanel,
      );
      if (action.threadId && isConnected) {
        const automationThreadId = action.threadId;
        void (async () => {
          try {
            const thread = await clientRef.current?.readThread(automationThreadId);
            if (!thread) {
              return;
            }
            setLibraryPanel((currentPanel) =>
              currentPanel?.title === action.title
                ? {
                    ...currentPanel,
                    items: automationRunHistoryItems(thread, locale),
                    error: undefined,
                  }
                : currentPanel,
            );
          } catch (error) {
            setLibraryPanel((currentPanel) =>
              currentPanel?.title === action.title
                ? {
                    ...currentPanel,
                    error:
                      error instanceof Error
                        ? error.message
                        : locale === "zh"
                          ? "读取自动化运行记录失败"
                          : "Unable to read automation run history",
                  }
                : currentPanel,
            );
          }
        })();
      }
      return;
    }

    if (action.type === "external-agent-import") {
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              body:
                locale === "zh"
                  ? "正在导入 Agent 配置..."
                  : "Importing agent config...",
              error: undefined,
            }
          : currentPanel,
      );

      try {
        await clientRef.current?.importExternalAgentConfig(action.item);
        const importedConfigBase = await createBackendAgentConfig();
        const importedName =
          locale === "zh"
            ? `导入智能体 · ${action.item.description}`
            : `Imported agent · ${action.item.description}`;
        const importedConfig: AgentConfig = {
          ...importedConfigBase,
          name: importedName,
          role:
            locale === "zh"
              ? `${action.item.itemType} · 可招募`
              : `${action.item.itemType} · recruitable`,
          systemPrompt: [
            locale === "zh"
              ? "这是从外部 Agent 配置迁移进 Crewon 的智能体。"
              : "This agent was migrated into Crewon from an external agent configuration.",
            externalAgentMigrationSummary(action.item, locale),
            importedConfigBase.systemPrompt,
          ].join("\n\n"),
        };
        const thread =
          (await clientRef.current?.startThread(
            action.item.cwd ?? undefined,
            "agent",
          )) ?? null;
        if (thread) {
          await clientRef.current?.renameThread(thread.id, importedConfig.name);
          await clientRef.current?.setThreadGoal(
            thread.id,
            locale === "zh"
              ? `导入外部智能体配置「${action.item.description}」，并作为办公室可招募角色使用。`
              : `Import external agent config "${action.item.description}" and make it recruitable by offices.`,
            null,
          );
          const payloadConfig = { ...importedConfig, threadId: thread.id };
          const agentConfigPath = await writeAgentConfigFile(payloadConfig);
          const response = await clientRef.current?.startTurn(
            thread.id,
            [
              locale === "zh"
                ? `导入智能体：${importedConfig.name}`
                : `Import agent: ${importedConfig.name}`,
              `Source: ${action.item.itemType}`,
              action.item.cwd ? `CWD: ${action.item.cwd}` : "Scope: Home",
              "",
              externalAgentMigrationSummary(action.item, locale),
              "",
              agentConfigPayload(payloadConfig),
              agentConfigPath
                ? locale === "zh"
                  ? `配置文件：${agentConfigPath}`
                  : `Config file: ${agentConfigPath}`
                : "",
            ].join("\n"),
          );
          setThreads((current) =>
            upsertThread(current, { ...thread, name: importedConfig.name }),
          );
          if (response) {
            setThreads((current) =>
              current.map((candidate) =>
                candidate.id === thread.id
                  ? upsertTurn(candidate, response.turn)
                  : candidate,
              ),
            );
          }
        }
        await openLibrary("agents");
        setNotice(
          thread
            ? {
                text:
                  locale === "zh"
                    ? `已导入并创建后端智能体：${importedConfig.name}`
                    : `Imported and created backend agent: ${importedConfig.name}`,
                tone: "success",
              }
            : {
                text:
                  locale === "zh"
                    ? "外部配置已导入，但未创建智能体线程"
                    : "External config imported, but no agent thread was created",
                tone: "warning",
              },
        );
      } catch (error) {
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  error instanceof Error
                    ? error.message
                    : locale === "zh"
                      ? "导入 Agent 配置失败"
                      : "Unable to import agent config",
              }
            : currentPanel,
        );
      }
      return;
    }

    if (action.type === "skill-file") {
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              body: locale === "zh" ? "正在读取 Skill..." : "Reading skill...",
              error: undefined,
            }
          : currentPanel,
      );

      try {
        const response = await clientRef.current?.readFile(action.path);
        if (!response) {
          return;
        }

        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                title: action.skillName,
                subtitle: action.path,
                body: decodeBase64Text(response.dataBase64),
                actions: [
                  {
                    id: "open-path",
                    label:
                      locale === "zh"
                        ? "右栏打开源文件"
                        : "Open source in sidebar",
                    pathToOpen: action.path,
                    pathKind: "file",
                  },
                  {
                    id: "toggle-skill",
                    label:
                      action.enabled === false
                        ? locale === "zh"
                          ? "启用 Skill"
                          : "Enable skill"
                        : locale === "zh"
                          ? "停用 Skill"
                          : "Disable skill",
                    skillEnabled: action.enabled !== false,
                    skillName: action.skillName,
                    skillPath: action.path,
                    tone: action.enabled === false ? "primary" : undefined,
                  },
                  ...(action.configPath
                    ? [
                        {
                          id: "open-path" as const,
                          label:
                            locale === "zh"
                              ? "打开配置文件"
                              : "Open config file",
                          pathToOpen: action.configPath,
                          pathKind: "file" as const,
                        },
                        {
                          id: "delete-config-file" as const,
                          label:
                            locale === "zh"
                              ? "删除配置文件"
                              : "Delete config file",
                          pathToOpen: action.configPath,
                          pathKind: "file" as const,
                          tone: "danger" as const,
                        },
                      ]
                    : []),
                ],
              }
            : currentPanel,
        );
      } catch (error) {
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  error instanceof Error
                    ? error.message
                    : locale === "zh"
                      ? "读取 Skill 失败"
                      : "Unable to read skill",
              }
            : currentPanel,
        );
      }
      return;
    }

    if (action.type === "plugin-skill") {
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              body: locale === "zh" ? "正在读取 Skill..." : "Reading skill...",
              error: undefined,
            }
          : currentPanel,
      );

      try {
        const response = await clientRef.current?.readPluginSkill(
          action.remoteMarketplaceName,
          action.remotePluginId,
          action.skillName,
        );

        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                title: item.title,
                subtitle: locale === "zh" ? "Skill 详情" : "Skill details",
                body:
                  response?.contents ??
                  (locale === "zh" ? "暂无内容" : "No contents"),
              }
            : currentPanel,
        );
      } catch (error) {
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  error instanceof Error
                    ? error.message
                    : locale === "zh"
                      ? "读取 Skill 失败"
                      : "Unable to read skill",
              }
            : currentPanel,
        );
      }
    }
  }

  async function ensureOfficeThread(
    panel: LibraryPanel,
    workspaceOverride?: OfficeWorkspace,
    forceNew = false,
  ): Promise<string | null> {
    const workspace = workspaceOverride ?? panel.workspace;
    if (!workspace) {
      return null;
    }

    if (!isConnected) {
      return workspace.threadId ?? null;
    }

    if (workspace.threadId && !forceNew) {
      try {
        await clientRef.current?.readThread(workspace.threadId);
        await persistOfficeWorkspace(panel, workspace, workspace.threadId);
        setLibraryPanel((currentPanel) =>
          currentPanel?.workspace
            ? {
                ...currentPanel,
                workspace: {
                  ...currentPanel.workspace,
                  threadId: workspace.threadId,
                  backendStatus: "connected",
                },
              }
            : currentPanel,
        );
        return workspace.threadId;
      } catch (error) {
        if (!isMissingThreadError(error)) {
          throw error;
        }
      }
    }

    setLibraryPanel((currentPanel) =>
      currentPanel?.workspace
        ? {
            ...currentPanel,
            workspace: {
              ...currentPanel.workspace,
              threadId: undefined,
              backendStatus: "binding",
            },
          }
        : currentPanel,
    );

    const thread = await clientRef.current?.startThread(undefined, "office");
    if (!thread) {
      return null;
    }

    await clientRef.current?.renameThread(thread.id, panel.title);
    await clientRef.current?.setThreadGoal(thread.id, workspace.goal, null);
    const config = officeConfigForThread(
      panel.title,
      panel.subtitle,
      workspace,
      thread.id,
    );
    await clientRef.current?.startTurn(
      thread.id,
      [
        locale === "zh"
          ? `绑定办公室：${panel.title}`
          : `Bind office: ${panel.title}`,
        "",
        officeConfigPayload(config),
      ].join("\n"),
    );
    await persistOfficeWorkspace(panel, workspace, thread.id);
    const namedThread = { ...thread, name: panel.title };
    setThreads((current) => upsertThread(current, namedThread));

    setLibraryPanel((currentPanel) =>
      currentPanel?.workspace
        ? {
            ...currentPanel,
            subtitle:
              currentPanel.subtitle.includes("后端线程") ||
              currentPanel.subtitle.includes("backend thread")
                ? currentPanel.subtitle
                : locale === "zh"
                  ? `${currentPanel.subtitle} · 已绑定后端线程`
                  : `${currentPanel.subtitle} · backend thread bound`,
            workspace: {
              ...currentPanel.workspace,
              threadId: thread.id,
              backendStatus: "connected",
            },
          }
        : currentPanel,
    );

    return thread.id;
  }

  async function persistOfficeWorkspace(
    panel: Pick<LibraryPanel, "title" | "subtitle">,
    workspace: OfficeWorkspace,
    threadId?: string | null,
  ): Promise<string | null> {
    const stableThreadId = threadId ?? workspace.threadId;
    if (!stableThreadId) {
      return null;
    }
    return writeOfficeConfigFile(
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspace,
        stableThreadId,
      ),
    );
  }

  async function persistOfficeMessage(
    panel: Pick<LibraryPanel, "title" | "subtitle">,
    workspaceBeforeMessage: OfficeWorkspace,
    message: OfficeMessage,
    threadId: string,
  ): Promise<OfficeConfig | null> {
    const officeCwd = await resolveBackendCwd();
    const client = clientRef.current;
    if (!officeCwd || !client) {
      return null;
    }
    try {
      const response = await client.sendOfficeMessageConfig(
        officeCwd,
        officeConfigForThread(
          panel.title,
          panel.subtitle,
          workspaceBeforeMessage,
          threadId,
        ),
        message,
      );
      return response.config;
    } catch (error) {
      if (!(error instanceof AppServerRpcError)) {
        throw error;
      }
      await persistOfficeWorkspace(
        panel,
        {
          ...workspaceBeforeMessage,
          messages: [...workspaceBeforeMessage.messages, message],
        },
        threadId,
      );
      return null;
    }
  }

  async function writeOfficeConfigFile(config: OfficeConfig): Promise<string | null> {
    const officeCwd = await resolveBackendCwd();
    const client = clientRef.current;
    if (!officeCwd || !client) {
      return null;
    }
    return writeStoredOfficeConfigFile(client, officeCwd, config);
  }

  async function readOfficeConfigFiles(): Promise<LibraryItem[]> {
    const officeCwd = await resolveBackendCwd();
    const client = clientRef.current;
    if (!officeCwd || !client) {
      return [];
    }

    const records = await readStoredOfficeConfigFiles(client, officeCwd);
    return records.map(({ filePath, savedAt, config }) => ({
        title: config.title,
        meta:
          locale === "zh"
            ? `工作区配置 · ${savedAt ? new Date(savedAt).toLocaleString("zh-CN") : pathBaseName(filePath)}`
            : `Workspace config · ${savedAt ? new Date(savedAt).toLocaleString("en-US") : pathBaseName(filePath)}`,
        description:
          config.workspace.goal ||
          (locale === "zh"
            ? "从工作区配置恢复的办公室。"
            : "Office restored from a workspace config."),
        glyph: "⌘",
        accent: "green",
        badge: { label: locale === "zh" ? "配置" : "config", tone: "planning" },
        action: {
          type: "office-detail",
          title: config.title,
          subtitle: config.subtitle,
          body: config.workspace.goal,
          items: [],
          workspace: config.workspace,
          configPath: filePath,
        },
      }));
  }

  async function writeAgentConfigFile(config: AgentConfig): Promise<string | null> {
    const agentCwd = await resolveBackendCwd();
    const client = clientRef.current;
    if (!agentCwd || !client) {
      return null;
    }
    return writeStoredAgentConfigFile(client, agentCwd, config);
  }

  async function readAgentConfigFiles(): Promise<LibraryItem[]> {
    const agentCwd = await resolveBackendCwd();
    const client = clientRef.current;
    if (!agentCwd || !client) {
      return [];
    }

    const records = await readStoredAgentConfigFiles(client, agentCwd);
    return records.map(({ filePath, savedAt, config }) => ({
        title: config.name,
        meta:
          locale === "zh"
            ? `工作区配置 · ${savedAt ? new Date(savedAt).toLocaleString("zh-CN") : pathBaseName(filePath)}`
            : `Workspace config · ${savedAt ? new Date(savedAt).toLocaleString("en-US") : pathBaseName(filePath)}`,
        description:
          locale === "zh"
            ? `${config.role} · ${config.model} · ${config.permission}`
            : `${config.role} · ${config.model} · ${config.permission}`,
        glyph: config.glyph,
        accent: config.accent,
        badge: { label: locale === "zh" ? "配置" : "config", tone: "planning" },
        action: {
          type: "agent-config",
          config,
          configPath: filePath,
        },
      }));
  }

  async function writeAutomationConfigFile(
    config: AutomationConfig,
  ): Promise<string | null> {
    const automationCwd = await resolveBackendCwd();
    const client = clientRef.current;
    if (!automationCwd || !client) {
      return null;
    }
    return writeStoredAutomationConfigFile(client, automationCwd, config);
  }

  async function readAutomationConfigFiles(): Promise<LibraryItem[]> {
    const automationCwd = await resolveBackendCwd();
    const client = clientRef.current;
    if (!automationCwd || !client) {
      return [];
    }

    const records = await readStoredAutomationConfigFiles(client, automationCwd);
    return records.map(({ filePath, savedAt, config }) => ({
        title: config.title,
        meta:
          locale === "zh"
            ? `工作区配置 · ${savedAt ? new Date(savedAt).toLocaleString("zh-CN") : pathBaseName(filePath)}`
            : `Workspace config · ${savedAt ? new Date(savedAt).toLocaleString("en-US") : pathBaseName(filePath)}`,
        description: config.subtitle || promptPreview(config.prompt),
        glyph: "⏱",
        accent: "cyan",
        badge: { label: locale === "zh" ? "配置" : "config", tone: "planning" },
        action: {
          type: "automation-detail",
          title: config.title,
          subtitle: config.subtitle,
          body: [
            config.body,
            locale === "zh" ? `配置文件：${filePath}` : `Config file: ${filePath}`,
          ].join("\n"),
          prompt: config.prompt,
          threadId: config.threadId,
          configPath: filePath,
        },
      }));
  }

  async function writeToolConfigFile(config: ToolConfig): Promise<string | null> {
    const toolCwd = await resolveBackendCwd();
    const client = clientRef.current;
    if (!toolCwd || !client) {
      return null;
    }
    return writeStoredToolConfigFile(client, toolCwd, config);
  }

  async function readToolConfigFiles(): Promise<LibraryItem[]> {
    const toolCwd = await resolveBackendCwd();
    const client = clientRef.current;
    if (!toolCwd || !client) {
      return [];
    }

    const records = await readStoredToolConfigFiles(client, toolCwd);
    return records.map(({ filePath, savedAt, config }) => ({
      title: `${config.kind === "mcp" ? "MCP" : "Skill"} · ${config.title}`,
      meta:
        locale === "zh"
          ? `工作区配置 · ${savedAt ? new Date(savedAt).toLocaleString("zh-CN") : pathBaseName(filePath)}`
          : `Workspace config · ${savedAt ? new Date(savedAt).toLocaleString("en-US") : pathBaseName(filePath)}`,
      description:
        config.description ||
        (config.kind === "mcp"
          ? config.command
          : config.path) ||
        (locale === "zh"
          ? "从工作区工具配置恢复。"
          : "Restored from a workspace tool config."),
      glyph: config.kind === "mcp" ? "⌁" : "◇",
      accent: config.kind === "mcp" ? "blue" : "violet",
      badge: {
        label: config.kind === "mcp" ? "MCP" : "Skill",
        tone: config.enabled === false ? "warning" : "planning",
      },
      action:
        config.kind === "mcp"
          ? {
              type: "mcp-detail",
              title: config.title,
              subtitle: config.name,
              body: [
                config.description,
                config.command
                  ? `${locale === "zh" ? "命令" : "Command"}: ${config.command}`
                  : null,
                config.args?.length
                  ? `${locale === "zh" ? "参数" : "Args"}: ${config.args.join(" ")}`
                  : null,
                locale === "zh" ? `配置文件：${filePath}` : `Config file: ${filePath}`,
              ]
                .filter(Boolean)
                .join("\n"),
              configPath: filePath,
            }
          : {
              type: "skill-file",
              skillName: config.name,
              path: config.path ?? filePath,
              enabled: config.enabled ?? true,
              configPath: filePath,
            },
    }));
  }

  async function readRecruitableAgentConfig(
    existingMembers: OfficeMember[],
  ): Promise<AgentConfig | null> {
    if (!isConnected) {
      return null;
    }

    const memberNames = new Set(existingMembers.map((member) => member.name));
    const backendThreads = (await clientRef.current?.listThreads(false)) ?? [];
    const agentDetails = await Promise.allSettled(
      backendThreads.map(async (thread) => {
        const detailedThread =
          (await clientRef.current?.readThread(thread.id)) ?? thread;
        return {
          thread: detailedThread,
          config: parseAgentConfigFromThread(detailedThread, locale),
        };
      }),
    );

    const configs = agentDetails
      .flatMap((result) =>
        result.status === "fulfilled" && result.value.config
          ? [
              {
                updatedAt: result.value.thread.updatedAt,
                config: result.value.config,
              },
            ]
          : [],
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((entry) => entry.config);

    return (
      configs.find((config) => !memberNames.has(config.name)) ??
      configs[0] ??
      null
    );
  }

  async function readLatestOfficeConfig(): Promise<OfficeConfig | null> {
    if (!isConnected) {
      return null;
    }

    const [backendThreads, workspaceOfficeItems] = await Promise.all([
      clientRef.current?.listThreads(false),
      readOfficeConfigFiles(),
    ]);
    const workspaceConfigs = workspaceOfficeItems.flatMap((item) =>
      item.action?.type === "office-detail" && item.action.workspace
        ? [
            {
              updatedAt: Date.now(),
              config: {
                title: item.action.title,
                subtitle: item.action.subtitle,
                workspace: item.action.workspace,
              },
            },
          ]
        : [],
    );
    const officeDetails = await Promise.allSettled(
      (backendThreads ?? []).map(async (thread) => {
        const detailedThread =
          (await clientRef.current?.readThread(thread.id)) ?? thread;
        return {
          thread: detailedThread,
          config: parseOfficeConfigFromThread(detailedThread, locale),
        };
      }),
    );

    return (
      officeDetails
        .flatMap((result) =>
          result.status === "fulfilled" && result.value.config
            ? [
                {
                  updatedAt: result.value.thread.updatedAt,
                  config: result.value.config,
                },
              ]
            : [],
        )
        .concat(workspaceConfigs)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.config ??
      null
    );
  }

  async function createBackendAgentConfig(): Promise<AgentConfig> {
    const fallback = createDefaultAgentConfig(locale);
    if (!isConnected) {
      return fallback;
    }

    const effectiveCwd = isDemoPreview ? await resolveBackendCwd() : cwd;
    const effectiveThreadId = isDemoPreview
      ? undefined
      : (selectedThreadId ?? undefined);

    let mcpResponse;
    try {
      mcpResponse = await clientRef.current?.listMcpServerStatus(
        effectiveThreadId,
        "full",
      );
    } catch (threadScopedError) {
      if (
        !(threadScopedError instanceof Error) ||
        !threadScopedError.message.includes("thread not found")
      ) {
        throw threadScopedError;
      }
      mcpResponse = await clientRef.current?.listMcpServerStatus(
        undefined,
        "full",
      );
    }

    const [skillsResponse, modelsResponse, permissionsResponse] =
      await Promise.all([
        clientRef.current?.listSkills(effectiveCwd),
        clientRef.current?.listModels(),
        clientRef.current?.listPermissionProfiles(effectiveCwd),
      ]);

    const mcp = (mcpResponse?.data ?? []).map(createMcpAgentOptionWithLocale);
    const skills = (skillsResponse?.data ?? [])
      .flatMap((entry) => entry.skills)
      .map(createSkillAgentOptionWithLocale);
    const models =
      modelsResponse?.data.map((model) => model.model).filter(Boolean) ?? [];
    const defaultModel =
      modelsResponse?.data.find((model) => model.isDefault)?.model ?? models[0];
    const permissions =
      permissionsResponse?.data
        .map((permission) => permission.id)
        .filter(Boolean) ?? [];

    function createMcpAgentOptionWithLocale(
      server: McpServerStatus,
      index: number,
    ) {
      return createMcpAgentOption(server, locale, index);
    }

    function createSkillAgentOptionWithLocale(
      skill: SkillMetadata,
      index: number,
    ) {
      return createSkillAgentOption(skill, locale, index);
    }

    return {
      ...fallback,
      role:
        locale === "zh"
          ? "后端能力智能体 · 可招募"
          : "Backend-capable agent · recruitable",
      systemPrompt:
        locale === "zh"
          ? "你是办公室中的自定义智能体。你的模型、权限、MCP 和 Skill 来自当前 app-server。先理解目标，再列出计划，必要时调用已授权工具，并把结果沉淀为可复用交付物。"
          : "You are a custom agent in an office. Your model, permission profile, MCP connectors, and skills come from the current app-server. Understand the goal, outline a plan, use authorized tools when needed, and turn results into reusable deliverables.",
      model:
        defaultModel && models.includes(defaultModel)
          ? defaultModel
          : fallback.model,
      models: models.length > 0 ? models : fallback.models,
      permission: permissions[0] ?? fallback.permission,
      permissions:
        permissions.length > 0 ? permissions : fallback.permissions,
      mcp: mcp.length > 0 ? mcp : fallback.mcp,
      skills: skills.length > 0 ? skills : fallback.skills,
    };
  }

  async function createBackendKnowledgeData(): Promise<KnowledgeData> {
    const knowledgeCwd = await resolveBackendCwd();
    if (!knowledgeCwd) {
      return { memories: [], sources: [] };
    }

    const [rootResponse, backendThreadsResponse] = await Promise.all([
      clientRef.current?.readDirectory(knowledgeCwd),
      clientRef.current?.listThreads(false),
    ]);
    const rootEntries = rootResponse?.entries ?? [];
    const importantNames = new Set([
      ".crewon",
      "AGENTS.md",
      "ARCHITECTURE.md",
      "README.md",
      "README",
      "apps",
      "codex-rs",
      "docs",
      "packages",
      "pnpm-workspace.yaml",
    ]);
    const visibleEntries = rootEntries
      .filter((entry) => importantNames.has(entry.fileName))
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
    const sources: KnowledgeSource[] = [
      {
        name: pathBaseName(knowledgeCwd),
        glyph: "▦",
        accent: "blue",
        status: "indexed",
        path: knowledgeCwd,
        isDirectory: true,
        meta:
          locale === "zh"
            ? `${rootEntries.length} 个根目录条目 · app-server 文件系统`
            : `${rootEntries.length} root entries · app-server filesystem`,
      },
      ...visibleEntries.map((entry, index): KnowledgeSource => ({
        name: entry.fileName,
        glyph: entry.isDirectory ? "▤" : "◇",
        accent: CAPABILITY_ACCENTS[(index + 1) % CAPABILITY_ACCENTS.length],
        status: "indexed",
        path: joinPath(knowledgeCwd, entry.fileName),
        isDirectory: entry.isDirectory,
        meta: entry.isDirectory
          ? locale === "zh"
            ? "目录 · 可作为知识源"
            : "Directory · available as a knowledge source"
          : locale === "zh"
            ? "文件 · 已读取元数据"
            : "File · metadata available",
      })),
    ];
    const memoryPaths = [
      joinPath(knowledgeCwd, "AGENTS.md"),
      joinPath(knowledgeCwd, "README.md"),
      joinPath(joinPath(knowledgeCwd, ".crewon"), "memory.md"),
      joinPath(joinPath(knowledgeCwd, ".crewon"), "knowledge.md"),
    ];
    const memoryResults = await Promise.allSettled(
      memoryPaths.map(async (path) => {
        const response = await clientRef.current?.readFile(path);
        return {
          path,
          text: response ? decodeBase64Text(response.dataBase64) : "",
        };
      }),
    );
    const fileMemories = memoryResults.flatMap(
      (result, index): KnowledgeEntry[] => {
        if (result.status !== "fulfilled" || !result.value.text.trim()) {
          return [];
        }

        const title = knowledgeTitleFromPath(result.value.path);
        const isAgentsFile = pathBaseName(result.value.path) === "AGENTS.md";
        return [
          {
            title,
            glyph: isAgentsFile ? "★" : index % 2 === 0 ? "◆" : "✓",
            accent: isAgentsFile
              ? "amber"
              : CAPABILITY_ACCENTS[(index + 2) % CAPABILITY_ACCENTS.length],
            kind: isAgentsFile
              ? locale === "zh"
                ? "工程规则"
                : "Agent rules"
              : locale === "zh"
                ? "工作区记忆"
                : "Workspace memory",
            preview: knowledgePreviewFromText(
              result.value.text,
              locale === "zh"
                ? "已从工作区文件读取。"
                : "Loaded from workspace file.",
            ),
            path: result.value.path,
            meta:
              locale === "zh"
                ? `${result.value.path} · ${result.value.text.length} 字符`
                : `${result.value.path} · ${result.value.text.length} chars`,
            pinned: isAgentsFile,
          },
        ];
      },
    );
    const backendThreads = backendThreadsResponse ?? [];
    const reusableSources = new Set(["agent", "office", "automation", "tool"]);
    const backendMemories = backendThreads
      .filter(
        (thread) =>
          reusableSources.has(thread.threadSource ?? "") ||
          threadTitle(thread, "").includes("工具验证") ||
          threadTitle(thread, "").includes("Tool check") ||
          thread.preview.includes("CREWON_"),
      )
      .slice(0, 8)
      .map((thread, index): KnowledgeEntry => {
        const source = thread.threadSource ?? "thread";
        const kind =
          locale === "zh"
            ? source === "agent"
              ? "后端智能体"
              : source === "office"
                ? "后端办公室"
                : source === "automation"
                  ? "自动化记录"
                  : source === "tool"
                    ? "工具调用"
                    : "后端会话"
            : source === "agent"
              ? "Backend agent"
              : source === "office"
                ? "Backend office"
                : source === "automation"
                  ? "Automation record"
                  : source === "tool"
                    ? "Tool call"
                    : "Backend thread";
        return {
          title: threadTitle(
            thread,
            locale === "zh" ? "后端知识记录" : "Backend knowledge record",
          ),
          glyph: source === "office" ? "◎" : source === "agent" ? "✦" : "◇",
          accent: CAPABILITY_ACCENTS[(index + 4) % CAPABILITY_ACCENTS.length],
          kind,
          preview:
            knowledgePreviewFromText(
              thread.preview,
              locale === "zh"
                ? "点击打开后端线程查看完整上下文。"
                : "Open the backend thread for full context.",
            ) ||
            (locale === "zh"
              ? "点击打开后端线程查看完整上下文。"
              : "Open the backend thread for full context."),
          threadId: thread.id,
          meta:
            locale === "zh"
              ? `${kind} · ${formatUnixSeconds(thread.updatedAt, locale)}`
              : `${kind} · ${formatUnixSeconds(thread.updatedAt, locale)}`,
          pinned: source === "office",
        };
      });
    const memories = [...fileMemories, ...backendMemories];

    return { memories, sources };
  }

  async function writeKnowledgeMemory(): Promise<string | null> {
    const knowledgeCwd = await resolveBackendCwd();
    if (!knowledgeCwd) {
      return null;
    }

    const crewonDir = joinPath(knowledgeCwd, ".crewon");
    const knowledgePath = joinPath(crewonDir, "knowledge.md");
    await clientRef.current?.createDirectory(crewonDir, true);

    let existing = "";
    try {
      const response = await clientRef.current?.readFile(knowledgePath);
      existing = response ? decodeBase64Text(response.dataBase64) : "";
    } catch {
      existing = "";
    }

    const now = new Date().toISOString();
    const selectedThread =
      selectedThreadId && !isDemoThreadId(selectedThreadId)
        ? threads.find((thread) => thread.id === selectedThreadId)
        : null;
    const title =
      selectedThread && threadTitle(selectedThread, "")
        ? threadTitle(selectedThread, "")
        : "Crewon workspace memory";
    const entry = [
      `## ${now}`,
      "",
      `- Source: Crewon UI knowledge page`,
      `- Workspace: ${knowledgeCwd}`,
      selectedThread ? `- Session: ${title}` : null,
      "- Note: Backend-connected knowledge memory was written from the UI and can be reused by agents, offices, and automations.",
      "",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    const next = existing.trim()
      ? `${existing.trimEnd()}\n\n${entry}`
      : `# Crewon Knowledge\n\n${entry}`;
    await clientRef.current?.writeTextFile(knowledgePath, next);
    return knowledgePath;
  }

  async function resolveBackendCwd(): Promise<string> {
    const currentCwd = cwd.trim();
    if (currentCwd && !currentCwd.includes("/Users/me/")) {
      return currentCwd;
    }

    const backendThreads = (await clientRef.current?.listThreads(false)) ?? [];
    return (
      backendThreads
        .map((thread) => thread.cwd)
        .find((threadCwd) => threadCwd && !threadCwd.includes("/Users/me/")) ??
      ""
    );
  }

  function appendOfficeMessage(
    text: string,
    backendStatus?: OfficeWorkspace["backendStatus"],
  ) {
    setLibraryPanel((currentPanel) =>
      currentPanel?.workspace
        ? {
            ...currentPanel,
            workspace: {
              ...appendOfficeUserMessage(currentPanel.workspace, text, locale),
              backendStatus:
                backendStatus ?? currentPanel.workspace.backendStatus,
            },
          }
        : currentPanel,
    );
  }

  async function sendOfficeMessage(text: string) {
    const panel = libraryPanel;
    if (!panel?.workspace) {
      return;
    }
    const nextWorkspace = appendOfficeUserMessage(panel.workspace, text, locale);
    const message = nextWorkspace.messages[nextWorkspace.messages.length - 1];
    if (!message) {
      return;
    }

    appendOfficeMessage(
      text,
      panel.workspace.threadId ? "connected" : panel.workspace.backendStatus,
    );

    if (!isConnected) {
      return;
    }

    try {
      let threadId = await ensureOfficeThread(panel, nextWorkspace);
      if (!threadId) {
        return;
      }

      const officeTurnInput = (targetThreadId: string) =>
        [
          locale === "zh"
            ? `办公室「${panel.title}」群聊消息：${text}`
            : `Office "${panel.title}" group chat message: ${text}`,
          "",
          officeConfigPayload(
            officeConfigForThread(
              panel.title,
              panel.subtitle,
              nextWorkspace,
              targetThreadId,
            ),
          ),
        ].join("\n");
      let response;
      try {
        response = await clientRef.current?.startTurn(
          threadId,
          officeTurnInput(threadId),
        );
      } catch (error) {
        if (!isMissingThreadError(error)) {
          throw error;
        }
        threadId = await ensureOfficeThread(panel, nextWorkspace, true);
        if (!threadId) {
          return;
        }
        response = await clientRef.current?.startTurn(
          threadId,
          officeTurnInput(threadId),
        );
      }
      if (response) {
        setThreads((current) =>
          current.map((thread) =>
            thread.id === threadId ? upsertTurn(thread, response.turn) : thread,
          ),
        );
        if (response.turn.status === "inProgress") {
          setActiveTurnByThread((current) => ({
            ...current,
            [threadId]: response.turn.id,
          }));
        }
      }
      const savedConfig = await persistOfficeMessage(
        panel,
        panel.workspace,
        message,
        threadId,
      );
      setLibraryPanel((currentPanel) =>
        currentPanel?.workspace
          ? {
              ...currentPanel,
              workspace: {
                ...(savedConfig?.workspace ?? currentPanel.workspace),
                threadId,
                backendStatus: "connected",
              },
            }
          : currentPanel,
      );
    } catch (error) {
      setLibraryPanel((currentPanel) =>
        currentPanel?.workspace
          ? {
              ...currentPanel,
              workspace: {
                ...currentPanel.workspace,
                backendStatus: "error",
                messages: [
                  ...currentPanel.workspace.messages,
                  {
                    author: locale === "zh" ? "系统" : "System",
                    glyph: "⌗",
                    accent: "rose",
                    time: locale === "zh" ? "现在" : "now",
                    kind: "system",
                    text:
                      error instanceof Error
                        ? error.message
                        : locale === "zh"
                          ? "办公室消息发送到后端失败"
                          : "Unable to send office message to backend",
                  },
                ],
              },
            }
          : currentPanel,
      );
    }
  }

  async function ensureBackendToolThread(
    serverName: string,
    toolName: string,
  ): Promise<string | null> {
    if (selectedThreadId && !isDemoThreadId(selectedThreadId)) {
      return selectedThreadId;
    }

    const title =
      locale === "zh"
        ? `工具验证 · ${serverName}.${toolName}`
        : `Tool check · ${serverName}.${toolName}`;
    const thread = await clientRef.current?.startThread(
      await resolveBackendCwd(),
      "tool",
    );
    if (!thread) {
      return null;
    }
    await clientRef.current?.renameThread(thread.id, title);
    await clientRef.current?.setThreadGoal(
      thread.id,
      locale === "zh"
        ? `验证 MCP 工具 ${serverName}.${toolName} 的后端调用结果。`
        : `Verify backend MCP tool call result for ${serverName}.${toolName}.`,
      null,
    );
    setThreads((current) => upsertThread(current, { ...thread, name: title }));
    return thread.id;
  }

  async function recordBackendToolEvent(
    threadId: string,
    title: string,
    body: string,
  ): Promise<void> {
    const response = await clientRef.current?.startTurn(
      threadId,
      [title, "", body].join("\n"),
    );
    if (!response) {
      return;
    }
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId ? upsertTurn(thread, response.turn) : thread,
      ),
    );
    if (response.turn.status === "inProgress") {
      setActiveTurnByThread((current) => ({
        ...current,
        [threadId]: response.turn.id,
      }));
    }
  }

  function updateAgentConfig(patch: Partial<AgentConfig>) {
    setLibraryPanel((currentPanel) =>
      currentPanel?.agentConfig
        ? {
            ...currentPanel,
            agentConfig: { ...currentPanel.agentConfig, ...patch },
          }
        : currentPanel,
    );
  }

  function toggleAgentCapability(group: "mcp" | "skills", id: string) {
    setLibraryPanel((currentPanel) => {
      if (!currentPanel?.agentConfig) {
        return currentPanel;
      }
      const next = currentPanel.agentConfig[group].map((option) =>
        option.id === id ? { ...option, enabled: !option.enabled } : option,
      );
      return {
        ...currentPanel,
        agentConfig: { ...currentPanel.agentConfig, [group]: next },
      };
    });
  }

  async function saveAgentConfig() {
    const config = libraryPanel?.agentConfig;
    if (!config) {
      return;
    }
    const enabledMcp = config.mcp.filter((option) => option.enabled).length;
    const enabledSkills = config.skills.filter(
      (option) => option.enabled,
    ).length;
    try {
      if (isConnected) {
        let latestAgentThread: Thread | null = null;
        const writeAgentConfig = async (thread: Thread) => {
          await clientRef.current?.renameThread(thread.id, config.name);
          await clientRef.current?.setThreadGoal(
            thread.id,
            locale === "zh"
              ? `保存智能体「${config.name}」配置，并作为办公室可招募角色使用。`
              : `Persist agent "${config.name}" configuration and make it recruitable by offices.`,
            null,
          );
          const savedConfig = { ...config, threadId: thread.id };
          const agentConfigPath = await writeAgentConfigFile(savedConfig);
          const summary =
            locale === "zh"
              ? [
                  `智能体：${config.name}`,
                  `职责：${config.role}`,
                  `模型：${config.model}`,
                  `权限：${config.permission}`,
                  `启用 MCP：${config.mcp
                    .filter((option) => option.enabled)
                    .map((option) => option.name)
                    .join(", ")}`,
                  `启用 Skill：${config.skills
                    .filter((option) => option.enabled)
                    .map((option) => option.name)
                    .join(", ")}`,
                  "",
                  config.systemPrompt,
                  "",
                  agentConfigPayload(savedConfig),
                ].join("\n")
              : [
                  `Agent: ${config.name}`,
                  `Role: ${config.role}`,
                  `Model: ${config.model}`,
                  `Permission: ${config.permission}`,
                  `Enabled MCP: ${config.mcp
                    .filter((option) => option.enabled)
                    .map((option) => option.name)
                    .join(", ")}`,
                  `Enabled skills: ${config.skills
                    .filter((option) => option.enabled)
                    .map((option) => option.name)
                    .join(", ")}`,
                  "",
                  config.systemPrompt,
                  "",
                  agentConfigPayload(savedConfig),
                ].join("\n");
          const response = await clientRef.current?.startTurn(
            thread.id,
            summary,
          );
          setThreads((current) =>
            upsertThread(current, { ...thread, name: config.name }),
          );
          setLibraryPanel((currentPanel) =>
            currentPanel?.agentConfig
              ? {
                  ...currentPanel,
                  agentConfig: {
                    ...currentPanel.agentConfig,
                    threadId: thread.id,
                  },
                  body: agentConfigPath
                    ? locale === "zh"
                      ? `智能体配置已写入：${agentConfigPath}`
                      : `Agent config written: ${agentConfigPath}`
                    : currentPanel.body,
                }
              : currentPanel,
          );
          if (response) {
            const fallbackThread = upsertTurn(
              { ...thread, name: config.name },
              response.turn,
            );
            setThreads((current) =>
              current.map((currentThread) =>
                currentThread.id === thread.id
                  ? upsertTurn(currentThread, response.turn)
                  : currentThread,
              ),
            );
            try {
              latestAgentThread =
                (await clientRef.current?.readThread(thread.id)) ??
                fallbackThread;
            } catch (error) {
              if (!isMissingThreadError(error)) {
                throw error;
              }
              latestAgentThread = fallbackThread;
            }
          }
          setLibraryPanel((currentPanel) =>
            currentPanel?.agentConfig
              ? {
                  ...currentPanel,
                  items: latestAgentThread
                    ? agentThreadHistoryItems(latestAgentThread, locale)
                    : currentPanel.items,
                }
              : currentPanel,
          );
        };

        let thread = config.threadId
          ? threads.find((candidate) => candidate.id === config.threadId) ?? null
          : null;
        if (!thread && config.threadId) {
          try {
            thread =
              (await clientRef.current?.readThread(config.threadId)) ?? null;
          } catch (error) {
            if (!isMissingThreadError(error)) {
              throw error;
            }
          }
        }
        if (!thread) {
          thread = (await clientRef.current?.startThread(undefined, "agent")) ?? null;
        }
        if (thread) {
          try {
            await writeAgentConfig(thread);
          } catch (error) {
            if (!isMissingThreadError(error)) {
              throw error;
            }
            const replacementThread =
              (await clientRef.current?.startThread(undefined, "agent")) ?? null;
            if (replacementThread) {
              await writeAgentConfig(replacementThread);
            }
          }
        }
      }
      setNotice({
        text:
          locale === "zh"
            ? `已保存「${config.name}」配置 · ${config.model} · ${enabledMcp} MCP · ${enabledSkills} Skill`
            : `Saved "${config.name}" · ${config.model} · ${enabledMcp} MCP · ${enabledSkills} skills`,
        tone: "success",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "保存智能体配置失败"
              : "Unable to save agent config",
        tone: "warning",
      });
    }
  }

  function handleApprovalDecision(id: string, decision: "approved" | "denied") {
    const panel = libraryPanel;
    const selectedApproval =
      panel?.workspace?.activity?.approvals.find((req) => req.id === id) ?? null;
    const label = selectedApproval
      ? `${selectedApproval.actor} · ${selectedApproval.action}`
      : "";
    setLibraryPanel((currentPanel) => {
      const activity = currentPanel?.workspace?.activity;
      if (!currentPanel?.workspace || !activity) {
        return currentPanel;
      }
      const approvals = activity.approvals.map((req) => {
        if (req.id !== id) {
          return req;
        }
        return { ...req, decision };
      });
      return {
        ...currentPanel,
        workspace: {
          ...currentPanel.workspace,
          activity: { ...activity, approvals },
        },
      };
    });
    setNotice({
      text:
        locale === "zh"
          ? `${decision === "approved" ? "已批准" : "已拒绝"}：${label}`
          : `${decision === "approved" ? "Approved" : "Denied"}: ${label}`,
      tone: decision === "approved" ? "success" : "warning",
    });

    if (!isConnected || !panel?.workspace || !selectedApproval) {
      return;
    }

    const nextActivity = panel.workspace.activity
      ? {
          ...panel.workspace.activity,
          approvals: panel.workspace.activity.approvals.map((req) =>
            req.id === id ? { ...req, decision } : req,
          ),
        }
      : undefined;
    const nextWorkspace: OfficeWorkspace = {
      ...panel.workspace,
      activity: nextActivity,
      messages: [
        ...panel.workspace.messages,
        {
          author: locale === "zh" ? "系统" : "System",
          glyph: "⌗",
          accent: decision === "approved" ? "green" : "rose",
          time: locale === "zh" ? "现在" : "now",
          kind: "system",
          text:
            locale === "zh"
              ? `${decision === "approved" ? "已批准" : "已拒绝"}审批：${selectedApproval.actor} · ${selectedApproval.action}`
              : `${decision === "approved" ? "Approved" : "Denied"} approval: ${selectedApproval.actor} · ${selectedApproval.action}`,
        },
      ],
    };
    setLibraryPanel((currentPanel) =>
      currentPanel?.workspace
        ? {
            ...currentPanel,
            workspace: {
              ...nextWorkspace,
              threadId: currentPanel.workspace.threadId,
              backendStatus: currentPanel.workspace.backendStatus,
            },
          }
        : currentPanel,
    );

    void (async () => {
      try {
        let threadId = await ensureOfficeThread(panel, nextWorkspace);
        if (!threadId) {
          return;
        }
        const approvalInput = (targetThreadId: string) =>
          [
            locale === "zh"
              ? `办公室「${panel.title}」审批决策：${decision === "approved" ? "批准" : "拒绝"}`
              : `Office "${panel.title}" approval decision: ${decision}`,
            `Actor: ${selectedApproval.actor}`,
            `Action: ${selectedApproval.action}`,
            `Risk: ${selectedApproval.risk}`,
            `Detail: ${selectedApproval.detail}`,
            "",
            officeConfigPayload(
              officeConfigForThread(
                panel.title,
                panel.subtitle,
                nextWorkspace,
                targetThreadId,
              ),
            ),
          ].join("\n");
        let response;
        try {
          response = await clientRef.current?.startTurn(
            threadId,
            approvalInput(threadId),
          );
        } catch (error) {
          if (!isMissingThreadError(error)) {
            throw error;
          }
          threadId = await ensureOfficeThread(panel, nextWorkspace, true);
          if (!threadId) {
            return;
          }
          response = await clientRef.current?.startTurn(
            threadId,
            approvalInput(threadId),
          );
        }
        if (response) {
          setThreads((current) =>
            current.map((thread) =>
              thread.id === threadId ? upsertTurn(thread, response.turn) : thread,
            ),
          );
        }
        await persistOfficeWorkspace(panel, nextWorkspace, threadId);
        setLibraryPanel((currentPanel) =>
          currentPanel?.workspace
            ? {
                ...currentPanel,
                workspace: {
                  ...nextWorkspace,
                  threadId,
                  backendStatus: "connected",
                },
              }
            : currentPanel,
        );
      } catch (error) {
        setNotice({
          text:
            error instanceof Error
              ? error.message
              : locale === "zh"
                ? "审批决策写入后端失败"
                : "Unable to write approval decision to backend",
          tone: "warning",
        });
      }
    })();
  }

  async function handleOfficeArtifact(artifact: ArtifactItem) {
    if (!isConnected) {
      setCapabilityPanel({
        title: artifact.title,
        subtitle: locale === "zh" ? "办公室产物" : "Office artifact",
        body:
          locale === "zh"
            ? "连接 app-server 后会从当前工作区搜索并读取这个产物。"
            : "Connect app-server to search and read this artifact from the current workspace.",
      });
      return;
    }

    if (busyToolId) {
      return;
    }

    setBusyToolId("files");
    setCapabilityDockOpen(true);
    setCapabilityPanel({
      title: artifact.title,
      subtitle: locale === "zh" ? "正在定位产物" : "Locating artifact",
      body:
        locale === "zh"
          ? `正在工作区中搜索：${artifact.title}`
          : `Searching workspace for: ${artifact.title}`,
    });

    try {
      const root = await resolveBackendCwd();
      if (!root) {
        throw new Error(
          locale === "zh" ? "未找到后端工作区路径" : "No backend workspace path found",
        );
      }

      const response = await clientRef.current?.fuzzyFileSearch(
        artifact.title,
        [root],
        `office-artifact-${Date.now()}`,
      );
      const matches = response?.files ?? [];
      const exactMatch =
        matches.find((item) => item.file_name === artifact.title) ?? null;
      const fileMatch =
        exactMatch ??
        matches.find((item) => item.match_type === "file") ??
        matches[0] ??
        null;

      if (!fileMatch) {
        const panel = libraryPanel;
        const artifactDir = joinPath(joinPath(joinPath(root, ".crewon"), "offices"), "artifacts");
        const artifactPath = joinPath(
          artifactDir,
          `${slugifySkillName(artifact.title || "office-artifact")}.md`,
        );
        const artifactBody = [
          `# ${artifact.title}`,
          "",
          `- ${locale === "zh" ? "类型" : "Kind"}: ${artifact.kind}`,
          `- ${locale === "zh" ? "来源" : "Source"}: Crewon office`,
          `- ${locale === "zh" ? "创建时间" : "Created"}: ${new Date().toISOString()}`,
          panel?.workspace?.goal
            ? `- ${locale === "zh" ? "办公室目标" : "Office goal"}: ${panel.workspace.goal}`
            : null,
          "",
          artifact.meta,
          "",
          locale === "zh"
            ? "这里沉淀办公室协作产生的交付物。后续可由智能体、自动化或知识库复用。"
            : "This captures an office collaboration deliverable for reuse by agents, automations, or the knowledge library.",
          "",
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n");

        await clientRef.current?.createDirectory(artifactDir, true);
        await clientRef.current?.writeTextFile(artifactPath, artifactBody);
        const metadata = await clientRef.current?.getMetadata(artifactPath);
        if (panel?.workspace) {
          const savedArtifact: ArtifactItem = {
            ...artifact,
            meta:
              locale === "zh"
                ? `${artifact.meta} · 已保存 ${artifactPath}`
                : `${artifact.meta} · saved ${artifactPath}`,
          };
          const nextActivity = panel.workspace.activity
            ? {
                ...panel.workspace.activity,
                artifacts: [
                  savedArtifact,
                  ...panel.workspace.activity.artifacts.filter(
                    (item) => item.title !== artifact.title,
                  ),
                ],
              }
            : panel.workspace.activity;
          const nextWorkspace: OfficeWorkspace = {
            ...panel.workspace,
            activity: nextActivity,
            messages: [
              ...panel.workspace.messages,
              {
                author: locale === "zh" ? "系统" : "System",
                glyph: "⌗",
                accent: artifact.accent,
                time: locale === "zh" ? "现在" : "now",
                kind: "system",
                text:
                  locale === "zh"
                    ? `已创建办公室产物：${artifact.title}，保存到 ${artifactPath}`
                    : `Created office artifact: ${artifact.title}, saved to ${artifactPath}`,
              },
            ],
          };
          const threadId = await ensureOfficeThread(panel, nextWorkspace);
          if (threadId) {
            const artifactInput = [
              locale === "zh"
                ? `办公室「${panel.title}」创建产物：${artifact.title}`
                : `Office "${panel.title}" created artifact: ${artifact.title}`,
              "",
              artifactBody,
              "",
              officeConfigPayload(
                officeConfigForThread(
                  panel.title,
                  panel.subtitle,
                  nextWorkspace,
                  threadId,
                ),
              ),
            ].join("\n");
            const turn = await clientRef.current?.startTurn(threadId, artifactInput);
            if (turn) {
              setThreads((current) =>
                current.map((thread) =>
                  thread.id === threadId ? upsertTurn(thread, turn.turn) : thread,
                ),
              );
            }
            await persistOfficeWorkspace(panel, nextWorkspace, threadId);
            setLibraryPanel((currentPanel) =>
              currentPanel?.workspace
                ? {
                    ...currentPanel,
                    workspace: {
                      ...nextWorkspace,
                      threadId,
                      backendStatus: "connected",
                    },
                  }
                : currentPanel,
            );
          }
        }

        setCapabilityPanel({
          title: artifact.title,
          subtitle: artifactPath,
          body: [
            locale === "zh"
              ? "未找到现有产物，已在工作区创建办公室产物草稿。"
              : "No existing artifact was found, so a workspace artifact draft was created.",
            fileMetadataText(metadata ?? null, locale),
            artifactBody,
          ].join("\n\n"),
          actions: [
            {
              id: "copy-current-path",
              label: locale === "zh" ? "复制到 .copy" : "Copy to .copy",
            },
            ...(filePanelSearchControls(locale, artifactDir, artifact.title)
              .actions ?? []),
          ],
          fields: filePanelSearchControls(locale, artifactDir, artifact.title)
            .fields,
        });
        return;
      }

      const artifactPath = resolveSearchPath(fileMatch.root, fileMatch.path);
      const topMatches = matches.slice(0, 8).map(
        (item) =>
          ({
            label: `${item.match_type === "directory" ? ">" : " "} ${item.path}`,
            path: resolveSearchPath(item.root, item.path),
            kind: item.match_type,
          }) satisfies CapabilityPanelItem,
      );

      if (fileMatch.match_type === "directory") {
        setCapabilityPanel({
          title: artifact.title,
          subtitle: artifactPath,
          body:
            locale === "zh"
              ? "已定位到目录产物，正在读取目录内容..."
              : "Directory artifact located. Reading entries...",
          items: topMatches,
          ...filePanelSearchControls(locale, artifactPath, artifact.title),
        });
        await handleCapabilityPanelItem({
          label: artifact.title,
          path: artifactPath,
          kind: "directory",
        });
        return;
      }

      const [file, metadata] = await Promise.all([
        clientRef.current?.readFile(artifactPath),
        clientRef.current?.getMetadata(artifactPath),
      ]);
      const fileText = file ? decodeBase64Text(file.dataBase64) : "";
      setCapabilityPanel({
        title: artifact.title,
        subtitle: artifactPath,
        body: [
          locale === "zh"
            ? `办公室产物已从后端工作区读取。`
            : "Office artifact loaded from the backend workspace.",
          fileMetadataText(metadata ?? null, locale),
          fileText.length > 12000
            ? `${fileText.slice(0, 12000)}\n...`
            : fileText || (locale === "zh" ? "文件为空" : "Empty file"),
        ]
          .filter(Boolean)
          .join("\n\n"),
        actions: [
          {
            id: "copy-current-path",
            label: locale === "zh" ? "复制到 .copy" : "Copy to .copy",
          },
          ...(filePanelSearchControls(locale, pathDirName(artifactPath), artifact.title)
            .actions ?? []),
        ],
        fields: filePanelSearchControls(
          locale,
          pathDirName(artifactPath),
          artifact.title,
        ).fields,
        items: topMatches,
      });
    } catch (error) {
      setCapabilityPanel({
        title: artifact.title,
        subtitle: locale === "zh" ? "办公室产物" : "Office artifact",
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "定位产物失败"
              : "Unable to locate artifact",
      });
    } finally {
      setBusyToolId(null);
    }
  }

  function handleKnowledgePath(item: CapabilityPanelItem) {
    setCapabilityDockOpen(true);
    void handleCapabilityPanelItem(item);
  }

  async function handleLibraryPanelAction(action: LibraryPanelAction) {
    const isLocalDemoAction =
      action.id === "create-office" ||
      action.id === "create-agent" ||
      action.id === "create-automation" ||
      action.id === "create-mcp" ||
      action.id === "create-skill" ||
      action.id === "recruit-agent";

    if (!isConnected && !(isDemo && isLocalDemoAction)) {
      if (
        isDemo &&
        (action.id === "reload-tools" || action.id === "install-plugin")
      ) {
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  action.id === "install-plugin"
                    ? locale === "zh"
                      ? "演示模式：市场浏览和安装会在接入后端后开启。这里展示已打包的 MCP 连接器与 Skill。"
                      : "Demo mode: marketplace browse and install open once the backend is connected. Shown here are bundled MCP connectors and skills."
                    : locale === "zh"
                      ? "演示模式：工具列表为内置示例，接入 app-server 后会显示真实的运行态 MCP 和 Skill。"
                      : "Demo mode: the tool list shows built-in samples. Connect the app-server to see live MCP and skills.",
                error: undefined,
              }
            : currentPanel,
        );
      }
      return;
    }

    if (action.id === "refresh-knowledge") {
      void openLibrary("knowledge");
      return;
    }

    if (action.id === "open-thread") {
      if (!action.threadId) {
        setNotice({
          text:
            locale === "zh"
              ? "没有可打开的后端线程"
              : "No backend thread is available to open",
          tone: "warning",
        });
        return;
      }

      try {
        const thread = await clientRef.current?.readThread(action.threadId);
        if (thread) {
          setThreads((current) => upsertThread(current, thread));
          setSelectedThreadId(thread.id);
          setAppView("chat");
          setLibraryPanel(null);
          setCapabilityPanel(null);
          setNotice({
            text:
              locale === "zh"
                ? `已打开后端线程：${threadTitle(thread, thread.id)}`
                : `Opened backend thread: ${threadTitle(thread, thread.id)}`,
            tone: "success",
          });
        }
      } catch (error) {
        setNotice({
          text:
            error instanceof Error
              ? error.message
              : locale === "zh"
                ? "打开后端线程失败"
                : "Unable to open backend thread",
          tone: "warning",
        });
      }
      return;
    }

    if (action.id === "reset-memory") {
      if (isDemo) {
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "记忆已重置（演示）。连接 app-server 后会调用 memory/reset。"
                    : "Memory reset (demo). With app-server connected this calls memory/reset.",
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }

      if (!isConnected) {
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  locale === "zh"
                    ? "未连接本地 app-server"
                    : "Local app-server is not connected",
              }
            : currentPanel,
        );
        return;
      }

      const confirmed = window.confirm(
        locale === "zh"
          ? "重置全局记忆会清除模型可复用的记忆状态。继续？"
          : "Resetting memory clears reusable model memory state. Continue?",
      );
      if (!confirmed) {
        return;
      }

      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              body: locale === "zh" ? "正在重置记忆..." : "Resetting memory...",
              error: undefined,
            }
          : currentPanel,
      );
      try {
        await clientRef.current?.resetMemory();
        await openLibrary("knowledge");
        setNotice({
          text: locale === "zh" ? "记忆已重置" : "Memory reset",
          tone: "success",
        });
      } catch (error) {
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  error instanceof Error
                    ? error.message
                    : locale === "zh"
                      ? "重置记忆失败"
                      : "Unable to reset memory",
              }
            : currentPanel,
        );
      }
      return;
    }

    if (action.id === "create-knowledge-memory") {
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              body:
                locale === "zh"
                  ? "正在写入工作区知识记忆..."
                  : "Writing workspace knowledge memory...",
              error: undefined,
            }
          : currentPanel,
      );
      try {
        const path = await writeKnowledgeMemory();
        if (!path) {
          setLibraryPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    locale === "zh"
                      ? "当前没有工作区路径，无法写入知识库。"
                      : "No workspace path is available for writing knowledge.",
                }
              : currentPanel,
          );
          return;
        }
        await openLibrary("knowledge");
        setNotice({
          text:
            locale === "zh"
              ? `已写入知识库：${path}`
              : `Knowledge memory written: ${path}`,
          tone: "success",
        });
      } catch (error) {
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  error instanceof Error
                    ? error.message
                    : locale === "zh"
                      ? "写入知识库失败"
                      : "Unable to write knowledge",
              }
            : currentPanel,
        );
      }
      return;
    }

    if (action.id === "recruit-agent" && isDemo) {
      setLibraryPanel((currentPanel) => {
        if (!currentPanel?.workspace) {
          return currentPanel;
        }
        const newMember =
          locale === "zh"
            ? {
                name: "新成员",
                role: "自定义智能体",
                glyph: "✦",
                accent: "rose" as const,
                status: "刚加入群聊",
                online: true,
              }
            : {
                name: "New",
                role: "Custom agent",
                glyph: "✦",
                accent: "rose" as const,
                status: "Just joined",
                online: true,
              };
        const joinMessage =
          locale === "zh"
            ? {
                author: "系统",
                glyph: "⌗",
                accent: "slate" as const,
                time: "现在",
                kind: "system" as const,
                text: "新成员已加入办公室群聊，可被 @ 指派任务",
              }
            : {
                author: "System",
                glyph: "⌗",
                accent: "slate" as const,
                time: "now",
                kind: "system" as const,
                text: "New member joined the office group chat and can be @mentioned for tasks",
              };
        return {
          ...currentPanel,
          workspace: {
            ...currentPanel.workspace,
            members: [...currentPanel.workspace.members, newMember],
            messages: [...currentPanel.workspace.messages, joinMessage],
          },
        };
      });
      return;
    }

    if (action.id === "recruit-agent" && isConnected && libraryPanel?.workspace) {
      const panel = libraryPanel;
      const workspace = panel.workspace;
      if (!workspace) {
        return;
      }
      try {
        const recruitConfig = await readRecruitableAgentConfig(workspace.members);
        const newMember = recruitConfig
          ? agentConfigToOfficeMember(recruitConfig, locale)
          : locale === "zh"
            ? {
                name: "新成员",
                role: "自定义智能体",
                glyph: "✦",
                accent: "rose" as const,
                status: "已写入后端线程",
                online: true,
              }
            : {
                name: "New",
                role: "Custom agent",
                glyph: "✦",
                accent: "rose" as const,
                status: "Written to backend thread",
                online: true,
              };
        const enabledMcp =
          recruitConfig?.mcp
            .filter((option) => option.enabled)
            .map((option) => option.name)
            .join(", ") || (locale === "zh" ? "未配置" : "not configured");
        const enabledSkills =
          recruitConfig?.skills
            .filter((option) => option.enabled)
            .map((option) => option.name)
            .join(", ") || (locale === "zh" ? "未配置" : "not configured");
        const joinMessage =
          locale === "zh"
            ? {
                author: "系统",
                glyph: "⌗",
                accent: "slate" as const,
                time: "现在",
                kind: "system" as const,
                text: recruitConfig
                  ? `已从智能体库招募 ${newMember.name}，模型 ${recruitConfig.model}，MCP：${enabledMcp}，Skill：${enabledSkills}。`
                  : "新成员已加入办公室群聊，招募动作已写入后端线程。尚未找到已保存的后端智能体配置。",
              }
            : {
                author: "System",
                glyph: "⌗",
                accent: "slate" as const,
                time: "now",
                kind: "system" as const,
                text: recruitConfig
                  ? `Recruited ${newMember.name} from agents. Model ${recruitConfig.model}; MCP: ${enabledMcp}; skills: ${enabledSkills}.`
                  : "New member joined the office chat and recruitment was written to the backend thread. No saved backend agent config was found yet.",
              };
        const nextWorkspace = {
          ...workspace,
          members: [...workspace.members, newMember],
          messages: [...workspace.messages, joinMessage],
        };
        setLibraryPanel((currentPanel) =>
          currentPanel?.workspace
            ? {
                ...currentPanel,
                workspace: nextWorkspace,
              }
            : currentPanel,
        );
        let threadId = await ensureOfficeThread(panel, nextWorkspace);
        if (threadId) {
          const recruitTurnInput = (targetThreadId: string) =>
            [
              locale === "zh"
                ? `办公室「${panel.title}」招募智能体：${newMember.name}，角色：${newMember.role}。模型：${recruitConfig?.model ?? "未配置"}。MCP：${enabledMcp}。Skill：${enabledSkills}。请把它纳入后续协作。`
                : `Office "${panel.title}" recruited agent: ${newMember.name}, role: ${newMember.role}. Model: ${recruitConfig?.model ?? "not configured"}. MCP: ${enabledMcp}. Skills: ${enabledSkills}. Include it in future collaboration.`,
              "",
              officeConfigPayload(
                officeConfigForThread(
                  panel.title,
                  panel.subtitle,
                  nextWorkspace,
                  targetThreadId,
                ),
              ),
            ].join("\n");
          let response;
          try {
            response = await clientRef.current?.startTurn(
              threadId,
              recruitTurnInput(threadId),
            );
          } catch (error) {
            if (!isMissingThreadError(error)) {
              throw error;
            }
            threadId = await ensureOfficeThread(panel, nextWorkspace, true);
            if (!threadId) {
              return;
            }
            response = await clientRef.current?.startTurn(
              threadId,
              recruitTurnInput(threadId),
            );
          }
          if (response) {
            setThreads((current) =>
              current.map((thread) =>
                thread.id === threadId
                  ? upsertTurn(thread, response.turn)
                  : thread,
              ),
            );
          }
          await persistOfficeWorkspace(panel, nextWorkspace, threadId);
          setNotice({
            text:
              locale === "zh"
                ? `已招募 ${newMember.name}，并写入后端办公室线程`
                : `Recruited ${newMember.name} and wrote it to the backend office thread`,
            tone: "success",
          });
        }
      } catch (error) {
        setNotice({
          text:
            error instanceof Error
              ? error.message
              : locale === "zh"
                ? "招募智能体写入后端失败"
                : "Unable to write agent recruitment to backend",
          tone: "warning",
        });
      }
      return;
    }

    if (action.id === "create-office" && isConnected) {
      const baseOffice = demoLibraryPanel("office", locale).items.find(
        (item) => item.action?.type === "office-detail",
      );
      const baseAction =
        baseOffice?.action?.type === "office-detail" ? baseOffice.action : null;
      const title =
        locale === "zh"
          ? `新办公室 ${new Date().toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}`
          : `New office ${new Date().toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            })}`;
      const thread = await clientRef.current?.startThread(undefined, "office");
      if (!thread || !baseAction?.workspace) {
        return;
      }
      await clientRef.current?.renameThread(thread.id, title);
      await clientRef.current?.setThreadGoal(
        thread.id,
        baseAction.workspace.goal,
        null,
      );
      const workspace: OfficeWorkspace = {
        ...baseAction.workspace,
        threadId: thread.id,
        backendStatus: "connected",
        messages: [
          ...baseAction.workspace.messages,
          {
            author: locale === "zh" ? "系统" : "System",
            glyph: "⌗",
            accent: "blue",
            time: locale === "zh" ? "现在" : "now",
            kind: "system",
            text:
              locale === "zh"
                ? "办公室已创建，并绑定到真实 app-server 线程。"
                : "Office created and bound to a real app-server thread.",
          },
        ],
      };
      const createResponse = await clientRef.current?.startTurn(
        thread.id,
        [
          locale === "zh" ? `创建办公室：${title}` : `Create office: ${title}`,
          "",
          officeConfigPayload(
            officeConfigForThread(
              title,
              locale === "zh"
                ? "新建办公室 · 已绑定后端线程"
                : "New office · backend thread bound",
              workspace,
              thread.id,
            ),
          ),
        ].join("\n"),
      );
      setThreads((current) => upsertThread(current, { ...thread, name: title }));
      if (createResponse) {
        setThreads((current) =>
          current.map((currentThread) =>
            currentThread.id === thread.id
              ? upsertTurn(currentThread, createResponse.turn)
              : currentThread,
          ),
        );
      }
      const officeConfigPath = await writeOfficeConfigFile(
        officeConfigForThread(
          title,
          locale === "zh"
            ? "新建办公室 · 已绑定后端线程"
            : "New office · backend thread bound",
          workspace,
          thread.id,
        ),
      );
      setLibraryPanel({
        kind: "office",
        title,
        subtitle:
          locale === "zh"
            ? "新建办公室 · 已绑定后端线程"
            : "New office · backend thread bound",
        body: officeConfigPath
          ? locale === "zh"
            ? `配置文件：${officeConfigPath}`
            : `Config file: ${officeConfigPath}`
          : undefined,
        items: [],
        actions: [
          {
            id: "recruit-agent",
            label: locale === "zh" ? "招募智能体" : "Recruit agent",
            tone: "primary",
          },
        ],
        workspace,
      });
      return;
    }

    if (action.id === "create-automation" && isConnected) {
      const title =
        locale === "zh"
          ? `自动化 ${new Date().toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}`
          : `Automation ${new Date().toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            })}`;
      const thread = await clientRef.current?.startThread(
        undefined,
        "automation",
      );
      if (!thread) {
        return;
      }
      await clientRef.current?.renameThread(thread.id, title);
      await clientRef.current?.setThreadGoal(
        thread.id,
        locale === "zh"
          ? "运行自动化，绑定目标办公室和执行智能体，并沉淀后续运行记录。"
          : "Run automation with a target office and execution agent, keeping future run records.",
        null,
      );
      const [targetOffice, executionAgent] = await Promise.all([
        readLatestOfficeConfig(),
        readRecruitableAgentConfig([]),
      ]);
      const enabledMcp =
        executionAgent?.mcp
          .filter((option) => option.enabled)
          .map((option) => option.name)
          .join(", ") || (locale === "zh" ? "未配置" : "not configured");
      const enabledSkills =
        executionAgent?.skills
          .filter((option) => option.enabled)
          .map((option) => option.name)
          .join(", ") || (locale === "zh" ? "未配置" : "not configured");
      const automationConfig: AutomationConfig = {
        threadId: thread.id,
        title,
        subtitle:
          locale === "zh"
            ? `手动触发 · ${targetOffice?.title ?? "未绑定办公室"} · ${executionAgent?.name ?? "未绑定智能体"}`
            : `Manual trigger · ${targetOffice?.title ?? "No office"} · ${executionAgent?.name ?? "No agent"}`,
        body:
          locale === "zh"
            ? [
                "触发器：手动",
                `目标办公室：${targetOffice?.title ?? "未绑定"}`,
                `执行智能体：${executionAgent?.name ?? "未绑定"}`,
                `模型：${executionAgent?.model ?? "未配置"}`,
                `MCP：${enabledMcp}`,
                `Skill：${enabledSkills}`,
                `动作：运行自动化「${title}」，并把执行记录写入当前后端线程。`,
              ].join("\n")
            : [
                "Trigger: manual",
                `Target office: ${targetOffice?.title ?? "not bound"}`,
                `Agent: ${executionAgent?.name ?? "not bound"}`,
                `Model: ${executionAgent?.model ?? "not configured"}`,
                `MCP: ${enabledMcp}`,
                `Skills: ${enabledSkills}`,
                `Action: run automation "${title}" and write the execution record to the backend thread.`,
              ].join("\n"),
        prompt:
          locale === "zh"
            ? `运行自动化「${title}」。目标办公室：${targetOffice?.title ?? "未绑定"}。执行智能体：${executionAgent?.name ?? "未绑定"}。请记录运行结果、下一步任务和风险。`
            : `Run automation "${title}". Target office: ${targetOffice?.title ?? "not bound"}. Agent: ${executionAgent?.name ?? "not bound"}. Record results, next tasks, and risks.`,
      };
      const automationConfigPath =
        await writeAutomationConfigFile(automationConfig);
      const createResponse = await clientRef.current?.startTurn(
        thread.id,
        [
          locale === "zh"
            ? `创建自动化：${title}`
            : `Create automation: ${title}`,
          "",
          automationConfigPayload(automationConfig),
        ].join("\n"),
      );
      setThreads((current) => upsertThread(current, { ...thread, name: title }));
      if (createResponse) {
        setThreads((current) =>
          current.map((currentThread) =>
            currentThread.id === thread.id
              ? upsertTurn(currentThread, createResponse.turn)
              : currentThread,
          ),
        );
      }
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              body:
                locale === "zh"
                  ? `已创建自动化执行线程：${title}\n已绑定：${targetOffice?.title ?? "未绑定办公室"} · ${executionAgent?.name ?? "未绑定智能体"}${automationConfigPath ? `\n配置文件：${automationConfigPath}` : ""}`
                  : `Created automation execution thread: ${title}\nBound to: ${targetOffice?.title ?? "No office"} · ${executionAgent?.name ?? "No agent"}${automationConfigPath ? `\nConfig file: ${automationConfigPath}` : ""}`,
              items: [
                {
                  title,
                  meta:
                    locale === "zh"
                      ? "后端线程 · 可立即运行"
                      : "Backend thread · ready to run",
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
                    title: automationConfig.title,
                    subtitle: automationConfig.subtitle,
                    body: automationConfig.body,
                    prompt: automationConfig.prompt,
                    threadId: thread.id,
                    configPath: automationConfigPath ?? undefined,
                  },
                },
                ...currentPanel.items,
              ],
              error: undefined,
            }
          : currentPanel,
      );
      return;
    }

    if (action.id === "create-agent" && isConnected) {
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              body:
                locale === "zh"
                  ? "正在读取模型、权限、MCP 和 Skill..."
                  : "Reading models, permissions, MCP, and skills...",
              error: undefined,
            }
          : currentPanel,
      );

      let config: AgentConfig;
      let configError: string | undefined;
      try {
        config = await createBackendAgentConfig();
      } catch (error) {
        config = createDefaultAgentConfig(locale);
        configError =
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取后端智能体能力失败"
              : "Unable to read backend agent capabilities";
      }
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              title: config.name,
              subtitle: locale === "zh" ? "智能体配置" : "Agent configuration",
              body: undefined,
              actions: undefined,
              items: [],
              agentConfig: config,
              error: configError,
            }
          : currentPanel,
      );
      return;
    }

    if (action.id === "create-mcp" && isConnected) {
      const timestamp = new Date()
        .toISOString()
        .slice(0, 16)
        .replace(/[-:T]/g, "");
      const serverName = slugifySkillName(`crewon-demo-mcp-${timestamp}`);
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              title: locale === "zh" ? "新建 MCP" : "New MCP",
              subtitle:
                locale === "zh"
                  ? "草稿 · 保存后写入 config.toml"
                  : "Draft · saved to config.toml",
              body:
                locale === "zh"
                  ? "填写 MCP server 名称、启动命令和参数。保存后会调用 config/batchWrite 并重载 MCP。"
                  : "Fill in the MCP server name, command, and arguments. Saving calls config/batchWrite and reloads MCP.",
              fields: [
                {
                  id: "mcp-draft-name",
                  label: locale === "zh" ? "服务器名称" : "Server name",
                  value: serverName,
                },
                {
                  id: "mcp-draft-command",
                  label: locale === "zh" ? "启动命令" : "Command",
                  value: "npx",
                },
                {
                  id: "mcp-draft-args",
                  label: locale === "zh" ? "参数 JSON 数组" : "Arguments JSON array",
                  placeholder: "[\"-y\", \"@modelcontextprotocol/server-everything\"]",
                  value: "[\n  \"-y\",\n  \"@modelcontextprotocol/server-everything\"\n]",
                },
                {
                  id: "mcp-draft-env",
                  label: locale === "zh" ? "环境变量 JSON" : "Environment JSON",
                  placeholder: "{\n}",
                  value: "{}",
                },
              ],
              actions: [
                {
                  id: "save-mcp-draft",
                  label: locale === "zh" ? "保存 MCP" : "Save MCP",
                  tone: "primary",
                },
                {
                  id: "reload-tools",
                  label: locale === "zh" ? "返回并刷新工具" : "Back and refresh tools",
                },
              ],
              items: [],
              error: undefined,
            }
          : currentPanel,
      );
      return;
    }

    if (action.id === "create-skill" && isConnected) {
      const skillCwd = await resolveBackendCwd();
      if (!skillCwd) {
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  locale === "zh"
                    ? "当前没有工作区路径，无法创建本地 Skill"
                    : "No workspace path is available for creating a local skill",
              }
            : currentPanel,
        );
        return;
      }

      const timestamp = new Date()
        .toISOString()
        .slice(0, 16)
        .replace(/[-:T]/g, "");
      const skillName = slugifySkillName(`client-demo-${timestamp}`);
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              title: locale === "zh" ? "新建 Skill" : "New Skill",
              subtitle:
                locale === "zh"
                  ? `${skillCwd} · 保存到 .crewon/skill`
                  : `${skillCwd} · saved to .crewon/skill`,
              body:
                locale === "zh"
                  ? "填写 Skill 名称、描述和工作流步骤。保存后会写入 SKILL.md 并注册 Skill root。"
                  : "Fill in the skill name, description, and workflow steps. Saving writes SKILL.md and registers the skill root.",
              fields: [
                {
                  id: "skill-draft-name",
                  label: locale === "zh" ? "Skill 名称" : "Skill name",
                  value: skillName,
                },
                {
                  id: "skill-draft-description",
                  label: locale === "zh" ? "描述" : "Description",
                  value:
                    locale === "zh"
                      ? "从 Crewon UI 创建的可复用工作流。"
                      : "A reusable workflow created from the Crewon UI.",
                },
                {
                  id: "skill-draft-workflow",
                  label: locale === "zh" ? "工作流步骤" : "Workflow steps",
                  value:
                    locale === "zh"
                      ? "- 确认目标产物和受众。\n- 收集当前应用状态和后端证据。\n- 输出简洁结果和验证记录。"
                      : "- Confirm the target deliverable and audience.\n- Gather the current app state and backend evidence.\n- Produce a concise result with verification notes.",
                },
              ],
              actions: [
                {
                  id: "save-skill-draft",
                  label: locale === "zh" ? "保存 Skill" : "Save Skill",
                  tone: "primary",
                },
                {
                  id: "reload-tools",
                  label: locale === "zh" ? "返回并刷新工具" : "Back and refresh tools",
                },
              ],
              items: [],
              error: undefined,
            }
          : currentPanel,
      );
      return;
    }

    if (
      action.id === "create-office" ||
      action.id === "create-agent" ||
      action.id === "create-automation" ||
      action.id === "create-mcp" ||
      action.id === "create-skill" ||
      action.id === "recruit-agent"
    ) {
      const copy = {
        "create-office": locale === "zh" ? "新建办公室" : "New office",
        "create-agent": locale === "zh" ? "新建智能体" : "New agent",
        "create-automation": locale === "zh" ? "新建自动化" : "New automation",
        "create-mcp": locale === "zh" ? "新建 MCP" : "New MCP",
        "create-skill": locale === "zh" ? "新建 Skill" : "New Skill",
        "recruit-agent": locale === "zh" ? "招募智能体" : "Recruit agent",
      }[action.id];
      const demoItem: LibraryItem = {
        title: copy,
        meta:
          locale === "zh"
            ? action.id === "recruit-agent"
              ? "待选择角色 · 可加入当前办公室"
              : "草稿 · 等待后端保存"
            : action.id === "recruit-agent"
              ? "Choose role · can join current office"
              : "Draft · waiting for backend save",
        description:
          locale === "zh"
            ? action.id === "create-office"
              ? "填写名称、目标、成员和默认工具后创建办公室。"
              : action.id === "create-agent"
                ? "配置职责、模型、权限、默认工具和可加入办公室。"
                : action.id === "create-automation"
                  ? "选择触发器、目标办公室、执行智能体和失败通知。"
                  : action.id === "recruit-agent"
                    ? "选择智能体、分配职责和工具权限，然后加入群聊协作。"
                    : "配置名称、权限、来源和可见范围，保存后进入工具库。"
            : action.id === "create-office"
              ? "Name it, set goals, members, and default tools."
              : action.id === "create-agent"
                ? "Configure role, model, permissions, default tools, and offices."
                : action.id === "create-automation"
                  ? "Choose trigger, target office, execution agent, and failure routing."
                  : action.id === "recruit-agent"
                    ? "Pick an agent, assign responsibilities and tool permissions, then join the group chat."
                    : "Configure name, permissions, source, and visibility before saving.",
      };
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              body:
                locale === "zh"
                  ? `${copy}已进入草稿状态。后端接入后这里会打开真实创建流程，现在用于展示入口、状态和下一步。`
                  : `${copy} is now in draft state. Once the backend is connected, this opens the real creation flow; for the demo it shows entry, status, and next step.`,
              items: [demoItem, ...currentPanel.items],
              error: undefined,
            }
          : currentPanel,
      );
      return;
    }

    setLibraryPanel((currentPanel) =>
      currentPanel
        ? {
            ...currentPanel,
            body:
              action.id === "install-plugin"
                ? locale === "zh"
                  ? "正在安装插件..."
                  : "Installing plugin..."
                : action.id === "reload-tools"
                  ? locale === "zh"
                    ? "正在刷新工具..."
                    : "Refreshing tools..."
                  : action.id === "reload-plugins"
                    ? locale === "zh"
                      ? "正在刷新插件..."
                      : "Refreshing plugins..."
                  : action.id === "login-mcp-oauth"
                    ? locale === "zh"
                      ? "正在打开 MCP 授权..."
                      : "Opening MCP authorization..."
                    : action.id === "run-automation"
                      ? locale === "zh"
                        ? "正在运行自动化..."
                        : "Running automation..."
                    : action.id === "read-mcp-resource"
                      ? locale === "zh"
                        ? "正在读取 MCP 资源..."
                        : "Reading MCP resource..."
                  : action.id === "call-mcp-tool"
                    ? locale === "zh"
                      ? "正在调用 MCP 工具..."
                      : "Calling MCP tool..."
                    : action.id === "toggle-skill"
                      ? locale === "zh"
                        ? "正在更新 Skill 配置..."
                        : "Updating skill config..."
                      : action.id === "delete-config-file"
                        ? locale === "zh"
                          ? "正在删除配置文件..."
                          : "Deleting config file..."
                        : locale === "zh"
                          ? "正在卸载插件..."
                          : "Uninstalling plugin...",
            error: undefined,
          }
        : currentPanel,
    );

    try {
      if (action.id === "reload-tools") {
        await clientRef.current?.reloadMcpServers();
        await openLibrary("tools");
        return;
      }

      if (action.id === "reload-plugins") {
        await openLibrary("plugins");
        return;
      }

      if (action.id === "open-path") {
        if (!action.pathToOpen) {
          return;
        }
        setCapabilityDockOpen(true);
        void handleCapabilityPanelItem({
          label: pathBaseName(action.pathToOpen),
          path: action.pathToOpen,
          kind: action.pathKind ?? "file",
        });
        return;
      }

      if (action.id === "delete-config-file") {
        if (!action.pathToOpen) {
          return;
        }
        const configCwd = await resolveBackendCwd();
        const client = clientRef.current;
        if (!configCwd || !client) {
          throw new Error(
            locale === "zh"
              ? "未连接本地 app-server"
              : "Local app-server is not connected",
          );
        }
        await deleteDomainConfigFile(client, configCwd, action.pathToOpen);
        setNotice({
          text:
            locale === "zh"
              ? `已删除配置文件：${action.pathToOpen}`
              : `Deleted config file: ${action.pathToOpen}`,
          tone: "success",
        });
        await openLibrary(libraryPanel?.kind ?? "agents");
        return;
      }

      if (action.id === "save-mcp-draft") {
        const fieldValue = (fieldId: string) =>
          libraryPanel?.fields
            ?.find((field) => field.id === fieldId)
            ?.value.trim() ?? "";
        const rawName = fieldValue("mcp-draft-name");
        const serverName = slugifySkillName(rawName);
        const command = fieldValue("mcp-draft-command");
        const rawArgs = fieldValue("mcp-draft-args") || "[]";
        const rawEnv = fieldValue("mcp-draft-env") || "{}";

        if (!serverName || !command) {
          setLibraryPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    locale === "zh"
                      ? "服务器名称和启动命令不能为空"
                      : "Server name and command are required",
                }
              : currentPanel,
          );
          return;
        }

        let args: unknown;
        let env: unknown;
        try {
          args = JSON.parse(rawArgs);
          env = JSON.parse(rawEnv);
        } catch (error) {
          setLibraryPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "参数或环境变量 JSON 无效"
                        : "Arguments or environment JSON is invalid",
                }
              : currentPanel,
          );
          return;
        }

        if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
          setLibraryPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    locale === "zh"
                      ? "参数必须是字符串数组"
                      : "Arguments must be an array of strings",
                }
              : currentPanel,
          );
          return;
        }

        if (
          !env ||
          typeof env !== "object" ||
          Array.isArray(env) ||
          !Object.values(env).every((value) => typeof value === "string")
        ) {
          setLibraryPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    locale === "zh"
                      ? "环境变量必须是字符串键值对象"
                      : "Environment must be an object of string values",
                }
              : currentPanel,
          );
          return;
        }

        const parsedArgs = args as string[];
        const parsedEnv = env as Record<string, string>;
        const serverConfig = {
          command,
          args: parsedArgs,
          env: parsedEnv,
          enabled: false,
        };

        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? `正在保存 MCP 配置：${serverName}`
                    : `Saving MCP config: ${serverName}`,
                error: undefined,
              }
            : currentPanel,
        );

        await clientRef.current?.writeConfigBatch([
          {
            keyPath: `mcp_servers.${serverName}`,
            value: serverConfig,
            mergeStrategy: "upsert",
          },
        ]);
        await writeToolConfigFile({
          kind: "mcp",
          title: rawName || serverName,
          name: serverName,
          description:
            locale === "zh"
              ? "从工具页创建的 MCP 草稿。"
              : "MCP draft created from the tools page.",
          command,
          args: parsedArgs,
          env: parsedEnv,
          enabled: false,
        });
        await clientRef.current?.reloadMcpServers();
        await openLibrary("tools");
        setNotice({
          text:
            locale === "zh"
              ? `已保存 MCP 草稿：${serverName}（默认停用）`
              : `Saved MCP draft: ${serverName} (disabled by default)`,
          tone: "success",
        });
        return;
      }

      if (action.id === "save-skill-draft") {
        const fieldValue = (fieldId: string) =>
          libraryPanel?.fields
            ?.find((field) => field.id === fieldId)
            ?.value.trim() ?? "";
        const skillCwd = await resolveBackendCwd();
        const skillName = slugifySkillName(fieldValue("skill-draft-name"));
        const description = fieldValue("skill-draft-description");
        const workflow = fieldValue("skill-draft-workflow");

        if (!skillCwd || !skillName || !description || !workflow) {
          setLibraryPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    locale === "zh"
                      ? "工作区、名称、描述和工作流步骤都不能为空"
                      : "Workspace, name, description, and workflow steps are required",
                }
              : currentPanel,
          );
          return;
        }

        const skillsRoot = [
          skillCwd.replace(/[\\/]+$/, ""),
          ".crewon",
          "skills",
        ].join(skillCwd.includes("\\") ? "\\" : "/");
        const skillDir = joinPath(skillsRoot, skillName);
        const skillFile = joinPath(skillDir, "SKILL.md");
        const skillBody = [
          "---",
          `name: ${skillName}`,
          `description: ${description.replace(/\n/g, " ")}`,
          "---",
          "",
          `# ${skillName}`,
          "",
          description,
          "",
          "## Workflow",
          workflow,
          "",
        ].join("\n");

        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? `正在写入 Skill：${skillName}`
                    : `Writing skill: ${skillName}`,
                error: undefined,
              }
            : currentPanel,
        );

        await clientRef.current?.createDirectory(skillDir, true);
        await clientRef.current?.writeTextFile(skillFile, skillBody);
        await writeToolConfigFile({
          kind: "skill",
          title: skillName,
          name: skillName,
          description,
          path: skillFile,
          enabled: true,
        });
        const nextExtraRoots = mergeSkillExtraRoots(
          readStoredSkillExtraRoots(),
          [skillsRoot],
        );
        await clientRef.current?.setSkillExtraRoots(nextExtraRoots);
        writeStoredSkillExtraRoots(nextExtraRoots);
        await openLibrary("tools");
        setNotice({
          text:
            locale === "zh"
              ? `已保存 Skill：${skillName}，并注册 ${nextExtraRoots.length} 个 Skill root`
              : `Saved skill: ${skillName} and registered ${nextExtraRoots.length} skill roots`,
          tone: "success",
        });
        return;
      }

      if (action.id === "run-automation") {
        const title =
          action.automationTitle ??
          (locale === "zh" ? "自动化任务" : "Automation job");
        const runNote =
          libraryPanel?.fields
            ?.find((field) => field.id === "automation-run-note")
            ?.value.trim() ?? "";
        const [targetOffice, executionAgent] = await Promise.all([
          readLatestOfficeConfig(),
          readRecruitableAgentConfig([]),
        ]);
        const enabledMcp =
          executionAgent?.mcp
            .filter((option) => option.enabled)
            .map((option) => option.name)
            .join(", ") || (locale === "zh" ? "未配置" : "not configured");
        const enabledSkills =
          executionAgent?.skills
            .filter((option) => option.enabled)
            .map((option) => option.name)
            .join(", ") || (locale === "zh" ? "未配置" : "not configured");
        const automationBody =
          locale === "zh"
            ? [
                "触发器：手动",
                `目标办公室：${targetOffice?.title ?? "待选择"}`,
                `执行智能体：${executionAgent?.name ?? "待选择"}`,
                `模型：${executionAgent?.model ?? "未配置"}`,
                `MCP：${enabledMcp}`,
                `Skill：${enabledSkills}`,
                `动作：运行自动化「${title}」，并把执行记录写入当前后端线程。`,
              ].join("\n")
            : [
                "Trigger: manual",
                `Target office: ${targetOffice?.title ?? "pending"}`,
                `Agent: ${executionAgent?.name ?? "pending"}`,
                `Model: ${executionAgent?.model ?? "not configured"}`,
                `MCP: ${enabledMcp}`,
                `Skills: ${enabledSkills}`,
                `Action: run automation "${title}" and write the execution record to the backend thread.`,
              ].join("\n");
        const automationPrompt =
          locale === "zh"
            ? `立即运行自动化「${title}」。目标办公室：${targetOffice?.title ?? "待选择"}。执行智能体：${executionAgent?.name ?? "待选择"}。请记录运行结果、下一步任务和风险。`
            : `Run automation "${title}" now. Target office: ${targetOffice?.title ?? "pending"}. Agent: ${executionAgent?.name ?? "pending"}. Record results, next tasks, and risks.`;
        const fullAutomationPrompt = [
          action.automationPrompt,
          automationPrompt,
          runNote
            ? locale === "zh"
              ? `本次运行补充说明：${runNote}`
              : `Run note: ${runNote}`
            : null,
        ]
          .filter(Boolean)
          .join("\n\n");
        let threadId = action.automationThreadId;
        if (threadId) {
          try {
            await clientRef.current?.readThread(threadId);
          } catch (error) {
            if (!isMissingThreadError(error)) {
              throw error;
            }
            threadId = undefined;
          }
        }
        if (!threadId) {
          const createdThread =
            (await clientRef.current?.startThread(undefined, "automation")) ??
            null;
          if (createdThread) {
            threadId = createdThread.id;
            await clientRef.current?.renameThread(createdThread.id, title);
            await clientRef.current?.setThreadGoal(
              createdThread.id,
              locale === "zh"
                ? `执行并记录自动化「${title}」的运行结果。`
                : `Run and record automation "${title}".`,
              null,
            );
            setThreads((current) =>
              upsertThread(current, { ...createdThread, name: title }),
            );
          }
        }
        if (!threadId) {
          return;
        }
        const automationConfig: AutomationConfig = {
          threadId,
          title,
          subtitle:
            locale === "zh"
              ? `${targetOffice?.title ?? "未绑定办公室"} · ${executionAgent?.name ?? "未绑定智能体"}`
              : `${targetOffice?.title ?? "No office"} · ${executionAgent?.name ?? "No agent"}`,
          body: automationBody,
          prompt: fullAutomationPrompt,
        };
        let automationConfigPath =
          await writeAutomationConfigFile(automationConfig);
        const runAutomationTurn = (targetThreadId: string) =>
          clientRef.current?.startTurn(
            targetThreadId,
            [
              automationConfig.prompt,
              "",
              automationConfigPayload({
                ...automationConfig,
                threadId: targetThreadId,
              }),
            ].join("\n"),
          );
        let response;
        try {
          response = await runAutomationTurn(threadId);
        } catch (error) {
          if (!isMissingThreadError(error)) {
            throw error;
          }
          const replacementThread =
            (await clientRef.current?.startThread(undefined, "automation")) ??
            null;
          if (!replacementThread) {
            return;
          }
          threadId = replacementThread.id;
          await clientRef.current?.renameThread(replacementThread.id, title);
          await clientRef.current?.setThreadGoal(
            replacementThread.id,
            locale === "zh"
              ? `执行并记录自动化「${title}」的运行结果。`
              : `Run and record automation "${title}".`,
            null,
          );
          setThreads((current) =>
            upsertThread(current, { ...replacementThread, name: title }),
          );
          automationConfigPath = await writeAutomationConfigFile({
            ...automationConfig,
            threadId: replacementThread.id,
          });
          response = await runAutomationTurn(replacementThread.id);
        }
        let latestAutomationThread: Thread | null = null;
        if (response) {
          setThreads((current) =>
            current.map((currentThread) =>
              currentThread.id === threadId
                ? upsertTurn(currentThread, response.turn)
                : currentThread,
            ),
          );
          try {
            latestAutomationThread =
              (await clientRef.current?.readThread(threadId)) ?? null;
          } catch (error) {
            if (!isMissingThreadError(error)) {
              throw error;
            }
          }
        }
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                subtitle:
                  locale === "zh"
                    ? "已写入后端执行线程"
                    : "Written to backend execution thread",
                body: [
                  automationConfig.body,
                  locale === "zh"
                    ? `运行请求已发送到线程：${threadId}`
                    : `Run request sent to thread: ${threadId}`,
                  automationConfigPath
                    ? locale === "zh"
                      ? `配置文件：${automationConfigPath}`
                      : `Config file: ${automationConfigPath}`
                    : null,
                ]
                  .filter(Boolean)
                  .join("\n"),
                items: latestAutomationThread
                  ? automationRunHistoryItems(latestAutomationThread, locale)
                  : currentPanel.items,
                actions: currentPanel.actions?.map((currentAction) =>
                  currentAction.id === "run-automation"
                    ? {
                        ...currentAction,
                        automationThreadId: threadId,
                        label: locale === "zh" ? "再次运行" : "Run again",
                      }
                    : currentAction,
                ).concat(
                  automationConfigPath &&
                    !currentPanel.actions?.some(
                      (currentAction) =>
                        currentAction.id === "open-path" &&
                        currentAction.pathToOpen === automationConfigPath,
                    )
                    ? [
                        {
                          id: "open-path" as const,
                          label:
                            locale === "zh"
                              ? "打开配置文件"
                              : "Open config file",
                          pathToOpen: automationConfigPath,
                          pathKind: "file" as const,
                        },
                        {
                          id: "delete-config-file" as const,
                          label:
                            locale === "zh"
                              ? "删除配置文件"
                              : "Delete config file",
                          pathToOpen: automationConfigPath,
                          pathKind: "file" as const,
                          tone: "danger" as const,
                        },
                      ]
                    : [],
                ),
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }

      if (action.id === "login-mcp-oauth") {
        if (!action.mcpServerName) {
          return;
        }
        const response = await clientRef.current?.startMcpOauthLogin(
          action.mcpServerName,
        );
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body: response?.authorizationUrl
                  ? `${locale === "zh" ? "打开以下链接完成 MCP 授权" : "Open this URL to finish MCP authorization"}\n${response.authorizationUrl}`
                  : locale === "zh"
                    ? "MCP 授权已启动"
                    : "MCP authorization started",
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }

      if (action.id === "call-mcp-tool") {
        if (!action.mcpServerName || !action.mcpToolName) {
          return;
        }
        const toolThreadId = await ensureBackendToolThread(
          action.mcpServerName,
          action.mcpToolName,
        );
        if (!toolThreadId) {
          setLibraryPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    locale === "zh"
                      ? "无法创建工具验证线程。"
                      : "Unable to create a tool verification thread.",
                }
              : currentPanel,
          );
          return;
        }

        const argsText =
          libraryPanel?.fields?.find((field) => field.id === "mcp-tool-arguments")
            ?.value ?? "{}";
        let parsedArgs: JsonValue | undefined;
        try {
          parsedArgs = argsText.trim()
            ? (JSON.parse(argsText) as JsonValue)
            : undefined;
        } catch (error) {
          setLibraryPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? `${locale === "zh" ? "参数不是合法 JSON" : "Arguments are not valid JSON"}: ${error.message}`
                      : locale === "zh"
                        ? "参数不是合法 JSON"
                        : "Arguments are not valid JSON",
                }
              : currentPanel,
          );
          return;
        }

        const response = await clientRef.current?.callMcpTool(
          toolThreadId,
          action.mcpServerName,
          action.mcpToolName,
          parsedArgs,
        );
        let recordWarning: string | null = null;
        try {
          await recordBackendToolEvent(
            toolThreadId,
            locale === "zh"
              ? `记录 MCP 工具调用：${action.mcpServerName}.${action.mcpToolName}`
              : `Record MCP tool call: ${action.mcpServerName}.${action.mcpToolName}`,
            [
              locale === "zh"
                ? `工具：${action.mcpServerName}.${action.mcpToolName}`
                : `Tool: ${action.mcpServerName}.${action.mcpToolName}`,
              locale === "zh" ? "参数：" : "Arguments:",
              JSON.stringify(parsedArgs ?? {}, null, 2),
              locale === "zh" ? "结果：" : "Result:",
              JSON.stringify(response ?? {}, null, 2),
            ].join("\n"),
          );
        } catch (error) {
          recordWarning =
            error instanceof Error
              ? error.message
              : locale === "zh"
                ? "工具调用结果写入后端线程失败"
                : "Unable to write tool result to backend thread";
        }
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body: [
                  currentPanel.body ?? "",
                  "",
                  locale === "zh"
                    ? `调用结果 · 线程 ${toolThreadId}`
                    : `Tool result · thread ${toolThreadId}`,
                  JSON.stringify(response ?? {}, null, 2),
                  recordWarning
                    ? locale === "zh"
                      ? `记录警告：${recordWarning}`
                      : `Record warning: ${recordWarning}`
                    : locale === "zh"
                      ? "结果已写入工具验证线程。"
                      : "Result written to the tool verification thread.",
                ]
                  .filter(Boolean)
                  .join("\n"),
                actions: [
                  {
                    id: "open-thread",
                    label:
                      locale === "zh"
                        ? "打开工具验证线程"
                        : "Open tool verification thread",
                    threadId: toolThreadId,
                  },
                  ...(currentPanel.actions ?? []).filter(
                    (currentAction) =>
                      !(
                        currentAction.id === "open-thread" &&
                        currentAction.threadId === toolThreadId
                      ),
                  ),
                ],
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }

      if (action.id === "read-mcp-resource") {
        if (!action.mcpResourceServer || !action.mcpResourceUri) {
          return;
        }
        const resourceThreadId = await ensureBackendToolThread(
          action.mcpResourceServer,
          "resource",
        );
        const response = await clientRef.current?.readMcpResource(
          action.mcpResourceServer,
          action.mcpResourceUri,
          isDemoPreview ? undefined : (selectedThreadId ?? undefined),
        );
        const contents = response?.contents ?? [];
        const body = contents
          .map((content) => {
            if ("text" in content) {
              return [
                `URI: ${content.uri}`,
                content.mimeType ? `MIME: ${content.mimeType}` : null,
                "",
                content.text,
              ]
                .filter(Boolean)
                .join("\n");
            }
            return [
              `URI: ${content.uri}`,
              content.mimeType ? `MIME: ${content.mimeType}` : null,
              "",
              locale === "zh"
                ? `二进制资源，base64 长度：${content.blob.length}`
                : `Binary resource, base64 length: ${content.blob.length}`,
            ]
              .filter(Boolean)
              .join("\n");
          })
          .join("\n\n---\n\n");
        let recordWarning: string | null = null;
        if (resourceThreadId) {
          try {
            await recordBackendToolEvent(
              resourceThreadId,
              locale === "zh"
                ? `记录 MCP 资源读取：${action.mcpResourceServer}`
                : `Record MCP resource read: ${action.mcpResourceServer}`,
              [
                locale === "zh"
                  ? `资源：${action.mcpResourceUri}`
                  : `Resource: ${action.mcpResourceUri}`,
                locale === "zh" ? "内容摘要：" : "Content summary:",
                body.length > 6000 ? `${body.slice(0, 6000)}\n...` : body,
              ].join("\n"),
            );
          } catch (error) {
            recordWarning =
              error instanceof Error
                ? error.message
                : locale === "zh"
                  ? "资源读取结果写入后端线程失败"
                  : "Unable to write resource result to backend thread";
          }
        }
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body: [
                  body ||
                    (locale === "zh"
                      ? "资源读取成功，但没有内容。"
                      : "Resource read succeeded with no contents."),
                  resourceThreadId
                    ? recordWarning
                      ? locale === "zh"
                        ? `记录警告：${recordWarning}`
                        : `Record warning: ${recordWarning}`
                      : locale === "zh"
                        ? `资源读取结果已写入线程：${resourceThreadId}`
                        : `Resource read result written to thread: ${resourceThreadId}`
                    : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                actions: resourceThreadId
                  ? [
                      {
                        id: "open-thread",
                        label:
                          locale === "zh"
                            ? "打开资源验证线程"
                            : "Open resource verification thread",
                        threadId: resourceThreadId,
                      },
                      ...(currentPanel.actions ?? []).filter(
                        (currentAction) =>
                          !(
                            currentAction.id === "open-thread" &&
                            currentAction.threadId === resourceThreadId
                          ),
                      ),
                    ]
                  : currentPanel.actions,
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }

      if (action.id === "toggle-skill") {
        await clientRef.current?.writeSkillConfig({
          path: action.skillPath ?? null,
          name: action.skillPath ? null : (action.skillName ?? null),
          enabled: !action.skillEnabled,
        });
        setNotice({
          text:
            locale === "zh"
              ? `${action.skillName ?? "Skill"} 已${action.skillEnabled ? "停用" : "启用"}`
              : `${action.skillName ?? "Skill"} ${action.skillEnabled ? "disabled" : "enabled"}`,
          tone: "success",
        });
        await openLibrary("tools");
        return;
      }

      if (action.id === "install-plugin") {
        if (!action.pluginName) {
          return;
        }
        const response = await clientRef.current?.installPlugin(
          action.pluginName,
          action.marketplacePath,
          action.remoteMarketplaceName,
        );
        const authSummary = response
          ? `${locale === "zh" ? "授权策略" : "Auth policy"}: ${response.authPolicy}\n${
              locale === "zh" ? "需要授权的应用" : "Apps needing auth"
            }: ${response.appsNeedingAuth.length}`
          : "";
        setLibraryPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body: [
                  locale === "zh" ? "插件已安装" : "Plugin installed",
                  authSummary,
                ]
                  .filter(Boolean)
                  .join("\n"),
                error: undefined,
              }
            : currentPanel,
        );
        await openLibrary("plugins");
        return;
      }

      if (!action.pluginId) {
        return;
      }
      await clientRef.current?.uninstallPlugin(action.pluginId);
      await openLibrary("plugins");
    } catch (error) {
      setLibraryPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              error:
                error instanceof Error
                  ? error.message
                  : action.id === "install-plugin"
                    ? locale === "zh"
                  ? "安装插件失败"
                  : "Unable to install plugin"
                : action.id === "reload-tools"
                  ? locale === "zh"
                    ? "刷新工具失败"
                    : "Unable to refresh tools"
                  : action.id === "read-mcp-resource"
                    ? locale === "zh"
                      ? "读取 MCP 资源失败"
                      : "Unable to read MCP resource"
                  : action.id === "toggle-skill"
                    ? locale === "zh"
                      ? "更新 Skill 配置失败"
                      : "Unable to update skill config"
                  : locale === "zh"
                    ? "卸载插件失败"
                        : "Unable to uninstall plugin",
            }
          : currentPanel,
      );
    }
  }

  function retryConnection() {
    clientRef.current?.close();
    setConnectionState("connecting");
    setNotice(null);
    setStreamingTextByThread({});
    setConnectionAttempt((attempt) => attempt + 1);
  }

  function showDemoThreads() {
    const demoThreads = getDemoThreads(localeRef.current);
    setThreads(demoThreads);
    setSelectedThreadId(demoThreads[0]?.id ?? null);
    setStreamingTextByThread({});
  }

  const switchToDemoThreads = useCallback((showConnectionNotice = true) => {
    setConnectionState("demo");
    setNotice(
      showConnectionNotice
        ? { text: translate(localeRef.current).connectionLost, tone: "warning" }
        : null,
    );
    showDemoThreads();
  }, []);

  const handleNotification = useCallback(
    (notification: AppServerNotification) => {
      function refreshAccount() {
        void clientRef.current
          ?.getAccount()
          .then(setAccountStatus)
          .catch(() => undefined);
      }

      function refreshThread(threadId: string) {
        void clientRef.current
          ?.readThread(threadId)
          .then((thread) => {
            setThreads((current) => upsertThread(current, thread));
          })
          .catch(() => undefined);
      }

      switch (notification.method) {
        case "account/login/completed": {
          const { success, error } = notification.params;
          refreshAccount();
          setNotice({
            text: success
              ? localeRef.current === "zh"
                ? "账号登录完成"
                : "Account login completed"
              : error ||
                (localeRef.current === "zh"
                  ? "账号登录失败"
                  : "Account login failed"),
            tone: success ? "success" : "warning",
          });
          return;
        }
        case "account/rateLimits/updated": {
          const [firstLine] = rateLimitText(
            notification.params.rateLimits,
            localeRef.current,
          );
          setNotice({
            text:
              firstLine ||
              (localeRef.current === "zh"
                ? "账号额度已更新"
                : "Account rate limits updated"),
            tone: "success",
          });
          return;
        }
        case "account/updated": {
          refreshAccount();
          return;
        }
        case "command/exec/outputDelta": {
          const { processId, stream, deltaBase64, capReached } =
            notification.params;
          if (terminalProcessIdRef.current !== processId) {
            return;
          }

          const text = decodeBase64Text(deltaBase64);
          const chunk = `${stream === "stderr" ? "[stderr] " : ""}${text}${capReached ? "\n[output cap reached]" : ""}`;
          setCapabilityPanel((currentPanel) =>
            currentPanel?.commandInput
              ? {
                  ...currentPanel,
                  body: `${currentPanel.body && currentPanel.body !== (localeRef.current === "zh" ? "正在运行..." : "Running...") ? currentPanel.body : ""}${chunk}`,
                }
              : currentPanel,
          );
          return;
        }
        case "configWarning": {
          const { summary, details, path } = notification.params;
          setNotice({
            text: [summary, path, details].filter(Boolean).join("\n"),
            tone: "warning",
          });
          return;
        }
        case "fs/changed": {
          const { watchId, changedPaths } = notification.params;
          setActiveFileWatch((currentWatch) => {
            if (!currentWatch || currentWatch.id !== watchId) {
              return currentWatch;
            }
            const changedText = changedPaths.slice(0, 4).join("\n");
            setCapabilityPanel((currentPanel) =>
              currentPanel?.title === (localeRef.current === "zh" ? "文件" : "Files")
                ? {
                    ...currentPanel,
                    body: [
                      currentPanel.body,
                      localeRef.current === "zh"
                        ? `监听到文件变化：\n${changedText}`
                        : `File changes detected:\n${changedText}`,
                    ]
                      .filter(Boolean)
                      .join("\n\n"),
                    error: undefined,
                  }
                : currentPanel,
            );
            setNotice({
              text:
                localeRef.current === "zh"
                  ? `文件变化：${changedPaths[0] ?? currentWatch.path}`
                  : `File changed: ${changedPaths[0] ?? currentWatch.path}`,
              tone: "success",
            });
            return currentWatch;
          });
          return;
        }
        case "error": {
          const { threadId } = notification.params;
          setStreamingTextByThread((current) => ({
            ...current,
            [threadId]: "",
          }));
          setActiveTurnByThread((current) => {
            const { [threadId]: _removed, ...next } = current;
            return next;
          });
          return;
        }
        case "item/agentMessage/delta": {
          const { threadId, delta } = notification.params;
          setStreamingTextByThread((current) => ({
            ...current,
            [threadId]: `${current[threadId] ?? ""}${delta}`,
          }));
          return;
        }
        case "item/commandExecution/outputDelta": {
          const { threadId, turnId, itemId, delta } = notification.params;
          setThreads((current) =>
            current.map((thread) =>
              thread.id === threadId
                ? updateItem(thread, turnId, itemId, (item) =>
                    item.type === "commandExecution"
                      ? {
                          ...item,
                          aggregatedOutput: `${item.aggregatedOutput ?? ""}${delta}`,
                        }
                      : item,
                  )
                : thread,
            ),
          );
          return;
        }
        case "item/completed": {
          const { threadId, turnId, item } = notification.params;
          setThreads((current) =>
            current.map((thread) =>
              thread.id === threadId
                ? appendItem(thread, turnId, item)
                : thread,
            ),
          );
          setStreamingTextByThread((current) => ({
            ...current,
            [threadId]: "",
          }));
          return;
        }
        case "item/fileChange/patchUpdated": {
          const { threadId, turnId, itemId, changes } = notification.params;
          setThreads((current) =>
            current.map((thread) =>
              thread.id === threadId
                ? updateItem(thread, turnId, itemId, (item) =>
                    item.type === "fileChange" ? { ...item, changes } : item,
                  )
                : thread,
            ),
          );
          return;
        }
        case "item/plan/delta": {
          const { threadId, turnId, itemId, delta } = notification.params;
          setThreads((current) =>
            current.map((thread) =>
              thread.id === threadId
                ? updateItem(thread, turnId, itemId, (item) =>
                    item.type === "plan"
                      ? { ...item, text: `${item.text}${delta}` }
                      : item,
                  )
                : thread,
            ),
          );
          return;
        }
        case "item/started": {
          const { threadId, turnId, item } = notification.params;
          setThreads((current) =>
            current.map((thread) =>
              thread.id === threadId
                ? appendItem(thread, turnId, item)
                : thread,
            ),
          );
          return;
        }
        case "mcpServer/oauthLogin/completed": {
          const { name, success, error } = notification.params;
          setNotice({
            text: success
              ? localeRef.current === "zh"
                ? `${name} 登录完成`
                : `${name} login completed`
              : error ||
                (localeRef.current === "zh"
                  ? `${name} 登录失败`
                  : `${name} login failed`),
            tone: success ? "success" : "warning",
          });
          return;
        }
        case "mcpServer/startupStatus/updated": {
          const { name, status, error } = notification.params;
          setNotice({
            text: error ? `${name}: ${status}\n${error}` : `${name}: ${status}`,
            tone: status === "failed" ? "warning" : "success",
          });
          return;
        }
        case "serverRequest/resolved": {
          const { requestId } = notification.params;
          setCapabilityPanel((currentPanel) =>
            currentPanel?.subtitle === String(requestId)
              ? {
                  ...currentPanel,
                  actions: undefined,
                  fields: undefined,
                  body:
                    localeRef.current === "zh"
                      ? "请求已处理"
                      : "Request resolved",
                }
              : currentPanel,
          );
          setPendingApprovalRequest((currentRequest) =>
            String(currentRequest?.id) === String(requestId)
              ? null
              : currentRequest,
          );
          setPendingUserInputRequest((currentRequest) =>
            String(currentRequest?.id) === String(requestId)
              ? null
              : currentRequest,
          );
          setPendingDynamicToolRequest((currentRequest) =>
            String(currentRequest?.id) === String(requestId)
              ? null
              : currentRequest,
          );
          setPendingMcpElicitationRequest((currentRequest) =>
            String(currentRequest?.id) === String(requestId)
              ? null
              : currentRequest,
          );
          setPendingExternalSecretRequest((currentRequest) =>
            String(currentRequest?.id) === String(requestId)
              ? null
              : currentRequest,
          );
          return;
        }
        case "thread/archived":
        case "thread/deleted": {
          const { threadId } = notification.params;
          setThreads((current) =>
            current.filter((thread) => thread.id !== threadId),
          );
          setStreamingTextByThread((current) => {
            const { [threadId]: _removed, ...next } = current;
            return next;
          });
          setActiveTurnByThread((current) => {
            const { [threadId]: _removed, ...next } = current;
            return next;
          });
          setSelectedThreadId((currentThreadId) =>
            currentThreadId === threadId ? null : currentThreadId,
          );
          return;
        }
        case "thread/goal/cleared": {
          refreshThread(notification.params.threadId);
          if (notification.params.threadId === selectedThreadIdRef.current) {
            setThreadGoal(null);
          }
          return;
        }
        case "thread/goal/updated": {
          refreshThread(notification.params.threadId);
          if (notification.params.threadId === selectedThreadIdRef.current) {
            void clientRef.current
              ?.getThreadGoal(notification.params.threadId)
              .then((response) => setThreadGoal(response.goal))
              .catch(() => undefined);
          }
          return;
        }
        case "thread/name/updated": {
          const { threadId, threadName } = notification.params;
          setThreads((current) =>
            current.map((thread) =>
              thread.id === threadId
                ? { ...thread, name: threadName ?? null }
                : thread,
            ),
          );
          return;
        }
        case "thread/started": {
          const { thread } = notification.params;
          setThreads((current) => upsertThread(current, thread));
          return;
        }
        case "thread/status/changed": {
          const { threadId, status } = notification.params;
          setThreads((current) =>
            current.map((thread) =>
              thread.id === threadId ? { ...thread, status } : thread,
            ),
          );
          return;
        }
        case "thread/tokenUsage/updated": {
          refreshThread(notification.params.threadId);
          return;
        }
        case "thread/unarchived": {
          void clientRef.current
            ?.listThreads(showArchivedThreadsRef.current)
            .then((serverThreads) => {
              setThreads(serverThreads);
            });
          return;
        }
        case "turn/completed": {
          const { threadId, turn } = notification.params;
          setThreads((current) =>
            current.map((thread) =>
              thread.id === threadId ? upsertTurn(thread, turn) : thread,
            ),
          );
          setStreamingTextByThread((current) => ({
            ...current,
            [threadId]: "",
          }));
          setActiveTurnByThread((current) => {
            const { [threadId]: _removed, ...next } = current;
            return next;
          });
          return;
        }
        case "turn/diff/updated":
        case "turn/plan/updated": {
          refreshThread(notification.params.threadId);
          return;
        }
        case "turn/started": {
          const { threadId, turn } = notification.params;
          setThreads((current) =>
            current.map((thread) =>
              thread.id === threadId ? upsertTurn(thread, turn) : thread,
            ),
          );
          if (turn.status === "inProgress") {
            setActiveTurnByThread((current) => ({
              ...current,
              [threadId]: turn.id,
            }));
          }
          return;
        }
        case "warning": {
          const { threadId, message } = notification.params;
          if (!threadId || threadId === selectedThreadIdRef.current) {
            setNotice({ text: message, tone: "warning" });
          }
          return;
        }
      }
    },
    [],
  );

  const handleServerRequest = useCallback((request: AppServerRequest) => {
    const label =
      request.method === "item/commandExecution/requestApproval"
        ? localeRef.current === "zh"
          ? "命令审批"
          : "Command approval"
        : request.method === "item/fileChange/requestApproval"
          ? localeRef.current === "zh"
            ? "文件变更审批"
            : "File change approval"
          : request.method === "item/permissions/requestApproval"
            ? localeRef.current === "zh"
              ? "权限请求"
              : "Permission request"
            : request.method === "item/tool/requestUserInput"
              ? localeRef.current === "zh"
                ? "用户输入请求"
                : "User input request"
              : request.method === "item/tool/call"
                ? localeRef.current === "zh"
                  ? "动态工具调用"
                  : "Dynamic tool call"
                : request.method === "applyPatchApproval"
                  ? localeRef.current === "zh"
                    ? "补丁审批"
                    : "Patch approval"
                  : request.method === "execCommandApproval"
                    ? localeRef.current === "zh"
                      ? "命令审批"
                      : "Command approval"
                    : request.method === "mcpServer/elicitation/request"
                      ? localeRef.current === "zh"
                        ? "MCP 输入请求"
                        : "MCP elicitation"
                      : request.method === "account/chatgptAuthTokens/refresh"
                        ? localeRef.current === "zh"
                          ? "刷新模型账号 Token"
                          : "Refresh model account token"
                        : request.method === "attestation/generate"
                          ? localeRef.current === "zh"
                            ? "Attestation Token"
                            : "Attestation token"
                          : request.method;

    const command = getParamDisplay(request.params, "command");
    const cwd = getParamDisplay(request.params, "cwd");
    const reason = getParamDisplay(request.params, "reason");
    const grantRoot = getParamDisplay(request.params, "grantRoot");
    const permissions = getParamDisplay(request.params, "permissions");
    const fileChanges = getParamDisplay(request.params, "fileChanges");
    const details = [command, cwd, reason, grantRoot, permissions, fileChanges]
      .filter(Boolean)
      .join("\n");
    const isInteractiveApproval =
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval" ||
      request.method === "item/permissions/requestApproval" ||
      request.method === "applyPatchApproval" ||
      request.method === "execCommandApproval";

    setCapabilityDockOpen(true);
    setInspectorOpen(false);

    if (isInteractiveApproval) {
      setPendingApprovalRequest({
        id: request.id,
        method: request.method,
        params: request.params,
      });
      setPendingUserInputRequest(null);
      setPendingDynamicToolRequest(null);
      setPendingMcpElicitationRequest(null);
      setPendingExternalSecretRequest(null);
      setCapabilityPanel({
        title: label,
        subtitle: String(request.id),
        actions: [
          {
            id: "approve-request",
            label: localeRef.current === "zh" ? "同意" : "Approve",
            tone: "primary",
          },
          {
            id: "decline-request",
            label: localeRef.current === "zh" ? "拒绝" : "Decline",
            tone: "danger",
          },
        ],
        body:
          details ||
          (localeRef.current === "zh" ? "等待处理" : "Waiting for review"),
      });
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      const questions = getUserInputQuestions(request.params);
      setPendingApprovalRequest(null);
      setPendingDynamicToolRequest(null);
      setPendingMcpElicitationRequest(null);
      setPendingExternalSecretRequest(null);
      setPendingUserInputRequest({
        id: request.id,
        questionIds: questions.map((question) => question.id),
      });
      setCapabilityPanel({
        title: label,
        subtitle: String(request.id),
        body:
          details ||
          (localeRef.current === "zh"
            ? "请补充后端请求的信息"
            : "Answer the backend request"),
        fields: questions.map((question) => ({
          id: question.id,
          label: question.label,
          placeholder: question.placeholder,
          secret: question.secret,
          value: "",
        })),
        actions: [
          {
            id: "submit-user-input",
            label: localeRef.current === "zh" ? "提交" : "Submit",
            tone: "primary",
          },
          {
            id: "cancel-user-input",
            label: localeRef.current === "zh" ? "取消" : "Cancel",
          },
        ],
      });
      return;
    }

    if (request.method === "item/tool/call") {
      const tool = getDynamicToolDetails(request.params);
      const fieldId = "dynamic-tool-result";
      setPendingApprovalRequest(null);
      setPendingUserInputRequest(null);
      setPendingMcpElicitationRequest(null);
      setPendingExternalSecretRequest(null);
      setPendingDynamicToolRequest({ id: request.id, fieldId });
      setCapabilityPanel({
        title: `${label}: ${tool.title}`,
        subtitle: String(request.id),
        body: tool.body || tool.title,
        fields: [
          {
            id: fieldId,
            label:
              localeRef.current === "zh"
                ? "返回给工具调用的文本"
                : "Text returned to the tool call",
            placeholder:
              localeRef.current === "zh"
                ? "输入工具结果..."
                : "Enter tool result...",
            value: "",
          },
        ],
        actions: [
          {
            id: "complete-dynamic-tool",
            label: localeRef.current === "zh" ? "返回成功" : "Return success",
            tone: "primary",
          },
          {
            id: "fail-dynamic-tool",
            label: localeRef.current === "zh" ? "返回失败" : "Return failure",
            tone: "danger",
          },
        ],
      });
      return;
    }

    if (request.method === "mcpServer/elicitation/request") {
      const elicitation = getMcpElicitationDetails(request.params);
      const fieldId = "mcp-elicitation-content";
      setPendingApprovalRequest(null);
      setPendingUserInputRequest(null);
      setPendingDynamicToolRequest(null);
      setPendingExternalSecretRequest(null);
      setPendingMcpElicitationRequest({ id: request.id, fieldId });
      setCapabilityPanel({
        title: `${label}: ${elicitation.title}`,
        subtitle: String(request.id),
        body:
          elicitation.body ||
          (localeRef.current === "zh"
            ? "MCP 服务器请求输入"
            : "MCP server requested input"),
        fields: [
          {
            id: fieldId,
            label:
              localeRef.current === "zh"
                ? "返回内容 JSON"
                : "Response content JSON",
            placeholder: elicitation.placeholder,
            value: "",
          },
        ],
        actions: [
          {
            id: "accept-mcp-elicitation",
            label: localeRef.current === "zh" ? "接受" : "Accept",
            tone: "primary",
          },
          {
            id: "decline-mcp-elicitation",
            label: localeRef.current === "zh" ? "拒绝" : "Decline",
            tone: "danger",
          },
          {
            id: "cancel-mcp-elicitation",
            label: localeRef.current === "zh" ? "取消" : "Cancel",
          },
        ],
      });
      return;
    }

    if (request.method === "account/chatgptAuthTokens/refresh") {
      setPendingApprovalRequest(null);
      setPendingUserInputRequest(null);
      setPendingDynamicToolRequest(null);
      setPendingMcpElicitationRequest(null);
      setPendingExternalSecretRequest({
        id: request.id,
        kind: "chatgptAuthTokens",
      });
      setCapabilityPanel({
        title: label,
        subtitle: String(request.id),
        body: [
          getParamDisplay(request.params, "reason"),
          getParamDisplay(request.params, "previousAccountId"),
        ]
          .filter(Boolean)
          .join("\n"),
        fields: [
          {
            id: "accessToken",
            label: localeRef.current === "zh" ? "Access Token" : "Access token",
            secret: true,
            value: "",
          },
          {
            id: "chatgptAccountId",
            label: localeRef.current === "zh" ? "账号 ID" : "Account ID",
            value: "",
          },
          {
            id: "chatgptPlanType",
            label: localeRef.current === "zh" ? "计划类型" : "Plan type",
            placeholder: "pro",
            value: "",
          },
        ],
        actions: [
          {
            id: "submit-auth-refresh",
            label: localeRef.current === "zh" ? "提交 Token" : "Submit token",
            tone: "primary",
          },
          {
            id: "reject-external-secret",
            label: localeRef.current === "zh" ? "拒绝" : "Reject",
            tone: "danger",
          },
        ],
      });
      return;
    }

    if (request.method === "attestation/generate") {
      setPendingApprovalRequest(null);
      setPendingUserInputRequest(null);
      setPendingDynamicToolRequest(null);
      setPendingMcpElicitationRequest(null);
      setPendingExternalSecretRequest({ id: request.id, kind: "attestation" });
      setCapabilityPanel({
        title: label,
        subtitle: String(request.id),
        body:
          localeRef.current === "zh"
            ? "输入外部 attestation token。"
            : "Enter an external attestation token.",
        fields: [
          { id: "attestationToken", label: "Token", secret: true, value: "" },
        ],
        actions: [
          {
            id: "submit-attestation",
            label: localeRef.current === "zh" ? "提交 Token" : "Submit token",
            tone: "primary",
          },
          {
            id: "reject-external-secret",
            label: localeRef.current === "zh" ? "拒绝" : "Reject",
            tone: "danger",
          },
        ],
      });
      return;
    }

    setCapabilityPanel({
      title: localeRef.current === "zh" ? "后端请求" : "Server request",
      subtitle: String(request.id),
      body:
        localeRef.current === "zh"
          ? `${label}\n已发送保守响应，避免当前任务悬挂。`
          : `${label}\nSent a conservative response so the turn does not hang.`,
    });
  }, []);

  useEffect(() => {
    let isMounted = true;
    const client = new AppServerClient(
      serverUrl,
      handleNotification,
      () => {
        if (!isMounted || clientRef.current !== client) {
          return;
        }

        switchToDemoThreads();
      },
      handleServerRequest,
    );
    clientRef.current = client;

    client
      .connect()
      .then(() => client.listThreads(showArchivedThreadsRef.current))
      .then((serverThreads) => {
        if (!isMounted) {
          return;
        }

        setConnectionState("connected");
        setNotice(null);
        if (isDemoPreview) {
          showDemoThreads();
        } else {
          setThreads(serverThreads);
          setSelectedThreadId(serverThreads[0]?.id ?? null);
        }
        void client
          .getAccount()
          .then(setAccountStatus)
          .catch(() => undefined);
      })
      .catch(() => {
        if (!isMounted) {
          return;
        }

        switchToDemoThreads(!isDemoPreview);
      });

    return () => {
      isMounted = false;
      client.close();
    };
  }, [
    connectionAttempt,
    handleNotification,
    handleServerRequest,
    isDemoPreview,
    serverUrl,
    switchToDemoThreads,
  ]);

  useEffect(() => {
    if (connectionState === "demo") {
      setThreads((currentThreads) =>
        localizeSeedDemoThreads(currentThreads, locale),
      );
    }
  }, [connectionState, locale]);

  useEffect(() => {
    if (!isDemo) {
      return;
    }

    setAccountStatus(demoAccountStatus(locale));
    setGitRemoteDiff(selectedThread ? demoGitRemoteDiff() : null);
    setConversationSummary(
      selectedThreadId ? demoConversationSummary(locale) : null,
    );
    setThreadGoal(selectedThreadId ? demoThreadGoal(locale) : null);
  }, [isDemo, locale, selectedThread, selectedThreadId]);

  useEffect(() => {
    if (!sidebarOpen && !inspectorOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSidebarOpen(false);
        setInspectorOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [inspectorOpen, sidebarOpen]);

  useEffect(() => {
    if (!inspectorOpen) {
      return;
    }

    function handleClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (
        target.closest(".inspector") ||
        target.closest(".titlebar-env-toggle")
      ) {
        return;
      }

      setInspectorOpen(false);
    }

    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [inspectorOpen]);

  useEffect(() => {
    if (!inspectorOpen) {
      return;
    }

    function closeInspectorIfCramped() {
      if (shouldAutoCloseInspector(sidebarOpen, capabilityDockOpen)) {
        setInspectorOpen(false);
      }
    }

    closeInspectorIfCramped();
    window.addEventListener("resize", closeInspectorIfCramped);
    return () => window.removeEventListener("resize", closeInspectorIfCramped);
  }, [capabilityDockOpen, inspectorOpen, sidebarOpen]);

  async function selectThread(threadId: string) {
    setAppView("chat");
    setSelectedThreadId(threadId);
    setInspectorOpen(false);
    if (shouldAutoCloseSidebar()) {
      setSidebarOpen(false);
    }

    if (!isConnected) {
      return;
    }

    try {
      const thread = await clientRef.current?.readThread(threadId);
      if (thread) {
        setThreads((current) => upsertThread(current, thread));
      }
    } catch {
      switchToDemoThreads();
    }
  }

  const startDraftThread = useCallback(() => {
    setAppView("chat");
    setSelectedThreadId(null);
    setInspectorOpen(false);
    setComposerValue("");
    setPendingComposerMentions([]);
    setComposerFocusSignal((signal) => signal + 1);
    if (shouldAutoCloseSidebar()) {
      setSidebarOpen(false);
    }
  }, []);

  async function toggleArchivedThreads() {
    const nextShowArchived = !showArchivedThreadsRef.current;
    setShowArchivedThreads(nextShowArchived);
    showArchivedThreadsRef.current = nextShowArchived;
    setSelectedThreadId(null);
    setThreadSearchTerm("");
    setThreads([]);

    if (!isConnected) {
      return;
    }

    try {
      const serverThreads =
        await clientRef.current?.listThreads(nextShowArchived);
      setThreads(serverThreads ?? []);
      setSelectedThreadId(serverThreads?.[0]?.id ?? null);
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取会话失败"
              : "Unable to load sessions",
        tone: "warning",
      });
    }
  }

  async function archiveThread(thread: Thread) {
    if (!isConnected) {
      setThreads((current) =>
        current.filter((currentThread) => currentThread.id !== thread.id),
      );
      setSelectedThreadId((currentThreadId) =>
        currentThreadId === thread.id ? null : currentThreadId,
      );
      return;
    }

    try {
      if (showArchivedThreadsRef.current) {
        await clientRef.current?.unarchiveThread(thread.id);
      } else {
        await clientRef.current?.archiveThread(thread.id);
      }

      const serverThreads = await clientRef.current?.listThreads(
        showArchivedThreadsRef.current,
      );
      setThreads(serverThreads ?? []);
      setSelectedThreadId((currentThreadId) =>
        currentThreadId &&
        serverThreads?.some(
          (serverThread) => serverThread.id === currentThreadId,
        )
          ? currentThreadId
          : (serverThreads?.[0]?.id ?? null),
      );
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "会话操作失败"
              : "Session action failed",
        tone: "warning",
      });
    }
  }

  async function deleteArchivedThread(thread: Thread) {
    const title = threadTitle(thread, t.untitledThread);
    const confirmed = window.confirm(
      locale === "zh"
        ? `永久删除已归档会话「${title}」？此操作无法撤销。`
        : `Permanently delete archived session "${title}"? This cannot be undone.`,
    );

    if (!confirmed) {
      return;
    }

    if (!isConnected) {
      setThreads((current) =>
        current.filter((currentThread) => currentThread.id !== thread.id),
      );
      setSelectedThreadId((currentThreadId) =>
        currentThreadId === thread.id ? null : currentThreadId,
      );
      return;
    }

    try {
      await clientRef.current?.deleteThread(thread.id);
      const serverThreads = await clientRef.current?.listThreads(
        showArchivedThreadsRef.current,
      );
      setThreads(serverThreads ?? []);
      setSelectedThreadId((currentThreadId) =>
        currentThreadId &&
        serverThreads?.some(
          (serverThread) => serverThread.id === currentThreadId,
        )
          ? currentThreadId
          : (serverThreads?.[0]?.id ?? null),
      );
      setNotice({
        text:
          locale === "zh"
            ? `已删除会话：${title}`
            : `Deleted session: ${title}`,
        tone: "success",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "删除会话失败"
              : "Unable to delete session",
        tone: "warning",
      });
    }
  }

  async function renameThread(thread: Thread) {
    const currentName = threadTitle(thread, t.untitledThread);
    const nextName = window
      .prompt(locale === "zh" ? "重命名会话" : "Rename session", currentName)
      ?.trim();

    if (!nextName || nextName === currentName) {
      return;
    }

    if (!isConnected) {
      setThreads((current) =>
        current.map((currentThread) =>
          currentThread.id === thread.id
            ? { ...currentThread, name: nextName }
            : currentThread,
        ),
      );
      return;
    }

    try {
      await clientRef.current?.renameThread(thread.id, nextName);
      setThreads((current) =>
        current.map((currentThread) =>
          currentThread.id === thread.id
            ? { ...currentThread, name: nextName }
            : currentThread,
        ),
      );
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "重命名会话失败"
              : "Unable to rename session",
        tone: "warning",
      });
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        if (!isSending) {
          startDraftThread();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSending, startDraftThread]);

  function createDemoThread(initialPrompt?: string): Thread {
    const preview = initialPrompt
      ? promptPreview(initialPrompt)
      : t.newDraftPreview;
    const [demoTemplate] = getDemoThreads(locale);
    const demoThread = {
      ...demoTemplate,
      id: `demo-${Date.now()}`,
      sessionId: `demo-session-${Date.now()}`,
      name: initialPrompt ? preview : t.newDraftThread,
      preview,
      turns: [],
      updatedAt: Math.floor(Date.now() / 1000),
    };
    setThreads((current) => [demoThread, ...current]);
    setSelectedThreadId(demoThread.id);
    setInspectorOpen(false);
    if (shouldAutoCloseSidebar()) {
      setSidebarOpen(false);
    }
    return demoThread;
  }

  function createDemoTurn(text: string): Turn {
    const now = Math.floor(Date.now() / 1000);

    return {
      id: `demo-turn-${Date.now()}`,
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      items: [
        {
          type: "userMessage",
          id: `demo-user-${Date.now()}`,
          clientId: null,
          content: [{ type: "text", text, text_elements: [] }],
        },
        {
          type: "agentMessage",
          id: `demo-agent-${Date.now()}`,
          text: t.demoResponse,
          phase: null,
          memoryCitation: null,
        },
      ],
    };
  }

  async function createThread(
    initialPrompt?: string,
    threadSource = "app_server",
  ): Promise<Thread | null> {
    if (!isConnected) {
      return createDemoThread(initialPrompt);
    }

    try {
      const threadCwd = await resolveBackendCwd();
      const thread = await clientRef.current?.startThread(
        threadCwd || undefined,
        threadSource,
      );
      if (thread) {
        setThreads((current) => upsertThread(current, thread));
        setSelectedThreadId(thread.id);
        if (shouldAutoCloseSidebar()) {
          setSidebarOpen(false);
        }
        return thread;
      }
    } catch {
      switchToDemoThreads();
      return createDemoThread(initialPrompt);
    }

    return null;
  }

  async function sendMessage(text: string) {
    if (isSending) {
      return;
    }

    setIsSending(true);
    let thread = isDemoPreview ? null : selectedThread;

    try {
      if (activeTurnId && selectedThreadId && isConnected) {
        const response = await clientRef.current?.steerTurn(
          selectedThreadId,
          text,
          pendingComposerMentions,
        );
        setPendingComposerMentions([]);
        if (response?.turnId) {
          setActiveTurnByThread((current) => ({
            ...current,
            [selectedThreadId]: response.turnId,
          }));
        }
        setNotice({
          text:
            locale === "zh"
              ? "已追加到当前任务"
              : "Added guidance to the current turn",
          tone: "success",
        });
        return;
      }

      if (!thread) {
        thread = await createThread(text);
      }

      if (!thread) {
        return;
      }

      const activeThread = thread;

      if (!isConnected) {
        const now = Math.floor(Date.now() / 1000);
        const turn = createDemoTurn(text);

        setThreads((current) =>
          current.map((currentThread) =>
            currentThread.id === activeThread.id
              ? {
                  ...currentThread,
                  name: currentThread.name || promptPreview(text),
                  preview: currentThread.preview || promptPreview(text),
                  updatedAt: now,
                  turns: [...currentThread.turns, turn],
                }
              : currentThread,
          ),
        );
        return;
      }

      const resumedThread =
        activeThread.status.type === "notLoaded"
          ? await clientRef.current?.resumeThread(activeThread.id)
          : activeThread;

      if (resumedThread) {
        setThreads((current) => upsertThread(current, resumedThread));
        setSelectedThreadId(resumedThread.id);
      }

      const response = await clientRef.current?.startTurn(
        (resumedThread ?? activeThread).id,
        text,
        pendingComposerMentions,
      );
      if (response) {
        setPendingComposerMentions([]);
        setThreads((current) =>
          current.map((currentThread) =>
            currentThread.id === (resumedThread ?? activeThread).id
              ? upsertTurn(currentThread, response.turn)
              : currentThread,
          ),
        );
        if (response.turn.status === "inProgress") {
          setActiveTurnByThread((current) => ({
            ...current,
            [(resumedThread ?? activeThread).id]: response.turn.id,
          }));
        }
      }
    } catch {
      setPendingComposerMentions([]);
      switchToDemoThreads();
      const fallbackThread = createDemoThread(text);
      const turn = createDemoTurn(text);
      setThreads((current) =>
        current.map((currentThread) =>
          currentThread.id === fallbackThread.id
            ? { ...currentThread, turns: [turn] }
            : currentThread,
        ),
      );
    } finally {
      setIsSending(false);
    }
  }

  async function interruptActiveTurn() {
    if (!selectedThreadId || !activeTurnId || !isConnected) {
      return;
    }

    setIsSending(true);
    try {
      await clientRef.current?.interruptTurn(selectedThreadId, activeTurnId);
      setNotice({
        text:
          locale === "zh"
            ? "已请求停止当前任务"
            : "Requested stop for current turn",
        tone: "success",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "停止当前任务失败"
              : "Unable to stop current turn",
        tone: "warning",
      });
    } finally {
      setIsSending(false);
    }
  }

  function changeWorkMode(nextMode: WorkMode) {
    setWorkMode(nextMode);
  }

  async function startReview() {
    if (busyToolId) {
      return;
    }
    if (isDemo) {
      setCapabilityPanel(demoCapabilityPanel("review", locale));
      return;
    }
    if (!isConnected) {
      return;
    }

    setBusyToolId("review");

    try {
      let thread = isDemoPreview ? null : selectedThread;

      if (!thread) {
        thread = await createThread();
      }

      if (!thread) {
        return;
      }

      const response = await clientRef.current?.startReview(thread.id);

      if (response) {
        setSelectedThreadId(response.reviewThreadId);
        setThreads((current) =>
          current.map((currentThread) =>
            currentThread.id === response.reviewThreadId
              ? upsertTurn(currentThread, response.turn)
              : currentThread,
          ),
        );
      }
    } catch {
      switchToDemoThreads();
    } finally {
      setBusyToolId(null);
    }
  }

  async function showBackgroundTerminals(threadId: string) {
    setBusyToolId("terminal");
    setCapabilityPanel({
      title: locale === "zh" ? "后台终端" : "Background terminals",
      subtitle: threadId,
      body: locale === "zh" ? "正在读取..." : "Reading...",
    });

    try {
      const response = await clientRef.current?.listBackgroundTerminals(threadId);
      const terminals = response?.data ?? [];
      setCapabilityPanel({
        title: locale === "zh" ? "后台终端" : "Background terminals",
        subtitle:
          locale === "zh"
            ? `${terminals.length} 个后台任务`
            : `${terminals.length} background tasks`,
        body:
          terminals.length > 0
            ? locale === "zh"
              ? "点击任务可终止对应进程。"
              : "Click a task to terminate its process."
            : locale === "zh"
              ? "当前会话没有后台终端。"
              : "This session has no background terminals.",
        actions: [
          {
            id: "refresh-background-terminals",
            label: locale === "zh" ? "刷新" : "Refresh",
          },
          {
            id: "clean-background-terminals",
            label: locale === "zh" ? "清理已结束" : "Clean finished",
          },
        ],
        items: terminals.map(
          (terminal) =>
            ({
              label: backgroundTerminalLabel(terminal, locale),
              action: {
                type: "background-terminal",
                threadId,
                processId: terminal.processId,
              },
            }) satisfies CapabilityPanelItem,
        ),
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "后台终端" : "Background terminals",
        subtitle: threadId,
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取后台终端失败"
              : "Unable to read background terminals",
      });
    } finally {
      setBusyToolId(null);
    }
  }

  async function runTerminalStatus() {
    if (isDemo) {
      const command = terminalCommand.trim();
      const panel = demoCapabilityPanel("terminal", locale);
      setCapabilityPanel(
        command ? { ...panel, subtitle: `${command}  ·  exit 0` } : panel,
      );
      return;
    }

    const command = terminalCommand.trim();

    if (busyToolId || !isConnected || !command) {
      return;
    }

    const terminalCwd = await resolveBackendCwd();
    if (!terminalCwd) {
      return;
    }

    setBusyToolId("terminal");
    const processId = `crewon-ui-terminal-${Date.now()}`;
    terminalProcessIdRef.current = processId;
    setCapabilityPanel({
      title: locale === "zh" ? "终端" : "Terminal",
      subtitle: terminalCwd,
      commandInput: true,
      body: locale === "zh" ? "正在运行..." : "Running...",
      fields: [
        {
          id: "terminal-stdin",
          label: locale === "zh" ? "输入" : "Input",
          placeholder:
            locale === "zh"
              ? "发送到运行中的命令，可用 \\n 换行"
              : "Send to the running command; use \\n for newline",
          value: "",
        },
      ],
      actions: [
        {
          id: "send-terminal-to-thread",
          label: locale === "zh" ? "发送到会话" : "Send to session",
        },
        {
          id: "refresh-background-terminals",
          label: locale === "zh" ? "后台任务" : "Background tasks",
        },
        {
          id: "send-terminal-input",
          label: locale === "zh" ? "发送输入" : "Send input",
          tone: "primary",
        },
        {
          id: "stop-terminal",
          label: locale === "zh" ? "停止" : "Stop",
          tone: "danger",
        },
      ],
    });

    try {
      const response = await clientRef.current?.runCommand(
        terminalCwd,
        command,
        processId,
      );
      const output = [response?.stdout, response?.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      setCapabilityPanel((currentPanel) => ({
        title: locale === "zh" ? "终端" : "Terminal",
        subtitle: response ? `${command}  exit ${response.exitCode}` : command,
        commandInput: true,
        body:
          (currentPanel?.body &&
          currentPanel.body !== (locale === "zh" ? "正在运行..." : "Running...")
            ? currentPanel.body
            : output) || (locale === "zh" ? "无输出" : "No output"),
        actions: [
          {
            id: "send-terminal-to-thread",
            label: locale === "zh" ? "发送到会话" : "Send to session",
          },
          {
            id: "refresh-background-terminals",
            label: locale === "zh" ? "后台任务" : "Background tasks",
          },
        ],
      }));
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "终端" : "Terminal",
        subtitle: command,
        commandInput: true,
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "命令执行失败"
              : "Command failed",
      });
    } finally {
      if (terminalProcessIdRef.current === processId) {
        terminalProcessIdRef.current = null;
      }
      setBusyToolId(null);
    }
  }

  async function readWorkspaceFiles() {
    if (isDemo) {
      setCapabilityPanel(demoCapabilityPanel("files", locale));
      return;
    }
    if (busyToolId || !isConnected) {
      return;
    }

    const filesCwd = await resolveBackendCwd();
    if (!filesCwd) {
      return;
    }

    setBusyToolId("files");
    setCapabilityPanel({
      title: locale === "zh" ? "文件" : "Files",
      subtitle: filesCwd,
      body: locale === "zh" ? "正在读取..." : "Reading...",
    });

    try {
      const [response, metadata] = await Promise.all([
        clientRef.current?.readDirectory(filesCwd),
        clientRef.current?.getMetadata(filesCwd),
      ]);
      const entries = [...(response?.entries ?? [])]
        .sort(
          (left, right) =>
            Number(right.isDirectory) - Number(left.isDirectory) ||
            left.fileName.localeCompare(right.fileName),
        )
        .slice(0, 16)
        .map(
          (entry) =>
            ({
              label: `${entry.isDirectory ? ">" : " "} ${entry.fileName}`,
              path: joinPath(filesCwd, entry.fileName),
              kind: entry.isDirectory ? "directory" : "file",
            }) satisfies CapabilityPanelItem,
        );
      setCapabilityPanel({
        title: locale === "zh" ? "文件" : "Files",
        subtitle: filesCwd,
        body: fileMetadataText(metadata ?? null, locale),
        ...filePanelSearchControls(locale, filesCwd),
        items:
          entries.length > 0
            ? entries
            : [{ label: locale === "zh" ? "目录为空" : "Empty directory" }],
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "文件" : "Files",
        subtitle: filesCwd,
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取目录失败"
              : "Unable to read directory",
      });
    } finally {
      setBusyToolId(null);
    }
  }

  async function attachWorkspaceContext() {
    if (isDemo) {
      setCapabilityDockOpen(true);
      setCapabilityPanel({
        title: locale === "zh" ? "添加上下文" : "Attach context",
        subtitle: locale === "zh" ? "演示模式" : "Demo mode",
        body:
          locale === "zh"
            ? "演示模式下不会读取真实文件。连接 app-server 后，这里会搜索 README、AGENTS 和知识库文件。"
            : "Demo mode does not read real files. With app-server connected, this searches README, AGENTS, and knowledge files.",
      });
      return;
    }

    if (busyToolId || !isConnected) {
      return;
    }

    const contextCwd = await resolveBackendCwd();
    if (!contextCwd) {
      return;
    }

    setCapabilityDockOpen(true);
    setBusyToolId("files");
    setCapabilityPanel({
      title: locale === "zh" ? "添加上下文" : "Attach context",
      subtitle: contextCwd,
      body:
        locale === "zh"
          ? "正在从工作区搜索可添加的上下文..."
          : "Searching workspace context...",
    });

    try {
      const contextQueries = ["AGENTS.md", "README.md", "knowledge.md", "memory.md"];
      const searchResults = await Promise.allSettled(
        contextQueries.map((query) =>
          clientRef.current?.fuzzyFileSearch(query, [contextCwd]),
        ),
      );
      const seenPaths = new Set<string>();
      const files = searchResults.flatMap((result) =>
        result.status === "fulfilled" ? (result.value?.files ?? []) : [],
      );
      const items: CapabilityPanelItem[] = [];
      for (const file of files) {
        if (items.length >= 12) {
          break;
        }
        const path = resolveSearchPath(file.root, file.path);
        if (seenPaths.has(path)) {
          continue;
        }
        seenPaths.add(path);
        items.push({
          label: `${file.match_type === "directory" ? ">" : " "} ${file.path}`,
          path,
          kind: file.match_type === "directory" ? "directory" : "file",
          intent: "attach-context",
        });
      }

      const fallbackPaths = [
        joinPath(contextCwd, "AGENTS.md"),
        joinPath(contextCwd, "README.md"),
        joinPath(joinPath(contextCwd, ".crewon"), "knowledge.md"),
        joinPath(joinPath(contextCwd, ".crewon"), "memory.md"),
      ];
      for (const path of fallbackPaths) {
        if (items.length >= 12 || seenPaths.has(path)) {
          continue;
        }
        try {
          const metadata = await clientRef.current?.getMetadata(path);
          if (!metadata || metadata.isDirectory) {
            continue;
          }
          seenPaths.add(path);
          items.push({
            label: `  ${path.replace(`${contextCwd}/`, "")}`,
            path,
            kind: "file",
            intent: "attach-context",
          });
        } catch {
          // Missing optional context files are fine.
        }
      }

      setCapabilityPanel({
        title: locale === "zh" ? "添加上下文" : "Attach context",
        subtitle: contextCwd,
        body:
          locale === "zh"
            ? "选择一个文件加入当前对话上下文。这里读取的是 app-server 的真实工作区搜索结果。"
            : "Choose a file to inspect for the current conversation context. These are live app-server workspace search results.",
        ...filePanelSearchControls(locale, contextCwd, contextQueries.join(" ")),
        items:
          items.length > 0
            ? items
            : [
                {
                  label:
                    locale === "zh"
                      ? "没有找到可添加的上下文文件"
                      : "No context files found",
                },
              ],
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "添加上下文" : "Attach context",
        subtitle: contextCwd,
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "搜索上下文失败"
              : "Unable to search context",
      });
    } finally {
      setBusyToolId(null);
    }
  }

  async function loadBrowserApps() {
    if (isDemo) {
      setCapabilityPanel(demoCapabilityPanel("web", locale));
      return;
    }
    if (busyToolId || !isConnected) {
      return;
    }

    setBusyToolId("web");
    const appsCwd = await resolveBackendCwd();
    setCapabilityPanel({
      title: locale === "zh" ? "浏览器" : "Browser",
      subtitle:
        locale === "zh" ? "应用、插件与 Hook" : "Apps, plugins, and hooks",
      body: locale === "zh" ? "正在读取..." : "Loading...",
    });

    try {
      let response;
      let hooksResponse;
      let pluginsResponse;

      try {
        [response, hooksResponse, pluginsResponse] = await Promise.all([
          clientRef.current?.listApps(
            isDemoPreview ? undefined : (selectedThreadId ?? undefined),
          ),
          clientRef.current?.listHooks(appsCwd),
          clientRef.current?.listPlugins(appsCwd),
        ]);
      } catch (threadScopedError) {
        if (
          !(threadScopedError instanceof Error) ||
          !threadScopedError.message.includes("thread not found")
        ) {
          throw threadScopedError;
        }

        [response, hooksResponse, pluginsResponse] = await Promise.all([
          clientRef.current?.listApps(),
          clientRef.current?.listHooks(appsCwd),
          clientRef.current?.listPlugins(appsCwd),
        ]);
      }

      const apps = response?.data ?? [];
      const hooks = (hooksResponse?.data ?? []).flatMap((entry) => entry.hooks);
      const pluginEntries = (pluginsResponse?.marketplaces ?? []).flatMap(
        (marketplace) =>
          marketplace.plugins.map((plugin) => ({ marketplace, plugin })),
      );
      const installedPlugins = pluginEntries.filter(
        ({ plugin }) => plugin.installed || plugin.enabled,
      );
      const appItems =
        apps.length > 0
          ? apps.slice(0, 12).map((app) => {
              const access = app.isAccessible
                ? locale === "zh"
                  ? "可访问"
                  : "accessible"
                : locale === "zh"
                  ? "需连接"
                  : "needs auth";
              const enabled = app.isEnabled
                ? locale === "zh"
                  ? "已启用"
                  : "enabled"
                : locale === "zh"
                  ? "已停用"
                  : "disabled";
              const plugins =
                app.pluginDisplayNames.length > 0
                  ? ` · ${app.pluginDisplayNames.join(", ")}`
                  : "";
              return {
                label: `${locale === "zh" ? "应用" : "App"} · ${app.name} · ${access} · ${enabled}${plugins}`,
                action: {
                  type: "app" as const,
                  appId: app.id,
                  appName: app.name,
                },
              };
            })
          : [{ label: locale === "zh" ? "暂无可用应用" : "No apps available" }];
      const pluginItems =
        installedPlugins.length > 0
          ? installedPlugins.slice(0, 12).map(({ marketplace, plugin }) => {
              const source =
                plugin.source.type === "local"
                  ? locale === "zh"
                    ? "本地"
                    : "local"
                  : plugin.source.type === "git"
                    ? "Git"
                    : locale === "zh"
                      ? "远程"
                      : "remote";
              const state = plugin.enabled
                ? locale === "zh"
                  ? "启用"
                  : "enabled"
                : locale === "zh"
                  ? "停用"
                  : "disabled";
              return {
                label: `${locale === "zh" ? "插件" : "Plugin"} · ${plugin.name} · ${source} · ${state}`,
                action: {
                  type: "plugin" as const,
                  pluginName: plugin.name,
                  marketplacePath: marketplace.path ?? null,
                  remoteMarketplaceName: marketplace.path
                    ? null
                    : (marketplace.name ?? null),
                },
              };
            })
          : [
              {
                label:
                  locale === "zh"
                    ? "暂无已启用插件"
                    : "No enabled plugins",
              },
            ];
      const hookItems =
        hooks.length > 0
          ? hooks.slice(0, 8).map((hook) => {
              const status = hook.enabled
                ? locale === "zh"
                  ? "启用"
                  : "enabled"
                : locale === "zh"
                  ? "停用"
                  : "disabled";
              return {
                label: `${locale === "zh" ? "Hook" : "Hook"} · ${hook.eventName} · ${hook.handlerType} · ${status}`,
              };
            })
          : [{ label: locale === "zh" ? "暂无 Hook" : "No hooks" }];
      setCapabilityPanel({
        title: locale === "zh" ? "浏览器" : "Browser",
        subtitle:
          locale === "zh"
            ? `${apps.length} 应用 · ${installedPlugins.length} 插件 · ${hooks.length} Hook`
            : `${apps.length} apps · ${installedPlugins.length} plugins · ${hooks.length} hooks`,
        body:
          apps.length === 0 && installedPlugins.length > 0
            ? locale === "zh"
              ? "当前没有暴露 App，但已从插件市场读取到可用插件能力。点击插件可查看详情、打开本地目录或执行安装状态操作。"
              : "No Apps are exposed, but plugin capabilities are available from the marketplace. Open a plugin to inspect details, local files, or install state."
            : undefined,
        items: [...appItems, ...pluginItems, ...hookItems],
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "浏览器" : "Browser",
        subtitle:
          locale === "zh" ? "应用、插件与 Hook" : "Apps, plugins, and hooks",
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取应用失败"
              : "Unable to load apps",
      });
    } finally {
      setBusyToolId(null);
    }
  }

  async function refreshConfigPanel() {
    if (!isConnected) {
      setCapabilityPanel({
        title: locale === "zh" ? "配置" : "Config",
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    const configCwd = await resolveBackendCwd();
    setCapabilityPanel({
      title: locale === "zh" ? "配置" : "Config",
      subtitle: configCwd || (locale === "zh" ? "全局配置" : "Global config"),
      body: locale === "zh" ? "正在读取配置..." : "Reading config...",
    });

    try {
      const [configResult, requirementsResult, modelsResult] =
        await Promise.allSettled([
        clientRef.current?.readConfig(configCwd),
        clientRef.current?.readConfigRequirements(),
          clientRef.current?.listModels(),
        ]);
      const configRead =
        configResult.status === "fulfilled"
          ? (configResult.value ?? null)
          : null;
      const configRequirements =
        requirementsResult.status === "fulfilled"
          ? (requirementsResult.value ?? null)
          : null;
      const models =
        modelsResult.status === "fulfilled" ? (modelsResult.value ?? null) : null;
      const errors = [
        configResult.status === "rejected" ? configResult.reason : null,
        requirementsResult.status === "rejected"
          ? requirementsResult.reason
          : null,
        modelsResult.status === "rejected" ? modelsResult.reason : null,
      ]
        .filter((error): error is Error => error instanceof Error)
        .map((error) => error.message);
      const currentModel = configRead?.config.model ?? "";
      const currentApprovalPolicy =
        typeof configRead?.config.approval_policy === "string"
          ? configRead.config.approval_policy
          : "";
      const currentSandboxMode = configRead?.config.sandbox_mode ?? "";
      const modelOptions = [
        ...(currentModel
          ? [{ label: currentModel, value: currentModel }]
          : []),
        ...(models?.data ?? []).map((model) => ({
          label: model.displayName || model.model || model.id,
          value: model.model,
        })),
      ].filter(
        (option, index, options) =>
          option.value &&
          options.findIndex((candidate) => candidate.value === option.value) === index,
      );
      const approvalOptions = [
        ...(currentApprovalPolicy
          ? [{ label: currentApprovalPolicy, value: currentApprovalPolicy }]
          : []),
        ...(configRequirements?.requirements?.allowedApprovalPolicies ?? [
          "untrusted",
          "on-failure",
          "on-request",
          "never",
        ])
        .flatMap((policy) => (typeof policy === "string" ? [policy] : []))
        .map((policy) => ({ label: policy, value: policy })),
      ].filter(
        (option, index, options) =>
          option.value &&
          options.findIndex((candidate) => candidate.value === option.value) === index,
      );
      const sandboxOptions = [
        ...(currentSandboxMode
          ? [{ label: currentSandboxMode, value: currentSandboxMode }]
          : []),
        ...(configRequirements?.requirements?.allowedSandboxModes ?? [
          "read-only",
          "workspace-write",
          "danger-full-access",
        ]).map((mode) => ({ label: mode, value: mode })),
      ].filter(
        (option, index, options) =>
          option.value &&
          options.findIndex((candidate) => candidate.value === option.value) === index,
      );

      setCapabilityPanel({
        title: locale === "zh" ? "配置" : "Config",
        subtitle: configCwd || (locale === "zh" ? "全局配置" : "Global config"),
        body: [
          configSummaryText(configRead, locale) ||
            (locale === "zh" ? "未读取到配置" : "No config returned"),
          configRequirementsText(configRequirements, locale),
          errors.length > 0
            ? `${locale === "zh" ? "部分配置读取失败" : "Some config reads failed"}\n${errors.join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        fields: [
          {
            id: "config-model",
            label: locale === "zh" ? "默认模型" : "Default model",
            placeholder: "gpt-5-codex",
            value: currentModel || modelOptions[0]?.value || "",
            options: modelOptions,
          },
          {
            id: "config-approval-policy",
            label: locale === "zh" ? "审批策略" : "Approval policy",
            placeholder: "on-request",
            value: currentApprovalPolicy || approvalOptions[0]?.value || "",
            options: approvalOptions,
          },
          {
            id: "config-sandbox-mode",
            label: locale === "zh" ? "沙箱模式" : "Sandbox mode",
            placeholder: "workspace-write",
            value: currentSandboxMode || sandboxOptions[0]?.value || "",
            options: sandboxOptions,
          },
        ],
        actions: [
          {
            id: "save-config",
            label: locale === "zh" ? "保存配置" : "Save config",
            tone: "primary",
          },
          {
            id: "refresh-config",
            label: locale === "zh" ? "刷新配置" : "Refresh config",
          },
        ],
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "配置" : "Config",
        subtitle: configCwd || (locale === "zh" ? "全局配置" : "Global config"),
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取配置失败"
              : "Unable to read config",
      });
    }
  }

  async function refreshHooksPanel() {
    if (!isConnected) {
      setCapabilityPanel({
        title: locale === "zh" ? "钩子" : "Hooks",
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    const hooksCwd = await resolveBackendCwd();
    setCapabilityPanel({
      title: locale === "zh" ? "钩子" : "Hooks",
      subtitle: hooksCwd || (locale === "zh" ? "全局配置" : "Global config"),
      body: locale === "zh" ? "正在读取 Hook..." : "Reading hooks...",
    });

    try {
      const response = (await clientRef.current?.listHooks(hooksCwd)) ?? null;
      const hooks = (response?.data ?? []).flatMap((entry) => entry.hooks);
      const warnings = (response?.data ?? []).flatMap((entry) => entry.warnings);
      const errors = (response?.data ?? []).flatMap((entry) => entry.errors);
      setCapabilityPanel({
        title: locale === "zh" ? "钩子" : "Hooks",
        subtitle:
          locale === "zh"
            ? `${hooks.length} Hook · ${warnings.length} 警告 · ${errors.length} 错误`
            : `${hooks.length} hooks · ${warnings.length} warnings · ${errors.length} errors`,
        body: hooksSettingsText(response, locale),
        actions: [
          {
            id: "refresh-hooks",
            label: locale === "zh" ? "刷新 Hook" : "Refresh hooks",
          },
        ],
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "钩子" : "Hooks",
        subtitle: hooksCwd || (locale === "zh" ? "全局配置" : "Global config"),
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取 Hook 失败"
              : "Unable to read hooks",
      });
    }
  }

  async function refreshAppearanceSettingsPanel() {
    const title = locale === "zh" ? "外观" : "Appearance";
    if (!isConnected) {
      setCapabilityPanel({
        title,
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    const configCwd = await resolveBackendCwd();
    setCapabilityPanel({
      title,
      subtitle: configCwd || (locale === "zh" ? "全局配置" : "Global config"),
      body: locale === "zh" ? "正在读取外观设置..." : "Reading appearance settings...",
    });

    try {
      const configRead = (await clientRef.current?.readConfig(configCwd)) ?? null;
      const configuredLocale = configDesktopValue(configRead, "uiLocale") || locale;
      const configuredTheme = configDesktopValue(configRead, "appearanceTheme") || theme;
      setCapabilityPanel({
        title,
        subtitle: configCwd || (locale === "zh" ? "全局配置" : "Global config"),
        body: appearanceSettingsText(configRead, locale),
        fields: [
          {
            id: "appearance-locale",
            label: locale === "zh" ? "语言" : "Language",
            value: configuredLocale,
            options: [
              { label: "中文", value: "zh" },
              { label: "English", value: "en" },
            ],
          },
          {
            id: "appearance-theme",
            label: locale === "zh" ? "主题" : "Theme",
            value: configuredTheme,
            options: [
              { label: locale === "zh" ? "深色" : "Dark", value: "dark" },
              { label: locale === "zh" ? "浅色" : "Light", value: "light" },
            ],
          },
        ],
        actions: [
          {
            id: "save-appearance",
            label: locale === "zh" ? "保存外观" : "Save appearance",
            tone: "primary",
          },
          {
            id: "refresh-appearance",
            label: locale === "zh" ? "刷新外观" : "Refresh appearance",
          },
        ],
      });
    } catch (error) {
      setCapabilityPanel({
        title,
        subtitle: configCwd || (locale === "zh" ? "全局配置" : "Global config"),
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取外观设置失败"
              : "Unable to read appearance settings",
      });
    }
  }

  async function refreshPersonalizationSettingsPanel() {
    const title = locale === "zh" ? "个性化" : "Personalization";
    if (!isConnected) {
      setCapabilityPanel({
        title,
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    const configCwd = await resolveBackendCwd();
    setCapabilityPanel({
      title,
      subtitle: configCwd || (locale === "zh" ? "全局配置" : "Global config"),
      body:
        locale === "zh"
          ? "正在读取个性化设置..."
          : "Reading personalization settings...",
    });

    try {
      const configRead = (await clientRef.current?.readConfig(configCwd)) ?? null;
      setCapabilityPanel({
        title,
        subtitle: configCwd || (locale === "zh" ? "全局配置" : "Global config"),
        body: personalizationSettingsText(configRead, locale),
        fields: [
          {
            id: "personalization-instructions",
            label: locale === "zh" ? "个人指令" : "Instructions",
            placeholder:
              locale === "zh"
                ? "例如：回答更简洁，优先给出可执行步骤"
                : "Example: answer concisely and prioritize actionable steps",
            value: configRead?.config.instructions ?? "",
          },
          {
            id: "personalization-developer-instructions",
            label: locale === "zh" ? "开发者指令" : "Developer instructions",
            placeholder:
              locale === "zh"
                ? "团队级默认工程约束"
                : "Team-level engineering defaults",
            value: configRead?.config.developer_instructions ?? "",
          },
        ],
        actions: [
          {
            id: "save-personalization",
            label: locale === "zh" ? "保存个性化" : "Save personalization",
            tone: "primary",
          },
          {
            id: "refresh-personalization",
            label: locale === "zh" ? "刷新个性化" : "Refresh personalization",
          },
        ],
      });
    } catch (error) {
      setCapabilityPanel({
        title,
        subtitle: configCwd || (locale === "zh" ? "全局配置" : "Global config"),
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取个性化设置失败"
              : "Unable to read personalization settings",
      });
    }
  }

  async function refreshKeyboardSettingsPanel() {
    const title = locale === "zh" ? "键盘快捷键" : "Keyboard shortcuts";
    if (!isConnected) {
      setCapabilityPanel({
        title,
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    const configCwd = await resolveBackendCwd();
    setCapabilityPanel({
      title,
      subtitle: configCwd || (locale === "zh" ? "全局配置" : "Global config"),
      body: locale === "zh" ? "正在读取快捷键..." : "Reading shortcuts...",
    });

    try {
      const configRead = (await clientRef.current?.readConfig(configCwd)) ?? null;
      setCapabilityPanel({
        title,
        subtitle: configCwd || (locale === "zh" ? "全局配置" : "Global config"),
        body: keyboardSettingsText(configRead, locale),
        actions: [
          {
            id: "refresh-keyboard",
            label: locale === "zh" ? "刷新快捷键" : "Refresh shortcuts",
          },
        ],
      });
    } catch (error) {
      setCapabilityPanel({
        title,
        subtitle: configCwd || (locale === "zh" ? "全局配置" : "Global config"),
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取快捷键失败"
              : "Unable to read shortcuts",
      });
    }
  }

  async function refreshMcpSettingsPanel() {
    if (!isConnected) {
      setCapabilityPanel({
        title: locale === "zh" ? "MCP 服务器" : "MCP servers",
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    setCapabilityPanel({
      title: locale === "zh" ? "MCP 服务器" : "MCP servers",
      subtitle: locale === "zh" ? "运行态连接器" : "Runtime connectors",
      body: locale === "zh" ? "正在读取 MCP 服务器..." : "Reading MCP servers...",
    });

    try {
      let response;
      try {
        response = await clientRef.current?.listMcpServerStatus(
          isDemoPreview ? undefined : (selectedThreadId ?? undefined),
          "full",
        );
      } catch (threadScopedError) {
        if (
          !(threadScopedError instanceof Error) ||
          !threadScopedError.message.includes("thread not found")
        ) {
          throw threadScopedError;
        }
        response = await clientRef.current?.listMcpServerStatus(
          undefined,
          "full",
        );
      }

      const servers = response?.data ?? [];
      const toolCount = servers.reduce(
        (total, server) => total + Object.keys(server.tools).length,
        0,
      );
      const resourceCount = servers.reduce(
        (total, server) =>
          total + server.resources.length + server.resourceTemplates.length,
        0,
      );
      setCapabilityPanel({
        title: locale === "zh" ? "MCP 服务器" : "MCP servers",
        subtitle:
          locale === "zh"
            ? `${servers.length} 服务器 · ${toolCount} 工具 · ${resourceCount} 资源`
            : `${servers.length} servers · ${toolCount} tools · ${resourceCount} resources`,
        body: mcpSettingsText(servers, locale),
        actions: [
          {
            id: "refresh-mcp-settings",
            label: locale === "zh" ? "刷新 MCP" : "Refresh MCP",
          },
          {
            id: "reload-tools",
            label: locale === "zh" ? "重载 MCP 配置" : "Reload MCP config",
          },
        ],
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "MCP 服务器" : "MCP servers",
        subtitle: locale === "zh" ? "运行态连接器" : "Runtime connectors",
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取 MCP 服务器失败"
              : "Unable to read MCP servers",
      });
    }
  }

  async function refreshBrowserSettingsPanel() {
    if (!isConnected) {
      setCapabilityPanel({
        title: locale === "zh" ? "浏览器" : "Browser",
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    setCapabilityPanel({
      title: locale === "zh" ? "浏览器" : "Browser",
      subtitle: locale === "zh" ? "应用连接器" : "App connectors",
      body: locale === "zh" ? "正在读取应用..." : "Reading apps...",
    });

    try {
      let response;
      try {
        response = await clientRef.current?.listApps(
          isDemoPreview ? undefined : (selectedThreadId ?? undefined),
        );
      } catch (threadScopedError) {
        if (
          !(threadScopedError instanceof Error) ||
          !threadScopedError.message.includes("thread not found")
        ) {
          throw threadScopedError;
        }
        response = await clientRef.current?.listApps();
      }

      const apps = response?.data ?? [];
      const enabledCount = apps.filter((app) => app.isEnabled).length;
      const accessibleCount = apps.filter((app) => app.isAccessible).length;
      setCapabilityPanel({
        title: locale === "zh" ? "浏览器" : "Browser",
        subtitle:
          locale === "zh"
            ? `${apps.length} 应用 · ${enabledCount} 启用 · ${accessibleCount} 可访问`
            : `${apps.length} apps · ${enabledCount} enabled · ${accessibleCount} accessible`,
        body: browserAppsSettingsText(response ?? null, locale),
        actions: [
          {
            id: "refresh-browser-apps",
            label: locale === "zh" ? "刷新应用" : "Refresh apps",
          },
        ],
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "浏览器" : "Browser",
        subtitle: locale === "zh" ? "应用连接器" : "App connectors",
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取应用失败"
              : "Unable to read apps",
      });
    }
  }

  async function refreshEnvironmentSettingsPanel() {
    if (!isConnected) {
      setCapabilityPanel({
        title: locale === "zh" ? "环境" : "Environment",
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    const environmentCwd = await resolveBackendCwd();
    setCapabilityPanel({
      title: locale === "zh" ? "环境" : "Environment",
      subtitle:
        environmentCwd || (locale === "zh" ? "全局环境" : "Global environment"),
      body: locale === "zh" ? "正在读取环境能力..." : "Reading environment capabilities...",
    });

    const [requirementsResult, readinessResult] = await Promise.allSettled([
      clientRef.current?.readConfigRequirements(),
      clientRef.current?.readWindowsSandboxReadiness(),
    ]);
    const requirements =
      requirementsResult.status === "fulfilled"
        ? (requirementsResult.value ?? null)
        : null;
    const readiness =
      readinessResult.status === "fulfilled"
        ? (readinessResult.value?.status ?? null)
        : null;
    const readinessError =
      readinessResult.status === "rejected" && readinessResult.reason instanceof Error
        ? readinessResult.reason.message
        : null;
    const allowedWindowsSandbox =
      requirements?.requirements?.allowedWindowsSandboxImplementations ?? [];
    const actions = [
      {
        id: "refresh-environment",
        label: locale === "zh" ? "刷新环境" : "Refresh environment",
      },
      ...allowedWindowsSandbox.map((mode) => ({
        id: `setup-windows-sandbox-${mode}`,
        label:
          locale === "zh"
            ? `配置 Windows 沙箱：${mode}`
            : `Set up Windows sandbox: ${mode}`,
      })),
    ];

    setCapabilityPanel({
      title: locale === "zh" ? "环境" : "Environment",
      subtitle:
        environmentCwd || (locale === "zh" ? "全局环境" : "Global environment"),
      body: environmentSettingsText(
        requirements,
        readiness,
        readinessError,
        locale,
      ),
      actions,
      error:
        requirementsResult.status === "rejected" &&
        requirementsResult.reason instanceof Error
          ? requirementsResult.reason.message
          : undefined,
    });
  }

  async function refreshComputerControlSettingsPanel() {
    if (!isConnected) {
      setCapabilityPanel({
        title: locale === "zh" ? "电脑操控" : "Computer control",
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    setCapabilityPanel({
      title: locale === "zh" ? "电脑操控" : "Computer control",
      subtitle: locale === "zh" ? "远程控制与配对设备" : "Remote control and paired clients",
      body: locale === "zh" ? "正在读取电脑操控状态..." : "Reading computer control status...",
    });

    try {
      const status = (await clientRef.current?.readRemoteControlStatus()) ?? null;
      let clients: RemoteControlClient[] = [];
      let clientError: string | null = null;
      if (status?.environmentId) {
        try {
          const clientsResponse = await clientRef.current?.listRemoteControlClients(
            status.environmentId,
          );
          clients = clientsResponse?.data ?? [];
        } catch (error) {
          clientError =
            error instanceof Error
              ? error.message
              : locale === "zh"
                ? "读取配对设备失败"
                : "Unable to read paired clients";
        }
      }

      setCapabilityPanel({
        title: locale === "zh" ? "电脑操控" : "Computer control",
        subtitle:
          locale === "zh"
            ? `${status?.status ?? "unknown"} · ${clients.length} 设备`
            : `${status?.status ?? "unknown"} · ${clients.length} clients`,
        body: remoteControlSettingsText(status, clients, clientError, locale),
        fields:
          status?.environmentId && clients.length > 0
            ? [
                {
                  id: "remote-control-revoke-client",
                  label: locale === "zh" ? "撤销设备 ID" : "Client ID to revoke",
                  value: clients[0]?.clientId ?? "",
                },
              ]
            : undefined,
        actions: [
          {
            id: "refresh-computer-control",
            label: locale === "zh" ? "刷新电脑操控" : "Refresh computer control",
          },
          {
            id:
              status?.status === "connected" || status?.status === "connecting"
                ? "disable-remote-control"
                : "enable-remote-control",
            label:
              status?.status === "connected" || status?.status === "connecting"
                ? locale === "zh"
                  ? "停用远程控制"
                  : "Disable remote control"
                : locale === "zh"
                  ? "启用远程控制"
                  : "Enable remote control",
            tone:
              status?.status === "connected" || status?.status === "connecting"
                ? "danger"
                : "primary",
          },
          {
            id: "start-remote-pairing",
            label: locale === "zh" ? "开始配对" : "Start pairing",
          },
          ...(status?.environmentId && clients.length > 0
            ? [
                {
                  id: "revoke-remote-client",
                  label: locale === "zh" ? "撤销设备" : "Revoke client",
                  tone: "danger" as const,
                },
              ]
            : []),
        ],
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "电脑操控" : "Computer control",
        subtitle: locale === "zh" ? "远程控制与配对设备" : "Remote control and paired clients",
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取电脑操控失败"
              : "Unable to read computer control",
      });
    }
  }

  async function refreshAppSnapshotsSettingsPanel() {
    if (!isConnected) {
      setCapabilityPanel({
        title: locale === "zh" ? "应用快照" : "App snapshots",
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    setCapabilityPanel({
      title: locale === "zh" ? "应用快照" : "App snapshots",
      subtitle: locale === "zh" ? "策略与状态" : "Policy and status",
      body:
        locale === "zh"
          ? "正在读取应用快照策略..."
          : "Reading app snapshot policy...",
    });

    try {
      const requirements = (await clientRef.current?.readConfigRequirements()) ?? null;
      const allowed = requirements?.requirements?.allowAppshots;
      setCapabilityPanel({
        title: locale === "zh" ? "应用快照" : "App snapshots",
        subtitle:
          allowed === null || allowed === undefined
            ? locale === "zh"
              ? "策略未限制"
              : "Policy unrestricted"
            : allowed
              ? locale === "zh"
                ? "策略允许"
                : "Policy allowed"
              : locale === "zh"
                ? "策略禁用"
                : "Policy disabled",
        body: appSnapshotsSettingsText(requirements, locale),
        actions: [
          {
            id: "refresh-app-snapshots",
            label: locale === "zh" ? "刷新应用快照" : "Refresh app snapshots",
          },
        ],
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "应用快照" : "App snapshots",
        subtitle: locale === "zh" ? "策略与状态" : "Policy and status",
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取应用快照策略失败"
              : "Unable to read app snapshot policy",
      });
    }
  }

  async function refreshConnectionsSettingsPanel() {
    if (!isConnected) {
      setCapabilityPanel({
        title: locale === "zh" ? "连接" : "Connections",
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    const connectionsCwd = await resolveBackendCwd();
    setCapabilityPanel({
      title: locale === "zh" ? "连接" : "Connections",
      subtitle:
        connectionsCwd || (locale === "zh" ? "全局连接" : "Global connections"),
      body: locale === "zh" ? "正在读取连接状态..." : "Reading connection status...",
    });

    const client = clientRef.current;
    if (!client) {
      setCapabilityPanel({
        title: locale === "zh" ? "连接" : "Connections",
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    let appsPromise = client.listApps(
      isDemoPreview ? undefined : (selectedThreadId ?? undefined),
    );
    if (!isDemoPreview && selectedThreadId) {
      appsPromise = appsPromise.catch((error) => {
        if (error instanceof Error && error.message.includes("thread not found")) {
          return client.listApps();
        }
        throw error;
      });
    }

    const [
      accountResult,
      authResult,
      providerResult,
      requirementsResult,
      pluginsResult,
      appsResult,
    ] = await Promise.allSettled([
      client.getAccount(),
      client.getAuthStatus(),
      client.getModelProviderCapabilities(),
      client.readConfigRequirements(),
      client.listPlugins(connectionsCwd),
      appsPromise,
    ]);
    const errors = [
      accountResult.status === "rejected" ? accountResult.reason : null,
      authResult.status === "rejected" ? authResult.reason : null,
      providerResult.status === "rejected" ? providerResult.reason : null,
      requirementsResult.status === "rejected" ? requirementsResult.reason : null,
      pluginsResult.status === "rejected" ? pluginsResult.reason : null,
      appsResult.status === "rejected" ? appsResult.reason : null,
    ]
      .filter((error): error is Error => error instanceof Error)
      .map((error) => error.message);
    const account =
      accountResult.status === "fulfilled" ? (accountResult.value ?? null) : null;
    const auth =
      authResult.status === "fulfilled" ? (authResult.value ?? null) : null;
    const provider =
      providerResult.status === "fulfilled"
        ? (providerResult.value ?? null)
        : null;
    const requirements =
      requirementsResult.status === "fulfilled"
        ? (requirementsResult.value ?? null)
        : null;
    const plugins =
      pluginsResult.status === "fulfilled" ? (pluginsResult.value ?? null) : null;
    const apps =
      appsResult.status === "fulfilled" ? (appsResult.value ?? null) : null;

    setCapabilityPanel({
      title: locale === "zh" ? "连接" : "Connections",
      subtitle:
        locale === "zh"
          ? `${apps?.data.length ?? 0} 应用 · ${(plugins?.marketplaces ?? []).length} 市场 · ${auth?.authMethod ?? "unknown"}`
          : `${apps?.data.length ?? 0} apps · ${(plugins?.marketplaces ?? []).length} marketplaces · ${auth?.authMethod ?? "unknown"}`,
      body: connectionsSettingsText(
        account,
        auth,
        provider,
        requirements,
        plugins,
        apps,
        errors,
        locale,
      ),
      actions: [
        {
          id: "refresh-connections",
          label: locale === "zh" ? "刷新连接" : "Refresh connections",
        },
      ],
      error: errors.length > 0 ? errors[0] : undefined,
    });
  }

  async function refreshGitSettingsPanel() {
    if (!isConnected) {
      setCapabilityPanel({
        title: "Git",
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    const gitCwd = await resolveBackendCwd();
    if (!gitCwd) {
      setCapabilityPanel({
        title: "Git",
        subtitle: locale === "zh" ? "未选择工作区" : "No workspace selected",
        error:
          locale === "zh"
            ? "当前没有工作区路径，无法读取 Git 状态。"
            : "No workspace path is available for reading Git status.",
      });
      return;
    }

    setCapabilityPanel({
      title: "Git",
      subtitle: gitCwd,
      body: locale === "zh" ? "正在读取 Git 状态..." : "Reading Git status...",
    });

    const [diffResult, configResult] = await Promise.allSettled([
      clientRef.current?.getGitDiffToRemote(gitCwd),
      clientRef.current?.readConfig(gitCwd),
    ]);
    const remoteDiff =
      diffResult.status === "fulfilled" && diffResult.value
        ? summarizeRemoteDiff(diffResult.value.diff, diffResult.value.sha)
        : diffResult.status === "rejected"
          ? {
              status: "error" as const,
              added: 0,
              removed: 0,
              files: 0,
              error:
                diffResult.reason instanceof Error
                  ? diffResult.reason.message
                  : locale === "zh"
                    ? "读取远端差异失败"
                    : "Unable to read remote diff",
            }
          : null;
    const configRead =
      configResult.status === "fulfilled" ? (configResult.value ?? null) : null;
    setCapabilityPanel({
      title: "Git",
      subtitle:
        remoteDiff?.status === "ready"
          ? `${gitCwd} · +${remoteDiff.added} -${remoteDiff.removed}`
          : gitCwd,
      body: gitSettingsText(
        gitCwd,
        selectedThread,
        conversationSummary,
        remoteDiff,
        configRead,
        locale,
      ),
      actions: [
        {
          id: "refresh-git",
          label: locale === "zh" ? "刷新 Git" : "Refresh Git",
        },
      ],
      error:
        configResult.status === "rejected" &&
        configResult.reason instanceof Error
          ? configResult.reason.message
      : undefined,
    });
  }

  async function refreshWorktreesSettingsPanel() {
    if (!isConnected) {
      setCapabilityPanel({
        title: locale === "zh" ? "工作树" : "Worktrees",
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    const worktreeCwd = await resolveBackendCwd();
    if (!worktreeCwd) {
      setCapabilityPanel({
        title: locale === "zh" ? "工作树" : "Worktrees",
        subtitle: locale === "zh" ? "未选择工作区" : "No workspace selected",
        error:
          locale === "zh"
            ? "当前没有工作区路径，无法创建工作树会话。"
            : "No workspace path is available for creating worktree sessions.",
      });
      return;
    }

    setCapabilityPanel({
      title: locale === "zh" ? "工作树" : "Worktrees",
      subtitle: worktreeCwd,
      body: locale === "zh" ? "正在读取工作区会话..." : "Reading workspace sessions...",
    });

    const [threadResult, diffResult] = await Promise.allSettled([
      clientRef.current?.listThreads(false),
      clientRef.current?.getGitDiffToRemote(worktreeCwd),
    ]);
    const backendThreads =
      threadResult.status === "fulfilled" ? (threadResult.value ?? []) : threads;
    const relatedThreads = backendThreads
      .filter((candidate) => candidate.cwd === worktreeCwd)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const remoteDiff =
      diffResult.status === "fulfilled" && diffResult.value
        ? summarizeRemoteDiff(diffResult.value.diff, diffResult.value.sha)
        : diffResult.status === "rejected"
          ? {
              status: "error" as const,
              added: 0,
              removed: 0,
              files: 0,
              error:
                diffResult.reason instanceof Error
                  ? diffResult.reason.message
                  : locale === "zh"
                    ? "读取远端差异失败"
                    : "Unable to read remote diff",
            }
          : null;

    if (threadResult.status === "fulfilled" && threadResult.value) {
      const refreshedThreads = threadResult.value;
      setThreads((current) =>
        refreshedThreads.reduce(
          (nextThreads, thread) => upsertThread(nextThreads, thread),
          current,
        ),
      );
    }

    setCapabilityPanel({
      title: locale === "zh" ? "工作树" : "Worktrees",
      subtitle:
        locale === "zh"
          ? `${relatedThreads.length} 个会话 · ${worktreeCwd}`
          : `${relatedThreads.length} sessions · ${worktreeCwd}`,
      body: worktreesSettingsText(
        worktreeCwd,
        selectedThread,
        relatedThreads,
        conversationSummary,
        remoteDiff,
        locale,
      ),
      actions: [
        {
          id: "create-worktree-session",
          label: locale === "zh" ? "新建会话" : "New session",
          tone: "primary",
        },
        {
          id: "fork-worktree",
          label: locale === "zh" ? "分叉当前会话" : "Fork current session",
        },
        {
          id: "refresh-worktrees",
          label: locale === "zh" ? "刷新工作树" : "Refresh worktrees",
        },
      ],
      error:
        threadResult.status === "rejected" && threadResult.reason instanceof Error
          ? threadResult.reason.message
          : undefined,
    });
  }

  async function refreshIntegrationsPanel() {
    if (!isConnected) {
      setCapabilityPanel({
        title: locale === "zh" ? "集成" : "Integrations",
        subtitle: t.connectionHints[connectionState],
        error:
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
      });
      return;
    }

    setCapabilityPanel({
      title: locale === "zh" ? "集成" : "Integrations",
      subtitle: locale === "zh" ? "应用与 Hook" : "Apps and hooks",
      body: locale === "zh" ? "正在读取集成..." : "Reading integrations...",
    });

    try {
      const client = clientRef.current;
      if (!client) {
        throw new Error(
          locale === "zh"
            ? "未连接本地 app-server"
            : "Local app-server is not connected",
        );
      }

      let appsPromise = client.listApps(
        isDemoPreview ? undefined : (selectedThreadId ?? undefined),
      );
      const integrationsCwd = await resolveBackendCwd();
      const hooksPromise = client.listHooks(integrationsCwd);

      if (!isDemoPreview && selectedThreadId) {
        appsPromise = appsPromise?.catch((error) => {
          if (
            error instanceof Error &&
            error.message.includes("thread not found")
          ) {
            return client.listApps();
          }
          throw error;
        });
      }

      const [appsResult, hooksResult] = await Promise.allSettled([
        appsPromise,
        hooksPromise,
      ]);
      const apps =
        appsResult.status === "fulfilled" ? (appsResult.value?.data ?? []) : [];
      const hooks =
        hooksResult.status === "fulfilled"
          ? (hooksResult.value?.data ?? []).flatMap((entry) => entry.hooks)
          : [];
      const errors = [
        appsResult.status === "rejected" ? appsResult.reason : null,
        hooksResult.status === "rejected" ? hooksResult.reason : null,
      ]
        .filter((error): error is Error => error instanceof Error)
        .map((error) => error.message);

      const appLines = apps.slice(0, 12).map((app) => {
        const access = app.isAccessible
          ? locale === "zh"
            ? "可访问"
            : "accessible"
          : locale === "zh"
            ? "需授权"
            : "needs auth";
        const enabled = app.isEnabled
          ? locale === "zh"
            ? "启用"
            : "enabled"
          : locale === "zh"
            ? "停用"
            : "disabled";
        return `- ${app.name}: ${access} · ${enabled}`;
      });
      const hookLines = hooks
        .slice(0, 12)
        .map(
          (hook) =>
            `- ${hook.eventName}: ${hook.handlerType} · ${hook.enabled ? "enabled" : "disabled"}`,
        );

      setCapabilityPanel({
        title: locale === "zh" ? "集成" : "Integrations",
        subtitle:
          locale === "zh"
            ? `${apps.length} 应用 · ${hooks.length} Hook`
            : `${apps.length} apps · ${hooks.length} hooks`,
        body: [
          locale === "zh" ? "应用" : "Apps",
          appLines.length > 0
            ? appLines.join("\n")
            : locale === "zh"
              ? "暂无应用"
              : "No apps",
          "Hooks",
          hookLines.length > 0
            ? hookLines.join("\n")
            : locale === "zh"
              ? "暂无 Hook"
              : "No hooks",
          errors.length > 0
            ? `${locale === "zh" ? "部分集成读取失败" : "Some integration reads failed"}\n${errors.join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        actions: [
          {
            id: "refresh-integrations",
            label: locale === "zh" ? "刷新集成" : "Refresh integrations",
          },
        ],
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "集成" : "Integrations",
        subtitle: locale === "zh" ? "应用与 Hook" : "Apps and hooks",
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取集成失败"
              : "Unable to read integrations",
      });
    }
  }

  async function refreshAccountPanel() {
    if (!isConnected) {
      setCapabilityPanel({
        title: locale === "zh" ? "常规" : "General",
        subtitle:
          locale === "zh"
            ? "认证、模型、权限与用量"
            : "Auth, models, permissions, and usage",
        body:
          connectionState === "connecting"
            ? locale === "zh"
              ? "正在连接本地 app-server..."
              : "Connecting to local app-server..."
            : t.connectionHints[connectionState],
      });
      return;
    }

    setCapabilityPanel({
      title: locale === "zh" ? "常规" : "General",
      subtitle: locale === "zh" ? "认证状态" : "Auth status",
      body: locale === "zh" ? "正在读取..." : "Loading...",
    });

    try {
      const [
        accountResult,
        authStatusResult,
        rateLimitsResult,
        usageResult,
        modelsResult,
        permissionProfilesResult,
        providerCapabilitiesResult,
      ] = await Promise.allSettled([
        clientRef.current?.getAccount(),
        clientRef.current?.getAuthStatus(),
        clientRef.current?.getAccountRateLimits(),
        clientRef.current?.getAccountUsage(),
        clientRef.current?.listModels(),
        clientRef.current?.listPermissionProfiles(await resolveBackendCwd()),
        clientRef.current?.getModelProviderCapabilities(),
      ]);
      const account =
        accountResult.status === "fulfilled"
          ? (accountResult.value ?? null)
          : null;
      const authStatus =
        authStatusResult.status === "fulfilled"
          ? (authStatusResult.value ?? null)
          : null;
      const rateLimits =
        rateLimitsResult.status === "fulfilled"
          ? (rateLimitsResult.value ?? null)
          : null;
      const usage =
        usageResult.status === "fulfilled" ? (usageResult.value ?? null) : null;
      const models =
        modelsResult.status === "fulfilled"
          ? (modelsResult.value ?? null)
          : null;
      const permissionProfiles =
        permissionProfilesResult.status === "fulfilled"
          ? (permissionProfilesResult.value ?? null)
          : null;
      const providerCapabilities =
        providerCapabilitiesResult.status === "fulfilled"
          ? (providerCapabilitiesResult.value ?? null)
          : null;
      const errors = [
        accountResult.status === "rejected" ? accountResult.reason : null,
        authStatusResult.status === "rejected" ? authStatusResult.reason : null,
        rateLimitsResult.status === "rejected" ? rateLimitsResult.reason : null,
        usageResult.status === "rejected" ? usageResult.reason : null,
        modelsResult.status === "rejected" ? modelsResult.reason : null,
        permissionProfilesResult.status === "rejected"
          ? permissionProfilesResult.reason
          : null,
        providerCapabilitiesResult.status === "rejected"
          ? providerCapabilitiesResult.reason
          : null,
      ]
        .filter((error): error is Error => error instanceof Error)
        .map((error) => error.message);

      if (account) {
        setAccountStatus(account);
      }
      const telemetry = accountTelemetryText(rateLimits, usage, locale);
      const capabilities = workspaceCapabilitiesText(
        models,
        permissionProfiles,
        providerCapabilities,
        locale,
      );
      setCapabilityPanel({
        title: locale === "zh" ? "常规" : "General",
        subtitle:
          locale === "zh"
            ? "认证、模型、权限与用量"
            : "Auth, models, permissions, and usage",
        body: [
          accountStatusText(account ?? accountStatus, locale),
          authStatusText(authStatus, locale),
          capabilities,
          telemetry,
          errors.length > 0
            ? `${locale === "zh" ? "部分能力读取失败" : "Some reads failed"}\n${errors.join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        actions: [
          {
            id: "login-chatgpt",
            label: locale === "zh" ? "模型账号登录" : "Model login",
            tone: "primary",
          },
          {
            id: "login-device-code",
            label: locale === "zh" ? "设备码登录" : "Device code",
          },
          {
            id: "logout-account",
            label: locale === "zh" ? "退出登录" : "Logout",
            tone: "danger",
          },
          {
            id: "refresh-account",
            label: locale === "zh" ? "刷新" : "Refresh",
          },
        ],
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "常规" : "General",
        subtitle: locale === "zh" ? "认证状态" : "Auth status",
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取账号失败"
              : "Unable to read account",
      });
    }
  }

  async function openThreadSettingsPanel() {
    const hasBackendThread =
      selectedThreadId && !(isDemoPreview && isDemoThreadId(selectedThreadId));
    if (!hasBackendThread && !isDemoPreview) {
      setCapabilityDockOpen(true);
      setCapabilityPanel({
        title: locale === "zh" ? "会话设置" : "Session settings",
        subtitle: locale === "zh" ? "目标" : "Goal",
        error: locale === "zh" ? "请先选择一个会话" : "Select a session first",
      });
      return;
    }

    setCapabilityDockOpen(true);
    setCapabilityPanel({
      title: locale === "zh" ? "会话设置" : "Session settings",
      subtitle: locale === "zh" ? "目标" : "Goal",
      body: threadGoal
        ? `${locale === "zh" ? "当前状态" : "Current status"}: ${threadGoal.status}\n${locale === "zh" ? "已用 tokens" : "Tokens used"}: ${threadGoal.tokensUsed}`
        : isDemoPreview && !hasBackendThread
          ? locale === "zh"
            ? "保存后会创建真实后端会话并绑定目标"
            : "Saving creates a real backend session and binds the goal"
          : locale === "zh"
            ? "当前未设置目标"
            : "No goal is currently set",
      fields: [
        {
          id: "thread-goal-objective",
          label: locale === "zh" ? "目标" : "Goal",
          placeholder:
            locale === "zh"
              ? "描述这个会话要持续完成的目标"
              : "Describe the ongoing goal for this session",
          value: threadGoal?.objective ?? "",
        },
        {
          id: "thread-goal-token-budget",
          label: locale === "zh" ? "Token 预算" : "Token budget",
          placeholder:
            locale === "zh"
              ? "可选，留空表示不限制"
              : "Optional, leave blank for no budget",
          value: threadGoal?.tokenBudget ? String(threadGoal.tokenBudget) : "",
        },
        {
          id: "thread-settings-model",
          label: locale === "zh" ? "会话模型" : "Session model",
          placeholder:
            locale === "zh" ? "留空表示沿用默认配置" : "Leave empty to use defaults",
          value: "",
          options: [
            {
              label: locale === "zh" ? "沿用默认" : "Use default",
              value: "",
            },
          ],
        },
        {
          id: "thread-settings-approval-policy",
          label: locale === "zh" ? "会话审批" : "Session approval",
          placeholder:
            locale === "zh" ? "留空表示沿用默认配置" : "Leave empty to use defaults",
          value: "",
          options: [
            {
              label: locale === "zh" ? "沿用默认" : "Use default",
              value: "",
            },
          ],
        },
        {
          id: "thread-settings-sandbox-mode",
          label: locale === "zh" ? "会话沙箱" : "Session sandbox",
          placeholder:
            locale === "zh" ? "留空表示沿用默认配置" : "Leave empty to use defaults",
          value: "",
          options: [
            {
              label: locale === "zh" ? "沿用默认" : "Use default",
              value: "",
            },
          ],
        },
      ],
      actions: [
        {
          id: "save-thread-goal",
          label: locale === "zh" ? "保存目标" : "Save goal",
          tone: "primary",
        },
        {
          id: "clear-thread-goal",
          label: locale === "zh" ? "清除目标" : "Clear goal",
          tone: "danger",
        },
        {
          id: "save-thread-settings",
          label: locale === "zh" ? "保存会话设置" : "Save session settings",
        },
        {
          id: "refresh-thread-history",
          label: locale === "zh" ? "刷新历史" : "Refresh history",
        },
        {
          id: "compact-thread",
          label: locale === "zh" ? "压缩上下文" : "Compact context",
        },
        {
          id: "enable-thread-memory",
          label: locale === "zh" ? "启用记忆" : "Enable memory",
        },
        {
          id: "disable-thread-memory",
          label: locale === "zh" ? "禁用记忆" : "Disable memory",
        },
        {
          id: "rollback-thread",
          label: locale === "zh" ? "回滚上一轮" : "Rollback last turn",
          tone: "danger",
        },
      ],
    });

    if (!isConnected || !hasBackendThread) {
      return;
    }

    const settingsCwd = cwd || (await resolveBackendCwd());
    const [configResult, requirementsResult, modelsResult] =
      await Promise.allSettled([
        clientRef.current?.readConfig(settingsCwd),
        clientRef.current?.readConfigRequirements(),
        clientRef.current?.listModels(),
      ]);
    const configRead =
      configResult.status === "fulfilled" ? (configResult.value ?? null) : null;
    const requirements =
      requirementsResult.status === "fulfilled"
        ? (requirementsResult.value ?? null)
        : null;
    const models =
      modelsResult.status === "fulfilled" ? (modelsResult.value ?? null) : null;
    const defaultOption = {
      label: locale === "zh" ? "沿用默认" : "Use default",
      value: "",
    };
    const modelOptions = [
      defaultOption,
      ...(models?.data ?? []).map((model) => ({
        label: model.displayName || model.model || model.id,
        value: model.model,
      })),
    ].filter(
      (option, index, options) =>
        options.findIndex((candidate) => candidate.value === option.value) === index,
    );
    const approvalOptions = [
      defaultOption,
      ...(requirements?.requirements?.allowedApprovalPolicies ?? [
        "untrusted",
        "on-failure",
        "on-request",
        "never",
      ])
        .flatMap((policy) => (typeof policy === "string" ? [policy] : []))
        .map((policy) => ({ label: policy, value: policy })),
    ].filter(
      (option, index, options) =>
        options.findIndex((candidate) => candidate.value === option.value) === index,
    );
    const sandboxOptions = [
      defaultOption,
      ...(requirements?.requirements?.allowedSandboxModes ?? [
        "read-only",
        "workspace-write",
        "danger-full-access",
      ]).map((mode) => ({ label: mode, value: mode })),
    ].filter(
      (option, index, options) =>
        options.findIndex((candidate) => candidate.value === option.value) === index,
    );
    const currentModel =
      typeof configRead?.config.model === "string" ? configRead.config.model : "";
    const currentApproval =
      typeof configRead?.config.approval_policy === "string"
        ? configRead.config.approval_policy
        : "";
    const currentSandbox =
      typeof configRead?.config.sandbox_mode === "string"
        ? configRead.config.sandbox_mode
        : "";

    setCapabilityPanel((currentPanel) =>
      currentPanel?.title === (locale === "zh" ? "会话设置" : "Session settings")
        ? {
            ...currentPanel,
            body: [
              currentPanel.body,
              locale === "zh"
                ? "会话设置只影响当前会话的后续任务。"
                : "Session settings affect only future turns in this session.",
            ]
              .filter(Boolean)
              .join("\n"),
            fields: currentPanel.fields?.map((field) => {
              if (field.id === "thread-settings-model") {
                return {
                  ...field,
                  placeholder: currentModel || field.placeholder,
                  options: modelOptions,
                };
              }
              if (field.id === "thread-settings-approval-policy") {
                return {
                  ...field,
                  placeholder: currentApproval || field.placeholder,
                  options: approvalOptions,
                };
              }
              if (field.id === "thread-settings-sandbox-mode") {
                return {
                  ...field,
                  placeholder: currentSandbox || field.placeholder,
                  options: sandboxOptions,
                };
              }
              return field;
            }),
          }
        : currentPanel,
    );
  }

  function handleCapabilityPanelAction(actionId: string) {
    if (isDemo) {
      if (actionId === "refresh-account") {
        setCapabilityPanel(demoSettingsPanel("account", locale));
        return;
      }
      if (actionId === "refresh-config") {
        setCapabilityPanel(demoSettingsPanel("config", locale));
        return;
      }
      if (actionId === "save-config") {
        setCapabilityPanel({
          ...demoSettingsPanel("config", locale),
          subtitle: locale === "zh" ? "已保存（演示）" : "Saved (demo)",
          body:
            locale === "zh"
              ? "配置已保存到演示状态。连接本地 app-server 后会写入 config.toml 并热重载用户配置。"
              : "Config saved to demo state. With app-server connected, this writes config.toml and hot-reloads user config.",
        });
        return;
      }
      if (
        actionId === "refresh-appearance" ||
        actionId === "save-appearance"
      ) {
        setCapabilityPanel({
          ...demoSettingsPanel("appearance", locale),
          subtitle:
            actionId === "save-appearance"
              ? locale === "zh"
                ? "已保存（演示）"
                : "Saved (demo)"
              : locale === "zh"
                ? "已刷新（演示）"
                : "Refreshed (demo)",
        });
        return;
      }
      if (
        actionId === "refresh-personalization" ||
        actionId === "save-personalization"
      ) {
        setCapabilityPanel({
          ...demoSettingsPanel("personalization", locale),
          subtitle:
            actionId === "save-personalization"
              ? locale === "zh"
                ? "已保存（演示）"
                : "Saved (demo)"
              : locale === "zh"
                ? "已刷新（演示）"
                : "Refreshed (demo)",
        });
        return;
      }
      if (actionId === "refresh-keyboard") {
        setCapabilityPanel(demoSettingsPanel("keyboard", locale));
        return;
      }
      if (actionId === "save-thread-settings") {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "会话设置已保存（演示）。连接 app-server 后会调用 thread/settings/update。"
                    : "Session settings saved (demo). With app-server connected this calls thread/settings/update.",
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }
      if (actionId === "refresh-integrations") {
        setCapabilityPanel(demoSettingsPanel("mcp-servers", locale));
        return;
      }
      if (actionId === "refresh-mcp-settings" || actionId === "reload-tools") {
        setCapabilityPanel(demoSettingsPanel("mcp-servers", locale));
        return;
      }
      if (actionId === "refresh-browser-apps") {
        setCapabilityPanel(demoSettingsPanel("browser", locale));
        return;
      }
      if (
        actionId === "refresh-environment" ||
        actionId.startsWith("setup-windows-sandbox-")
      ) {
        setCapabilityPanel(demoSettingsPanel("environment", locale));
        return;
      }
      if (
        actionId === "refresh-computer-control" ||
        actionId === "enable-remote-control" ||
        actionId === "disable-remote-control" ||
        actionId === "start-remote-pairing" ||
        actionId === "revoke-remote-client"
      ) {
        setCapabilityPanel(demoSettingsPanel("computer-control", locale));
        return;
      }
      if (actionId === "refresh-app-snapshots") {
        setCapabilityPanel(demoSettingsPanel("app-snapshots", locale));
        return;
      }
      if (actionId === "refresh-connections") {
        setCapabilityPanel(demoSettingsPanel("connections", locale));
        return;
      }
      if (actionId === "refresh-git") {
        setCapabilityPanel(demoSettingsPanel("git", locale));
        return;
      }
      if (
        actionId === "refresh-worktrees" ||
        actionId === "create-worktree-session" ||
        actionId === "fork-worktree"
      ) {
        setCapabilityPanel({
          ...demoSettingsPanel("worktrees", locale),
          subtitle:
            actionId === "refresh-worktrees"
              ? locale === "zh"
                ? "已刷新（演示）"
                : "Refreshed (demo)"
              : actionId === "fork-worktree"
                ? locale === "zh"
                  ? "已分叉（演示）"
                  : "Forked (demo)"
                : locale === "zh"
                  ? "已新建（演示）"
                  : "Created (demo)",
        });
        return;
      }
      if (actionId === "refresh-hooks") {
        setCapabilityPanel(demoSettingsPanel("hooks", locale));
        return;
      }
      if (actionId === "refresh-connectors") {
        setCapabilityPanel(demoCapabilityPanel("web", locale));
        return;
      }
      if (
        actionId === "login-chatgpt" ||
        actionId === "login-device-code" ||
        actionId === "logout-account"
      ) {
        setCapabilityPanel({
          title: locale === "zh" ? "常规" : "General",
          subtitle: locale === "zh" ? "演示模式" : "Demo mode",
          body:
            locale === "zh"
              ? "演示模式下不会发起真实登录。启动本地 app-server 后，这里会打开模型账号或设备码登录流程。"
              : "Demo mode does not start a real login. Connect the local app-server to open model-account or device-code login here.",
          actions: [
            {
              id: "refresh-account",
              label: locale === "zh" ? "返回常规" : "Back to General",
            },
          ],
        });
        return;
      }
    }

    if (actionId === "refresh-connectors") {
      void loadBrowserApps();
      return;
    }

    if (actionId.startsWith("open-plugin-path:")) {
      const payload = decodeCapabilityActionPayload<{ path: string }>(
        actionId.slice("open-plugin-path:".length),
      );
      if (!payload?.path) {
        return;
      }
      void handleCapabilityPanelItem({
        label: pathBaseName(payload.path),
        path: payload.path,
        kind: "directory",
      });
      return;
    }

    if (actionId.startsWith("install-plugin:")) {
      const payload = decodeCapabilityActionPayload<{
        marketplacePath?: string | null;
        pluginName: string;
        remoteMarketplaceName?: string | null;
      }>(actionId.slice("install-plugin:".length));
      if (!payload?.pluginName) {
        return;
      }
      setCapabilityPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              body:
                locale === "zh"
                  ? `正在安装插件：${payload.pluginName}`
                  : `Installing plugin: ${payload.pluginName}`,
              error: undefined,
            }
          : currentPanel,
      );
      void clientRef.current
        ?.installPlugin(
          payload.pluginName,
          payload.marketplacePath ?? null,
          payload.remoteMarketplaceName ?? null,
        )
        .then((response) => {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  body: [
                    locale === "zh" ? "插件已安装" : "Plugin installed",
                    response
                      ? `${locale === "zh" ? "授权策略" : "Auth policy"}: ${response.authPolicy}`
                      : null,
                    response
                      ? `${locale === "zh" ? "需要授权的应用" : "Apps needing auth"}: ${response.appsNeedingAuth.length}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  error: undefined,
                }
              : currentPanel,
          );
          void loadBrowserApps();
        })
        .catch((error) => {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "安装插件失败"
                        : "Unable to install plugin",
                }
              : currentPanel,
          );
        });
      return;
    }

    if (actionId.startsWith("uninstall-plugin:")) {
      const payload = decodeCapabilityActionPayload<{ pluginId: string }>(
        actionId.slice("uninstall-plugin:".length),
      );
      if (!payload?.pluginId) {
        return;
      }
      setCapabilityPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              body:
                locale === "zh"
                  ? "正在卸载插件..."
                  : "Uninstalling plugin...",
              error: undefined,
            }
          : currentPanel,
      );
      void clientRef.current
        ?.uninstallPlugin(payload.pluginId)
        .then(() => {
          setNotice({
            text: locale === "zh" ? "插件已卸载" : "Plugin uninstalled",
            tone: "success",
          });
          void loadBrowserApps();
        })
        .catch((error) => {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "卸载插件失败"
                        : "Unable to uninstall plugin",
                }
              : currentPanel,
          );
        });
      return;
    }

    if (actionId === "refresh-config") {
      void refreshConfigPanel();
      return;
    }

    if (actionId === "refresh-appearance") {
      void refreshAppearanceSettingsPanel();
      return;
    }

    if (actionId === "refresh-personalization") {
      void refreshPersonalizationSettingsPanel();
      return;
    }

    if (actionId === "refresh-keyboard") {
      void refreshKeyboardSettingsPanel();
      return;
    }

    if (actionId === "save-config") {
      const fieldValue = (fieldId: string) =>
        capabilityPanel?.fields
          ?.find((field) => field.id === fieldId)
          ?.value.trim() ?? "";
      const edits = [
        { keyPath: "model", value: fieldValue("config-model") },
        {
          keyPath: "approval_policy",
          value: fieldValue("config-approval-policy"),
        },
        { keyPath: "sandbox_mode", value: fieldValue("config-sandbox-mode") },
      ].filter((edit) => edit.value);

      if (!isConnected || edits.length === 0) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  locale === "zh"
                    ? "没有可保存的配置项"
                    : "No config values to save",
              }
            : currentPanel,
        );
        return;
      }

      void (async () => {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body: locale === "zh" ? "正在保存配置..." : "Saving config...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          const response = await clientRef.current?.writeConfigBatch(edits);
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  subtitle: response?.filePath ?? currentPanel.subtitle,
                  body: `${locale === "zh" ? "配置已保存并热重载" : "Config saved and hot-reloaded"}\nversion: ${
                    response?.version ?? "-"
                  }\nstatus: ${response?.status ?? "ok"}`,
                  error: undefined,
                }
              : currentPanel,
          );
          await refreshConfigPanel();
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "保存配置失败"
                        : "Unable to save config",
                }
              : currentPanel,
          );
        }
      })();
      return;
    }

    if (actionId === "save-appearance") {
      const fieldValue = (fieldId: string) =>
        capabilityPanel?.fields
          ?.find((field) => field.id === fieldId)
          ?.value.trim() ?? "";
      const nextLocale = fieldValue("appearance-locale") as Locale;
      const nextTheme = fieldValue("appearance-theme") as Theme;
      const edits = [
        { keyPath: DESKTOP_LOCALE_KEY_PATH, value: nextLocale || locale },
        { keyPath: DESKTOP_THEME_KEY_PATH, value: nextTheme || theme },
      ];

      if (!isConnected) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  locale === "zh"
                    ? "未连接本地 app-server"
                    : "Local app-server is not connected",
              }
            : currentPanel,
        );
        return;
      }

      void (async () => {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "正在保存外观设置..."
                    : "Saving appearance settings...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          const response = await clientRef.current?.writeConfigBatch(edits);
          if (nextLocale === "zh" || nextLocale === "en") {
            setLocale(nextLocale);
            persistLocale(nextLocale);
          }
          if (nextTheme === "dark" || nextTheme === "light") {
            setTheme(nextTheme);
            persistTheme(nextTheme);
          }
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  subtitle: response?.filePath ?? currentPanel.subtitle,
                  body: `${locale === "zh" ? "外观设置已保存" : "Appearance saved"}\nversion: ${
                    response?.version ?? "-"
                  }\nstatus: ${response?.status ?? "ok"}`,
                  error: undefined,
                }
              : currentPanel,
          );
          await refreshAppearanceSettingsPanel();
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "保存外观设置失败"
                        : "Unable to save appearance settings",
                }
              : currentPanel,
          );
        }
      })();
      return;
    }

    if (actionId === "save-personalization") {
      const fieldValue = (fieldId: string) =>
        capabilityPanel?.fields
          ?.find((field) => field.id === fieldId)
          ?.value.trim() ?? "";
      const edits = [
        {
          keyPath: "instructions",
          value: fieldValue("personalization-instructions"),
        },
        {
          keyPath: "developer_instructions",
          value: fieldValue("personalization-developer-instructions"),
        },
      ];

      if (!isConnected) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  locale === "zh"
                    ? "未连接本地 app-server"
                    : "Local app-server is not connected",
              }
            : currentPanel,
        );
        return;
      }

      void (async () => {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "正在保存个性化设置..."
                    : "Saving personalization settings...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          const response = await clientRef.current?.writeConfigBatch(edits);
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  subtitle: response?.filePath ?? currentPanel.subtitle,
                  body: `${locale === "zh" ? "个性化设置已保存" : "Personalization saved"}\nversion: ${
                    response?.version ?? "-"
                  }\nstatus: ${response?.status ?? "ok"}`,
                  error: undefined,
                }
              : currentPanel,
          );
          await refreshPersonalizationSettingsPanel();
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "保存个性化设置失败"
                        : "Unable to save personalization settings",
                }
              : currentPanel,
          );
        }
      })();
      return;
    }

    if (actionId === "save-thread-settings") {
      const fieldValue = (fieldId: string) =>
        capabilityPanel?.fields
          ?.find((field) => field.id === fieldId)
          ?.value.trim() ?? "";
      const model = fieldValue("thread-settings-model");
      const approvalPolicy = fieldValue("thread-settings-approval-policy");
      const sandboxMode = fieldValue("thread-settings-sandbox-mode");
      const threadId =
        selectedThreadId && !isDemoThreadId(selectedThreadId)
          ? selectedThreadId
          : null;

      if (!model && !approvalPolicy && !sandboxMode) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  locale === "zh"
                    ? "没有可保存的会话设置"
                    : "No session settings selected",
              }
            : currentPanel,
        );
        return;
      }

      if (busyToolId || !isConnected || !threadId) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  locale === "zh"
                    ? "请先选择一个真实会话"
                    : "Select a real session first",
              }
            : currentPanel,
        );
        return;
      }

      void (async () => {
        setBusyToolId("sidechat");
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "正在保存会话设置..."
                    : "Saving session settings...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          await clientRef.current?.updateThreadSettings(threadId, {
            model,
            approvalPolicy,
            sandboxMode,
          });
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  body: [
                    locale === "zh"
                      ? "会话设置已保存，将作用于后续任务。"
                      : "Session settings saved for future turns.",
                    model
                      ? `${locale === "zh" ? "模型" : "Model"}: ${model}`
                      : null,
                    approvalPolicy
                      ? `${locale === "zh" ? "审批" : "Approval"}: ${approvalPolicy}`
                      : null,
                    sandboxMode
                      ? `${locale === "zh" ? "沙箱" : "Sandbox"}: ${sandboxMode}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  error: undefined,
                }
              : currentPanel,
          );
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "保存会话设置失败"
                        : "Unable to save session settings",
                }
              : currentPanel,
          );
        } finally {
          setBusyToolId(null);
        }
      })();
      return;
    }

    if (actionId === "refresh-thread-history") {
      if (isDemo) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "会话历史已刷新（演示）。连接 app-server 后会调用 thread/turns/list。"
                    : "Session history refreshed (demo). With app-server connected this calls thread/turns/list.",
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }

      const threadId =
        selectedThreadId && !isDemoThreadId(selectedThreadId)
          ? selectedThreadId
          : null;
      if (busyToolId || !isConnected || !threadId || !selectedThread) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  locale === "zh"
                    ? "请先选择一个真实会话"
                    : "Select a real session first",
              }
            : currentPanel,
        );
        return;
      }

      void (async () => {
        setBusyToolId("sidechat");
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "正在读取分页会话历史..."
                    : "Reading paged session history...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          const turns = await clientRef.current?.listThreadTurns(threadId);
          if (!turns) {
            return;
          }
          setThreads((current) =>
            current.map((thread) =>
              thread.id === threadId ? { ...thread, turns } : thread,
            ),
          );
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  body:
                    locale === "zh"
                      ? `已通过 thread/turns/list 刷新 ${turns.length} 轮历史。`
                      : `Refreshed ${turns.length} turns through thread/turns/list.`,
                  error: undefined,
                }
              : currentPanel,
          );
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "刷新会话历史失败"
                        : "Unable to refresh session history",
                }
              : currentPanel,
          );
        } finally {
          setBusyToolId(null);
        }
      })();
      return;
    }

    if (actionId === "refresh-integrations") {
      void refreshIntegrationsPanel();
      return;
    }

    if (actionId === "refresh-hooks") {
      void refreshHooksPanel();
      return;
    }

    if (actionId === "refresh-mcp-settings") {
      void refreshMcpSettingsPanel();
      return;
    }

    if (actionId === "refresh-browser-apps") {
      void refreshBrowserSettingsPanel();
      return;
    }

    if (actionId === "refresh-environment") {
      void refreshEnvironmentSettingsPanel();
      return;
    }

    if (actionId === "refresh-computer-control") {
      void refreshComputerControlSettingsPanel();
      return;
    }

    if (actionId === "refresh-app-snapshots") {
      void refreshAppSnapshotsSettingsPanel();
      return;
    }

    if (actionId === "refresh-connections") {
      void refreshConnectionsSettingsPanel();
      return;
    }

    if (actionId === "refresh-git") {
      void refreshGitSettingsPanel();
      return;
    }

    if (actionId === "refresh-worktrees") {
      void refreshWorktreesSettingsPanel();
      return;
    }

    if (actionId === "create-worktree-session" || actionId === "fork-worktree") {
      void (async () => {
        const title = locale === "zh" ? "工作树" : "Worktrees";
        try {
          const worktreeCwd = await resolveBackendCwd();
          if (!worktreeCwd) {
            throw new Error(
              locale === "zh"
                ? "当前没有工作区路径，无法创建会话。"
                : "No workspace path is available for creating a session.",
            );
          }

          setCapabilityPanel((currentPanel) => ({
            ...(currentPanel ?? { title }),
            title,
            subtitle: worktreeCwd,
            body:
              actionId === "fork-worktree"
                ? locale === "zh"
                  ? "正在分叉当前会话..."
                  : "Forking current session..."
                : locale === "zh"
                  ? "正在新建工作区会话..."
                  : "Creating workspace session...",
            error: undefined,
          }));

          let nextThread: Thread | null = null;
          if (actionId === "fork-worktree") {
            if (!selectedThreadId) {
              throw new Error(
                locale === "zh"
                  ? "请先选择一个可分叉的对话。"
                  : "Select a conversation before forking.",
              );
            }
            const response = await clientRef.current?.forkThread(selectedThreadId);
            nextThread = response?.thread ?? null;
          } else {
            nextThread =
              (await clientRef.current?.startThread(worktreeCwd, "worktree")) ??
              null;
          }

          if (!nextThread) {
            throw new Error(locale === "zh" ? "创建会话失败" : "Unable to create session");
          }

          setThreads((current) => upsertThread(current, nextThread));
          setSelectedThreadId(nextThread.id);
          await refreshWorktreesSettingsPanel();
        } catch (error) {
          setCapabilityPanel((currentPanel) => ({
            ...(currentPanel ?? { title }),
            title,
            error:
              error instanceof Error
                ? error.message
                : locale === "zh"
                  ? "工作树操作失败"
                  : "Worktree action failed",
          }));
        }
      })();
      return;
    }

    if (
      actionId === "enable-remote-control" ||
      actionId === "disable-remote-control"
    ) {
      void (async () => {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  actionId === "enable-remote-control"
                    ? locale === "zh"
                      ? "正在启用远程控制..."
                      : "Enabling remote control..."
                    : locale === "zh"
                      ? "正在停用远程控制..."
                      : "Disabling remote control...",
                error: undefined,
              }
            : currentPanel,
        );
        try {
          const response =
            actionId === "enable-remote-control"
              ? await clientRef.current?.enableRemoteControl()
              : await clientRef.current?.disableRemoteControl();
          await refreshComputerControlSettingsPanel();
          setNotice({
            text:
              locale === "zh"
                ? `远程控制状态：${response?.status ?? "unknown"}`
                : `Remote control: ${response?.status ?? "unknown"}`,
            tone: response?.status === "errored" ? "warning" : "success",
          });
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "更新远程控制状态失败"
                        : "Unable to update remote control",
                }
              : currentPanel,
          );
        }
      })();
      return;
    }

    if (actionId === "start-remote-pairing") {
      void (async () => {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body: locale === "zh" ? "正在创建配对码..." : "Creating pairing code...",
                error: undefined,
              }
            : currentPanel,
        );
        try {
          const response = await clientRef.current?.startRemoteControlPairing();
          const status = response
            ? await clientRef.current?.getRemoteControlPairingStatus(
                response.pairingCode,
                response.manualPairingCode,
              )
            : null;
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  subtitle:
                    locale === "zh"
                      ? "配对码已创建"
                      : "Pairing code created",
                  body: [
                    locale === "zh" ? "远程控制配对" : "Remote control pairing",
                    `${locale === "zh" ? "配对码" : "Pairing code"}: ${response?.pairingCode ?? ""}`,
                    response?.manualPairingCode
                      ? `${locale === "zh" ? "手动配对码" : "Manual pairing code"}: ${response.manualPairingCode}`
                      : null,
                    `${locale === "zh" ? "环境 ID" : "Environment ID"}: ${response?.environmentId ?? ""}`,
                    response?.expiresAt
                      ? `${locale === "zh" ? "过期时间" : "Expires"}: ${new Date(response.expiresAt * 1000).toLocaleString()}`
                      : null,
                    `${locale === "zh" ? "是否已认领" : "Claimed"}: ${status?.claimed ? "yes" : "no"}`,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  actions: [
                    {
                      id: "refresh-computer-control",
                      label:
                        locale === "zh"
                          ? "返回电脑操控"
                          : "Back to computer control",
                    },
                  ],
                  fields: undefined,
                  error: undefined,
                }
              : currentPanel,
          );
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "创建配对码失败"
                        : "Unable to create pairing code",
                }
              : currentPanel,
          );
        }
      })();
      return;
    }

    if (actionId === "revoke-remote-client") {
      void (async () => {
        const environmentId = await clientRef.current
          ?.readRemoteControlStatus()
          .then((status) => status.environmentId ?? null);
        const clientId =
          capabilityPanel?.fields?.find(
            (field) => field.id === "remote-control-revoke-client",
          )?.value ?? "";
        if (!environmentId || !clientId.trim()) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    locale === "zh"
                      ? "缺少环境 ID 或设备 ID"
                      : "Missing environment ID or client ID",
                }
              : currentPanel,
          );
          return;
        }
        try {
          await clientRef.current?.revokeRemoteControlClient(
            environmentId,
            clientId.trim(),
          );
          await refreshComputerControlSettingsPanel();
          setNotice({
            text:
              locale === "zh"
                ? `已撤销设备：${clientId.trim()}`
                : `Revoked client: ${clientId.trim()}`,
            tone: "success",
          });
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "撤销设备失败"
                        : "Unable to revoke client",
                }
              : currentPanel,
          );
        }
      })();
      return;
    }

    if (actionId.startsWith("setup-windows-sandbox-")) {
      const mode = actionId.replace("setup-windows-sandbox-", "");
      if (mode !== "elevated" && mode !== "unelevated") {
        return;
      }
      void (async () => {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? `正在启动 Windows 沙箱配置：${mode}`
                    : `Starting Windows sandbox setup: ${mode}`,
                error: undefined,
              }
            : currentPanel,
        );
        try {
          const cwd = await resolveBackendCwd();
          const response = await clientRef.current?.startWindowsSandboxSetup(
            mode,
            cwd || undefined,
          );
          await refreshEnvironmentSettingsPanel();
          setNotice({
            text:
              locale === "zh"
                ? `Windows 沙箱配置${response?.started ? "已启动" : "未启动"}`
                : `Windows sandbox setup ${response?.started ? "started" : "did not start"}`,
            tone: response?.started ? "success" : "warning",
          });
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "启动 Windows 沙箱配置失败"
                        : "Unable to start Windows sandbox setup",
                }
              : currentPanel,
          );
        }
      })();
      return;
    }

    if (actionId === "reload-tools") {
      void (async () => {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "正在重载 MCP 配置..."
                    : "Reloading MCP config...",
                error: undefined,
              }
            : currentPanel,
        );
        try {
          await clientRef.current?.reloadMcpServers();
          await refreshMcpSettingsPanel();
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "重载 MCP 配置失败"
                        : "Unable to reload MCP config",
                }
              : currentPanel,
          );
        }
      })();
      return;
    }

    if (actionId === "compact-thread") {
      if (isDemo) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "上下文压缩已启动（演示）。连接 app-server 后会调用 thread/compact/start。"
                    : "Context compaction started (demo). With app-server connected this calls thread/compact/start.",
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }

      const threadId =
        selectedThreadId && !isDemoThreadId(selectedThreadId)
          ? selectedThreadId
          : null;
      if (busyToolId || !isConnected || !threadId) {
        return;
      }

      void (async () => {
        setBusyToolId("sidechat");
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "正在启动上下文压缩..."
                    : "Starting context compaction...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          await clientRef.current?.compactThread(threadId);
          const thread = await clientRef.current?.readThread(threadId);
          if (thread) {
            setThreads((current) => upsertThread(current, thread));
          }
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  body:
                    locale === "zh"
                      ? "上下文压缩已启动，完成后会出现在当前会话中。"
                      : "Context compaction started. It will appear in this session when complete.",
                  error: undefined,
                }
              : currentPanel,
          );
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "启动上下文压缩失败"
                        : "Unable to start context compaction",
                }
              : currentPanel,
          );
        } finally {
          setBusyToolId(null);
        }
      })();
      return;
    }

    if (actionId === "rollback-thread") {
      if (isDemo) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "已回滚上一轮（演示）。连接 app-server 后会调用 thread/rollback。"
                    : "Rolled back the last turn (demo). With app-server connected this calls thread/rollback.",
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }

      const threadId =
        selectedThreadId && !isDemoThreadId(selectedThreadId)
          ? selectedThreadId
          : null;
      if (busyToolId || !isConnected || !threadId) {
        return;
      }

      const confirmed = window.confirm(
        locale === "zh"
          ? "回滚会删除当前会话最后一轮历史，但不会自动回退文件改动。继续？"
          : "Rollback removes the last turn from this session history, but does not revert file changes. Continue?",
      );
      if (!confirmed) {
        return;
      }

      void (async () => {
        setBusyToolId("sidechat");
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "正在回滚上一轮..."
                    : "Rolling back the last turn...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          const thread = await clientRef.current?.rollbackThread(threadId, 1);
          if (thread) {
            setThreads((current) => upsertThread(current, thread));
          }
          setActiveTurnByThread((current) => {
            const { [threadId]: _removed, ...next } = current;
            return next;
          });
          setStreamingTextByThread((current) => {
            const { [threadId]: _removed, ...next } = current;
            return next;
          });
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  body:
                    locale === "zh"
                      ? "已回滚上一轮会话历史。"
                      : "Rolled back the last turn in this session.",
                  error: undefined,
                }
              : currentPanel,
          );
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "回滚会话失败"
                        : "Unable to rollback session",
                }
              : currentPanel,
          );
        } finally {
          setBusyToolId(null);
        }
      })();
      return;
    }

    if (
      actionId === "enable-thread-memory" ||
      actionId === "disable-thread-memory"
    ) {
      const mode = actionId === "enable-thread-memory" ? "enabled" : "disabled";
      if (isDemo) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? `记忆模式已${mode === "enabled" ? "启用" : "禁用"}（演示）。连接 app-server 后会调用 thread/memoryMode/set。`
                    : `Memory mode ${mode} (demo). With app-server connected this calls thread/memoryMode/set.`,
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }

      const threadId =
        selectedThreadId && !isDemoThreadId(selectedThreadId)
          ? selectedThreadId
          : null;
      if (busyToolId || !isConnected || !threadId) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  locale === "zh"
                    ? "请先选择一个真实会话"
                    : "Select a real session first",
              }
            : currentPanel,
        );
        return;
      }

      void (async () => {
        setBusyToolId("sidechat");
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "正在更新记忆模式..."
                    : "Updating memory mode...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          await clientRef.current?.setThreadMemoryMode(threadId, mode);
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  body:
                    locale === "zh"
                      ? `记忆模式已${mode === "enabled" ? "启用" : "禁用"}。`
                      : `Memory mode ${mode}.`,
                  error: undefined,
                }
              : currentPanel,
          );
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "更新记忆模式失败"
                        : "Unable to update memory mode",
                }
              : currentPanel,
          );
        } finally {
          setBusyToolId(null);
        }
      })();
      return;
    }

    if (actionId === "save-thread-goal" || actionId === "clear-thread-goal") {
      if (isDemo) {
        const objective =
          capabilityPanel?.fields
            ?.find((field) => field.id === "thread-goal-objective")
            ?.value.trim() ?? "";
        if (actionId === "clear-thread-goal") {
          setThreadGoal(null);
          setCapabilityPanel({
            title: locale === "zh" ? "会话设置" : "Session settings",
            subtitle: locale === "zh" ? "目标" : "Goal",
            body:
              locale === "zh" ? "目标已清除（演示）" : "Goal cleared (demo)",
            actions: [
              {
                id: "save-thread-goal",
                label: locale === "zh" ? "重新设置" : "Set again",
                tone: "primary",
              },
            ],
          });
          return;
        }
        setCapabilityPanel({
          title: locale === "zh" ? "会话设置" : "Session settings",
          subtitle: locale === "zh" ? "目标" : "Goal",
          body: objective
            ? `${locale === "zh" ? "已保存目标（演示）" : "Goal saved (demo)"}\n${objective}`
            : locale === "zh"
              ? "请输入目标后再保存"
              : "Enter a goal before saving",
          actions: objective
            ? [
                {
                  id: "clear-thread-goal",
                  label: locale === "zh" ? "清除目标" : "Clear goal",
                  tone: "danger",
                },
              ]
            : undefined,
        });
        return;
      }

      if (busyToolId || !isConnected) {
        return;
      }

      let threadId =
        selectedThreadId && !(isDemoPreview && isDemoThreadId(selectedThreadId))
          ? selectedThreadId
          : null;
      void (async () => {
        setBusyToolId("sidechat");
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  actionId === "save-thread-goal"
                    ? locale === "zh"
                      ? "正在保存目标..."
                      : "Saving goal..."
                    : locale === "zh"
                      ? "正在清除目标..."
                      : "Clearing goal...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          if (actionId === "clear-thread-goal") {
            if (!threadId) {
              setThreadGoal(null);
              openThreadSettingsPanel();
              return;
            }
            await clientRef.current?.clearThreadGoal(threadId);
            setThreadGoal(null);
            setCapabilityPanel((currentPanel) =>
              currentPanel
                ? {
                    ...currentPanel,
                    body: locale === "zh" ? "目标已清除" : "Goal cleared",
                    fields: [
                      {
                        id: "thread-goal-objective",
                        label: locale === "zh" ? "目标" : "Goal",
                        placeholder:
                          locale === "zh"
                            ? "描述这个会话要持续完成的目标"
                            : "Describe the ongoing goal for this session",
                        value: "",
                      },
                      {
                        id: "thread-goal-token-budget",
                        label: locale === "zh" ? "Token 预算" : "Token budget",
                        placeholder:
                          locale === "zh"
                            ? "可选，留空表示不限制"
                            : "Optional, leave blank for no budget",
                        value: "",
                      },
                    ],
                    actions: [
                      {
                        id: "save-thread-goal",
                        label: locale === "zh" ? "重新设置" : "Set again",
                        tone: "primary",
                      },
                    ],
                  }
                : currentPanel,
            );
            return;
          }

          const objective =
            capabilityPanel?.fields
              ?.find((field) => field.id === "thread-goal-objective")
              ?.value.trim() ?? "";
          const tokenBudgetText =
            capabilityPanel?.fields
              ?.find((field) => field.id === "thread-goal-token-budget")
              ?.value.trim() ?? "";
          const tokenBudget = tokenBudgetText ? Number(tokenBudgetText) : null;

          if (!objective) {
            setCapabilityPanel((currentPanel) =>
              currentPanel
                ? {
                    ...currentPanel,
                    error:
                      locale === "zh" ? "目标不能为空" : "Goal cannot be empty",
                  }
                : currentPanel,
            );
            return;
          }

          if (
            tokenBudget !== null &&
            (!Number.isFinite(tokenBudget) || tokenBudget <= 0)
          ) {
            setCapabilityPanel((currentPanel) =>
              currentPanel
                ? {
                    ...currentPanel,
                    error:
                      locale === "zh"
                        ? "Token 预算必须是正数"
                        : "Token budget must be a positive number",
                  }
                : currentPanel,
            );
            return;
          }

          if (!threadId) {
            const thread = await createThread(objective);
            threadId = thread?.id ?? null;
          }

          if (!threadId) {
            return;
          }

          const response = await clientRef.current?.setThreadGoal(
            threadId,
            objective,
            tokenBudget,
          );
          setThreadGoal(response?.goal ?? null);
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  body: locale === "zh" ? "目标已保存" : "Goal saved",
                  error: undefined,
                }
              : currentPanel,
          );
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "目标操作失败"
                        : "Goal action failed",
                }
              : currentPanel,
          );
        } finally {
          setBusyToolId(null);
        }
      })();
      return;
    }

    if (actionId === "create-context-note") {
      const selectedRoot =
        capabilityPanel?.fields
          ?.find((field) => field.id === "file-search-root")
          ?.value.trim() || "";

      if (busyToolId || !isConnected) {
        return;
      }

      void (async () => {
        const root = selectedRoot || (await resolveBackendCwd());
        if (!root) {
          return;
        }

        setBusyToolId("files");
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "正在创建上下文笔记..."
                    : "Creating context note...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          const notesDir = joinPath(joinPath(root, ".crewon"), "context-notes");
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const notePath = joinPath(notesDir, `note-${stamp}.md`);
          const noteBody = [
            `# ${locale === "zh" ? "上下文笔记" : "Context note"}`,
            "",
            `- ${locale === "zh" ? "创建时间" : "Created"}: ${new Date().toISOString()}`,
            `- ${locale === "zh" ? "工作区" : "Workspace"}: ${root}`,
            `- ${locale === "zh" ? "来源" : "Source"}: Crewon files panel`,
            "",
            locale === "zh"
              ? "这里记录给智能体、办公室或自动化复用的项目上下文。"
              : "Record reusable project context for agents, offices, or automations here.",
            "",
          ].join("\n");

          await clientRef.current?.createDirectory(notesDir, true);
          await clientRef.current?.writeTextFile(notePath, noteBody);
          const metadata = await clientRef.current?.getMetadata(notePath);
          setCapabilityPanel({
            title: locale === "zh" ? "上下文笔记" : "Context note",
            subtitle: notePath,
            body: [
              fileMetadataText(metadata ?? null, locale),
              noteBody,
            ]
              .filter(Boolean)
              .join("\n\n"),
            ...filePanelSearchControls(locale, root),
          });
          setNotice({
            text:
              locale === "zh"
                ? `已创建上下文笔记：${notePath}`
                : `Context note created: ${notePath}`,
            tone: "success",
          });
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "创建上下文笔记失败"
                        : "Unable to create context note",
                }
              : currentPanel,
          );
        } finally {
          setBusyToolId(null);
        }
      })();
      return;
    }

    if (actionId === "send-context-to-thread") {
      const contextFile = pendingContextFile;
      if (!contextFile || busyToolId || !isConnected) {
        return;
      }

      void (async () => {
        setBusyToolId("files");
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "正在发送上下文到后端会话..."
                    : "Sending context to backend thread...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          let thread =
            selectedThreadId && !isDemoThreadId(selectedThreadId)
              ? selectedThread
              : null;
          if (thread?.status.type === "notLoaded") {
            thread = (await clientRef.current?.resumeThread(thread.id)) ?? thread;
          }
          if (!thread) {
            thread = await createThread(
              locale === "zh"
                ? `读取工作区上下文：${contextFile.path}`
                : `Read workspace context: ${contextFile.path}`,
            );
          }
          if (!thread) {
            return;
          }

          setThreads((current) => upsertThread(current, thread));
          setSelectedThreadId(thread.id);

          const maxChars = 6000;
          const excerpt =
            contextFile.text.length > maxChars
              ? `${contextFile.text.slice(0, maxChars)}\n...`
              : contextFile.text;
          const prompt = [
            locale === "zh"
              ? `以下工作区文件已由用户从右栏作为上下文发送，请阅读并在后续回答中参考：${contextFile.path}`
              : `The user sent this workspace file from the right sidebar as context. Read it and use it in follow-up answers: ${contextFile.path}`,
            "",
            "```markdown",
            excerpt || (locale === "zh" ? "文件为空" : "Empty file"),
            "```",
          ].join("\n");

          const response = await clientRef.current?.startTurn(thread.id, prompt);
          if (response) {
            setThreads((current) =>
              current.map((currentThread) =>
                currentThread.id === thread.id
                  ? upsertTurn(currentThread, response.turn)
                  : currentThread,
              ),
            );
            if (response.turn.status === "inProgress") {
              setActiveTurnByThread((current) => ({
                ...current,
                [thread.id]: response.turn.id,
              }));
            }
          }
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  body:
                    locale === "zh"
                      ? `已发送到后端会话：${threadTitle(thread, thread.id)}`
                      : `Sent to backend thread: ${threadTitle(thread, thread.id)}`,
                  error: undefined,
                }
              : currentPanel,
          );
          setNotice({
            text:
              locale === "zh"
                ? "上下文文件已发送到后端会话"
                : "Context file sent to backend thread",
            tone: "success",
          });
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "发送上下文失败"
                        : "Unable to send context",
                }
              : currentPanel,
          );
        } finally {
          setBusyToolId(null);
        }
      })();
      return;
    }

    if (actionId === "watch-current-path" || actionId === "unwatch-current-path") {
      if (isDemo) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "文件监听已更新（演示）。连接 app-server 后会调用 fs/watch 或 fs/unwatch。"
                    : "File watch updated (demo). With app-server connected this calls fs/watch or fs/unwatch.",
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }

      const targetPath =
        capabilityPanel?.fields
          ?.find((field) => field.id === "file-search-root")
          ?.value.trim() ||
        capabilityPanel?.subtitle?.trim() ||
        "";

      if (busyToolId || !isConnected || !targetPath) {
        return;
      }

      void (async () => {
        setBusyToolId("files");
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  actionId === "watch-current-path"
                    ? locale === "zh"
                      ? "正在启动文件监听..."
                      : "Starting file watch..."
                    : locale === "zh"
                      ? "正在停止文件监听..."
                      : "Stopping file watch...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          if (actionId === "unwatch-current-path") {
            if (!activeFileWatch) {
              setCapabilityPanel((currentPanel) =>
                currentPanel
                  ? {
                      ...currentPanel,
                      body:
                        locale === "zh"
                          ? "当前没有运行中的文件监听。"
                          : "No file watch is currently running.",
                      error: undefined,
                    }
                  : currentPanel,
              );
              return;
            }
            await clientRef.current?.unwatchPath(activeFileWatch.id);
            setActiveFileWatch(null);
            setCapabilityPanel((currentPanel) =>
              currentPanel
                ? {
                    ...currentPanel,
                    body:
                      locale === "zh"
                        ? `已停止监听：${activeFileWatch.path}`
                        : `Stopped watching: ${activeFileWatch.path}`,
                    error: undefined,
                  }
                : currentPanel,
            );
            return;
          }

          if (activeFileWatch) {
            await clientRef.current?.unwatchPath(activeFileWatch.id);
          }
          const watchId = `crewon-ui-${Date.now()}`;
          const response = await clientRef.current?.watchPath(watchId, targetPath);
          const watchedPath = response?.path ?? targetPath;
          setActiveFileWatch({ id: watchId, path: watchedPath });
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  body:
                    locale === "zh"
                      ? `正在监听：${watchedPath}`
                      : `Watching: ${watchedPath}`,
                  error: undefined,
                }
              : currentPanel,
          );
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "文件监听操作失败"
                        : "File watch action failed",
                }
              : currentPanel,
          );
        } finally {
          setBusyToolId(null);
        }
      })();
      return;
    }

    if (actionId === "copy-current-path") {
      const sourcePath = capabilityPanel?.subtitle?.trim() ?? "";
      if (!sourcePath || busyToolId || !isConnected) {
        return;
      }

      void (async () => {
        setBusyToolId("files");
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body: locale === "zh" ? "正在复制..." : "Copying...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          const metadata = await clientRef.current?.getMetadata(sourcePath);
          const destinationPath = `${sourcePath.replace(/[\\/]+$/, "")}.copy`;
          await clientRef.current?.copyPath(
            sourcePath,
            destinationPath,
            Boolean(metadata?.isDirectory),
          );
          const parentPath = pathDirName(sourcePath);
          const [response, parentMetadata] = await Promise.all([
            clientRef.current?.readDirectory(parentPath),
            clientRef.current?.getMetadata(parentPath),
          ]);
          const entries = [...(response?.entries ?? [])]
            .sort(
              (left, right) =>
                Number(right.isDirectory) - Number(left.isDirectory) ||
                left.fileName.localeCompare(right.fileName),
            )
            .slice(0, 16)
            .map(
              (entry) =>
                ({
                  label: `${entry.isDirectory ? ">" : " "} ${entry.fileName}`,
                  path: joinPath(parentPath, entry.fileName),
                  kind: entry.isDirectory ? "directory" : "file",
                }) satisfies CapabilityPanelItem,
            );
          setCapabilityPanel({
            title: locale === "zh" ? "文件" : "Files",
            subtitle: parentPath,
            body: [
              locale === "zh"
                ? `已复制到：${destinationPath}`
                : `Copied to: ${destinationPath}`,
              fileMetadataText(parentMetadata ?? null, locale),
            ]
              .filter(Boolean)
              .join("\n\n"),
            ...filePanelSearchControls(locale, parentPath),
            items:
              entries.length > 0
                ? entries
                : [{ label: locale === "zh" ? "目录为空" : "Empty directory" }],
          });
          setNotice({
            text:
              locale === "zh"
                ? `已复制：${destinationPath}`
                : `Copied: ${destinationPath}`,
            tone: "success",
          });
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "复制失败"
                        : "Unable to copy",
                }
              : currentPanel,
          );
        } finally {
          setBusyToolId(null);
        }
      })();
      return;
    }

    if (actionId === "search-files" || actionId === "clear-file-search") {
      const root =
        capabilityPanel?.fields
          ?.find((field) => field.id === "file-search-root")
          ?.value.trim() || cwd;

      if (!root) {
        return;
      }

      if (actionId === "clear-file-search") {
        void readWorkspaceFiles();
        return;
      }

      const query =
        capabilityPanel?.fields
          ?.find((field) => field.id === "file-search")
          ?.value.trim() ?? "";
      if (!query || busyToolId || !isConnected) {
        return;
      }

      void (async () => {
        setBusyToolId("files");
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body: locale === "zh" ? "正在搜索..." : "Searching...",
                error: undefined,
              }
            : currentPanel,
        );

        try {
          const response = await clientRef.current?.fuzzyFileSearch(query, [
            root,
          ]);
          const items =
            response?.files.slice(0, 24).map((file) => {
              const path = resolveSearchPath(file.root, file.path);
              return {
                label: `${file.match_type === "directory" ? ">" : " "} ${file.path}`,
                path,
                kind: file.match_type,
              } satisfies CapabilityPanelItem;
            }) ?? [];

          setCapabilityPanel({
            title: locale === "zh" ? "文件" : "Files",
            subtitle: root,
            body: `${locale === "zh" ? "搜索" : "Search"}: ${query}`,
            ...filePanelSearchControls(locale, root, query),
            items:
              items.length > 0
                ? items
                : [{ label: locale === "zh" ? "没有匹配结果" : "No matches" }],
          });
        } catch (error) {
          setCapabilityPanel({
            title: locale === "zh" ? "文件" : "Files",
            subtitle: root,
            error:
              error instanceof Error
                ? error.message
                : locale === "zh"
                  ? "搜索失败"
                  : "Search failed",
            ...filePanelSearchControls(locale, root, query),
          });
        } finally {
          setBusyToolId(null);
        }
      })();
      return;
    }

    if (
      actionId === "refresh-background-terminals" ||
      actionId === "clean-background-terminals"
    ) {
      const threadId =
        selectedThreadId && !isDemoThreadId(selectedThreadId)
          ? selectedThreadId
          : null;

      if (isDemo) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "演示模式下没有后台终端。连接 app-server 后会读取真实会话后台任务。"
                    : "Demo mode has no background terminals. Connect app-server to read real session tasks.",
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }

      if (!isConnected || !threadId) {
        setCapabilityPanel({
          title: locale === "zh" ? "后台终端" : "Background terminals",
          subtitle: locale === "zh" ? "0 个后台任务" : "0 background tasks",
          body:
            locale === "zh"
              ? "当前会话没有后台终端。"
              : "This session has no background terminals.",
          actions: [
            {
              id: "refresh-background-terminals",
              label: locale === "zh" ? "刷新" : "Refresh",
            },
          ],
        });
        return;
      }

      void (async () => {
        try {
          if (actionId === "clean-background-terminals") {
            await clientRef.current?.cleanBackgroundTerminals(threadId);
          }
          await showBackgroundTerminals(threadId);
        } catch (error) {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "后台终端操作失败"
                        : "Background terminal action failed",
                }
              : currentPanel,
          );
        }
      })();
      return;
    }

    if (actionId === "send-terminal-input") {
      const processId = terminalProcessIdRef.current;
      const stdinValue =
        capabilityPanel?.fields
          ?.find((field) => field.id === "terminal-stdin")
          ?.value ?? "";

      if (!processId || !stdinValue) {
        return;
      }

      void clientRef.current
        ?.writeCommandInput(processId, stdinValue.replace(/\\n/g, "\n"))
        .then(() => {
          setCapabilityPanel((currentPanel) =>
            currentPanel?.commandInput
              ? {
                  ...currentPanel,
                  fields: currentPanel.fields?.map((field) =>
                    field.id === "terminal-stdin"
                      ? { ...field, value: "" }
                      : field,
                  ),
                  body: `${currentPanel.body ?? ""}\n${
                    locale === "zh" ? "[已发送输入]" : "[input sent]"
                  }`.trim(),
                }
              : currentPanel,
          );
        })
        .catch((error) => {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "发送终端输入失败"
                        : "Unable to send terminal input",
                }
              : currentPanel,
          );
        });
      return;
    }

    if (actionId === "send-terminal-to-thread") {
      const command = terminalCommand.trim();
      const threadId =
        selectedThreadId && !isDemoThreadId(selectedThreadId)
          ? selectedThreadId
          : null;

      if (!command) {
        return;
      }

      if (isDemo) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                body:
                  locale === "zh"
                    ? "命令已发送到会话（演示）。连接 app-server 后会调用 thread/shellCommand。"
                    : "Command sent to the session (demo). With app-server connected this calls thread/shellCommand.",
                error: undefined,
              }
            : currentPanel,
        );
        return;
      }

      if (busyToolId || !isConnected || !threadId) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  locale === "zh"
                    ? "请先选择一个真实会话"
                    : "Select a real session first",
              }
            : currentPanel,
        );
        return;
      }

      const confirmed = window.confirm(
        locale === "zh"
          ? `将命令发送到当前会话执行：${command}`
          : `Send this command to the current session: ${command}`,
      );
      if (!confirmed) {
        return;
      }

      void clientRef.current
        ?.runThreadShellCommand(threadId, command)
        .then(() => {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  body:
                    locale === "zh"
                      ? `已发送到会话：${command}`
                      : `Sent to session: ${command}`,
                  error: undefined,
                }
              : currentPanel,
          );
          setNotice({
            text:
              locale === "zh"
                ? "命令已发送到当前会话"
                : "Command sent to the current session",
            tone: "success",
          });
        })
        .catch((error) => {
          setCapabilityPanel((currentPanel) =>
            currentPanel
              ? {
                  ...currentPanel,
                  error:
                    error instanceof Error
                      ? error.message
                      : locale === "zh"
                        ? "发送命令到会话失败"
                        : "Unable to send command to session",
                }
              : currentPanel,
          );
        });
      return;
    }

    if (actionId === "stop-terminal") {
      const processId = terminalProcessIdRef.current;
      if (!processId) {
        return;
      }

      void clientRef.current?.terminateCommand(processId).catch((error) => {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  error instanceof Error
                    ? error.message
                    : locale === "zh"
                      ? "停止命令失败"
                      : "Unable to stop command",
              }
            : currentPanel,
        );
      });
      setCapabilityPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              actions: undefined,
              body: `${currentPanel.body ?? ""}\n${locale === "zh" ? "正在停止..." : "Stopping..."}`.trim(),
            }
          : currentPanel,
      );
      return;
    }

    if (
      pendingExternalSecretRequest &&
      (actionId === "submit-auth-refresh" ||
        actionId === "submit-attestation" ||
        actionId === "reject-external-secret")
    ) {
      const fieldValue = (fieldId: string) =>
        capabilityPanel?.fields
          ?.find((field) => field.id === fieldId)
          ?.value.trim() ?? "";

      if (actionId === "reject-external-secret") {
        clientRef.current?.rejectServerRequest(
          pendingExternalSecretRequest.id,
          pendingExternalSecretRequest.kind === "attestation"
            ? "Attestation token was not provided"
            : "Model account auth tokens were not provided",
        );
      } else if (pendingExternalSecretRequest.kind === "chatgptAuthTokens") {
        const accessToken = fieldValue("accessToken");
        const chatgptAccountId = fieldValue("chatgptAccountId");
        if (!accessToken || !chatgptAccountId) {
          clientRef.current?.rejectServerRequest(
            pendingExternalSecretRequest.id,
            "Missing model account access token or account id",
          );
        } else {
          clientRef.current?.respondServerRequest(
            pendingExternalSecretRequest.id,
            {
              accessToken,
              chatgptAccountId,
              chatgptPlanType: fieldValue("chatgptPlanType") || null,
            },
          );
        }
      } else {
        const token = fieldValue("attestationToken");
        if (!token) {
          clientRef.current?.rejectServerRequest(
            pendingExternalSecretRequest.id,
            "Missing attestation token",
          );
        } else {
          clientRef.current?.respondServerRequest(
            pendingExternalSecretRequest.id,
            { token },
          );
        }
      }

      setCapabilityPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              actions: undefined,
              fields: undefined,
              body:
                actionId === "reject-external-secret"
                  ? locale === "zh"
                    ? "已拒绝请求"
                    : "Request rejected"
                  : locale === "zh"
                    ? "已提交响应"
                    : "Response submitted",
            }
          : currentPanel,
      );
      setPendingExternalSecretRequest(null);
      return;
    }

    if (actionId === "refresh-account") {
      void refreshAccountPanel();
      return;
    }

    if (
      actionId === "login-chatgpt" ||
      actionId === "login-device-code" ||
      actionId === "logout-account"
    ) {
      void (async () => {
        if (!isConnected) {
          return;
        }

        try {
          if (actionId === "logout-account") {
            await clientRef.current?.logoutAccount();
            const account = await clientRef.current?.getAccount();
            setAccountStatus(account ?? null);
            setCapabilityPanel({
              title: locale === "zh" ? "常规" : "General",
              subtitle: locale === "zh" ? "已退出" : "Logged out",
              body: accountStatusText(account ?? null, locale),
            });
            return;
          }

          const response = await clientRef.current?.loginAccount(
            actionId === "login-device-code"
              ? { type: "chatgptDeviceCode" }
              : { type: "chatgpt" },
          );
          if (!response) {
            return;
          }

          if (response.type === "chatgpt") {
            setCapabilityPanel({
              title: locale === "zh" ? "常规" : "General",
              subtitle: locale === "zh" ? "模型账号登录" : "Model login",
              body: `${locale === "zh" ? "打开链接完成登录" : "Open this URL to finish login"}\n${response.authUrl}\nloginId: ${response.loginId}`,
              actions: [
                {
                  id: "refresh-account",
                  label: locale === "zh" ? "刷新状态" : "Refresh status",
                  tone: "primary",
                },
              ],
            });
            return;
          }

          if (response.type === "chatgptDeviceCode") {
            setCapabilityPanel({
              title: locale === "zh" ? "常规" : "General",
              subtitle: locale === "zh" ? "设备码登录" : "Device code login",
              body: `${locale === "zh" ? "访问链接并输入代码" : "Open the URL and enter the code"}\n${response.verificationUrl}\n${response.userCode}\nloginId: ${response.loginId}`,
              actions: [
                {
                  id: "refresh-account",
                  label: locale === "zh" ? "刷新状态" : "Refresh status",
                  tone: "primary",
                },
              ],
            });
            return;
          }

          const account = await clientRef.current?.getAccount();
          setAccountStatus(account ?? null);
          setCapabilityPanel({
            title: locale === "zh" ? "常规" : "General",
            subtitle: locale === "zh" ? "已登录" : "Logged in",
            body: accountStatusText(account ?? null, locale),
          });
        } catch (error) {
          setCapabilityPanel({
            title: locale === "zh" ? "常规" : "General",
            subtitle: locale === "zh" ? "认证操作" : "Auth action",
            error:
              error instanceof Error
                ? error.message
                : locale === "zh"
                  ? "账号操作失败"
                  : "Account action failed",
          });
        }
      })();
      return;
    }

    if (
      pendingMcpElicitationRequest &&
      (actionId === "accept-mcp-elicitation" ||
        actionId === "decline-mcp-elicitation" ||
        actionId === "cancel-mcp-elicitation")
    ) {
      const value =
        capabilityPanel?.fields
          ?.find((field) => field.id === pendingMcpElicitationRequest.fieldId)
          ?.value.trim() ?? "";
      let content: unknown = null;

      if (actionId === "accept-mcp-elicitation" && value) {
        try {
          content = JSON.parse(value);
        } catch {
          content = value;
        }
      }

      const action =
        actionId === "accept-mcp-elicitation"
          ? "accept"
          : actionId === "decline-mcp-elicitation"
            ? "decline"
            : "cancel";
      clientRef.current?.respondServerRequest(pendingMcpElicitationRequest.id, {
        action,
        content: action === "accept" ? content : null,
        _meta: null,
      });
      setCapabilityPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              actions: undefined,
              fields: undefined,
              body:
                action === "accept"
                  ? locale === "zh"
                    ? "已提交 MCP 输入"
                    : "MCP input submitted"
                  : locale === "zh"
                    ? "已结束 MCP 输入请求"
                    : "MCP elicitation closed",
            }
          : currentPanel,
      );
      setPendingMcpElicitationRequest(null);
      return;
    }

    if (
      pendingDynamicToolRequest &&
      (actionId === "complete-dynamic-tool" || actionId === "fail-dynamic-tool")
    ) {
      const value =
        capabilityPanel?.fields
          ?.find((field) => field.id === pendingDynamicToolRequest.fieldId)
          ?.value.trim() ?? "";
      const success = actionId === "complete-dynamic-tool";
      const text =
        value ||
        (success
          ? locale === "zh"
            ? "工具调用已完成。"
            : "Tool call completed."
          : locale === "zh"
            ? "工具调用被用户标记为失败。"
            : "Tool call marked as failed by the user.");

      clientRef.current?.respondServerRequest(pendingDynamicToolRequest.id, {
        contentItems: [{ type: "inputText", text }],
        success,
      });
      setCapabilityPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              actions: undefined,
              fields: undefined,
              body: success
                ? locale === "zh"
                  ? "已返回工具结果"
                  : "Tool result returned"
                : locale === "zh"
                  ? "已返回工具失败"
                  : "Tool failure returned",
            }
          : currentPanel,
      );
      setPendingDynamicToolRequest(null);
      return;
    }

    if (
      pendingUserInputRequest &&
      (actionId === "submit-user-input" || actionId === "cancel-user-input")
    ) {
      const answers =
        actionId === "submit-user-input"
          ? Object.fromEntries(
              (capabilityPanel?.fields ?? [])
                .filter((field) =>
                  pendingUserInputRequest.questionIds.includes(field.id),
                )
                .map((field) => [
                  field.id,
                  { answers: field.value.trim() ? [field.value.trim()] : [] },
                ]),
            )
          : {};

      clientRef.current?.respondServerRequest(pendingUserInputRequest.id, {
        answers,
      });
      setCapabilityPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              actions: undefined,
              fields: undefined,
              body:
                actionId === "submit-user-input"
                  ? locale === "zh"
                    ? "已提交输入"
                    : "Input submitted"
                  : locale === "zh"
                    ? "已取消输入请求"
                    : "Input request cancelled",
            }
          : currentPanel,
      );
      setPendingUserInputRequest(null);
      return;
    }

    if (!pendingApprovalRequest) {
      return;
    }

    const isApprove = actionId === "approve-request";
    const approvalResult =
      pendingApprovalRequest.method === "item/permissions/requestApproval"
        ? {
            permissions: isApprove
              ? grantedPermissionsFromRequest(pendingApprovalRequest.params)
              : {},
            scope: "turn",
            strictAutoReview: isApprove ? undefined : true,
          }
        : pendingApprovalRequest.method === "applyPatchApproval" ||
            pendingApprovalRequest.method === "execCommandApproval"
          ? { decision: isApprove ? "approved" : "denied" }
          : { decision: isApprove ? "accept" : "decline" };

    clientRef.current?.respondServerRequest(
      pendingApprovalRequest.id,
      approvalResult,
    );
    setCapabilityPanel((currentPanel) =>
      currentPanel
        ? {
            ...currentPanel,
            actions: undefined,
            body: isApprove
              ? locale === "zh"
                ? "已同意请求"
                : "Request approved"
              : locale === "zh"
                ? "已拒绝请求"
                : "Request declined",
          }
        : currentPanel,
    );
    setPendingApprovalRequest(null);
  }

  function handleCapabilityPanelFieldChange(fieldId: string, value: string) {
    setCapabilityPanel((currentPanel) =>
      currentPanel?.fields
        ? {
            ...currentPanel,
            fields: currentPanel.fields.map((field) =>
              field.id === fieldId ? { ...field, value } : field,
            ),
          }
        : currentPanel,
    );
    setLibraryPanel((currentPanel) =>
      currentPanel?.fields
        ? {
            ...currentPanel,
            fields: currentPanel.fields.map((field) =>
              field.id === fieldId ? { ...field, value } : field,
            ),
          }
        : currentPanel,
    );
  }

  async function startSideChat() {
    if (isDemo) {
      setCapabilityPanel(demoCapabilityPanel("sidechat", locale));
      return;
    }
    if (busyToolId || !isConnected) {
      return;
    }

    setBusyToolId("sidechat");
    setCapabilityPanel({
      title: locale === "zh" ? "侧边聊天" : "Side chat",
      subtitle: locale === "zh" ? "分叉会话" : "Fork thread",
      body: locale === "zh" ? "正在创建..." : "Creating...",
    });

    try {
      let thread = isDemoPreview ? null : selectedThread;

      if (!thread) {
        thread = await createThread();
      }

      if (!thread) {
        return;
      }

      const response = await clientRef.current?.forkThread(thread.id);

      if (response) {
        setThreads((current) => upsertThread(current, response.thread));
        setSelectedThreadId(response.thread.id);
        setCapabilityPanel({
          title: locale === "zh" ? "侧边聊天" : "Side chat",
          subtitle: response.thread.id,
          body: locale === "zh" ? "已创建分叉会话" : "Forked side chat created",
        });
      }
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "侧边聊天" : "Side chat",
        subtitle: locale === "zh" ? "分叉会话" : "Fork thread",
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "创建失败"
              : "Unable to create side chat",
      });
    } finally {
      setBusyToolId(null);
    }
  }

  async function handleCapabilityPanelItem(item: CapabilityPanelItem) {
    if (isDemo) {
      if (item.kind === "directory") {
        setCapabilityPanel({
          title: locale === "zh" ? "文件" : "Files",
          subtitle: item.path ?? item.label.trim(),
          body: locale === "zh" ? "目录 · 演示数据" : "directory · demo data",
          items: [
            {
              label:
                locale === "zh" ? "  （演示）crewon-ui" : "  (demo) crewon-ui",
              path: `${item.path ?? ""}/crewon-ui`,
              kind: "directory",
            },
            {
              label:
                locale === "zh" ? "  （演示）README.md" : "  (demo) README.md",
              path: `${item.path ?? ""}/README.md`,
              kind: "file",
            },
          ],
        });
        return;
      }
      setCapabilityPanel({
        title: item.label.trim(),
        subtitle: item.path ?? "",
        body:
          locale === "zh"
            ? "演示模式下展示的是示例文件内容。接入本地 app-server 后，这里会读取真实文件。"
            : "Demo mode shows sample file contents. Connect the local app-server to read real files here.",
      });
      return;
    }

    if (busyToolId || !isConnected || (!item.path && !item.action)) {
      return;
    }

    const itemAction = item.action;

    if (itemAction?.type === "app") {
      const appId = itemAction.appId;
      const appName = itemAction.appName;
      const appPath = `app://${appId}`;
      const slug = appMentionSlug(appName);
      const token = `$${slug}`;
      setPendingComposerMentions((currentMentions) => {
        return currentMentions.some((mention) => mention.path === appPath)
          ? currentMentions
          : [
              ...currentMentions,
              {
                name: appName,
                path: appPath,
              },
            ];
      });
      setComposerValue((currentValue) => {
        if (currentValue.includes(token)) {
          return currentValue;
        }
        return currentValue.trim()
          ? `${token} ${currentValue}`
          : `${token} `;
      });
      setComposerFocusSignal((signal) => signal + 1);
      setCapabilityPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              body:
                locale === "zh"
                  ? `${token} 已加入输入框。发送后会通过 turn/start 携带 app mention：${appPath}`
                  : `${token} added to the composer. Sending will include the app mention through turn/start: ${appPath}`,
              error: undefined,
            }
          : currentPanel,
      );
      return;
    }

    if (itemAction?.type === "background-terminal") {
      const confirmed = window.confirm(
        locale === "zh"
          ? `终止后台进程：${itemAction.processId}`
          : `Terminate background process: ${itemAction.processId}`,
      );
      if (!confirmed) {
        return;
      }

      setBusyToolId("terminal");
      try {
        const terminated = await clientRef.current?.terminateBackgroundTerminal(
          itemAction.threadId,
          itemAction.processId,
        );
        setNotice({
          text:
            locale === "zh"
              ? terminated
                ? "后台进程已终止"
                : "后台进程已经结束"
              : terminated
                ? "Background process terminated"
                : "Background process was already finished",
          tone: "success",
        });
        await showBackgroundTerminals(itemAction.threadId);
      } catch (error) {
        setCapabilityPanel((currentPanel) =>
          currentPanel
            ? {
                ...currentPanel,
                error:
                  error instanceof Error
                    ? error.message
                    : locale === "zh"
                      ? "终止后台进程失败"
                      : "Unable to terminate background process",
              }
            : currentPanel,
        );
      } finally {
        setBusyToolId(null);
      }
      return;
    }

    if (item.action?.type === "plugin") {
      setBusyToolId("web");
      setCapabilityPanel({
        title: item.action.pluginName,
        subtitle: locale === "zh" ? "插件详情" : "Plugin details",
        body: locale === "zh" ? "正在读取..." : "Reading...",
      });

      try {
        const response = await clientRef.current?.readPlugin(
          item.action.pluginName,
          item.action.marketplacePath,
          item.action.remoteMarketplaceName,
        );

        if (!response) {
          return;
        }

        const pluginActions = [
          ...(response.plugin.summary.source.type === "local"
            ? [
                {
                  id: `open-plugin-path:${encodeCapabilityActionPayload({
                    path: response.plugin.summary.source.path,
                  })}`,
                  label:
                    locale === "zh"
                      ? "右栏打开插件目录"
                      : "Open plugin folder",
                },
              ]
            : []),
          ...(response.plugin.summary.installed
            ? [
                {
                  id: `uninstall-plugin:${encodeCapabilityActionPayload({
                    pluginId: response.plugin.summary.id,
                  })}`,
                  label: locale === "zh" ? "卸载插件" : "Uninstall plugin",
                  tone: "danger" as const,
                },
              ]
            : response.plugin.summary.installPolicy === "AVAILABLE" &&
                response.plugin.summary.availability === "AVAILABLE"
              ? [
                  {
                    id: `install-plugin:${encodeCapabilityActionPayload({
                      marketplacePath: item.action.marketplacePath ?? null,
                      pluginName: item.action.pluginName,
                      remoteMarketplaceName:
                        item.action.remoteMarketplaceName ?? null,
                    })}`,
                    label: locale === "zh" ? "安装插件" : "Install plugin",
                    tone: "primary" as const,
                  },
                ]
              : []),
        ];

        setCapabilityPanel({
          title: response.plugin.summary.name,
          subtitle: locale === "zh" ? "插件详情" : "Plugin details",
          body: pluginDetailText(response, locale),
          actions: [
            ...pluginActions,
            {
              id: "refresh-connectors",
              label: locale === "zh" ? "返回连接器" : "Back to connectors",
            },
          ],
        });
      } catch (error) {
        setCapabilityPanel({
          title: item.action.pluginName,
          subtitle: locale === "zh" ? "插件详情" : "Plugin details",
          error:
            error instanceof Error
              ? error.message
              : locale === "zh"
                ? "读取插件失败"
                : "Unable to read plugin",
          actions: [
            {
              id: "refresh-connectors",
              label: locale === "zh" ? "返回连接器" : "Back to connectors",
            },
          ],
        });
      } finally {
        setBusyToolId(null);
      }
      return;
    }

    setBusyToolId("files");
    const itemPath = item.path;
    if (!itemPath) {
      setBusyToolId(null);
      return;
    }

    try {
      if (item.kind === "directory") {
        setCapabilityPanel({
          title: locale === "zh" ? "文件" : "Files",
          subtitle: itemPath,
          body: locale === "zh" ? "正在读取..." : "Reading...",
        });
        const [response, metadata] = await Promise.all([
          clientRef.current?.readDirectory(itemPath),
          clientRef.current?.getMetadata(itemPath),
        ]);
        const entries = [...(response?.entries ?? [])]
          .sort(
            (left, right) =>
              Number(right.isDirectory) - Number(left.isDirectory) ||
              left.fileName.localeCompare(right.fileName),
          )
          .slice(0, 16)
          .map(
            (entry) =>
              ({
                label: `${entry.isDirectory ? ">" : " "} ${entry.fileName}`,
                path: joinPath(itemPath, entry.fileName),
                kind: entry.isDirectory ? "directory" : "file",
              }) satisfies CapabilityPanelItem,
          );
        setCapabilityPanel({
          title: locale === "zh" ? "文件" : "Files",
          subtitle: itemPath,
          body: fileMetadataText(metadata ?? null, locale),
          ...filePanelSearchControls(locale, itemPath),
          actions: [
            {
              id: "copy-current-path",
              label: locale === "zh" ? "复制到 .copy" : "Copy to .copy",
            },
            ...(filePanelSearchControls(locale, itemPath).actions ?? []),
          ],
          items:
            entries.length > 0
              ? entries
              : [{ label: locale === "zh" ? "目录为空" : "Empty directory" }],
        });
        return;
      }

      setCapabilityPanel({
        title: locale === "zh" ? "文件" : "Files",
        subtitle: itemPath,
        body: locale === "zh" ? "正在读取..." : "Reading...",
      });
      const [response, metadata] = await Promise.all([
        clientRef.current?.readFile(itemPath),
        clientRef.current?.getMetadata(itemPath),
      ]);
      const fileText = response ? decodeBase64Text(response.dataBase64) : "";
      const metadataText = fileMetadataText(metadata ?? null, locale);
      if (item.intent === "attach-context") {
        const contextText = fileText.trim();
        const excerpt =
          contextText.length > 2400
            ? `${contextText.slice(0, 2400)}\n...`
            : contextText;
        const contextBlock = [
          locale === "zh"
            ? `请参考以下工作区上下文文件：${itemPath}`
            : `Use this workspace context file: ${itemPath}`,
          "",
          "```markdown",
          excerpt || (locale === "zh" ? "文件为空" : "Empty file"),
          "```",
        ].join("\n");
        setComposerValue((currentValue) =>
          currentValue.trim()
            ? `${currentValue.trim()}\n\n${contextBlock}`
            : contextBlock,
        );
        setPendingContextFile({ path: itemPath, text: contextText });
      }
      setCapabilityPanel({
        title: item.label.trim(),
        subtitle: itemPath,
        body: [
          metadataText,
          item.intent === "attach-context"
            ? locale === "zh"
              ? "已加入输入框，发送后会随请求进入后端 turn/start。"
              : "Added to the composer. It will be sent through backend turn/start."
            : null,
          fileText.length > 12000
            ? `${fileText.slice(0, 12000)}\n...`
            : fileText || (locale === "zh" ? "文件为空" : "Empty file"),
        ]
          .filter(Boolean)
          .join("\n\n"),
        actions: [
          ...(item.intent === "attach-context"
            ? [
                {
                  id: "send-context-to-thread",
                  label:
                    locale === "zh"
                      ? "发送到后端会话"
                      : "Send to backend thread",
                  tone: "primary" as const,
                },
              ]
            : []),
          {
            id: "copy-current-path",
            label: locale === "zh" ? "复制到 .copy" : "Copy to .copy",
          },
          ...(filePanelSearchControls(locale, pathDirName(itemPath)).actions ?? []),
        ],
      });
    } catch (error) {
      setCapabilityPanel({
        title: locale === "zh" ? "文件" : "Files",
        subtitle: item.path,
        error:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "读取失败"
              : "Unable to read",
      });
    } finally {
      setBusyToolId(null);
    }
  }

  return (
    <div
      className="app-shell"
      data-inspector-open={inspectorOpen}
      data-right-sidebar-open={
        capabilityDockOpen && Boolean(capabilityPanel) && appView !== "settings"
      }
      data-sidebar-open={sidebarOpen}
    >
      <TitleBar
        capabilityDockOpen={capabilityDockOpen}
        inspectorOpen={inspectorOpen}
        locale={locale}
        platform={platform}
        sidebarOpen={sidebarOpen}
        theme={theme}
        title={titlebarTitle}
        hideSidebarLabel={t.hideSidebar}
        capabilityLabel={locale === "zh" ? "能力" : "Capabilities"}
        inspectorLabel={locale === "zh" ? "环境信息" : "Environment"}
        languageLabel={t.language}
        showSidebarLabel={t.showSidebar}
        themeLabel={theme === "light" ? t.themeDark : t.themeLight}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onToggleCapabilityDock={toggleCapabilityDock}
        onToggleInspector={toggleInspector}
        onLocaleChange={changeLocale}
        onToggleTheme={toggleTheme}
      />
      <div className="workspace">
        {notice ? (
          <div className="notice-stack">
            <div
              className="connection-notice"
              data-tone={notice.tone}
              role="status"
            >
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{notice.text}</span>
              <button
                type="button"
                aria-label={t.dismiss}
                title={t.dismiss}
                onClick={() => setNotice(null)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          </div>
        ) : null}
        {sidebarOpen ? (
          <button
            className="sidebar-scrim"
            type="button"
            aria-label={t.hideSidebar}
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}
        {appView === "settings" ? (
          <SettingsSidebar
            activeSection={settingsSection}
            locale={locale}
            onBack={closeSettings}
            onSectionChange={openSettingsSection}
          />
        ) : null}
        {appView !== "settings" ? (
          <Sidebar
            threads={threads}
            selectedThreadId={selectedThreadId}
            clearSearchLabel={t.clearSearch}
            newThreadLabel={t.newThread}
            newThreadShortcutLabel={newThreadShortcutLabel}
            noThreadsFoundLabel={t.noThreadsFound}
            searchPlaceholder={t.searchThreads}
            searchShortcutLabel={searchShortcutLabel}
            settingsLabel={t.settings}
            threadsSectionLabel={t.threadsSection}
            untitledThreadLabel={t.untitledThread}
            workspaceLabel={t.workspaceLabel}
            archiveThreadLabel={
              locale === "zh" ? "归档会话" : "Archive session"
            }
            deleteThreadLabel={
              locale === "zh" ? "删除会话" : "Delete session"
            }
            renameThreadLabel={
              locale === "zh" ? "重命名会话" : "Rename session"
            }
            archivedThreadsLabel={locale === "zh" ? "已归档" : "Archived"}
            activeThreadsLabel={locale === "zh" ? "活跃会话" : "Active"}
            activeLibraryKind={
              appView === "library" ? libraryPanel?.kind : null
            }
            showArchived={showArchivedThreads}
            isLoading={connectionState === "connecting" || isSearchingThreads}
            searchValue={threadSearchTerm}
            locale={locale}
            loadingThreadsLabel={t.loadingThreads}
            onSelectThread={selectThread}
            onNewThread={startDraftThread}
            onArchiveThread={archiveThread}
            onDeleteThread={deleteArchivedThread}
            onAgents={() => void openLibrary("agents")}
            onAutomation={() => void openLibrary("automation")}
            onOffice={() => void openLibrary("office")}
            onPlugins={() => void openLibrary("plugins")}
            onKnowledge={() => void openLibrary("knowledge")}
            onSearchChange={setThreadSearchTerm}
            onRenameThread={renameThread}
            onSettings={openSettings}
            onTools={() => void openLibrary("tools")}
            onToggleArchived={toggleArchivedThreads}
          />
        ) : null}
        {appView === "settings" ? (
          <SettingsView
            disabled={!isConnected && !isDemo}
            locale={locale}
            panel={capabilityPanel}
            onPanelAction={handleCapabilityPanelAction}
            onPanelFieldChange={handleCapabilityPanelFieldChange}
          />
        ) : appView === "library" && libraryPanel ? (
          renderLibraryView(
            libraryPanel,
            locale,
            closeLibrary,
            openLibraryItem,
            handleLibraryPanelAction,
            handleCapabilityPanelFieldChange,
            sendOfficeMessage,
            updateAgentConfig,
            toggleAgentCapability,
            saveAgentConfig,
            handleApprovalDecision,
            handleOfficeArtifact,
            handleKnowledgePath,
          )
        ) : (
          <section
            className="conversation-surface"
            data-mode={workMode}
            data-state={selectedThread ? "thread" : "start"}
          >
            <Transcript
              commandLabel={t.command}
              crewonLabel={t.crewon}
              emptyDescription={t.emptyDescription}
              emptyThreadDescription={t.emptyThreadDescription}
              emptyThreadTitle={t.emptyThreadTitle}
              emptyTitle={t.emptyTitle}
              filesLabel={t.files}
              locale={locale}
              mode={workMode}
              modeCodeLabel={t.modeCode}
              modeCodeDescription={t.modeCodeDescription}
              modeOfficeLabel={t.modeOffice}
              modeOfficeDescription={t.modeOfficeDescription}
              modeTitleLabel={t.modeTitle}
              onModeChange={changeWorkMode}
              planLabel={t.plan}
              reasoningLabel={t.reasoning}
              thread={selectedThread}
              streamingText={
                selectedThreadId
                  ? (streamingTextByThread[selectedThreadId] ?? "")
                  : ""
              }
              youLabel={t.you}
            />
            <Composer
              attachContextLabel={t.attachContext}
              autoModeLabel={t.autoMode}
              connectionStatusLabel={t.connectionHints[connectionState]}
              connectionTone={connectionState}
              disabled={
                connectionState === "connecting" ||
                isSending
              }
              cwd={cwd}
              draftUnsavedLabel={t.draftUnsaved}
              focusSignal={composerFocusSignal}
              noWorkspaceSelectedLabel={t.noWorkspaceSelected}
              placeholder={t.askPlaceholder}
              retryConnectionLabel={t.retryConnection}
              sendLabel={t.send}
              sendShortcutLabel={sendShortcutLabel}
              stopLabel={locale === "zh" ? "停止当前任务" : "Stop current turn"}
              isRunning={Boolean(activeTurnId)}
              busyStatusLabel={
                activeTurnId
                  ? locale === "zh"
                    ? "正在执行"
                    : "Running"
                  : isSending
                    ? t.sending
                    : t.connecting
              }
              threadSettingsLabel={t.threadSettings}
              value={composerValue}
              onAttachContext={attachWorkspaceContext}
              onChange={setComposerValue}
              onRetryConnection={retryConnection}
              onSend={sendMessage}
              onThreadSettings={openThreadSettingsPanel}
              onStop={interruptActiveTurn}
            />
          </section>
        )}
        {capabilityDockOpen && capabilityPanel && appView !== "settings" ? (
          <aside
            className="right-sidebar"
            aria-label={locale === "zh" ? "右栏" : "Right sidebar"}
          >
            <CapabilityDock
              locale={locale}
              disabled={!isConnected && !isDemo}
              busyToolId={busyToolId}
              commandValue={terminalCommand}
              panel={capabilityPanel}
              onCommandChange={setTerminalCommand}
              onCommandSubmit={runTerminalStatus}
              onFiles={readWorkspaceFiles}
              onPanelAction={handleCapabilityPanelAction}
              onPanelFieldChange={handleCapabilityPanelFieldChange}
              onPanelItem={handleCapabilityPanelItem}
              onReview={startReview}
              onSideChat={startSideChat}
              onTerminal={runTerminalStatus}
              onWeb={loadBrowserApps}
            />
          </aside>
        ) : null}
        {inspectorOpen && appView === "chat" ? (
          <Inspector
            account={accountStatus}
            conversationSummary={conversationSummary}
            gitRemoteDiff={gitRemoteDiff}
            loadedThreadIds={loadedThreadIds}
            locale={locale}
            serverUrl={serverUrl}
            thread={selectedThread}
            threadGoal={threadGoal}
          />
        ) : null}
      </div>
    </div>
  );
}
