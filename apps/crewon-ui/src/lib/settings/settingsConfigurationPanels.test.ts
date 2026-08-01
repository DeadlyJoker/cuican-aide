import { describe, expect, it } from "vitest";

import {
  appearanceDisconnectedPanel,
  appearanceErrorPanel,
  appearanceLoadingPanel,
  appearancePanel,
  configDisconnectedPanel,
  configErrorPanel,
  configLoadingPanel,
  configPanel,
  keyboardDisconnectedPanel,
  keyboardErrorPanel,
  keyboardLoadingPanel,
  keyboardPanel,
  personalizationDisconnectedPanel,
  personalizationErrorPanel,
  personalizationLoadingPanel,
  personalizationPanel,
} from "./settingsConfigurationPanels";

describe("settings configuration panels", () => {
  it("builds config panels", () => {
    expect(configDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Config",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(configLoadingPanel(null, "zh")).toEqual({
      title: "配置",
      subtitle: "全局配置",
      body: "正在读取配置...",
    });
    expect(
      configPanel({
        configRead: null,
        configRequirements: null,
        cwd: "/repo",
        errors: ["models failed"],
        locale: "en",
        models: null,
      }),
    ).toEqual({
      title: "Config",
      subtitle: "/repo",
      body: [
        "No config returned",
        "Config requirements: none",
        "Some config reads failed\nmodels failed",
      ].join("\n\n"),
      fields: [
        {
          commitOnChange: true,
          id: "config-model",
          label: "Default model",
          placeholder: "gpt-5-codex",
          value: "",
          options: [],
        },
        {
          commitOnChange: true,
          id: "config-approval-policy",
          label: "Approval policy",
          placeholder: "on-request",
          value: "untrusted",
          options: [
            { label: "untrusted", value: "untrusted" },
            { label: "on-failure", value: "on-failure" },
            { label: "on-request", value: "on-request" },
            { label: "never", value: "never" },
          ],
        },
        {
          commitOnChange: true,
          id: "config-sandbox-mode",
          label: "Sandbox mode",
          placeholder: "workspace-write",
          value: "read-only",
          options: [
            { label: "read-only", value: "read-only" },
            { label: "workspace-write", value: "workspace-write" },
            { label: "danger-full-access", value: "danger-full-access" },
          ],
        },
      ],
    });
    expect(
      configErrorPanel({
        cwd: "/repo",
        error: null,
        locale: "en",
      }),
    ).toEqual({
      title: "Config",
      subtitle: "/repo",
      error: "Unable to read config",
    });
    expect(
      configErrorPanel({
        cwd: null,
        error: new Error("denied"),
        locale: "zh",
      }),
    ).toEqual({
      title: "配置",
      subtitle: "全局配置",
      error: "denied",
    });
  });

  it("builds appearance panels", () => {
    expect(appearanceDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Appearance",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(appearanceLoadingPanel(null, "zh")).toEqual({
      title: "外观",
      subtitle: "全局配置",
      body: "正在读取外观设置...",
    });
    expect(
      appearancePanel({
        configRead: null,
        currentLocale: "zh",
        currentTheme: "dark",
        cwd: "/repo",
        locale: "en",
      }),
    ).toEqual({
      title: "Appearance",
      subtitle: "/repo",
      body: [
        "Appearance",
        "Language: follow current UI",
        "Theme: system/current",
        "Config layers: 0",
        "Appearance settings are written to desktop config and applied immediately.",
      ].join("\n"),
      fields: [
        {
          commitOnChange: true,
          id: "appearance-locale",
          label: "Language",
          value: "zh",
          options: [
            { label: "中文", value: "zh" },
            { label: "English", value: "en" },
          ],
        },
        {
          commitOnChange: true,
          id: "appearance-theme",
          label: "Theme",
          value: "dark",
          options: [
            { label: "Dark", value: "dark" },
            { label: "Light", value: "light" },
          ],
        },
      ],
    });
    expect(
      appearanceErrorPanel({
        cwd: "/repo",
        error: null,
        locale: "en",
      }),
    ).toEqual({
      title: "Appearance",
      subtitle: "/repo",
      error: "Unable to read appearance settings",
    });
    expect(
      appearanceErrorPanel({
        cwd: null,
        error: new Error("denied"),
        locale: "zh",
      }),
    ).toEqual({
      title: "外观",
      subtitle: "全局配置",
      error: "denied",
    });
  });

  it("builds keyboard panels", () => {
    expect(keyboardDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Keyboard shortcuts",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(keyboardLoadingPanel(null, "zh")).toEqual({
      title: "键盘快捷键",
      subtitle: "全局配置",
      body: "正在读取快捷键...",
    });
    expect(
      keyboardPanel({
        configRead: null,
        cwd: "/repo",
        locale: "en",
      }),
    ).toEqual({
      title: "Keyboard shortcuts",
      subtitle: "/repo",
      body: [
        "Keyboard shortcuts",
        [
          "- New chat: ⌘N / Ctrl N",
          "- Search: ⌘K / Ctrl K",
          "- Send: ⌘ Enter / Ctrl Enter",
          "- Review: ⌃⇧G",
          "- Browser: ⌘T",
          "- Files: ⌘P",
          "- Side chat: ⌥⌘S",
        ].join("\n"),
        "Config layers: 0",
        "The current app-server protocol does not expose shortcut-write APIs yet. This page reads config state and shows the active desktop bindings.",
      ].join("\n"),
      actions: [{ id: "refresh-keyboard", label: "Refresh shortcuts" }],
    });
    expect(
      keyboardErrorPanel({
        cwd: "/repo",
        error: null,
        locale: "en",
      }),
    ).toEqual({
      title: "Keyboard shortcuts",
      subtitle: "/repo",
      error: "Unable to read shortcuts",
    });
    expect(
      keyboardErrorPanel({
        cwd: null,
        error: new Error("denied"),
        locale: "zh",
      }),
    ).toEqual({
      title: "键盘快捷键",
      subtitle: "全局配置",
      error: "denied",
    });
  });

  it("builds personalization panels", () => {
    expect(personalizationDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Assistant profile & memory",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(personalizationLoadingPanel(null, "zh")).toEqual({
      title: "助理人格与记忆",
      subtitle: "全局配置",
      body: "正在读取助理人格与记忆设置...",
    });
    expect(
      personalizationPanel({
        configRead: null,
        cwd: "/repo",
        locale: "en",
      }),
    ).toEqual({
      title: "Assistant profile & memory",
      subtitle: "/repo",
      body: [
        "Assistant profile & memory",
        "Role: not configured",
        "Soul & principles: not configured",
        "Long-term memory: Turn off long-term memory",
        "Config layers: 0",
        "The app-server hot-reloads these settings. Role and soul affect new sessions; long-term memory is consolidated asynchronously after conversations become idle and retrieved with bounded relevance.",
      ].join("\n"),
      fields: [
        {
          id: "personalization-instructions",
          label: "Role",
          description:
            "Define who the assistant is, what it owns, and the perspective it works from. Saved as system instructions.",
          multiline: true,
          placeholder:
            "Example: You are my product and engineering assistant, turning ambiguous ideas into verified deliverables.",
          rows: 6,
          value: "",
        },
        {
          id: "personalization-developer-instructions",
          label: "Soul & principles",
          description:
            "Define values, voice, boundaries, and durable behavior principles. Saved as developer instructions.",
          multiline: true,
          placeholder:
            "Example: Mark unverified boundaries honestly, move work forward without crossing authority, and prefer real evidence.",
          rows: 7,
          value: "",
        },
        {
          id: "personalization-memory-mode",
          label: "Long-term memory",
          description:
            "Control whether conversations form long-term memories and whether existing memories are retrieved in new tasks.",
          value: "off",
          options: [
            { label: "Learn and use (recommended)", value: "on" },
            { label: "Use existing memories only", value: "read-only" },
            { label: "Learn without retrieval", value: "learn-only" },
            { label: "Turn off long-term memory", value: "off" },
          ],
        },
      ],
      actions: [
        {
          id: "save-personalization",
          label: "Save assistant settings",
          tone: "primary",
        },
        {
          id: "refresh-personalization",
          label: "Refresh assistant settings",
        },
      ],
    });
    expect(
      personalizationErrorPanel({
        cwd: "/repo",
        error: null,
        locale: "en",
      }),
    ).toEqual({
      title: "Assistant profile & memory",
      subtitle: "/repo",
      error: "Unable to read assistant profile and memory settings",
    });
    expect(
      personalizationErrorPanel({
        cwd: null,
        error: new Error("denied"),
        locale: "zh",
      }),
    ).toEqual({
      title: "助理人格与记忆",
      subtitle: "全局配置",
      error: "denied",
    });
  });
});
