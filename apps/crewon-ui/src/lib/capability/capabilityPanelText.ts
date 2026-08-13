import type { FsGetMetadataResponse } from "@crewon-protocol/v2/FsGetMetadataResponse";
import type { PluginReadResponse } from "@crewon-protocol/v2/PluginReadResponse";

import type {
  CapabilityPanel,
  CapabilityPanelAction,
  CapabilityPanelField,
} from "./capabilityPanelTypes";
import type { Locale } from "../i18n";
import { formatUnixMillis } from "../shared/timeFormatters";

type PanelSearchControls = {
  actions: CapabilityPanelAction[];
  fields: CapabilityPanelField[];
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
