import type { FsGetMetadataResponse } from "@crewon/app-server-protocol/v2/FsGetMetadataResponse";
import type { PluginReadResponse } from "@crewon/app-server-protocol/v2/PluginReadResponse";

import type { BackgroundTerminal } from "../app-server/appServer";
import type {
  CapabilityPanel,
  CapabilityPanelAction,
  CapabilityPanelField,
  CapabilityPanelItem,
} from "./capabilityPanelTypes";
import type { Locale } from "../i18n";
import { formatUnixMillis } from "../shared/timeFormatters";

type PanelSearchControls = {
  actions: CapabilityPanelAction[];
  fields: CapabilityPanelField[];
};

type TerminalCommandResponse = {
  exitCode: number;
  stderr?: string | null;
  stdout?: string | null;
};

export function defaultCapabilityPanel(locale: Locale): CapabilityPanel {
  return {
    title: locale === "zh" ? "能力" : "Capabilities",
  };
}

export function fileMetadataText(
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

export function filePanelSearchControls(
  locale: Locale,
  root: string,
  value = "",
): PanelSearchControls {
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

export function backgroundTerminalLabel(
  terminal: BackgroundTerminal,
  locale: Locale,
): string {
  const metrics = [
    terminal.osPid ? `pid ${terminal.osPid}` : null,
    terminal.cpuPercent == null
      ? null
      : `cpu ${terminal.cpuPercent.toFixed(1)}%`,
    terminal.rssKb == null
      ? null
      : `rss ${Math.round(terminal.rssKb / 1024)}MB`,
  ]
    .filter(Boolean)
    .join(" · ");
  const title = terminal.command || terminal.processId;
  const suffix = metrics ? `  ${metrics}` : "";
  const cwd = String(terminal.cwd);
  return `${title}${suffix}\n${locale === "zh" ? "目录" : "cwd"} ${cwd}`;
}

export function backgroundTerminalsLoadingPanel(
  threadId: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: locale === "zh" ? "后台终端" : "Background terminals",
    subtitle: threadId,
    body: locale === "zh" ? "正在读取..." : "Reading...",
  };
}

export function backgroundTerminalsEmptyPanel(locale: Locale): CapabilityPanel {
  return {
    title: locale === "zh" ? "后台终端" : "Background terminals",
    subtitle: locale === "zh" ? "0 个后台任务" : "0 background tasks",
    body:
      locale === "zh"
        ? "当前会话没有后台终端。"
        : "This session has no background terminals.",
    actions: [backgroundTerminalsRefreshAction(locale)],
  };
}

export function backgroundTerminalsPanel(params: {
  locale: Locale;
  terminals: BackgroundTerminal[];
  threadId: string;
}): CapabilityPanel {
  const { locale, terminals, threadId } = params;
  return {
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
      backgroundTerminalsRefreshAction(locale),
      {
        id: "clean-background-terminals",
        label: locale === "zh" ? "清理已结束" : "Clean finished",
      },
    ],
    items: terminals.map(
      (terminal): CapabilityPanelItem => ({
        label: backgroundTerminalLabel(terminal, locale),
        action: {
          type: "background-terminal",
          threadId,
          processId: terminal.processId,
        },
      }),
    ),
  };
}

export function backgroundTerminalsErrorPanel(params: {
  error: unknown;
  locale: Locale;
  threadId: string;
}): CapabilityPanel {
  const { error, locale, threadId } = params;
  return {
    title: locale === "zh" ? "后台终端" : "Background terminals",
    subtitle: threadId,
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取后台终端失败"
          : "Unable to read background terminals",
  };
}

export function terminalRunningPanel(
  cwd: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: locale === "zh" ? "终端" : "Terminal",
    subtitle: cwd,
    commandInput: true,
    body: terminalRunningText(locale),
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
      terminalSendToThreadAction(locale),
      backgroundTerminalAction(locale),
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
  };
}

export function terminalCompletedPanel(params: {
  command: string;
  currentBody?: string;
  locale: Locale;
  response?: TerminalCommandResponse | null;
}): CapabilityPanel {
  const { command, currentBody, locale, response } = params;
  const output = [response?.stdout, response?.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    title: locale === "zh" ? "终端" : "Terminal",
    subtitle: response ? `${command}  exit ${response.exitCode}` : command,
    commandInput: true,
    body:
      (currentBody && currentBody !== terminalRunningText(locale)
        ? currentBody
        : output) || (locale === "zh" ? "无输出" : "No output"),
    actions: [terminalSendToThreadAction(locale), backgroundTerminalAction(locale)],
  };
}

export function terminalErrorPanel(params: {
  command: string;
  error: unknown;
  locale: Locale;
}): CapabilityPanel {
  const { command, error, locale } = params;
  return {
    title: locale === "zh" ? "终端" : "Terminal",
    subtitle: command,
    commandInput: true,
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "命令执行失败"
          : "Command failed",
  };
}

function terminalRunningText(locale: Locale): string {
  return locale === "zh" ? "正在运行..." : "Running...";
}

function terminalSendToThreadAction(locale: Locale): CapabilityPanelAction {
  return {
    id: "send-terminal-to-thread",
    label: locale === "zh" ? "发送到会话" : "Send to session",
  };
}

function backgroundTerminalAction(locale: Locale): CapabilityPanelAction {
  return {
    id: "refresh-background-terminals",
    label: locale === "zh" ? "后台任务" : "Background tasks",
  };
}

function backgroundTerminalsRefreshAction(
  locale: Locale,
): CapabilityPanelAction {
  return {
    id: "refresh-background-terminals",
    label: locale === "zh" ? "刷新" : "Refresh",
  };
}

export function pluginDetailText(
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
