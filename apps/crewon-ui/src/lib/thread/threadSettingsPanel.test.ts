import { describe, expect, it } from "vitest";

import {
  applyThreadSettingsFieldMetadata,
  buildThreadSettingsFieldMetadata,
  threadCompactDemoBody,
  threadCompactDemoPanel,
  threadCompactFailureMessage,
  threadCompactFailurePanel,
  threadCompactProgressBody,
  threadCompactProgressPanel,
  threadCompactSuccessBody,
  threadCompactSuccessPanel,
  threadMemoryDemoBody,
  threadMemoryDemoPanel,
  threadMemoryFailureMessage,
  threadMemoryFailurePanel,
  threadMemoryProgressBody,
  threadMemoryProgressPanel,
  threadMemorySuccessBody,
  threadMemorySuccessPanel,
  threadRollbackConfirmMessage,
  threadRollbackDemoBody,
  threadRollbackDemoPanel,
  threadRollbackFailureMessage,
  threadRollbackFailurePanel,
  threadRollbackProgressBody,
  threadRollbackProgressPanel,
  threadRollbackSuccessBody,
  threadRollbackSuccessPanel,
  threadSettingsInitialPanel,
  threadSettingsMetadataPanel,
  threadSettingsMissingThreadPanel,
} from "./threadSettingsPanel";

describe("thread settings panel helpers", () => {
  function panel() {
    return {
      title: "Session settings",
      subtitle: "Goal",
      body: "Existing",
      error: "old error",
      actions: [{ id: "compact-thread", label: "Compact" }],
    };
  }

  it("builds thread settings entry panels", () => {
    expect(threadSettingsMissingThreadPanel("zh")).toEqual({
      title: "会话设置",
      subtitle: "目标",
      error: "请先选择一个会话",
    });
    expect(
      threadSettingsInitialPanel({
        hasBackendThread: true,
        isDemoPreview: false,
        locale: "en",
        threadGoal: {
          objective: "Ship refactor",
          status: "active",
          tokenBudget: 12000,
          tokensUsed: 340,
        },
      }),
    ).toEqual({
      title: "Session settings",
      subtitle: "Goal",
      body: "Current status: active\nTokens used: 340",
      fields: [
        {
          id: "thread-goal-objective",
          label: "Goal",
          placeholder: "Describe the ongoing goal for this session",
          value: "Ship refactor",
        },
        {
          id: "thread-goal-token-budget",
          label: "Token budget",
          placeholder: "Optional, leave blank for no budget",
          value: "12000",
        },
        {
          id: "thread-settings-model",
          label: "Session model",
          placeholder: "Leave empty to use defaults",
          value: "",
          options: [{ label: "Use default", value: "" }],
        },
        {
          id: "thread-settings-approval-policy",
          label: "Session approval",
          placeholder: "Leave empty to use defaults",
          value: "",
          options: [{ label: "Use default", value: "" }],
        },
        {
          id: "thread-settings-sandbox-mode",
          label: "Session sandbox",
          placeholder: "Leave empty to use defaults",
          value: "",
          options: [{ label: "Use default", value: "" }],
        },
      ],
      actions: [
        {
          id: "save-thread-goal",
          label: "Save goal",
          tone: "primary",
        },
        {
          id: "clear-thread-goal",
          label: "Clear goal",
          tone: "danger",
        },
        {
          id: "save-thread-settings",
          label: "Save session settings",
        },
        {
          id: "refresh-thread-history",
          label: "Refresh history",
        },
        {
          id: "compact-thread",
          label: "Compact context",
        },
        {
          id: "enable-thread-memory",
          label: "Enable memory",
        },
        {
          id: "disable-thread-memory",
          label: "Disable memory",
        },
        {
          id: "rollback-thread",
          label: "Rollback last turn",
          tone: "danger",
        },
      ],
    });
    expect(
      threadSettingsInitialPanel({
        hasBackendThread: false,
        isDemoPreview: true,
        locale: "zh",
        threadGoal: null,
      }).body,
    ).toBe("保存后会创建真实后端会话并绑定目标");
  });

  it("builds field metadata with defaults, configured values, and unique model options", () => {
    const metadata = buildThreadSettingsFieldMetadata(
      {
        data: [
          {
            id: "gpt-5",
            model: "gpt-5",
            displayName: "GPT-5",
          },
          {
            id: "gpt-5-duplicate",
            model: "gpt-5",
            displayName: "GPT-5 duplicate",
          },
        ],
      },
      null,
      {
        model: "gpt-5",
        approval_policy: "on-request",
        sandbox_mode: "workspace-write",
      },
      "en",
    );

    expect(metadata.currentModel).toBe("gpt-5");
    expect(metadata.currentApproval).toBe("on-request");
    expect(metadata.currentSandbox).toBe("workspace-write");
    expect(metadata.modelOptions).toEqual([
      { label: "Use default", value: "" },
      { label: "GPT-5", value: "gpt-5" },
    ]);
    expect(metadata.approvalOptions.map((option) => option.value)).toEqual([
      "",
      "untrusted",
      "on-failure",
      "on-request",
      "never",
    ]);
  });

  it("applies metadata to known thread setting fields", () => {
    const fields = [
      {
        id: "thread-settings-model",
        label: "Model",
        placeholder: "Use default",
        value: "",
      },
      {
        id: "thread-settings-approval-policy",
        label: "Approval",
        placeholder: "Use default",
        value: "",
      },
      {
        id: "other",
        label: "Other",
        value: "same",
      },
    ];

    expect(
      applyThreadSettingsFieldMetadata(fields, {
        approvalOptions: [{ label: "never", value: "never" }],
        currentApproval: "never",
        currentModel: "gpt-5",
        currentSandbox: "workspace-write",
        modelOptions: [{ label: "GPT-5", value: "gpt-5" }],
        sandboxOptions: [{ label: "workspace-write", value: "workspace-write" }],
      }),
    ).toEqual([
      {
        id: "thread-settings-model",
        label: "Model",
        placeholder: "gpt-5",
        value: "",
        options: [{ label: "GPT-5", value: "gpt-5" }],
      },
      {
        id: "thread-settings-approval-policy",
        label: "Approval",
        placeholder: "never",
        value: "",
        options: [{ label: "never", value: "never" }],
      },
      {
        id: "other",
        label: "Other",
        value: "same",
      },
    ]);
  });

  it("applies metadata to the thread settings panel", () => {
    const panel = threadSettingsInitialPanel({
      hasBackendThread: true,
      isDemoPreview: false,
      locale: "en",
      threadGoal: null,
    });

    expect(
      threadSettingsMetadataPanel(
        panel,
        {
          approvalOptions: [{ label: "never", value: "never" }],
          currentApproval: "never",
          currentModel: "gpt-5",
          currentSandbox: "workspace-write",
          modelOptions: [{ label: "GPT-5", value: "gpt-5" }],
          sandboxOptions: [
            { label: "workspace-write", value: "workspace-write" },
          ],
        },
        "en",
      ),
    ).toEqual({
      ...panel,
      body: [
        "No goal is currently set",
        "Session settings affect only future turns in this session.",
      ].join("\n"),
      fields: applyThreadSettingsFieldMetadata(panel.fields, {
        approvalOptions: [{ label: "never", value: "never" }],
        currentApproval: "never",
        currentModel: "gpt-5",
        currentSandbox: "workspace-write",
        modelOptions: [{ label: "GPT-5", value: "gpt-5" }],
        sandboxOptions: [{ label: "workspace-write", value: "workspace-write" }],
      }),
    });
    expect(
      threadSettingsMetadataPanel(
        { title: "Account" },
        {
          approvalOptions: [],
          currentApproval: "",
          currentModel: "",
          currentSandbox: "",
          modelOptions: [],
          sandboxOptions: [],
        },
        "en",
      ),
    ).toEqual({ title: "Account" });
  });

  it("builds compact action feedback", () => {
    expect(threadCompactDemoBody("en")).toBe(
      "Context compaction started (demo). With app-server connected this calls thread/compact/start.",
    );
    expect(threadCompactProgressBody("zh")).toBe("正在启动上下文压缩...");
    expect(threadCompactSuccessBody("en")).toBe(
      "Context compaction started. It will appear in this session when complete.",
    );
    expect(threadCompactFailureMessage(null, "zh")).toBe(
      "启动上下文压缩失败",
    );
    expect(threadCompactFailureMessage(new Error("denied"), "en")).toBe(
      "denied",
    );
    expect(threadCompactDemoPanel(panel(), "en")).toEqual({
      ...panel(),
      body: "Context compaction started (demo). With app-server connected this calls thread/compact/start.",
      error: undefined,
    });
    expect(threadCompactProgressPanel(panel(), "zh")).toEqual({
      ...panel(),
      body: "正在启动上下文压缩...",
      error: undefined,
    });
    expect(threadCompactSuccessPanel(panel(), "en")).toEqual({
      ...panel(),
      body: "Context compaction started. It will appear in this session when complete.",
      error: undefined,
    });
    expect(threadCompactFailurePanel(panel(), null, "zh")).toEqual({
      ...panel(),
      error: "启动上下文压缩失败",
    });
    expect(threadCompactDemoPanel(null, "en")).toBeNull();
  });

  it("builds rollback action feedback", () => {
    expect(threadRollbackDemoBody("zh")).toBe(
      "已回滚上一轮（演示）。连接 app-server 后会调用 thread/rollback。",
    );
    expect(threadRollbackConfirmMessage("en")).toBe(
      "Rollback removes the last turn from this session history, but does not revert file changes. Continue?",
    );
    expect(threadRollbackProgressBody("en")).toBe(
      "Rolling back the last turn...",
    );
    expect(threadRollbackSuccessBody("zh")).toBe("已回滚上一轮会话历史。");
    expect(threadRollbackFailureMessage(null, "en")).toBe(
      "Unable to rollback session",
    );
    expect(threadRollbackFailureMessage(new Error("denied"), "zh")).toBe(
      "denied",
    );
    expect(threadRollbackDemoPanel(panel(), "zh")).toEqual({
      ...panel(),
      body: "已回滚上一轮（演示）。连接 app-server 后会调用 thread/rollback。",
      error: undefined,
    });
    expect(threadRollbackProgressPanel(panel(), "en")).toEqual({
      ...panel(),
      body: "Rolling back the last turn...",
      error: undefined,
    });
    expect(threadRollbackSuccessPanel(panel(), "zh")).toEqual({
      ...panel(),
      body: "已回滚上一轮会话历史。",
      error: undefined,
    });
    expect(threadRollbackFailurePanel(panel(), null, "en")).toEqual({
      ...panel(),
      error: "Unable to rollback session",
    });
    expect(threadRollbackFailurePanel(null, null, "en")).toBeNull();
  });

  it("builds memory action feedback", () => {
    expect(threadMemoryDemoBody("enabled", "zh")).toBe(
      "记忆模式已启用（演示）。连接 app-server 后会调用 thread/memoryMode/set。",
    );
    expect(threadMemoryDemoBody("disabled", "en")).toBe(
      "Memory mode disabled (demo). With app-server connected this calls thread/memoryMode/set.",
    );
    expect(threadMemoryProgressBody("en")).toBe("Updating memory mode...");
    expect(threadMemorySuccessBody("disabled", "zh")).toBe("记忆模式已禁用。");
    expect(threadMemoryFailureMessage(null, "zh")).toBe("更新记忆模式失败");
    expect(threadMemoryFailureMessage(new Error("denied"), "en")).toBe(
      "denied",
    );
    expect(threadMemoryDemoPanel(panel(), "enabled", "zh")).toEqual({
      ...panel(),
      body: "记忆模式已启用（演示）。连接 app-server 后会调用 thread/memoryMode/set。",
      error: undefined,
    });
    expect(threadMemoryProgressPanel(panel(), "en")).toEqual({
      ...panel(),
      body: "Updating memory mode...",
      error: undefined,
    });
    expect(threadMemorySuccessPanel(panel(), "disabled", "zh")).toEqual({
      ...panel(),
      body: "记忆模式已禁用。",
      error: undefined,
    });
    expect(threadMemoryFailurePanel(panel(), null, "zh")).toEqual({
      ...panel(),
      error: "更新记忆模式失败",
    });
    expect(threadMemoryDemoPanel(null, "disabled", "en")).toBeNull();
  });
});
