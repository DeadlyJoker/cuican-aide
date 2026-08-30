import type { AppsListResponse } from "@crewon/app-server-protocol/v2/AppsListResponse";
import type { HooksListResponse } from "@crewon/app-server-protocol/v2/HooksListResponse";

import type {
  RemoteControlClient,
  RemoteControlPairingStartResponse,
  RemoteControlPairingStatusResponse,
  RemoteControlStatusResponse,
} from "../app-server/appServer";
import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";

export * from "./settingsBrowserAppsCapabilityPanels";
export * from "./settingsMcpCapabilityPanels";

type IntegrationApp = AppsListResponse["data"][number];
type IntegrationHook = HooksListResponse["data"][number]["hooks"][number];

function integrationsTitle(locale: Locale): string {
  return locale === "zh" ? "集成" : "Integrations";
}

function integrationsSubtitle(locale: Locale): string {
  return locale === "zh" ? "应用与 Hook" : "Apps and hooks";
}

export function integrationsDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: integrationsTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function integrationsLoadingPanel(locale: Locale): CapabilityPanel {
  return {
    title: integrationsTitle(locale),
    subtitle: integrationsSubtitle(locale),
    body: locale === "zh" ? "正在读取集成..." : "Reading integrations...",
  };
}

function integrationAppLine(app: IntegrationApp, locale: Locale): string {
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
}

function integrationHookLine(hook: IntegrationHook): string {
  return `- ${hook.eventName}: ${hook.handlerType} · ${
    hook.enabled ? "enabled" : "disabled"
  }`;
}

export function integrationsPanel(params: {
  apps: IntegrationApp[];
  errors: string[];
  hooks: IntegrationHook[];
  locale: Locale;
}): CapabilityPanel {
  const { apps, errors, hooks, locale } = params;
  const appLines = apps
    .slice(0, 12)
    .map((app) => integrationAppLine(app, locale));
  const hookLines = hooks.slice(0, 12).map(integrationHookLine);

  return {
    title: integrationsTitle(locale),
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
  };
}

export function integrationsErrorPanel(
  error: unknown,
  locale: Locale,
): CapabilityPanel {
  return {
    title: integrationsTitle(locale),
    subtitle: integrationsSubtitle(locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取集成失败"
          : "Unable to read integrations",
  };
}

export function remoteControlSettingsText(
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

function computerControlTitle(locale: Locale): string {
  return locale === "zh" ? "电脑操控" : "Computer control";
}

function computerControlSubtitle(locale: Locale): string {
  return locale === "zh"
    ? "远程控制与配对设备"
    : "Remote control and paired clients";
}

export function computerControlDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: computerControlTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function computerControlLoadingPanel(locale: Locale): CapabilityPanel {
  return {
    title: computerControlTitle(locale),
    subtitle: computerControlSubtitle(locale),
    body:
      locale === "zh"
        ? "正在读取电脑操控状态..."
        : "Reading computer control status...",
  };
}

export function computerControlPanel(params: {
  clientError: string | null;
  clients: RemoteControlClient[];
  locale: Locale;
  status: RemoteControlStatusResponse | null;
}): CapabilityPanel {
  const { clientError, clients, locale, status } = params;
  const isActive =
    status?.status === "connected" || status?.status === "connecting";
  const hasRevocableClient = Boolean(
    status?.environmentId && clients.length > 0,
  );

  return {
    title: computerControlTitle(locale),
    subtitle:
      locale === "zh"
        ? `${status?.status ?? "unknown"} · ${clients.length} 设备`
        : `${status?.status ?? "unknown"} · ${clients.length} clients`,
    body: remoteControlSettingsText(status, clients, clientError, locale),
    fields: hasRevocableClient
      ? [
          {
            id: "remote-control-revoke-client",
            label: locale === "zh" ? "选择设备" : "Choose a device",
            options: clients.map((client) => ({
              label:
                client.displayName ||
                client.deviceModel ||
                client.platform ||
                (locale === "zh" ? "已添加设备" : "Added device"),
              value: client.clientId,
            })),
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
        id: isActive ? "disable-remote-control" : "enable-remote-control",
        label: isActive
          ? locale === "zh"
            ? "停用远程控制"
            : "Disable remote control"
          : locale === "zh"
            ? "启用远程控制"
            : "Enable remote control",
        tone: isActive ? "danger" : "primary",
      },
      {
        id: "start-remote-pairing",
        label: locale === "zh" ? "开始配对" : "Start pairing",
      },
      ...(hasRevocableClient
        ? [
            {
              id: "revoke-remote-client",
              label: locale === "zh" ? "撤销设备" : "Revoke client",
              tone: "danger" as const,
            },
          ]
        : []),
    ],
  };
}

export function computerControlErrorPanel(
  error: unknown,
  locale: Locale,
): CapabilityPanel {
  return {
    title: computerControlTitle(locale),
    subtitle: computerControlSubtitle(locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取电脑操控失败"
          : "Unable to read computer control",
  };
}

export type RemoteControlToggleAction = "disable" | "enable";

export function remoteControlToggleProgressBody(
  action: RemoteControlToggleAction,
  locale: Locale,
): string {
  if (action === "enable") {
    return locale === "zh"
      ? "正在启用远程控制..."
      : "Enabling remote control...";
  }
  return locale === "zh"
    ? "正在停用远程控制..."
    : "Disabling remote control...";
}

export function remoteControlToggleProgressPanel(
  panel: CapabilityPanel | null,
  action: RemoteControlToggleAction,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        body: remoteControlToggleProgressBody(action, locale),
        error: undefined,
      }
    : panel;
}

export function remoteControlStatusNoticeText(
  status: string | null | undefined,
  locale: Locale,
): string {
  return locale === "zh"
    ? `远程控制状态：${status ?? "unknown"}`
    : `Remote control: ${status ?? "unknown"}`;
}

export function remoteControlStatusNotice(
  status: string | null | undefined,
  locale: Locale,
): NoticeState {
  return {
    text: remoteControlStatusNoticeText(status, locale),
    tone: status === "errored" ? "warning" : "success",
  };
}

export function remoteControlUpdateFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "更新远程控制状态失败"
      : "Unable to update remote control";
}

export function remoteControlUpdateFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        error: remoteControlUpdateFailureMessage(error, locale),
      }
    : panel;
}

export function remoteControlPairingProgressBody(locale: Locale): string {
  return locale === "zh" ? "正在创建配对码..." : "Creating pairing code...";
}

export function remoteControlPairingProgressPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        body: remoteControlPairingProgressBody(locale),
        error: undefined,
      }
    : panel;
}

export function remoteControlPairingPanel(params: {
  locale: Locale;
  response: RemoteControlPairingStartResponse | null | undefined;
  status: RemoteControlPairingStatusResponse | null | undefined;
}): CapabilityPanel {
  const { locale, response, status } = params;
  return {
    title: computerControlTitle(locale),
    subtitle: locale === "zh" ? "配对码已创建" : "Pairing code created",
    body: [
      locale === "zh" ? "远程控制配对" : "Remote control pairing",
      `${locale === "zh" ? "配对码" : "Pairing code"}: ${response?.pairingCode ?? ""}`,
      response?.manualPairingCode
        ? `${locale === "zh" ? "手动配对码" : "Manual pairing code"}: ${response.manualPairingCode}`
        : null,
      `${locale === "zh" ? "环境 ID" : "Environment ID"}: ${
        response?.environmentId ?? ""
      }`,
      response?.expiresAt
        ? `${locale === "zh" ? "过期时间" : "Expires"}: ${new Date(
            response.expiresAt * 1000,
          ).toLocaleString()}`
        : null,
      `${locale === "zh" ? "是否已认领" : "Claimed"}: ${
        status?.claimed ? "yes" : "no"
      }`,
    ]
      .filter(Boolean)
      .join("\n"),
    actions: [
      {
        id: "refresh-computer-control",
        label: locale === "zh" ? "返回电脑操控" : "Back to computer control",
      },
    ],
    fields: undefined,
    error: undefined,
  };
}

export function remoteControlPairingResultPanel(
  panel: CapabilityPanel | null,
  params: {
    locale: Locale;
    response: RemoteControlPairingStartResponse | null | undefined;
    status: RemoteControlPairingStatusResponse | null | undefined;
  },
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        ...remoteControlPairingPanel(params),
      }
    : panel;
}

export function remoteControlPairingFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "创建配对码失败"
      : "Unable to create pairing code";
}

export function remoteControlPairingFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        error: remoteControlPairingFailureMessage(error, locale),
      }
    : panel;
}

export function remoteControlRevokeMissingClientMessage(
  locale: Locale,
): string {
  return locale === "zh"
    ? "缺少环境 ID 或设备 ID"
    : "Missing environment ID or client ID";
}

export function remoteControlRevokeMissingClientPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        error: remoteControlRevokeMissingClientMessage(locale),
      }
    : panel;
}

export function remoteControlRevokeNoticeText(
  clientId: string,
  locale: Locale,
): string {
  return locale === "zh"
    ? `已撤销设备：${clientId}`
    : `Revoked client: ${clientId}`;
}

export function remoteControlRevokeNotice(
  clientId: string,
  locale: Locale,
): NoticeState {
  return {
    text: remoteControlRevokeNoticeText(clientId, locale),
    tone: "success",
  };
}

export function remoteControlRevokeFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "撤销设备失败"
      : "Unable to revoke client";
}

export function remoteControlRevokeFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        error: remoteControlRevokeFailureMessage(error, locale),
      }
    : panel;
}

export function hooksSettingsText(
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

function hooksTitle(locale: Locale): string {
  return locale === "zh" ? "钩子" : "Hooks";
}

function hooksConfigSubtitle(cwd: string | null, locale: Locale): string {
  return cwd || (locale === "zh" ? "全局配置" : "Global config");
}

export function hooksDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: hooksTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function hooksLoadingPanel(
  cwd: string | null,
  locale: Locale,
): CapabilityPanel {
  return {
    title: hooksTitle(locale),
    subtitle: hooksConfigSubtitle(cwd, locale),
    body: locale === "zh" ? "正在读取 Hook..." : "Reading hooks...",
  };
}

export function hooksPanel(
  response: HooksListResponse | null,
  locale: Locale,
): CapabilityPanel {
  const hooks = (response?.data ?? []).flatMap((entry) => entry.hooks);
  const warnings = (response?.data ?? []).flatMap((entry) => entry.warnings);
  const errors = (response?.data ?? []).flatMap((entry) => entry.errors);
  return {
    title: hooksTitle(locale),
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
  };
}

export function hooksErrorPanel(params: {
  cwd: string | null;
  error: unknown;
  locale: Locale;
}): CapabilityPanel {
  const { cwd, error, locale } = params;
  return {
    title: hooksTitle(locale),
    subtitle: hooksConfigSubtitle(cwd, locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取 Hook 失败"
          : "Unable to read hooks",
  };
}
