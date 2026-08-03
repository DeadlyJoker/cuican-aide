import type { GetAccountRateLimitsResponse } from "@crewon-protocol/v2/GetAccountRateLimitsResponse";
import type { GetAccountTokenUsageResponse } from "@crewon-protocol/v2/GetAccountTokenUsageResponse";
import type { GetAuthStatusResponse } from "@crewon-protocol/GetAuthStatusResponse";
import type { ModelListResponse } from "@crewon-protocol/v2/ModelListResponse";
import type { ModelProviderCapabilitiesReadResponse } from "@crewon-protocol/v2/ModelProviderCapabilitiesReadResponse";
import type { PermissionProfileListResponse } from "@crewon-protocol/v2/PermissionProfileListResponse";
import type { RateLimitSnapshot } from "@crewon-protocol/v2/RateLimitSnapshot";

import type { AgentPlatformUser } from "../agent-platform/agentPlatformSession";
import type { AccountStatus } from "../shared/statusTypes";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import { formatUnixSeconds } from "../shared/timeFormatters";

type ChatGptLoginResponse = {
  type: "chatgpt";
  authUrl: string;
  loginId: string;
};

type DeviceCodeLoginResponse = {
  type: "chatgptDeviceCode";
  verificationUrl: string;
  userCode: string;
  loginId: string;
};

type AccountOverviewContent = {
  account: AccountStatus | null;
  authStatus: GetAuthStatusResponse | null;
  capabilities: string;
  errors: string[];
  fallbackAccount: AccountStatus | null;
  platformUser: AgentPlatformUser | null;
  telemetry: string;
};

export function accountPanelTitle(locale: Locale): string {
  return locale === "zh" ? "账号" : "Account";
}

function refreshAccountAction(locale: Locale): CapabilityPanel["actions"] {
  return [
    {
      id: "refresh-account",
      label: locale === "zh" ? "刷新状态" : "Refresh status",
      tone: "primary",
    },
  ];
}

export function accountDisconnectedPanel(
  connectionBody: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: accountPanelTitle(locale),
    subtitle:
      locale === "zh"
        ? "企业身份、模型账号与用量"
        : "Enterprise identity, model account, and usage",
    body: connectionBody,
  };
}

export function accountLoadingPanel(locale: Locale): CapabilityPanel {
  return {
    title: accountPanelTitle(locale),
    subtitle: locale === "zh" ? "认证状态" : "Auth status",
    body: locale === "zh" ? "正在读取..." : "Loading...",
  };
}

export function accountOverviewPanel(
  content: AccountOverviewContent,
  locale: Locale,
): CapabilityPanel {
  const errorText =
    content.errors.length > 0
      ? `${locale === "zh" ? "部分能力读取失败" : "Some reads failed"}\n${content.errors.join("\n")}`
      : "";

  return {
    title: accountPanelTitle(locale),
    subtitle:
      locale === "zh"
        ? "企业身份、模型账号与用量"
        : "Enterprise identity, model account, and usage",
    body: [
      platformIdentityText(content.platformUser, locale),
      [
        locale === "zh" ? "模型账号" : "Model account",
        accountStatusText(content.account ?? content.fallbackAccount, locale),
      ].join("\n"),
      authStatusText(content.authStatus, locale),
      content.capabilities,
      content.telemetry,
      errorText,
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
        label: locale === "zh" ? "退出模型账号" : "Sign out of model account",
        tone: "danger",
      },
      {
        id: "refresh-account",
        label: locale === "zh" ? "刷新" : "Refresh",
      },
    ],
  };
}

export function accountReadErrorPanel(error: unknown, locale: Locale): CapabilityPanel {
  return {
    title: accountPanelTitle(locale),
    subtitle: locale === "zh" ? "认证状态" : "Auth status",
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取账号失败"
          : "Unable to read account",
  };
}

export function accountLoggedOutPanel(
  account: AccountStatus | null,
  locale: Locale,
): CapabilityPanel {
  return {
    title: accountPanelTitle(locale),
    subtitle: locale === "zh" ? "已退出" : "Logged out",
    body: accountStatusText(account, locale),
  };
}

export function accountLoggedInPanel(
  account: AccountStatus | null,
  locale: Locale,
): CapabilityPanel {
  return {
    title: accountPanelTitle(locale),
    subtitle: locale === "zh" ? "已登录" : "Logged in",
    body: accountStatusText(account, locale),
  };
}

export function accountChatGptLoginPanel(
  response: ChatGptLoginResponse,
  locale: Locale,
): CapabilityPanel {
  return {
    title: accountPanelTitle(locale),
    subtitle: locale === "zh" ? "模型账号登录" : "Model login",
    body: `${locale === "zh" ? "打开链接完成登录" : "Open this URL to finish login"}\n${response.authUrl}\nloginId: ${response.loginId}`,
    actions: refreshAccountAction(locale),
  };
}

export function accountDeviceCodeLoginPanel(
  response: DeviceCodeLoginResponse,
  locale: Locale,
): CapabilityPanel {
  return {
    title: accountPanelTitle(locale),
    subtitle: locale === "zh" ? "设备码登录" : "Device code login",
    body: `${locale === "zh" ? "访问链接并输入代码" : "Open the URL and enter the code"}\n${response.verificationUrl}\n${response.userCode}\nloginId: ${response.loginId}`,
    actions: refreshAccountAction(locale),
  };
}

export function accountAuthErrorPanel(
  error: unknown,
  locale: Locale,
): CapabilityPanel {
  return {
    title: accountPanelTitle(locale),
    subtitle: locale === "zh" ? "认证操作" : "Auth action",
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "账号操作失败"
          : "Account action failed",
  };
}

/*
 * The enterprise identity from agent-platform. This is who you are in CrewON;
 * the model account below is a separate, technical credential for inference.
 * The panel used to show only the latter under the title "account", which read
 * as though CrewON had no identity of its own.
 */
export function platformIdentityText(
  user: AgentPlatformUser | null,
  locale: Locale,
): string {
  if (!user) {
    return locale === "zh"
      ? "企业账号：未登录"
      : "Enterprise account: signed out";
  }

  const displayName =
    (user.display_name || user.nickname || user.username).trim() ||
    user.username;
  const wecomLinked = user.linked_providers?.includes("wecom") ?? false;
  const details = [
    user.email,
    locale === "zh"
      ? `角色：${user.role}`
      : `Role: ${user.role}`,
    wecomLinked
      ? locale === "zh"
        ? "企业微信已绑定"
        : "WeCom linked"
      : "",
  ].filter(Boolean);

  return [
    locale === "zh" ? `企业账号：${displayName}` : `Enterprise account: ${displayName}`,
    ...details,
  ].join("\n");
}

export function accountStatusText(
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

export function authStatusText(
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

export function rateLimitText(
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

export function accountTelemetryText(
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

export function workspaceCapabilitiesText(
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
