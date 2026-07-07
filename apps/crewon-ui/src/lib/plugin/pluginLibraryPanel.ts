import type { PluginSource } from "@crewon-protocol/v2/PluginSource";

import type { LibraryItem, LibraryPanelAction } from "../domain/crewonDomain";
import { libraryToolDecor } from "../domain/domainLibraryItems";
import type { Locale } from "../i18n";
import {
  pluginCapabilityItemAction,
  pluginEnabledLabel,
  pluginInstalledLabel,
  pluginSourceLabel,
} from "./pluginPanelActions";

type PluginLibraryPlugin = {
  name: string;
  localVersion: string | null;
  source: PluginSource;
  installed: boolean;
  enabled: boolean;
  keywords: string[];
  shareContext?: { creatorName: string | null } | null;
};

type PluginLibraryMarketplace = {
  name: string;
  path: string | null;
  interface?: { displayName: string | null } | null;
  plugins: PluginLibraryPlugin[];
};

type PluginLibraryLoadError = {
  marketplacePath: string;
  message: string;
};

type PluginLibraryPanelContent = {
  subtitle: string;
  body: string;
  actions: LibraryPanelAction[];
  items: LibraryItem[];
  error?: string;
};

export function buildPluginLibraryPanelContent(
  marketplaces: PluginLibraryMarketplace[],
  marketplaceLoadErrors: PluginLibraryLoadError[],
  locale: Locale,
): PluginLibraryPanelContent {
  const pluginEntries = marketplaces.flatMap((marketplace) =>
    marketplace.plugins.map((plugin) => ({ marketplace, plugin })),
  );
  const installedCount = pluginEntries.filter(
    ({ plugin }) => plugin.installed,
  ).length;
  const enabledCount = pluginEntries.filter(({ plugin }) => plugin.enabled).length;
  const pluginItems = pluginLibraryItems(marketplaces, locale);

  return {
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
      pluginItems.length > 0 ? pluginItems : [emptyPluginLibraryItem(locale)],
    error: marketplaceLoadErrors.length
      ? marketplaceLoadErrors
          .map(
            (loadError) =>
              `${loadError.marketplacePath}: ${loadError.message}`,
          )
          .join("\n")
      : undefined,
  };
}

function pluginLibraryItems(
  marketplaces: PluginLibraryMarketplace[],
  locale: Locale,
): LibraryItem[] {
  let pluginAccentIndex = 0;
  return marketplaces.flatMap((marketplace) => {
    const marketplaceTitle =
      marketplace.interface?.displayName || marketplace.name;
    const marketplaceItems = marketplace.plugins.map((plugin) => {
      const decor = libraryToolDecor("plugin", pluginAccentIndex++);
      const source = pluginSourceLabel(plugin.source, locale);
      const version = plugin.localVersion ? ` · v${plugin.localVersion}` : "";
      return {
        title: plugin.name,
        meta: `${source}${version} · ${pluginEnabledLabel(plugin.enabled, locale)} · ${pluginInstalledLabel(plugin.installed, locale)}`,
        description:
          plugin.keywords.length > 0
            ? plugin.keywords.join(", ")
            : plugin.shareContext?.creatorName
              ? `${locale === "zh" ? "创建者" : "Creator"}: ${plugin.shareContext.creatorName}`
              : undefined,
        glyph: decor.glyph,
        accent: decor.accent,
        badge: {
          label: pluginInstalledLabel(plugin.installed, locale),
          tone: plugin.installed ? "running" : "idle",
        },
        tags: plugin.keywords.slice(0, 3),
        action: pluginCapabilityItemAction(marketplace, plugin),
      } satisfies LibraryItem;
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
}

function emptyPluginLibraryItem(locale: Locale): LibraryItem {
  return {
    title: locale === "zh" ? "暂无插件" : "No plugins",
    meta: locale === "zh" ? "后端已连接" : "backend connected",
    description:
      locale === "zh"
        ? "当前工作区没有可用插件市场或插件条目。"
        : "No plugin marketplace or plugin entry is available for the current workspace.",
    section: true,
  };
}
