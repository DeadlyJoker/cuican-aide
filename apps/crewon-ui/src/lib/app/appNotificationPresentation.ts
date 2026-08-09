import type { RateLimitSnapshot } from "@crewon-protocol/v2/RateLimitSnapshot";

import type { NoticeState } from "./appRuntimeState";
import type { Locale } from "../i18n";
import { rateLimitText } from "../account/accountSummaryText";

export function accountLoginNotice(
  success: boolean,
  error: string | null | undefined,
  locale: Locale,
): NoticeState {
  return {
    text: success
      ? locale === "zh"
        ? "账号登录完成"
        : "Account login completed"
      : error ||
        (locale === "zh" ? "账号登录失败" : "Account login failed"),
    tone: success ? "success" : "warning",
  };
}

export function accountRateLimitNotice(
  rateLimits: RateLimitSnapshot | null | undefined,
  locale: Locale,
): NoticeState {
  const [firstLine] = rateLimitText(rateLimits, locale);
  return {
    text:
      firstLine ||
      (locale === "zh" ? "账号额度已更新" : "Account rate limits updated"),
    tone: "success",
  };
}

export function configWarningNotice(
  summary: string,
  details: string | null | undefined,
  path: string | null | undefined,
): NoticeState {
  return {
    text: [summary, path, details].filter(Boolean).join("\n"),
    tone: "warning",
  };
}

export function desktopPreferenceSyncFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "同步桌面设置失败"
          : "Unable to sync desktop preference",
    tone: "warning",
  };
}

export function automationRunSyncFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh"
      ? "自动化运行状态同步失败"
      : "Unable to sync automation run status",
  );
}

export function officeRunSyncFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return warningNotice(
    error,
    locale === "zh"
      ? "办公室运行状态同步失败"
      : "Unable to sync office run status",
  );
}

export function appWarningNotice(message: string): NoticeState {
  return {
    text: message,
    tone: "warning",
  };
}

export function connectionLostNotice(message: string): NoticeState {
  return appWarningNotice(message);
}

export function fileChangedNotice(
  changedPaths: string[],
  fallbackPath: string,
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? `文件变化：${changedPaths[0] ?? fallbackPath}`
        : `File changed: ${changedPaths[0] ?? fallbackPath}`,
    tone: "success",
  };
}

export function fileChangedPanelAppendText(
  changedPaths: string[],
  locale: Locale,
): string {
  const changedText = changedPaths.slice(0, 4).join("\n");
  return locale === "zh"
    ? `监听到文件变化：\n${changedText}`
    : `File changes detected:\n${changedText}`;
}

export function mcpOauthNotice(
  name: string,
  success: boolean,
  error: string | null | undefined,
  locale: Locale,
): NoticeState {
  return {
    text: success
      ? locale === "zh"
        ? `${name} 登录完成`
        : `${name} login completed`
      : error ||
        (locale === "zh" ? `${name} 登录失败` : `${name} login failed`),
    tone: success ? "success" : "warning",
  };
}

export function mcpStartupNotice(
  name: string,
  status: string,
  error: string | null | undefined,
): NoticeState {
  return {
    text: error ? `${name}: ${status}\n${error}` : `${name}: ${status}`,
    tone: status === "failed" ? "warning" : "success",
  };
}

export function terminalOutputChunk(
  stream: "stdout" | "stderr",
  text: string,
  capReached: boolean,
): string {
  return `${stream === "stderr" ? "[stderr] " : ""}${text}${capReached ? "\n[output cap reached]" : ""}`;
}

function warningNotice(error: unknown, fallback: string): NoticeState {
  return {
    text: error instanceof Error ? error.message : fallback,
    tone: "warning",
  };
}
