import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsContent } from "./SettingsContent";
import { modelProviderListPanel } from "../../lib/model-provider/modelProviderPanel";

describe("SettingsContent", () => {
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

  it("marks preview settings as read-only and does not expose saves", () => {
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

    expect(markup).toContain("当前为预览内容，暂时不能保存");
    expect(markup).toContain("disabled");
    expect(markup).toMatchSnapshot();
  });

  it("shows one concise message while settings are unavailable", () => {
    const markup = renderToStaticMarkup(
      <SettingsContent
        activeSection="config"
        dataMode="disconnected"
        locale="zh"
        panel={{
          title: "Config",
          error: "Local app-server is not connected",
        }}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
      />,
    );

    expect(markup.match(/设置暂不可用/gu)).toHaveLength(1);
    expect(markup.match(/暂时无法读取/gu)).toHaveLength(1);
    expect(markup).not.toContain("app-server");
  });

  it("renders model status without internal service language", () => {
    const panel = modelProviderListPanel({
      settings: {
        revision: 4,
        activeProviderId: "gateway",
        providers: [
          {
            providerId: "gateway",
            displayName: "Gateway",
            endpoint: "https://api.example.com/v1",
            credentialKind: "keychain",
            environmentVariable: null,
            isActive: true,
          },
        ],
        runtimeAvailability: "unavailable",
        updatedAt: "2026-08-09T00:00:00Z",
      },
      credentialCatalog: null,
      cwd: null,
      locale: "zh",
      mutationAvailable: false,
      probeAvailable: false,
    });
    const markup = renderToStaticMarkup(
      <SettingsContent
        activeSection="model-providers"
        dataMode="live"
        locale="zh"
        panel={panel}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
      />,
    );

    expect(markup).toContain("连接状态");
    expect(markup).toContain("不可用");
    expect(markup).toContain("settings-row");
    expect(markup).not.toContain("Provider");
    expect(markup).not.toContain("runtime");
    expect(markup).not.toContain("api.example.com");
    expect(markup).not.toContain("测试");
    expect(markup).toMatchSnapshot();
  });

  it("renders model actions as compact labelled icons", () => {
    const panel = modelProviderListPanel({
      settings: {
        revision: 4,
        activeProviderId: "gateway",
        providers: [
          {
            providerId: "gateway",
            displayName: "Gateway",
            endpoint: "https://api.example.com/v1",
            credentialKind: "keychain",
            environmentVariable: null,
            isActive: true,
          },
        ],
        runtimeAvailability: "available",
        updatedAt: "2026-08-09T00:00:00Z",
      },
      credentialCatalog: {
        activeProviderId: "gateway",
        bindings: [
          {
            credentialAvailable: true,
            credentialKind: "keychain",
            endpoint: "https://api.example.com/v1",
            environmentVariable: null,
            isActive: true,
            modelId: "gateway-model",
            providerId: "gateway",
          },
        ],
      },
      cwd: null,
      locale: "zh",
      mutationAvailable: true,
      probeAvailable: true,
    });
    const markup = renderToStaticMarkup(
      <SettingsContent
        activeSection="model-providers"
        dataMode="live"
        locale="zh"
        panel={panel}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
      />,
    );

    expect(markup).toContain("添加模型");
    expect(markup).toContain("settings-row-badge-icon");
    expect(markup).toContain("当前使用");
    expect(markup).toContain('aria-label="检查连接"');
    expect(markup).toContain('aria-label="编辑"');
    expect(markup).toContain('data-tone="danger"');
    expect(markup).not.toContain("Provider");
    expect(markup).not.toContain("api.example.com");
    expect(markup).not.toContain("runtimeBindingId");
    expect(markup).toMatchSnapshot();
  });
});
