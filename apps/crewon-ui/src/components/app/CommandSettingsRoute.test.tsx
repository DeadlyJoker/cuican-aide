import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandSettingsRoute } from "./CommandSettingsRoute";

describe("CommandSettingsRoute", () => {
  it("uses the command workspace shell for real settings", () => {
    const markup = renderToStaticMarkup(
      <CommandSettingsRoute
        activeSection="appearance"
        dataMode="live"
        disabled={false}
        locale="zh"
        notice={null}
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

    expect(markup).toContain("screen-shell command-screen settings-command-screen");
    expect(markup).not.toContain("titlebar-actions");
    expect(markup).toMatchSnapshot();
  });
});
