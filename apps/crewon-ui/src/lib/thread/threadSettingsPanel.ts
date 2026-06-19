import type {
  CapabilityPanel,
  CapabilityPanelField,
} from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";

type SelectOption = { label: string; value: string };
type ThreadGoalPanelState = {
  objective: string;
  status: string;
  tokenBudget?: number | null;
  tokensUsed: number;
};
type ThreadSettingsModel = {
  displayName?: string | null;
  id: string;
  model: string;
};
type ThreadSettingsRequirements = {
  requirements?: {
    allowedApprovalPolicies?: unknown[] | null;
    allowedSandboxModes?: string[] | null;
  } | null;
};

export type ThreadSettingsFieldMetadata = {
  approvalOptions: SelectOption[];
  currentApproval: string;
  currentModel: string;
  currentSandbox: string;
  modelOptions: SelectOption[];
  sandboxOptions: SelectOption[];
};

export function threadSettingsMissingThreadPanel(
  locale: Locale,
): CapabilityPanel {
  return {
    title: threadSettingsTitle(locale),
    subtitle: threadSettingsGoalSubtitle(locale),
    error: locale === "zh" ? "请先选择一个会话" : "Select a session first",
  };
}

export function threadSettingsInitialPanel(params: {
  hasBackendThread: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  threadGoal: ThreadGoalPanelState | null;
}): CapabilityPanel {
  const { hasBackendThread, isDemoPreview, locale, threadGoal } = params;
  return {
    title: threadSettingsTitle(locale),
    subtitle: threadSettingsGoalSubtitle(locale),
    body: threadSettingsInitialBody({
      hasBackendThread,
      isDemoPreview,
      locale,
      threadGoal,
    }),
    fields: [
      {
        id: "thread-goal-objective",
        label: locale === "zh" ? "目标" : "Goal",
        placeholder:
          locale === "zh"
            ? "描述这个会话要持续完成的目标"
            : "Describe the ongoing goal for this session",
        value: threadGoal?.objective ?? "",
      },
      {
        id: "thread-goal-token-budget",
        label: locale === "zh" ? "Token 预算" : "Token budget",
        placeholder:
          locale === "zh"
            ? "可选，留空表示不限制"
            : "Optional, leave blank for no budget",
        value: threadGoal?.tokenBudget ? String(threadGoal.tokenBudget) : "",
      },
      threadSettingsDefaultField("thread-settings-model", locale),
      threadSettingsDefaultField("thread-settings-approval-policy", locale),
      threadSettingsDefaultField("thread-settings-sandbox-mode", locale),
    ],
    actions: [
      {
        id: "save-thread-goal",
        label: locale === "zh" ? "保存目标" : "Save goal",
        tone: "primary",
      },
      {
        id: "clear-thread-goal",
        label: locale === "zh" ? "清除目标" : "Clear goal",
        tone: "danger",
      },
      {
        id: "save-thread-settings",
        label: locale === "zh" ? "保存会话设置" : "Save session settings",
      },
      {
        id: "refresh-thread-history",
        label: locale === "zh" ? "刷新历史" : "Refresh history",
      },
      {
        id: "compact-thread",
        label: locale === "zh" ? "压缩上下文" : "Compact context",
      },
      {
        id: "enable-thread-memory",
        label: locale === "zh" ? "启用记忆" : "Enable memory",
      },
      {
        id: "disable-thread-memory",
        label: locale === "zh" ? "禁用记忆" : "Disable memory",
      },
      {
        id: "rollback-thread",
        label: locale === "zh" ? "回滚上一轮" : "Rollback last turn",
        tone: "danger",
      },
    ],
  };
}

export function threadSettingsMetadataPanel(
  currentPanel: CapabilityPanel | null,
  fieldMetadata: ThreadSettingsFieldMetadata,
  locale: Locale,
): CapabilityPanel | null {
  if (currentPanel?.title !== threadSettingsTitle(locale)) {
    return currentPanel;
  }

  return {
    ...currentPanel,
    body: [
      currentPanel.body,
      locale === "zh"
        ? "会话设置只影响当前会话的后续任务。"
        : "Session settings affect only future turns in this session.",
    ]
      .filter(Boolean)
      .join("\n"),
    fields: applyThreadSettingsFieldMetadata(
      currentPanel.fields,
      fieldMetadata,
    ),
  };
}

export function buildThreadSettingsFieldMetadata(
  models: { data?: ThreadSettingsModel[] } | null,
  requirements: ThreadSettingsRequirements | null,
  config: Record<string, unknown> | null | undefined,
  locale: Locale,
): ThreadSettingsFieldMetadata {
  const defaultOption = {
    label: locale === "zh" ? "沿用默认" : "Use default",
    value: "",
  };
  const modelOptions = uniqueSelectOptions([
    defaultOption,
    ...(models?.data ?? []).map((model) => ({
      label: model.displayName || model.model || model.id,
      value: model.model,
    })),
  ]);
  const approvalOptions = uniqueSelectOptions([
    defaultOption,
    ...(
      requirements?.requirements?.allowedApprovalPolicies ?? [
        "untrusted",
        "on-failure",
        "on-request",
        "never",
      ]
    )
      .flatMap((policy) => (typeof policy === "string" ? [policy] : []))
      .map((policy) => ({ label: policy, value: policy })),
  ]);
  const sandboxOptions = uniqueSelectOptions([
    defaultOption,
    ...(
      requirements?.requirements?.allowedSandboxModes ?? [
        "read-only",
        "workspace-write",
        "danger-full-access",
      ]
    ).map((mode) => ({ label: mode, value: mode })),
  ]);

  return {
    approvalOptions,
    currentApproval:
      typeof config?.approval_policy === "string" ? config.approval_policy : "",
    currentModel: typeof config?.model === "string" ? config.model : "",
    currentSandbox:
      typeof config?.sandbox_mode === "string" ? config.sandbox_mode : "",
    modelOptions,
    sandboxOptions,
  };
}

export function applyThreadSettingsFieldMetadata(
  fields: CapabilityPanelField[] | undefined,
  metadata: ThreadSettingsFieldMetadata,
): CapabilityPanelField[] | undefined {
  return fields?.map((field) => {
    if (field.id === "thread-settings-model") {
      return {
        ...field,
        placeholder: metadata.currentModel || field.placeholder,
        options: metadata.modelOptions,
      };
    }
    if (field.id === "thread-settings-approval-policy") {
      return {
        ...field,
        placeholder: metadata.currentApproval || field.placeholder,
        options: metadata.approvalOptions,
      };
    }
    if (field.id === "thread-settings-sandbox-mode") {
      return {
        ...field,
        placeholder: metadata.currentSandbox || field.placeholder,
        options: metadata.sandboxOptions,
      };
    }
    return field;
  });
}

function uniqueSelectOptions(options: SelectOption[]): SelectOption[] {
  return options.filter(
    (option, index) =>
      options.findIndex((candidate) => candidate.value === option.value) ===
      index,
  );
}

function threadSettingsTitle(locale: Locale): string {
  return locale === "zh" ? "会话设置" : "Session settings";
}

function threadSettingsGoalSubtitle(locale: Locale): string {
  return locale === "zh" ? "目标" : "Goal";
}

function threadSettingsInitialBody(params: {
  hasBackendThread: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  threadGoal: ThreadGoalPanelState | null;
}): string {
  const { hasBackendThread, isDemoPreview, locale, threadGoal } = params;
  if (threadGoal) {
    return `${locale === "zh" ? "当前状态" : "Current status"}: ${threadGoal.status}\n${locale === "zh" ? "已用 tokens" : "Tokens used"}: ${threadGoal.tokensUsed}`;
  }
  if (isDemoPreview && !hasBackendThread) {
    return locale === "zh"
      ? "保存后会创建真实后端会话并绑定目标"
      : "Saving creates a real backend session and binds the goal";
  }
  return locale === "zh" ? "当前未设置目标" : "No goal is currently set";
}

function threadSettingsDefaultField(
  id:
    | "thread-settings-approval-policy"
    | "thread-settings-model"
    | "thread-settings-sandbox-mode",
  locale: Locale,
): CapabilityPanelField {
  const labels = {
    "thread-settings-approval-policy":
      locale === "zh" ? "会话审批" : "Session approval",
    "thread-settings-model": locale === "zh" ? "会话模型" : "Session model",
    "thread-settings-sandbox-mode":
      locale === "zh" ? "会话沙箱" : "Session sandbox",
  };

  return {
    id,
    label: labels[id],
    placeholder:
      locale === "zh" ? "留空表示沿用默认配置" : "Leave empty to use defaults",
    value: "",
    options: [
      {
        label: locale === "zh" ? "沿用默认" : "Use default",
        value: "",
      },
    ],
  };
}

export type ThreadMemoryMode = "disabled" | "enabled";

export function threadCompactDemoBody(locale: Locale): string {
  return locale === "zh"
    ? "上下文压缩已启动（演示）。连接 app-server 后会调用 thread/compact/start。"
    : "Context compaction started (demo). With app-server connected this calls thread/compact/start.";
}

export function threadCompactDemoPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadActionPanel(panel, {
    body: threadCompactDemoBody(locale),
    error: undefined,
  });
}

export function threadCompactProgressBody(locale: Locale): string {
  return locale === "zh"
    ? "正在启动上下文压缩..."
    : "Starting context compaction...";
}

export function threadCompactProgressPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadActionPanel(panel, {
    body: threadCompactProgressBody(locale),
    error: undefined,
  });
}

export function threadCompactSuccessBody(locale: Locale): string {
  return locale === "zh"
    ? "上下文压缩已启动，完成后会出现在当前会话中。"
    : "Context compaction started. It will appear in this session when complete.";
}

export function threadCompactSuccessPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadActionPanel(panel, {
    body: threadCompactSuccessBody(locale),
    error: undefined,
  });
}

export function threadCompactFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "启动上下文压缩失败"
      : "Unable to start context compaction";
}

export function threadCompactFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadActionPanel(panel, {
    error: threadCompactFailureMessage(error, locale),
  });
}

export function threadRollbackDemoBody(locale: Locale): string {
  return locale === "zh"
    ? "已回滚上一轮（演示）。连接 app-server 后会调用 thread/rollback。"
    : "Rolled back the last turn (demo). With app-server connected this calls thread/rollback.";
}

export function threadRollbackDemoPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadActionPanel(panel, {
    body: threadRollbackDemoBody(locale),
    error: undefined,
  });
}

export function threadRollbackConfirmMessage(locale: Locale): string {
  return locale === "zh"
    ? "回滚会删除当前会话最后一轮历史，但不会自动回退文件改动。继续？"
    : "Rollback removes the last turn from this session history, but does not revert file changes. Continue?";
}

export function threadRollbackProgressBody(locale: Locale): string {
  return locale === "zh" ? "正在回滚上一轮..." : "Rolling back the last turn...";
}

export function threadRollbackProgressPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadActionPanel(panel, {
    body: threadRollbackProgressBody(locale),
    error: undefined,
  });
}

export function threadRollbackSuccessBody(locale: Locale): string {
  return locale === "zh"
    ? "已回滚上一轮会话历史。"
    : "Rolled back the last turn in this session.";
}

export function threadRollbackSuccessPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadActionPanel(panel, {
    body: threadRollbackSuccessBody(locale),
    error: undefined,
  });
}

export function threadRollbackFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "回滚会话失败"
      : "Unable to rollback session";
}

export function threadRollbackFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadActionPanel(panel, {
    error: threadRollbackFailureMessage(error, locale),
  });
}

export function threadMemoryDemoBody(
  mode: ThreadMemoryMode,
  locale: Locale,
): string {
  return locale === "zh"
    ? `记忆模式已${mode === "enabled" ? "启用" : "禁用"}（演示）。连接 app-server 后会调用 thread/memoryMode/set。`
    : `Memory mode ${mode} (demo). With app-server connected this calls thread/memoryMode/set.`;
}

export function threadMemoryDemoPanel(
  panel: CapabilityPanel | null,
  mode: ThreadMemoryMode,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadActionPanel(panel, {
    body: threadMemoryDemoBody(mode, locale),
    error: undefined,
  });
}

export function threadMemoryProgressBody(locale: Locale): string {
  return locale === "zh" ? "正在更新记忆模式..." : "Updating memory mode...";
}

export function threadMemoryProgressPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadActionPanel(panel, {
    body: threadMemoryProgressBody(locale),
    error: undefined,
  });
}

export function threadMemorySuccessBody(
  mode: ThreadMemoryMode,
  locale: Locale,
): string {
  return locale === "zh"
    ? `记忆模式已${mode === "enabled" ? "启用" : "禁用"}。`
    : `Memory mode ${mode}.`;
}

export function threadMemorySuccessPanel(
  panel: CapabilityPanel | null,
  mode: ThreadMemoryMode,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadActionPanel(panel, {
    body: threadMemorySuccessBody(mode, locale),
    error: undefined,
  });
}

export function threadMemoryFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "更新记忆模式失败"
      : "Unable to update memory mode";
}

export function threadMemoryFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadActionPanel(panel, {
    error: threadMemoryFailureMessage(error, locale),
  });
}

function patchThreadActionPanel(
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
