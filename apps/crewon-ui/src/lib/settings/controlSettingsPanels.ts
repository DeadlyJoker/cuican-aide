import type { ActiveAgentVersionCatalogResponse } from "@crewon/contracts";
import type { AgentPlatformUser } from "../agent-platform/agentPlatformSession";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import type { RuntimeSurface } from "../platform";
import { settingsSectionLabel, type SettingsSection } from "./settingsCatalog";
import { controlCapabilitySettingsPanel } from "./controlCapabilitySettingsPanels";

export type SettingsCatalogState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; catalog: ActiveAgentVersionCatalogResponse };

export function usesControlSettingsPanel(section: SettingsSection): boolean {
  return [
    "config",
    "account",
    "mcp-servers",
    "browser",
    "computer-control",
    "connections",
    "environment",
  ].includes(section);
}

export function controlSettingsPanel(params: {
  section: SettingsSection;
  locale: Locale;
  state: SettingsCatalogState;
  platformUser: AgentPlatformUser | null;
  surface: RuntimeSurface;
}): CapabilityPanel {
  const { section, locale, state, platformUser, surface } = params;
  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const open = (target: SettingsSection, label: string) => ({
    id: `settings-open:${target}`,
    label,
  });
  const refresh = {
    id: "settings-refresh",
    label: t("刷新状态", "Refresh status"),
  };
  const title = settingsSectionLabel(section, locale);
  const mode =
    surface === "desktop" ? t("桌面端", "Desktop") : t("网页版", "Web");
  const unknown = t("尚未读取", "Not loaded");
  if (section === "connections" && state.status === "error") {
    return {
      title,
      error: t(
        "暂时无法读取设置，请刷新重试。",
        "Settings could not be loaded. Refresh to try again.",
      ),
      actions: [refresh],
    };
  }
  switch (section) {
    case "config":
      return {
        title,
        rows: [
          {
            id: "surface",
            title: t("使用环境", "Environment"),
            subtitle: mode,
          },
          {
            id: "selection",
            title: t("单次任务调整", "Per-task choices"),
            subtitle: t(
              "发送任务前，可在输入框下方调整模型、执行方式和权限。",
              "Choose the model, execution mode and permissions below the composer before sending.",
            ),
          },
        ],
        actions: [
          open("model-providers", t("查看 AI 模型", "View AI models")),
          open("environment", t("安全与权限", "Safety & access")),
        ],
      };
    case "account":
      return {
        title,
        rows: [
          {
            id: "enterprise",
            title: t("企业账号", "Enterprise account"),
            subtitle: platformUser?.username ?? t("未登录", "Signed out"),
            badge: platformUser ? t("已登录", "Signed in") : undefined,
          },
          {
            id: "role",
            title: t("账号角色", "Account role"),
            subtitle:
              platformUser?.role === "admin"
                ? t("管理员", "Administrator")
                : (platformUser?.role ?? unknown),
          },
        ],
        body: t(
          "退出登录：返回工作台，点击左下角账号菜单。",
          "To sign out, return to the workspace and open the account menu at the bottom left.",
        ),
        actions: [
          open("model-providers", t("查看模型来源", "View model sources")),
        ],
      };
    case "connections":
      return {
        title,
        rows: [
          {
            id: "control",
            title: t("任务服务", "Task service"),
            subtitle:
              state.status === "ready"
                ? t(
                    "已连接，可以读取任务配置。",
                    "Connected. Task settings are available.",
                  )
                : t("正在连接…", "Connecting…"),
            badge:
              state.status === "ready"
                ? t("已连接", "Connected")
                : t("读取中", "Loading"),
          },
          {
            id: "identity",
            title: t("企业登录", "Enterprise sign-in"),
            subtitle: platformUser?.username ?? t("未登录", "Signed out"),
          },
        ],
        actions: [
          open("model-providers", t("查看模型连接", "View model connection")),
          open("mcp-servers", t("查看工具与扩展", "View tools & extensions")),
          refresh,
        ],
      };
    default:
      return controlCapabilitySettingsPanel({ section, locale, surface });
  }
}
