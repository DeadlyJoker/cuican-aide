import type { RateLimitSnapshot } from "@crewon-protocol/v2/RateLimitSnapshot";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import type { AccountStatus } from "../shared/statusTypes";
import { formatUnixSeconds } from "../shared/timeFormatters";

function accountPanelTitle(locale: Locale): string {
  return locale === "zh" ? "账号" : "Account";
}

export function accountReadErrorPanel(
  error: unknown,
  locale: Locale,
): CapabilityPanel {
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

export function rateLimitText(
  snapshot: RateLimitSnapshot | null | undefined,
  locale: Locale,
): string[] {
  if (!snapshot) return [];
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
