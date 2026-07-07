import type { AppsListResponse } from "@crewon-protocol/v2/AppsListResponse";
import type { ConfigRequirementsReadResponse } from "@crewon-protocol/v2/ConfigRequirementsReadResponse";
import type { GetAccountResponse } from "@crewon-protocol/v2/GetAccountResponse";
import type { GetAuthStatusResponse } from "@crewon-protocol/GetAuthStatusResponse";
import type { ModelProviderCapabilitiesReadResponse } from "@crewon-protocol/v2/ModelProviderCapabilitiesReadResponse";
import type { PluginListResponse } from "@crewon-protocol/v2/PluginListResponse";

import { accountStatusText } from "../account/accountSummaryText";
import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";

export function environmentSettingsText(
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

function environmentTitle(locale: Locale): string {
  return locale === "zh" ? "环境" : "Environment";
}

function environmentSubtitle(cwd: string | null, locale: Locale): string {
  return cwd || (locale === "zh" ? "全局环境" : "Global environment");
}

export function environmentDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: environmentTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function environmentLoadingPanel(
  cwd: string | null,
  locale: Locale,
): CapabilityPanel {
  return {
    title: environmentTitle(locale),
    subtitle: environmentSubtitle(cwd, locale),
    body:
      locale === "zh"
        ? "正在读取环境能力..."
        : "Reading environment capabilities...",
  };
}

export function environmentPanel(params: {
  cwd: string | null;
  error?: string;
  locale: Locale;
  readiness: string | null;
  readinessError: string | null;
  requirements: ConfigRequirementsReadResponse | null;
}): CapabilityPanel {
  const { cwd, error, locale, readiness, readinessError, requirements } = params;
  const allowedWindowsSandbox =
    requirements?.requirements?.allowedWindowsSandboxImplementations ?? [];

  return {
    title: environmentTitle(locale),
    subtitle: environmentSubtitle(cwd, locale),
    body: environmentSettingsText(requirements, readiness, readinessError, locale),
    actions: [
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
    ],
    error,
  };
}

export type WindowsSandboxSetupMode = "elevated" | "unelevated";

export function windowsSandboxSetupProgressBody(
  mode: WindowsSandboxSetupMode,
  locale: Locale,
): string {
  return locale === "zh"
    ? `正在启动 Windows 沙箱配置：${mode}`
    : `Starting Windows sandbox setup: ${mode}`;
}

export function windowsSandboxSetupProgressPanel(
  panel: CapabilityPanel | null,
  mode: WindowsSandboxSetupMode,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        body: windowsSandboxSetupProgressBody(mode, locale),
        error: undefined,
      }
    : panel;
}

export function windowsSandboxSetupNoticeText(
  started: boolean | null | undefined,
  locale: Locale,
): string {
  return locale === "zh"
    ? `Windows 沙箱配置${started ? "已启动" : "未启动"}`
    : `Windows sandbox setup ${started ? "started" : "did not start"}`;
}

export function windowsSandboxSetupNotice(
  started: boolean | null | undefined,
  locale: Locale,
): NoticeState {
  return {
    text: windowsSandboxSetupNoticeText(started, locale),
    tone: started ? "success" : "warning",
  };
}

export function windowsSandboxSetupFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "启动 Windows 沙箱配置失败"
      : "Unable to start Windows sandbox setup";
}

export function windowsSandboxSetupFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        error: windowsSandboxSetupFailureMessage(error, locale),
      }
    : panel;
}

export function appSnapshotsSettingsText(
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

function appSnapshotsTitle(locale: Locale): string {
  return locale === "zh" ? "应用快照" : "App snapshots";
}

function appSnapshotsSubtitle(locale: Locale): string {
  return locale === "zh" ? "策略与状态" : "Policy and status";
}

export function appSnapshotsDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: appSnapshotsTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function appSnapshotsLoadingPanel(locale: Locale): CapabilityPanel {
  return {
    title: appSnapshotsTitle(locale),
    subtitle: appSnapshotsSubtitle(locale),
    body:
      locale === "zh"
        ? "正在读取应用快照策略..."
        : "Reading app snapshot policy...",
  };
}

export function appSnapshotsPanel(
  requirements: ConfigRequirementsReadResponse | null,
  locale: Locale,
): CapabilityPanel {
  const allowed = requirements?.requirements?.allowAppshots;
  return {
    title: appSnapshotsTitle(locale),
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
  };
}

export function appSnapshotsErrorPanel(
  error: unknown,
  locale: Locale,
): CapabilityPanel {
  return {
    title: appSnapshotsTitle(locale),
    subtitle: appSnapshotsSubtitle(locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取应用快照策略失败"
          : "Unable to read app snapshot policy",
  };
}

export function connectionsSettingsText(
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
      auth?.requiresOpenaiAuth === null ||
      auth?.requiresOpenaiAuth === undefined
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

function connectionsTitle(locale: Locale): string {
  return locale === "zh" ? "连接" : "Connections";
}

export function connectionsDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: connectionsTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function connectionsLoadingPanel(
  cwd: string | null,
  locale: Locale,
): CapabilityPanel {
  return {
    title: connectionsTitle(locale),
    subtitle: cwd || (locale === "zh" ? "全局连接" : "Global connections"),
    body:
      locale === "zh" ? "正在读取连接状态..." : "Reading connection status...",
  };
}

export function connectionsPanel(params: {
  account: GetAccountResponse | null;
  apps: AppsListResponse | null;
  auth: GetAuthStatusResponse | null;
  errors: string[];
  locale: Locale;
  plugins: PluginListResponse | null;
  providerCapabilities: ModelProviderCapabilitiesReadResponse | null;
  requirements: ConfigRequirementsReadResponse | null;
}): CapabilityPanel {
  const {
    account,
    apps,
    auth,
    errors,
    locale,
    plugins,
    providerCapabilities,
    requirements,
  } = params;

  return {
    title: connectionsTitle(locale),
    subtitle:
      locale === "zh"
        ? `${apps?.data.length ?? 0} 应用 · ${(plugins?.marketplaces ?? []).length} 市场 · ${auth?.authMethod ?? "unknown"}`
        : `${apps?.data.length ?? 0} apps · ${(plugins?.marketplaces ?? []).length} marketplaces · ${auth?.authMethod ?? "unknown"}`,
    body: connectionsSettingsText(
      account,
      auth,
      providerCapabilities,
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
  };
}
