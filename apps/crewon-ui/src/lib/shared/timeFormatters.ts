import type { Locale } from "../i18n";

export function formatUnixSeconds(
  value: number | null | undefined,
  locale: Locale,
): string | null {
  if (!value) {
    return null;
  }

  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1000));
}

export function formatUnixMillis(
  value: number | null | undefined,
  locale: Locale,
): string | null {
  if (!value) {
    return null;
  }

  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
