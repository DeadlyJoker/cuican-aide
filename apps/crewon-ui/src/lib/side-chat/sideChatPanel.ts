import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";

function sideChatTitle(locale: Locale): string {
  return locale === "zh" ? "侧边聊天" : "Side chat";
}

export function sideChatCreatingPanel(locale: Locale): CapabilityPanel {
  return {
    title: sideChatTitle(locale),
    subtitle: locale === "zh" ? "分叉会话" : "Fork thread",
    body: locale === "zh" ? "正在创建..." : "Creating...",
  };
}

export function sideChatCreatedPanel(
  threadId: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: sideChatTitle(locale),
    subtitle: threadId,
    body: locale === "zh" ? "已创建分叉会话" : "Forked side chat created",
  };
}

export function sideChatErrorPanel(error: unknown, locale: Locale): CapabilityPanel {
  return {
    title: sideChatTitle(locale),
    subtitle: locale === "zh" ? "分叉会话" : "Fork thread",
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "创建失败"
          : "Unable to create side chat",
  };
}
