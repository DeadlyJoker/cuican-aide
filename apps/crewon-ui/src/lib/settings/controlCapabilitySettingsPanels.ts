import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import type { RuntimeSurface } from "../platform";
import { settingsSectionLabel, type SettingsSection } from "./settingsCatalog";

export function controlCapabilitySettingsPanel({
  section,
  locale,
  surface,
}: {
  section: SettingsSection;
  locale: Locale;
  surface: RuntimeSurface;
}): CapabilityPanel {
  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const title = settingsSectionLabel(section, locale);
  const open = (target: SettingsSection, label: string) => ({
    id: `settings-open:${target}`,
    label,
  });
  switch (section) {
    case "mcp-servers":
      return {
        title,
      };
    case "browser":
      return {
        title,
        rows: [
          {
            id: "preview",
            title: t("工作台浏览器", "Workbench browser"),
            subtitle: t(
              "返回任务后，在右侧工作台选择浏览器，或点击任务产物中的网页链接。",
              "From a task, open Browser in the right workbench or follow a link in a task output.",
            ),
          },
          {
            id: "agent-browser",
            title: t("智能体网页操作", "Agent browser operations"),
            subtitle: t(
              "需要选择支持网页操作的智能体。你在工作台打开的网页不会自动交给智能体操作。",
              "Choose an agent with browser tools. Opening a page in the workbench does not hand it over to the agent.",
            ),
          },
        ],
        body:
          surface === "web"
            ? t(
                "网页版嵌入预览可能被网站拒绝。需要登录或不允许嵌入的网站，请在独立浏览器中操作。",
                "Web previews may be blocked by the site. Use a separate browser for sign-in or sites that refuse embedding.",
              )
            : t(
                "网页内容和登录信息不会自动分享给智能体。",
                "Page content and sign-in details are not automatically shared with the agent.",
              ),
      };
    case "computer-control":
      return {
        title,
        body: t(
          "暂不支持在这里添加设备。使用本地文件或终端，请在桌面端为任务选择工作空间，再打开右侧工作台。",
          "Devices cannot be added here yet. To use local files or a terminal, select a workspace for your task in the desktop app and open the right workbench.",
        ),
      };
    case "environment":
      return {
        title,
        rows: [
          {
            id: "authority",
            title: t("任务权限", "Task permissions"),
            subtitle: t(
              "发送前在输入框下方选择权限。任务只能使用已获准的工具和文件。",
              "Choose permissions below the composer before sending. Tasks can only use approved tools and files.",
            ),
          },
          {
            id: "approvals",
            title: t("发送与修改", "Sending and making changes"),
            subtitle: t(
              "生成草稿不等于已发送或修改。需要确认的操作会在任务中提示，请检查后再批准。",
              "A draft does not mean something was sent or changed. Review approval requests in the task before accepting them.",
            ),
          },
        ],
        actions: [open("config", t("常规设置", "General settings"))],
      };
    default:
      return {
        title,
        body: t(
          "请从左侧选择设置分类。",
          "Choose a settings category from the sidebar.",
        ),
      };
  }
}
