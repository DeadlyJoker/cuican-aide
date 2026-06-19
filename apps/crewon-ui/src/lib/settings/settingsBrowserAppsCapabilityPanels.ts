import type { AppsListResponse } from "@crewon-protocol/v2/AppsListResponse";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";

export function browserAppsSettingsText(
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
      app.distributionChannel ? `  channel: ${app.distributionChannel}` : null,
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

function browserAppsTitle(locale: Locale): string {
  return locale === "zh" ? "浏览器" : "Browser";
}

function browserAppsSubtitle(locale: Locale): string {
  return locale === "zh" ? "应用连接器" : "App connectors";
}

export function browserAppsDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: browserAppsTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function browserAppsLoadingPanel(locale: Locale): CapabilityPanel {
  return {
    title: browserAppsTitle(locale),
    subtitle: browserAppsSubtitle(locale),
    body: locale === "zh" ? "正在读取应用..." : "Reading apps...",
  };
}

export function browserAppsPanel(
  response: AppsListResponse | null,
  locale: Locale,
): CapabilityPanel {
  const apps = response?.data ?? [];
  const enabledCount = apps.filter((app) => app.isEnabled).length;
  const accessibleCount = apps.filter((app) => app.isAccessible).length;
  return {
    title: browserAppsTitle(locale),
    subtitle:
      locale === "zh"
        ? `${apps.length} 应用 · ${enabledCount} 启用 · ${accessibleCount} 可访问`
        : `${apps.length} apps · ${enabledCount} enabled · ${accessibleCount} accessible`,
    body: browserAppsSettingsText(response, locale),
    actions: [
      {
        id: "refresh-browser-apps",
        label: locale === "zh" ? "刷新应用" : "Refresh apps",
      },
    ],
  };
}

export function browserAppsErrorPanel(
  error: unknown,
  locale: Locale,
): CapabilityPanel {
  return {
    title: browserAppsTitle(locale),
    subtitle: browserAppsSubtitle(locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取应用失败"
          : "Unable to read apps",
  };
}
