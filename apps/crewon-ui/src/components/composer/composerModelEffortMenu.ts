import type { Locale } from "../../lib/i18n";
import type { CommandReasoningEffortOption } from "../../lib/thread/threadReasoningEffort";
import type { CommandModelOption } from "../../lib/thread/threadRuntimeSettings";
import type { CommandComposerSelectOption } from "./CommandComposer";

const EFFORT_PREFIX = "effort:";

export function effortOptionValue(effort: string): string {
  return `${EFFORT_PREFIX}${effort}`;
}

export function effortFromOptionValue(value: string): string | null {
  return value.startsWith(EFFORT_PREFIX)
    ? value.slice(EFFORT_PREFIX.length)
    : null;
}

export function modelEffortGroups(
  locale: Locale,
): Array<{ id: string; label: string }> {
  return [
    { id: "model", label: locale === "zh" ? "模型" : "Model" },
    { id: "effort", label: locale === "zh" ? "推理档位" : "Reasoning effort" },
  ];
}

/**
 * One menu drives both settings because the composer shows them as a single
 * label. Effort values are namespaced so the change handler can tell them
 * apart from model ids without a second callback.
 */
export function modelEffortMenuOptions({
  effortOptions,
  modelOptions,
}: {
  effortOptions: CommandReasoningEffortOption[];
  modelOptions: CommandModelOption[];
}): CommandComposerSelectOption[] {
  return [
    ...modelOptions.map((option) => ({
      detail: option.detail,
      group: "model",
      label: option.label,
      value: option.value,
    })),
    ...effortOptions.map((option) => ({
      detail: option.detail,
      group: "effort",
      label: option.label,
      value: effortOptionValue(option.value),
    })),
  ];
}
