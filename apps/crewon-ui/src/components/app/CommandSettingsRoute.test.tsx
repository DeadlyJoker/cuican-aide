import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandSettingsRoute } from "./CommandSettingsRoute";
import type { DesktopLocalPluginSourceImportClient } from "../../lib/desktop/desktopLocalPluginSourceImportProtocol";

describe("CommandSettingsRoute", () => {
  it("uses the command workspace shell for real settings", () => {
    const markup = renderToStaticMarkup(
      <CommandSettingsRoute
        activeSection="appearance"
        dataMode="live"
        disabled={false}
        locale="zh"
        notice={null}
        platform="mac"
        panel={{
          title: "外观",
          subtitle: "全局配置",
          fields: [
            {
              commitOnChange: true,
              id: "appearance-theme",
              label: "主题",
              value: "dark",
              options: [
                { label: "深色", value: "dark" },
                { label: "浅色", value: "light" },
              ],
            },
          ],
        }}
        onBack={vi.fn()}
        onDismissNotice={vi.fn()}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
        onPanelFieldCommit={vi.fn()}
        onSectionChange={vi.fn()}
      />,
    );

    expect(markup).toContain(
      "screen-shell command-screen settings-command-screen",
    );
    expect(markup).not.toContain("titlebar-actions");
    expect(markup).toMatchSnapshot();
  });

  it("adds the actual Native chooser within the original tools page without a Control catalogue", () => {
    const client: DesktopLocalPluginSourceImportClient = {
      version: 1,
      previewDirectory: vi.fn(async () => null),
      confirmPreview: vi.fn(),
      cancelPreview: vi.fn(),
      subscribeOwnerChanged: () => () => {},
    };
    const props = {
      activeSection: "mcp-servers" as const,
      dataMode: "disconnected" as const,
      disabled: true,
      locale: "zh" as const,
      notice: null,
      platform: "mac" as const,
      panel: null,
      onBack: vi.fn(),
      onDismissNotice: vi.fn(),
      onPanelAction: vi.fn(),
      onPanelFieldChange: vi.fn(),
      onPanelFieldCommit: vi.fn(),
      onSectionChange: vi.fn(),
    };
    const original = renderToStaticMarkup(<CommandSettingsRoute {...props} />);
    expect(original).not.toContain("选择本机插件目录");
    const native = renderToStaticMarkup(
      <CommandSettingsRoute
        {...props}
        localSourceImport={{ client, ownerKey: "native-owner" }}
      />,
    );
    expect(native).toContain("settings-command-window");
    expect(native).toContain("选择本机插件目录");
    expect(native).not.toContain("本地插件预览");
    expect(client.previewDirectory).not.toHaveBeenCalled();
    const demo = renderToStaticMarkup(
      <CommandSettingsRoute
        {...props}
        dataMode="demo"
        localSourceImport={{ client, ownerKey: "native-owner" }}
      />,
    );
    expect(demo).not.toContain("选择本机插件目录");
    const general = renderToStaticMarkup(
      <CommandSettingsRoute
        {...props}
        activeSection="environment"
        localSourceImport={{ client, ownerKey: "native-owner" }}
      />,
    );
    expect(general).not.toContain("选择本机插件目录");
  });
});
