import type { Locale } from "../i18n";

const CONTEXT_POLICY_LABELS: Record<string, { zh: string; en: string }> = {
  isolated: { zh: "独立上下文", en: "Isolated context" },
  forkLastN: { zh: "继承最近上下文", en: "Forks recent context" },
  sharedDigest: { zh: "共享摘要", en: "Shared digest" },
};

const MEMORY_SCOPE_LABELS: Record<string, { zh: string; en: string }> = {
  private: { zh: "私有记忆", en: "Private memory" },
  shared: { zh: "共享记忆", en: "Shared memory" },
  privateAndShared: { zh: "私有 + 共享记忆", en: "Private + shared memory" },
};

/**
 * Humanizes raw runtime policy values (for example `sharedDigest`) for the
 * members panel. Unknown values pass through unchanged so new backend
 * policies stay visible instead of disappearing.
 */
export function officeMemberRuntimeLabel(
  kind: "contextPolicy" | "memoryScope",
  value: string,
  locale: Locale,
): string {
  const table =
    kind === "contextPolicy" ? CONTEXT_POLICY_LABELS : MEMORY_SCOPE_LABELS;
  const label = table[value];
  if (!label) {
    return value;
  }
  return locale === "zh" ? label.zh : label.en;
}
