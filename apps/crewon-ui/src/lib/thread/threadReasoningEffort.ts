import type { Locale } from "../i18n";
import type { CommandModelOption } from "./threadRuntimeSettings";

export type CommandReasoningEffortOption = {
  detail?: string;
  label: string;
  value: string;
};

/**
 * Efforts the backend catalog can report. Unknown ids fall through with their
 * raw name so a new backend effort still renders instead of disappearing.
 */
const EFFORT_LABELS: Record<string, { en: string; zh: string }> = {
  minimal: { en: "Minimal", zh: "极低" },
  low: { en: "Low", zh: "低" },
  medium: { en: "Medium", zh: "中" },
  high: { en: "High", zh: "高" },
  xhigh: { en: "Extra high", zh: "极高" },
};

export function reasoningEffortLabel(effort: string, locale: Locale): string {
  const known = EFFORT_LABELS[effort.toLowerCase()];
  if (!known) {
    return effort;
  }
  return locale === "zh" ? known.zh : known.en;
}

/**
 * Efforts supported by one model, in catalog order. Returns an empty list when
 * the model exposes fewer than two efforts, because a single-option selector is
 * noise rather than a choice.
 */
export function commandReasoningEffortOptions(
  options: CommandModelOption[],
  model: string,
  locale: Locale,
): CommandReasoningEffortOption[] {
  const supported =
    options.find((option) => option.value === model)?.reasoningEfforts ?? [];
  if (supported.length < 2) {
    return [];
  }
  return supported.map((effort) => ({
    detail: effort.description || undefined,
    label: reasoningEffortLabel(effort.value, locale),
    value: effort.value,
  }));
}

/**
 * The composer renders model and effort as one label, so a model swap that
 * drops the active effort has to fall back to that model's catalog default.
 */
export function resolveReasoningEffort(
  options: CommandModelOption[],
  model: string,
  currentEffort: string | null,
): string | null {
  const modelOption = options.find((option) => option.value === model);
  if (!modelOption?.reasoningEfforts?.length) {
    return null;
  }
  const supported = modelOption.reasoningEfforts.map((effort) => effort.value);
  if (currentEffort && supported.includes(currentEffort)) {
    return currentEffort;
  }
  return modelOption.defaultReasoningEffort &&
    supported.includes(modelOption.defaultReasoningEffort)
    ? modelOption.defaultReasoningEffort
    : supported[0];
}

export function commandModelEffortLabel({
  effort,
  locale,
  modelLabel,
}: {
  effort: string | null;
  locale: Locale;
  modelLabel: string;
}): string {
  return effort
    ? `${modelLabel} ${reasoningEffortLabel(effort, locale)}`
    : modelLabel;
}
