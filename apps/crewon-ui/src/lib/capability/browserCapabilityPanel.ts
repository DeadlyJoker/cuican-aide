import type { PluginSource } from "@crewon-protocol/v2/PluginSource";

import type { CapabilityPanel, CapabilityPanelItem } from "./capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  pluginCapabilityItemAction,
  pluginEnabledLabel,
  pluginSourceLabel,
} from "../plugin/pluginPanelActions";

type BrowserCapabilityApp = {
  id: string;
  name: string;
  isAccessible: boolean;
  isEnabled: boolean;
  pluginDisplayNames: string[];
};

type BrowserCapabilityHook = {
  eventName: string;
  handlerType: string;
  enabled: boolean;
};

type BrowserCapabilityPlugin = {
  name: string;
  source: PluginSource;
  installed: boolean;
  enabled: boolean;
};

type BrowserCapabilityMarketplace = {
  name: string;
  path: string | null;
  plugins: BrowserCapabilityPlugin[];
};

type BrowserCapabilityPanelInput = {
  apps: BrowserCapabilityApp[];
  hookEntries: Array<{ hooks: BrowserCapabilityHook[] }>;
  marketplaces: BrowserCapabilityMarketplace[];
  locale: Locale;
};

type BrowserCapabilityPanelContent = {
  subtitle: string;
  body?: string;
  items: CapabilityPanelItem[];
};

export function browserCapabilityLoadingPanel(locale: Locale): CapabilityPanel {
  return {
    title: browserCapabilityTitle(locale),
    subtitle: browserCapabilitySubtitle(locale),
    body: locale === "zh" ? "正在读取..." : "Loading...",
  };
}

export function browserCapabilityPanel(
  input: BrowserCapabilityPanelInput,
): CapabilityPanel {
  const content = buildBrowserCapabilityPanelContent(input);
  return {
    title: browserCapabilityTitle(input.locale),
    subtitle: content.subtitle,
    body: content.body,
    items: content.items,
  };
}

export function browserCapabilityErrorPanel(
  error: unknown,
  locale: Locale,
): CapabilityPanel {
  return {
    title: browserCapabilityTitle(locale),
    subtitle: browserCapabilitySubtitle(locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取应用失败"
          : "Unable to load apps",
  };
}

export function buildBrowserCapabilityPanelContent({
  apps,
  hookEntries,
  marketplaces,
  locale,
}: BrowserCapabilityPanelInput): BrowserCapabilityPanelContent {
  const hooks = hookEntries.flatMap((entry) => entry.hooks);
  const pluginEntries = marketplaces.flatMap((marketplace) =>
    marketplace.plugins.map((plugin) => ({ marketplace, plugin })),
  );
  const installedPlugins = pluginEntries.filter(
    ({ plugin }) => plugin.installed || plugin.enabled,
  );

  return {
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
    items: [
      ...browserAppItems(apps, locale),
      ...browserPluginItems(installedPlugins, locale),
      ...browserHookItems(hooks, locale),
    ],
  };
}

function browserAppItems(
  apps: BrowserCapabilityApp[],
  locale: Locale,
): CapabilityPanelItem[] {
  if (apps.length === 0) {
    return [{ label: locale === "zh" ? "暂无可用应用" : "No apps available" }];
  }

  return apps.slice(0, 12).map((app) => {
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
        type: "app",
        appId: app.id,
        appName: app.name,
      },
    };
  });
}

function browserPluginItems(
  pluginEntries: Array<{
    marketplace: BrowserCapabilityMarketplace;
    plugin: BrowserCapabilityPlugin;
  }>,
  locale: Locale,
): CapabilityPanelItem[] {
  if (pluginEntries.length === 0) {
    return [{ label: locale === "zh" ? "暂无已启用插件" : "No enabled plugins" }];
  }

  return pluginEntries.slice(0, 12).map(({ marketplace, plugin }) => ({
    label: `${locale === "zh" ? "插件" : "Plugin"} · ${plugin.name} · ${pluginSourceLabel(plugin.source, locale)} · ${pluginEnabledLabel(plugin.enabled, locale)}`,
    action: pluginCapabilityItemAction(marketplace, plugin),
  }));
}

function browserHookItems(
  hooks: BrowserCapabilityHook[],
  locale: Locale,
): CapabilityPanelItem[] {
  if (hooks.length === 0) {
    return [{ label: locale === "zh" ? "暂无 Hook" : "No hooks" }];
  }

  return hooks.slice(0, 8).map((hook) => {
    const status = hook.enabled
      ? locale === "zh"
        ? "启用"
        : "enabled"
      : locale === "zh"
        ? "停用"
        : "disabled";
    return {
      label: `Hook · ${hook.eventName} · ${hook.handlerType} · ${status}`,
    };
  });
}

function browserCapabilityTitle(locale: Locale): string {
  return locale === "zh" ? "浏览器" : "Browser";
}

function browserCapabilitySubtitle(locale: Locale): string {
  return locale === "zh" ? "应用、插件与 Hook" : "Apps, plugins, and hooks";
}
