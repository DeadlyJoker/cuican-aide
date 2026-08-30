import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import { SETTINGS_SECTIONS } from "./settingsCatalog";
import { presentSettingsPanel } from "./settingsProductPresentation";

function visiblePanelText(panel: CapabilityPanel): string {
  return [
    panel.title,
    panel.subtitle,
    panel.body,
    panel.error,
    ...(panel.actions?.map((action) => action.label) ?? []),
    ...(panel.fields?.flatMap((field) => [
      field.label,
      field.description,
      ...(field.options?.map((option) => option.label) ?? []),
    ]) ?? []),
    ...(panel.rows?.flatMap((row) => [
      row.title,
      row.subtitle,
      row.badge,
      ...(row.meta ?? []),
      ...(row.actions?.map((action) => action.label) ?? []),
    ]) ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

describe("settings product presentation", () => {
  it.each(SETTINGS_SECTIONS)(
    "keeps internal service language out of the %s page",
    (section) => {
      const panel = presentSettingsPanel(
        section,
        {
          title: "Provider Control API config",
          subtitle: "Control runtime · MCP server",
          body: [
            "Runtime environment",
            "Provider: demo",
            "MCP servers: 2",
            "Sandbox modes: workspace-write",
            "Plugin marketplaces: 1",
            "Git worktree Hook Tokens: feature_flag_enabled",
            "catalog revision: 7",
            "clientId: internal-device-id",
          ].join("\n"),
          actions: [
            { id: "refresh-connections", label: "Refresh Provider config" },
          ],
          error: "control_runtime_session_unavailable",
        },
        "zh",
      );

      expect(panel).not.toBeNull();
      expect(visiblePanelText(panel!)).not.toMatch(
        /app-server|\bControl\b|\bruntime\b|\bMCP\b|\bProvider\b|\bAPI\b|\bURL\b|\bconfig\b|\bsandbox\b|\bplugin\b|\bWorker\b|\bcatalog\b|\bGit\b|\bworktree\b|\bHook\b|\bTokens?\b|clientId|feature_flag/iu,
      );
    },
  );

  it("turns execution choices into user decisions", () => {
    const panel = presentSettingsPanel(
      "config",
      {
        title: "Config",
        fields: [
          {
            id: "config-approval-policy",
            label: "Approval policy",
            options: [
              { label: "on-request", value: "on-request" },
              { label: "never", value: "never" },
            ],
            value: "on-request",
          },
          {
            id: "config-sandbox-mode",
            label: "Sandbox mode",
            options: [
              { label: "read-only", value: "read-only" },
              { label: "workspace-write", value: "workspace-write" },
              {
                label: "danger-full-access",
                value: "danger-full-access",
              },
            ],
            value: "workspace-write",
          },
        ],
      },
      "zh",
    );

    expect(panel?.fields).toEqual([
      expect.objectContaining({
        label: "需要确认的时机",
        options: [
          { label: "助理判断需要时", value: "on-request" },
          { label: "无需确认", value: "never" },
        ],
      }),
      expect.objectContaining({
        label: "可操作范围",
        options: [
          { label: "仅查看", value: "read-only" },
          { label: "当前项目", value: "workspace-write" },
          { label: "整台设备", value: "danger-full-access" },
        ],
      }),
    ]);
  });

  it("presents appearance controls as visual preferences", () => {
    const panel = presentSettingsPanel(
      "appearance",
      {
        title: "Appearance",
        fields: [
          {
            control: "color",
            id: "appearance-accent",
            label: "Accent",
            value: "#1f1f1f",
          },
          {
            id: "appearance-ui-font-size",
            label: "UI font size",
            unit: "px",
            value: "12",
          },
          {
            id: "appearance-code-font-size",
            label: "Code font size",
            unit: "px",
            value: "12",
          },
          {
            id: "appearance-diff-markers",
            label: "Diff markers",
            options: [
              { label: "Color", value: "color" },
              { label: "+/-", value: "sign" },
            ],
            value: "sign",
          },
          {
            description: "Use native macOS font antialiasing",
            id: "appearance-font-smoothing",
            label: "Font smoothing",
            value: "true",
          },
        ],
      },
      "zh",
    );

    expect(panel?.fields).toEqual([
      expect.objectContaining({ label: "重点颜色" }),
      expect.objectContaining({ label: "界面字号", unit: undefined }),
      expect.objectContaining({ label: "任务内容字号", unit: undefined }),
      expect.objectContaining({
        label: "修改标记",
        options: [
          { label: "颜色", value: "color" },
          { label: "符号", value: "sign" },
        ],
      }),
      expect.objectContaining({
        description: "让文字边缘更清晰",
        label: "文字清晰度",
      }),
    ]);
    expect(visiblePanelText(panel!)).not.toMatch(
      /\bUI\b|\bpx\b|macOS|抗锯齿|差异/iu,
    );
  });

  it("hides service addresses in model rows and simplifies their actions", () => {
    const panel = presentSettingsPanel(
      "model-providers",
      {
        title: "Model access",
        rows: [
          {
            id: "model-a",
            title: "Provider A",
            subtitle: "https://models.example/v1",
            badge: "当前使用",
            meta: ["OpenAI API", "API Key stored"],
            actions: [
              { id: "model-provider-edit:model-a", label: "Edit Provider" },
              {
                id: "model-provider-delete:model-a",
                label: "Delete Provider",
              },
            ],
          },
        ],
      },
      "zh",
    );

    expect(panel?.rows).toEqual([
      expect.objectContaining({
        title: "模型服务 A",
        subtitle: undefined,
        meta: ["OpenAI", "访问密钥 已保存"],
        actions: [
          expect.objectContaining({ label: "编辑" }),
          expect.objectContaining({ label: "移除" }),
        ],
      }),
    ]);
  });
});
