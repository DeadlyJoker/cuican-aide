import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import { demoCapabilityPanel, demoSettingsPanel } from "../demo/demoContent";
import type { Locale } from "../i18n";
import {
  demoSettingsSectionForAction,
  isAuthDemoAction,
  worktreeDemoAction,
} from "./settingsActions";

export function demoThreadSettingsSavedPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body:
      locale === "zh"
        ? "会话设置已保存（演示）。连接 app-server 后会调用 thread/settings/update。"
        : "Session settings saved (demo). With app-server connected this calls thread/settings/update.",
    error: undefined,
  };
}

export function demoThreadSettingsSavedPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return panel ? { ...panel, ...demoThreadSettingsSavedPatch(locale) } : panel;
}

export function demoCapabilityActionPanel(
  actionId: string,
  locale: Locale,
): CapabilityPanel | null {
  if (actionId === "save-config") {
    return {
      ...demoSettingsPanel("config", locale),
      subtitle: locale === "zh" ? "已保存（演示）" : "Saved (demo)",
      body:
        locale === "zh"
          ? "配置已保存到演示状态。连接本地 app-server 后会写入 config.toml 并热重载用户配置。"
          : "Config saved to demo state. With app-server connected, this writes config.toml and hot-reloads user config.",
    };
  }

  if (actionId === "refresh-appearance" || actionId === "save-appearance") {
    return {
      ...demoSettingsPanel("appearance", locale),
      subtitle: demoSavedOrRefreshedSubtitle(
        actionId === "save-appearance" ? "saved" : "refreshed",
        locale,
      ),
    };
  }

  if (
    actionId === "refresh-personalization" ||
    actionId === "save-personalization"
  ) {
    return {
      ...demoSettingsPanel("personalization", locale),
      subtitle: demoSavedOrRefreshedSubtitle(
        actionId === "save-personalization" ? "saved" : "refreshed",
        locale,
      ),
    };
  }

  const worktreeAction = worktreeDemoAction(actionId);
  if (worktreeAction) {
    return {
      ...demoSettingsPanel("worktrees", locale),
      subtitle:
        worktreeAction === "refreshed"
          ? demoSavedOrRefreshedSubtitle("refreshed", locale)
          : worktreeAction === "forked"
            ? locale === "zh"
              ? "已分叉（演示）"
              : "Forked (demo)"
            : locale === "zh"
              ? "已新建（演示）"
              : "Created (demo)",
    };
  }

  const settingsSection = demoSettingsSectionForAction(actionId);
  if (settingsSection) {
    return demoSettingsPanel(settingsSection, locale);
  }

  if (actionId === "refresh-connectors") {
    return demoCapabilityPanel("web", locale);
  }

  if (isAuthDemoAction(actionId)) {
    return {
      title: locale === "zh" ? "账号" : "Account",
      subtitle: locale === "zh" ? "演示模式" : "Demo mode",
      body:
        locale === "zh"
          ? "演示模式下不会发起真实登录。启动本地 app-server 后，这里会打开模型账号或设备码登录流程。"
          : "Demo mode does not start a real login. Connect the local app-server to open model-account or device-code login here.",
      actions: [
        {
          id: "refresh-account",
          label: locale === "zh" ? "返回账号" : "Back to Account",
        },
      ],
    };
  }

  return null;
}

function demoSavedOrRefreshedSubtitle(
  state: "refreshed" | "saved",
  locale: Locale,
): string {
  if (state === "saved") {
    return locale === "zh" ? "已保存（演示）" : "Saved (demo)";
  }
  return locale === "zh" ? "已刷新（演示）" : "Refreshed (demo)";
}
