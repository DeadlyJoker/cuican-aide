import type { ConfigReadResponse } from "@crewon/app-server-protocol/v2/ConfigReadResponse";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";

function configScopedSubtitle(cwd: string | null, locale: Locale): string {
  return cwd || (locale === "zh" ? "全局配置" : "Global config");
}

export function keyboardSettingsText(
  configRead: ConfigReadResponse | null,
  locale: Locale,
): string {
  if (!configRead) {
    return locale === "zh"
      ? "输入与任务\n新建任务: ⌘ N / Ctrl N（发送期间不可用）\n发送消息: Enter / ⌘ Enter / Ctrl Enter（输入框内）\n换行: Shift Enter\n\n右侧工作台（展开时）\n打开文件: ⌘ P / Ctrl P\n新建浏览器标签: ⌘ T / Ctrl T（当前不在浏览器标签时）\n代码审查: Ctrl Shift G（生码场景）\n\n快捷键目前不可自定义。浏览器或操作系统可能优先处理组合键；也可以通过界面按钮完成操作。"
      : "Input & tasks\nNew task: ⌘ N / Ctrl N (unavailable while sending)\nSend message: Enter / ⌘ Enter / Ctrl Enter (in the composer)\nNew line: Shift Enter\n\nRight workbench (while open)\nOpen files: ⌘ P / Ctrl P\nNew browser tab: ⌘ T / Ctrl T (when the active tab is not Browser)\nCode review: Ctrl Shift G (Code scene)\n\nShortcuts cannot be customized yet. The browser or OS may handle a key first; the same actions are available through UI buttons.";
  }
  const shortcuts =
    locale === "zh"
      ? [
          "新对话: ⌘N / Ctrl N",
          "搜索: ⌘K / Ctrl K",
          "发送: ⌘ Enter / Ctrl Enter",
          "审查: ⌃⇧G",
          "浏览器: ⌘T",
          "文件: ⌘P",
          "侧边聊天: ⌥⌘S",
        ]
      : [
          "New chat: ⌘N / Ctrl N",
          "Search: ⌘K / Ctrl K",
          "Send: ⌘ Enter / Ctrl Enter",
          "Review: ⌃⇧G",
          "Browser: ⌘T",
          "Files: ⌘P",
          "Side chat: ⌥⌘S",
        ];
  return [
    locale === "zh" ? "键盘快捷键" : "Keyboard shortcuts",
    shortcuts.map((shortcut) => `- ${shortcut}`).join("\n"),
    `${locale === "zh" ? "配置层" : "Config layers"}: ${configRead?.layers?.length ?? 0}`,
    locale === "zh"
      ? "当前 app-server 协议尚未暴露快捷键写入 API；此页读取配置状态并展示当前桌面端绑定。"
      : "The current app-server protocol does not expose shortcut-write APIs yet. This page reads config state and shows the active desktop bindings.",
  ].join("\n");
}

function keyboardTitle(locale: Locale): string {
  return locale === "zh" ? "键盘快捷键" : "Keyboard shortcuts";
}

export function keyboardDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: keyboardTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function keyboardLoadingPanel(
  cwd: string | null,
  locale: Locale,
): CapabilityPanel {
  return {
    title: keyboardTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    body: locale === "zh" ? "正在读取快捷键..." : "Reading shortcuts...",
  };
}

export function keyboardPanel(params: {
  configRead: ConfigReadResponse | null;
  cwd: string | null;
  locale: Locale;
}): CapabilityPanel {
  const { configRead, cwd, locale } = params;
  return {
    title: keyboardTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    body: keyboardSettingsText(configRead, locale),
    actions: [
      {
        id: "refresh-keyboard",
        label: locale === "zh" ? "刷新快捷键" : "Refresh shortcuts",
      },
    ],
  };
}

export function keyboardErrorPanel(params: {
  cwd: string | null;
  error: unknown;
  locale: Locale;
}): CapabilityPanel {
  const { cwd, error, locale } = params;
  return {
    title: keyboardTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取快捷键失败"
          : "Unable to read shortcuts",
  };
}
