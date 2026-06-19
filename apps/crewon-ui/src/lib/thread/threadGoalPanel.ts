import type { CapabilityPanel } from "../capability/capabilityPanelTypes";

export type ThreadGoalDraft = {
  objective: string;
  tokenBudget: number | null;
  tokenBudgetText: string;
};

export type ThreadGoalDraftValidation = "missingObjective" | "invalidBudget" | null;

export function buildThreadGoalDraft(
  fieldValue: (fieldId: string) => string,
): ThreadGoalDraft {
  const objective = fieldValue("thread-goal-objective");
  const tokenBudgetText = fieldValue("thread-goal-token-budget");
  return {
    objective,
    tokenBudget: tokenBudgetText ? Number(tokenBudgetText) : null,
    tokenBudgetText,
  };
}

export function validateThreadGoalDraft(
  draft: ThreadGoalDraft,
): ThreadGoalDraftValidation {
  if (!draft.objective) {
    return "missingObjective";
  }
  if (
    draft.tokenBudget !== null &&
    (!Number.isFinite(draft.tokenBudget) || draft.tokenBudget <= 0)
  ) {
    return "invalidBudget";
  }
  return null;
}

type Locale = "en" | "zh";
type ThreadGoalAction = "clear" | "save";

function threadGoalPanelTitle(locale: Locale): string {
  return locale === "zh" ? "会话设置" : "Session settings";
}

function threadGoalPanelSubtitle(locale: Locale): string {
  return locale === "zh" ? "目标" : "Goal";
}

export function threadGoalClearedDemoPanel(locale: Locale): CapabilityPanel {
  return {
    title: threadGoalPanelTitle(locale),
    subtitle: threadGoalPanelSubtitle(locale),
    body: locale === "zh" ? "目标已清除（演示）" : "Goal cleared (demo)",
    actions: [
      {
        id: "save-thread-goal",
        label: locale === "zh" ? "重新设置" : "Set again",
        tone: "primary",
      },
    ],
  };
}

export function threadGoalSavedDemoPanel(
  draft: ThreadGoalDraft,
  locale: Locale,
): CapabilityPanel {
  return {
    title: threadGoalPanelTitle(locale),
    subtitle: threadGoalPanelSubtitle(locale),
    body: draft.objective
      ? `${locale === "zh" ? "已保存目标（演示）" : "Goal saved (demo)"}\n${draft.objective}`
      : locale === "zh"
        ? "请输入目标后再保存"
        : "Enter a goal before saving",
    actions: draft.objective
      ? [
          {
            id: "clear-thread-goal",
            label: locale === "zh" ? "清除目标" : "Clear goal",
            tone: "danger",
          },
        ]
      : undefined,
  };
}

export function threadGoalActionProgressBody(
  action: ThreadGoalAction,
  locale: Locale,
): string {
  if (action === "save") {
    return locale === "zh" ? "正在保存目标..." : "Saving goal...";
  }
  return locale === "zh" ? "正在清除目标..." : "Clearing goal...";
}

export function threadGoalActionProgressPanel(
  panel: CapabilityPanel | null,
  action: ThreadGoalAction,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadGoalPanel(panel, {
    body: threadGoalActionProgressBody(action, locale),
    error: undefined,
  });
}

export function threadGoalClearedPanelPatch(
  locale: Locale,
): Pick<CapabilityPanel, "actions" | "body" | "fields"> {
  return {
    body: locale === "zh" ? "目标已清除" : "Goal cleared",
    fields: [
      {
        id: "thread-goal-objective",
        label: locale === "zh" ? "目标" : "Goal",
        placeholder:
          locale === "zh"
            ? "描述这个会话要持续完成的目标"
            : "Describe the ongoing goal for this session",
        value: "",
      },
      {
        id: "thread-goal-token-budget",
        label: locale === "zh" ? "Token 预算" : "Token budget",
        placeholder:
          locale === "zh"
            ? "可选，留空表示不限制"
            : "Optional, leave blank for no budget",
        value: "",
      },
    ],
    actions: [
      {
        id: "save-thread-goal",
        label: locale === "zh" ? "重新设置" : "Set again",
        tone: "primary",
      },
    ],
  };
}

export function threadGoalClearedPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadGoalPanel(panel, threadGoalClearedPanelPatch(locale));
}

export function threadGoalSavedBody(locale: Locale): string {
  return locale === "zh" ? "目标已保存" : "Goal saved";
}

export function threadGoalSavedPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadGoalPanel(panel, {
    body: threadGoalSavedBody(locale),
    error: undefined,
  });
}

export function threadGoalActionFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "目标操作失败"
      : "Goal action failed";
}

export function threadGoalActionFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadGoalPanel(panel, {
    error: threadGoalActionFailureMessage(error, locale),
  });
}

export function threadGoalValidationMessage(
  validation: ThreadGoalDraftValidation,
  locale: "en" | "zh",
): string | null {
  if (validation === "missingObjective") {
    return locale === "zh" ? "目标不能为空" : "Goal cannot be empty";
  }
  if (validation === "invalidBudget") {
    return locale === "zh"
      ? "Token 预算必须是正数"
      : "Token budget must be a positive number";
  }
  return null;
}

export function threadGoalValidationPanel(
  panel: CapabilityPanel | null,
  message: string,
): CapabilityPanel | null {
  return patchThreadGoalPanel(panel, {
    error: message,
  });
}

function patchThreadGoalPanel(
  panel: CapabilityPanel | null,
  patch: Partial<CapabilityPanel>,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        ...patch,
      }
    : panel;
}
