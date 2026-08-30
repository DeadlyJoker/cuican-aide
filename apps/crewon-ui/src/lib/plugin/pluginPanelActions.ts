import type { PluginMarketplaceEntry } from "@crewon/app-server-protocol/v2/PluginMarketplaceEntry";
import type { PluginInstallResponse } from "@crewon/app-server-protocol/v2/PluginInstallResponse";
import type { PluginReadResponse } from "@crewon/app-server-protocol/v2/PluginReadResponse";
import type { PluginSource } from "@crewon/app-server-protocol/v2/PluginSource";
import type { PluginSummary } from "@crewon/app-server-protocol/v2/PluginSummary";

import { pluginDetailText } from "../capability/capabilityPanelText";
import type { NoticeState } from "../shared/noticeState";
import type {
  CapabilityPanel,
  CapabilityPanelAction,
} from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  libraryActionFallbackErrorText,
  libraryActionProgressText,
  pluginInstallPanelBody,
} from "../library/libraryActionPresentation";
import {
  decodeCapabilityActionPayload,
  encodeCapabilityActionPayload,
} from "../server-request/serverRequestPresentation";

type PluginActionContext = {
  marketplacePath?: string | null;
  pluginName: string;
  remoteMarketplaceName?: string | null;
};

export type PluginPanelAction =
  | {
      type: "install";
      marketplacePath?: string | null;
      pluginName: string;
      remoteMarketplaceName?: string | null;
    }
  | {
      type: "openPath";
      path: string;
    }
  | {
      type: "refreshConnectors";
    }
  | {
      type: "uninstall";
      pluginId: string;
    };

type PluginActionClient = {
  installPlugin(
    pluginName: string,
    marketplacePath?: string | null,
    remoteMarketplaceName?: string | null,
  ): Promise<PluginInstallResponse>;
  uninstallPlugin(pluginId: string): Promise<void>;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

export type PluginPanelActionHandlersParams = {
  client: PluginActionClient | null | undefined;
  loadBrowserApps: () => Promise<void> | void;
  locale: Locale;
  openPluginPath: (path: string) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setNotice: (notice: NoticeState) => void;
};

export function pluginPanelActionForActionId(
  actionId: string,
): PluginPanelAction | null {
  if (actionId === "refresh-connectors") {
    return { type: "refreshConnectors" };
  }

  if (actionId.startsWith("open-plugin-path:")) {
    const payload = decodeCapabilityActionPayload<{ path: string }>(
      actionId.slice("open-plugin-path:".length),
    );
    return payload?.path ? { type: "openPath", path: payload.path } : null;
  }

  if (actionId.startsWith("install-plugin:")) {
    const payload = decodeCapabilityActionPayload<{
      marketplacePath?: string | null;
      pluginName: string;
      remoteMarketplaceName?: string | null;
    }>(actionId.slice("install-plugin:".length));
    return payload?.pluginName
      ? {
          type: "install",
          marketplacePath: payload.marketplacePath ?? null,
          pluginName: payload.pluginName,
          remoteMarketplaceName: payload.remoteMarketplaceName ?? null,
        }
      : null;
  }

  if (actionId.startsWith("uninstall-plugin:")) {
    const payload = decodeCapabilityActionPayload<{ pluginId: string }>(
      actionId.slice("uninstall-plugin:".length),
    );
    return payload?.pluginId
      ? { type: "uninstall", pluginId: payload.pluginId }
      : null;
  }

  return null;
}

export function handlePluginPanelAction(
  params: PluginPanelActionHandlersParams,
  action: PluginPanelAction,
) {
  switch (action.type) {
    case "install":
      installPlugin(params, action);
      return;
    case "openPath":
      params.openPluginPath(action.path);
      return;
    case "refreshConnectors":
      void params.loadBrowserApps();
      return;
    case "uninstall":
      uninstallPlugin(params, action.pluginId);
      return;
  }
}

function installPlugin(
  params: PluginPanelActionHandlersParams,
  action: Extract<PluginPanelAction, { type: "install" }>,
) {
  const { client, loadBrowserApps, locale, setCapabilityPanel } = params;

  setCapabilityPanel((currentPanel) =>
    pluginInstallProgressPanel(currentPanel, action.pluginName, locale),
  );
  void client
    ?.installPlugin(
      action.pluginName,
      action.marketplacePath ?? null,
      action.remoteMarketplaceName ?? null,
    )
    .then((response) => {
      setCapabilityPanel((currentPanel) =>
        pluginInstallSuccessPanel(currentPanel, response, locale),
      );
      void loadBrowserApps();
    })
    .catch((error) => {
      setCapabilityPanel((currentPanel) =>
        pluginInstallFailurePanel(currentPanel, error, locale),
      );
    });
}

function uninstallPlugin(
  params: PluginPanelActionHandlersParams,
  pluginId: string,
) {
  const { client, loadBrowserApps, locale, setCapabilityPanel, setNotice } =
    params;

  setCapabilityPanel((currentPanel) =>
    pluginUninstallProgressPanel(currentPanel, locale),
  );
  void client
    ?.uninstallPlugin(pluginId)
    .then(() => {
      setNotice(pluginUninstallNotice(locale));
      void loadBrowserApps();
    })
    .catch((error) => {
      setCapabilityPanel((currentPanel) =>
        pluginUninstallFailurePanel(currentPanel, error, locale),
      );
    });
}

export function pluginSourceLabel(
  source: PluginSource,
  locale: Locale,
): string {
  if (source.type === "local") {
    return locale === "zh" ? "本地" : "local";
  }
  if (source.type === "git") {
    return "Git";
  }
  return locale === "zh" ? "远程" : "remote";
}

export function pluginEnabledLabel(enabled: boolean, locale: Locale): string {
  return enabled
    ? locale === "zh"
      ? "启用"
      : "enabled"
    : locale === "zh"
      ? "停用"
      : "disabled";
}

export function pluginInstalledLabel(
  installed: boolean,
  locale: Locale,
): string {
  return installed
    ? locale === "zh"
      ? "已安装"
      : "installed"
    : locale === "zh"
      ? "未安装"
      : "not installed";
}

export function pluginCapabilityItemAction(
  marketplace: Pick<PluginMarketplaceEntry, "name" | "path">,
  plugin: Pick<PluginSummary, "name">,
): PluginActionContext & { type: "plugin" } {
  return {
    type: "plugin",
    pluginName: plugin.name,
    marketplacePath: marketplace.path ?? null,
    remoteMarketplaceName: marketplace.path ? null : (marketplace.name ?? null),
  };
}

export function pluginCapabilityPanelActions(
  response: PluginReadResponse,
  context: PluginActionContext,
  locale: Locale,
): CapabilityPanelAction[] {
  const { summary } = response.plugin;
  return [
    ...(summary.source.type === "local"
      ? [
          {
            id: `open-plugin-path:${encodeCapabilityActionPayload({
              path: summary.source.path,
            })}`,
            label: locale === "zh" ? "右栏打开插件目录" : "Open plugin folder",
          },
        ]
      : []),
    ...(summary.installed
      ? [
          {
            id: `uninstall-plugin:${encodeCapabilityActionPayload({
              pluginId: summary.id,
            })}`,
            label: locale === "zh" ? "卸载插件" : "Uninstall plugin",
            tone: "danger" as const,
          },
        ]
      : summary.installPolicy === "AVAILABLE" &&
          summary.availability === "AVAILABLE"
        ? [
            {
              id: `install-plugin:${encodeCapabilityActionPayload({
                marketplacePath: context.marketplacePath ?? null,
                pluginName: context.pluginName,
                remoteMarketplaceName: context.remoteMarketplaceName ?? null,
              })}`,
              label: locale === "zh" ? "安装插件" : "Install plugin",
              tone: "primary" as const,
            },
          ]
    : []),
  ];
}

function pluginDetailSubtitle(locale: Locale): string {
  return locale === "zh" ? "插件详情" : "Plugin details";
}

function refreshConnectorsAction(locale: Locale): CapabilityPanelAction {
  return {
    id: "refresh-connectors",
    label: locale === "zh" ? "返回连接器" : "Back to connectors",
  };
}

export function pluginCapabilityLoadingPanel(
  pluginName: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: pluginName,
    subtitle: pluginDetailSubtitle(locale),
    body: locale === "zh" ? "正在读取..." : "Reading...",
  };
}

export function pluginCapabilityDetailPanel(
  response: PluginReadResponse,
  context: PluginActionContext,
  locale: Locale,
): CapabilityPanel {
  return {
    title: response.plugin.summary.name,
    subtitle: pluginDetailSubtitle(locale),
    body: pluginDetailText(response, locale),
    actions: [
      ...pluginCapabilityPanelActions(response, context, locale),
      refreshConnectorsAction(locale),
    ],
  };
}

export function pluginCapabilityErrorPanel(params: {
  error: unknown;
  locale: Locale;
  pluginName: string;
}): CapabilityPanel {
  const { error, locale, pluginName } = params;
  return {
    title: pluginName,
    subtitle: pluginDetailSubtitle(locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取插件失败"
          : "Unable to read plugin",
    actions: [refreshConnectorsAction(locale)],
  };
}

export function pluginInstallProgressBody(
  pluginName: string,
  locale: Locale,
): string {
  return locale === "zh"
    ? `正在安装插件：${pluginName}`
    : `Installing plugin: ${pluginName}`;
}

export function pluginInstallProgressPanel(
  panel: CapabilityPanel | null,
  pluginName: string,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        body: pluginInstallProgressBody(pluginName, locale),
        error: undefined,
      }
    : panel;
}

export function pluginInstallSuccessBody(
  response: Parameters<typeof pluginInstallPanelBody>[0],
  locale: Locale,
): string {
  return pluginInstallPanelBody(response, locale);
}

export function pluginInstallSuccessPanel(
  panel: CapabilityPanel | null,
  response: Parameters<typeof pluginInstallPanelBody>[0],
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        body: pluginInstallSuccessBody(response, locale),
        error: undefined,
      }
    : panel;
}

export function pluginInstallFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : libraryActionFallbackErrorText("install-plugin", locale);
}

export function pluginInstallFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        error: pluginInstallFailureMessage(error, locale),
      }
    : panel;
}

export function pluginUninstallProgressBody(locale: Locale): string {
  return libraryActionProgressText("uninstall-plugin", locale);
}

export function pluginUninstallProgressPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        body: pluginUninstallProgressBody(locale),
        error: undefined,
      }
    : panel;
}

export function pluginUninstallNoticeText(locale: Locale): string {
  return locale === "zh" ? "插件已卸载" : "Plugin uninstalled";
}

export function pluginUninstallNotice(locale: Locale): NoticeState {
  return {
    text: pluginUninstallNoticeText(locale),
    tone: "success",
  };
}

export function pluginUninstallFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : libraryActionFallbackErrorText("uninstall-plugin", locale);
}

export function pluginUninstallFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        error: pluginUninstallFailureMessage(error, locale),
      }
    : panel;
}
