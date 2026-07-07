import type { PluginReadResponse } from "@crewon-protocol/v2/PluginReadResponse";

import { pluginDetailText } from "../capability/capabilityPanelText";
import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";

type PluginDetailActionContext = {
  marketplacePath?: string | null;
  pluginName: string;
  remoteMarketplaceName?: string | null;
};

type PluginDetailPanelContent = {
  title: string;
  subtitle: string;
  body: string;
  actions?: LibraryPanelAction[];
};

export function buildPluginDetailPanelContent(
  response: PluginReadResponse,
  context: PluginDetailActionContext,
  locale: Locale,
): PluginDetailPanelContent {
  const actions = pluginDetailActions(response, context, locale);
  return {
    title: response.plugin.summary.name,
    subtitle: locale === "zh" ? "插件详情" : "Plugin details",
    body: pluginDetailText(response, locale),
    actions: actions.length > 0 ? actions : undefined,
  };
}

export function pluginDetailLoadingPatch(
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    body:
      locale === "zh" ? "正在读取插件详情..." : "Reading plugin details...",
    error: undefined,
  };
}

export function pluginDetailLoadingPanel(
  panel: LibraryPanel | null,
  locale: Locale,
): LibraryPanel | null {
  return patchPluginDetailPanel(panel, pluginDetailLoadingPatch(locale));
}

export function pluginDetailContentPatch(
  content: PluginDetailPanelContent,
): Partial<LibraryPanel> {
  return {
    title: content.title,
    subtitle: content.subtitle,
    body: content.body,
    actions: content.actions,
  };
}

export function pluginDetailContentPanel(
  panel: LibraryPanel | null,
  content: PluginDetailPanelContent,
): LibraryPanel | null {
  return patchPluginDetailPanel(panel, pluginDetailContentPatch(content));
}

export function pluginDetailFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取插件失败"
          : "Unable to read plugin",
  };
}

export function pluginDetailFailurePanel(
  panel: LibraryPanel | null,
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return patchPluginDetailPanel(panel, pluginDetailFailurePatch(error, locale));
}

function patchPluginDetailPanel(
  panel: LibraryPanel | null,
  patch: Partial<LibraryPanel>,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        ...patch,
      }
    : panel;
}

function pluginDetailActions(
  response: PluginReadResponse,
  context: PluginDetailActionContext,
  locale: Locale,
): LibraryPanelAction[] {
  const { summary } = response.plugin;
  const actions: LibraryPanelAction[] = [];

  if (summary.source.type === "local") {
    actions.push({
      id: "open-path",
      label:
        locale === "zh"
          ? "右栏打开插件目录"
          : "Open plugin folder in sidebar",
      pathToOpen: summary.source.path,
      pathKind: "directory",
    });
  }

  if (summary.installed) {
    actions.push({
      id: "uninstall-plugin",
      label: locale === "zh" ? "卸载插件" : "Uninstall plugin",
      pluginId: summary.id,
      tone: "danger",
    });
    return actions;
  }

  if (
    summary.installPolicy === "AVAILABLE" &&
    summary.availability === "AVAILABLE"
  ) {
    actions.push({
      id: "install-plugin",
      label: locale === "zh" ? "安装插件" : "Install plugin",
      marketplacePath: context.marketplacePath,
      pluginName: context.pluginName,
      remoteMarketplaceName: context.remoteMarketplaceName,
      tone: "primary",
    });
  }

  return actions;
}
