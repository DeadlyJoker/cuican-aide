import { describe, expect, it } from "vitest";

import {
  buildAppearanceEdits,
  buildConfigEdits,
  buildPersonalizationEdits,
  buildThreadSettingsPatch,
  configValuesMissingPanel,
  configValuesMissingPatch,
  hasThreadSettingsPatch,
  localServerDisconnectedMessage,
  noConfigValuesToSaveMessage,
  noThreadSettingsSelectedMessage,
  realThreadRequiredPanel,
  realThreadRequiredMessage,
  realThreadRequiredPatch,
  settingsDisconnectedPanel,
  settingsDisconnectedPatch,
  settingsSaveFailureMessage,
  settingsSaveFailurePanel,
  settingsSaveFailurePatch,
  settingsSaveInProgressBody,
  settingsSaveProgressPanel,
  settingsSaveProgressPatch,
  settingsSaveSuccessBody,
  settingsSaveSuccessPanel,
  settingsSaveSuccessPatch,
  threadSettingsSaveFailureMessage,
  threadSettingsSaveFailurePanel,
  threadSettingsSaveFailurePatch,
  threadSettingsSaveInProgressBody,
  threadSettingsSaveProgressPanel,
  threadSettingsSaveProgressPatch,
  threadSettingsSaveSuccessBody,
  threadSettingsSaveSuccessPanel,
  threadSettingsSaveSuccessPatch,
  threadSettingsMissingSelectionPanel,
  threadSettingsMissingSelectionPatch,
} from "./settingsSavePayloads";

describe("settings save payload helpers", () => {
  it("builds non-empty config edits", () => {
    const values: Record<string, string> = {
      "config-model": "gpt-5",
      "config-approval-policy": "",
      "config-sandbox-mode": "workspace-write",
    };

    expect(buildConfigEdits((fieldId) => values[fieldId] ?? "")).toEqual([
      { keyPath: "model", value: "gpt-5" },
      { keyPath: "sandbox_mode", value: "workspace-write" },
    ]);
  });

  it("builds appearance edits with current value fallbacks", () => {
    const values: Record<string, string> = {
      "appearance-locale": "",
      "appearance-theme": "dark",
    };

    expect(
      buildAppearanceEdits((fieldId) => values[fieldId] ?? "", "en", "light"),
    ).toEqual({
      nextLocale: "",
      nextTheme: "dark",
      edits: [
        { keyPath: "desktop.uiLocale", value: "en" },
        { keyPath: "desktop.appearanceTheme", value: "dark" },
      ],
    });
  });

  it("builds personalization edits without dropping empty strings", () => {
    const values: Record<string, string> = {
      "personalization-instructions": "",
      "personalization-developer-instructions": "Prefer tests.",
    };

    expect(buildPersonalizationEdits((fieldId) => values[fieldId] ?? "")).toEqual(
      [
        { keyPath: "instructions", value: "" },
        { keyPath: "developer_instructions", value: "Prefer tests." },
      ],
    );
  });

  it("builds thread settings patches and detects whether they contain changes", () => {
    const patch = buildThreadSettingsPatch((fieldId) =>
      fieldId === "thread-settings-model" ? "gpt-5" : "",
    );

    expect(patch).toEqual({
      approvalPolicy: "",
      model: "gpt-5",
      sandboxMode: "",
    });
    expect(hasThreadSettingsPatch(patch)).toBe(true);
    expect(
      hasThreadSettingsPatch({
        approvalPolicy: "",
        model: "",
        sandboxMode: "",
      }),
    ).toBe(false);
  });

  it("builds shared save validation messages", () => {
    expect(localServerDisconnectedMessage("en")).toBe(
      "Local app-server is not connected",
    );
    expect(noConfigValuesToSaveMessage("zh")).toBe("没有可保存的配置项");
    expect(noThreadSettingsSelectedMessage("en")).toBe(
      "No session settings selected",
    );
    expect(realThreadRequiredMessage("zh")).toBe("请先选择一个真实会话");
  });

  it("builds config save status text", () => {
    expect(settingsSaveInProgressBody("config", "en")).toBe("Saving config...");
    expect(
      settingsSaveSuccessBody(
        "config",
        { status: "ok", version: 7n },
        "en",
      ),
    ).toBe("Config saved and hot-reloaded\nversion: 7\nstatus: ok");
    expect(settingsSaveFailureMessage("config", null, "zh")).toBe(
      "保存配置失败",
    );
    expect(settingsSaveFailureMessage("config", new Error("denied"), "en")).toBe(
      "denied",
    );
  });

  it("builds appearance and personalization save status text", () => {
    expect(settingsSaveInProgressBody("appearance", "zh")).toBe(
      "正在保存外观设置...",
    );
    expect(settingsSaveSuccessBody("appearance", null, "en")).toBe(
      "Appearance saved\nversion: -\nstatus: ok",
    );
    expect(settingsSaveFailureMessage("appearance", null, "en")).toBe(
      "Unable to save appearance settings",
    );
    expect(settingsSaveInProgressBody("personalization", "en")).toBe(
      "Saving personalization settings...",
    );
    expect(settingsSaveSuccessBody("personalization", { status: "saved" }, "zh"))
      .toBe("个性化设置已保存\nversion: -\nstatus: saved");
    expect(settingsSaveFailureMessage("personalization", null, "zh")).toBe(
      "保存个性化设置失败",
    );
  });

  it("builds settings save panel patches", () => {
    expect(configValuesMissingPatch("en")).toEqual({
      error: "No config values to save",
    });
    expect(settingsDisconnectedPatch("zh")).toEqual({
      error: "未连接本地 app-server",
    });
    expect(settingsSaveProgressPatch("appearance", "en")).toEqual({
      body: "Saving appearance settings...",
      error: undefined,
    });
    expect(
      settingsSaveSuccessPatch({
        currentSubtitle: "Current path",
        kind: "config",
        locale: "en",
        response: {
          filePath: "/repo/config.toml",
          status: "ok",
          version: 3,
        },
      }),
    ).toEqual({
      subtitle: "/repo/config.toml",
      body: "Config saved and hot-reloaded\nversion: 3\nstatus: ok",
      error: undefined,
    });
    expect(
      settingsSaveSuccessPatch({
        currentSubtitle: "Current path",
        kind: "personalization",
        locale: "zh",
        response: null,
      }),
    ).toEqual({
      subtitle: "Current path",
      body: "个性化设置已保存\nversion: -\nstatus: ok",
      error: undefined,
    });
    expect(settingsSaveFailurePatch("config", null, "zh")).toEqual({
      error: "保存配置失败",
    });
  });

  it("applies settings save panel patches", () => {
    const panel = {
      title: "Config",
      subtitle: "Current path",
      body: "Ready",
      error: "old",
    };

    expect(configValuesMissingPanel(panel, "en")).toEqual({
      title: "Config",
      subtitle: "Current path",
      body: "Ready",
      error: "No config values to save",
    });
    expect(settingsDisconnectedPanel(panel, "zh")).toEqual({
      title: "Config",
      subtitle: "Current path",
      body: "Ready",
      error: "未连接本地 app-server",
    });
    expect(settingsSaveProgressPanel(panel, "config", "en")).toEqual({
      title: "Config",
      subtitle: "Current path",
      body: "Saving config...",
      error: undefined,
    });
    expect(
      settingsSaveSuccessPanel(panel, {
        kind: "appearance",
        locale: "en",
        response: { filePath: "/repo/config.toml", status: "ok", version: 4 },
      }),
    ).toEqual({
      title: "Config",
      subtitle: "/repo/config.toml",
      body: "Appearance saved\nversion: 4\nstatus: ok",
      error: undefined,
    });
    expect(
      settingsSaveSuccessPanel(panel, {
        kind: "personalization",
        locale: "zh",
        response: null,
      }),
    ).toEqual({
      title: "Config",
      subtitle: "Current path",
      body: "个性化设置已保存\nversion: -\nstatus: ok",
      error: undefined,
    });
    expect(settingsSaveFailurePanel(panel, "config", null, "zh")).toEqual({
      title: "Config",
      subtitle: "Current path",
      body: "Ready",
      error: "保存配置失败",
    });
    expect(settingsSaveProgressPanel(null, "config", "en")).toBeNull();
  });

  it("builds thread settings save status text", () => {
    expect(threadSettingsSaveInProgressBody("en")).toBe(
      "Saving session settings...",
    );
    expect(
      threadSettingsSaveSuccessBody(
        {
          approvalPolicy: "on-request",
          model: "gpt-5",
          sandboxMode: "",
        },
        "en",
      ),
    ).toBe(
      [
        "Session settings saved for future turns.",
        "Model: gpt-5",
        "Approval: on-request",
      ].join("\n"),
    );
    expect(threadSettingsSaveFailureMessage(null, "zh")).toBe(
      "保存会话设置失败",
    );
    expect(
      threadSettingsSaveFailureMessage(new Error("thread denied"), "en"),
    ).toBe("thread denied");
  });

  it("builds thread settings save panel patches", () => {
    expect(threadSettingsMissingSelectionPatch("en")).toEqual({
      error: "No session settings selected",
    });
    expect(realThreadRequiredPatch("zh")).toEqual({
      error: "请先选择一个真实会话",
    });
    expect(threadSettingsSaveProgressPatch("zh")).toEqual({
      body: "正在保存会话设置...",
      error: undefined,
    });
    expect(
      threadSettingsSaveSuccessPatch(
        {
          approvalPolicy: "on-request",
          model: "gpt-5",
          sandboxMode: "workspace-write",
        },
        "en",
      ),
    ).toEqual({
      body: [
        "Session settings saved for future turns.",
        "Model: gpt-5",
        "Approval: on-request",
        "Sandbox: workspace-write",
      ].join("\n"),
      error: undefined,
    });
    expect(threadSettingsSaveFailurePatch(null, "zh")).toEqual({
      error: "保存会话设置失败",
    });
  });

  it("applies thread settings save panel patches", () => {
    const panel = {
      title: "Session settings",
      body: "Ready",
      error: "old",
    };
    const patch = {
      approvalPolicy: "on-request",
      model: "gpt-5",
      sandboxMode: "workspace-write",
    } as const;

    expect(threadSettingsMissingSelectionPanel(panel, "en")).toEqual({
      title: "Session settings",
      body: "Ready",
      error: "No session settings selected",
    });
    expect(realThreadRequiredPanel(panel, "zh")).toEqual({
      title: "Session settings",
      body: "Ready",
      error: "请先选择一个真实会话",
    });
    expect(threadSettingsSaveProgressPanel(panel, "zh")).toEqual({
      title: "Session settings",
      body: "正在保存会话设置...",
      error: undefined,
    });
    expect(threadSettingsSaveSuccessPanel(panel, patch, "en")).toEqual({
      title: "Session settings",
      body: [
        "Session settings saved for future turns.",
        "Model: gpt-5",
        "Approval: on-request",
        "Sandbox: workspace-write",
      ].join("\n"),
      error: undefined,
    });
    expect(threadSettingsSaveFailurePanel(panel, null, "zh")).toEqual({
      title: "Session settings",
      body: "Ready",
      error: "保存会话设置失败",
    });
    expect(threadSettingsSaveProgressPanel(null, "en")).toBeNull();
  });
});
