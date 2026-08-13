import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsContent } from "./SettingsContent";

describe("SettingsContent", () => {
  it("renders the Control-owned account summary", () => {
    const markup = renderToStaticMarkup(
      <SettingsContent
        activeSection="account"
        locale="zh"
        panel={{
          title: "账号",
          subtitle: "CrewON 身份与本机偏好",
          body: "王小明\n邮箱: user@example.com\n语言: zh\n主题: light\n本页不再连接 App Server；模型凭据在“模型接入”中管理。",
          actions: [{ id: "refresh-account", label: "刷新" }],
        }}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
      />,
    );
    expect(markup).toMatchSnapshot();
  });
  it("renders the assistant role, soul, and memory controls", () => {
    const markup = renderToStaticMarkup(
      <SettingsContent
        activeSection="personalization"
        locale="zh"
        panel={{
          title: "助理人格与记忆",
          subtitle: "全局配置",
          body: "角色、灵魂与长期记忆会影响新任务。",
          fields: [
            {
              id: "personalization-instructions",
              label: "角色定位",
              description: "定义助理是谁、负责什么。",
              multiline: true,
              rows: 6,
              value: "你是我的产品与工程助理。",
            },
            {
              id: "personalization-developer-instructions",
              label: "灵魂与原则",
              description: "定义价值取向与长期行为原则。",
              multiline: true,
              rows: 7,
              value: "诚实标注未验证边界。",
            },
            {
              id: "personalization-memory-mode",
              label: "长期记忆",
              description: "控制记忆的形成与检索。",
              value: "on",
              options: [
                { label: "生成并使用（推荐）", value: "on" },
                { label: "关闭长期记忆", value: "off" },
              ],
            },
          ],
          actions: [
            {
              id: "save-personalization",
              label: "保存助理设置",
              tone: "primary",
            },
          ],
        }}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
      />,
    );

    expect(markup).toMatchSnapshot();
  });

  it("marks demo settings as read-only and does not expose fake saves", () => {
    const markup = renderToStaticMarkup(
      <SettingsContent
        activeSection="appearance"
        dataMode="demo"
        locale="zh"
        panel={{
          title: "外观",
          subtitle: "演示配置",
          body: "外观\n语言: zh\n主题: dark",
          fields: [
            {
              id: "appearance-theme",
              label: "主题",
              value: "dark",
              options: [{ label: "深色", value: "dark" }],
            },
          ],
          actions: [
            {
              id: "save-appearance",
              label: "保存外观",
              tone: "primary",
            },
          ],
        }}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
      />,
    );

    expect(markup).toContain("演示模式不会保存");
    expect(markup).toContain("disabled");
    expect(markup).toMatchSnapshot();
  });
});
