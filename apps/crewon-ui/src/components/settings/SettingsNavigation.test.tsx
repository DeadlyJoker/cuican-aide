import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsNavigation } from "./SettingsNavigation";

describe("SettingsNavigation", () => {
  it("shows only settings backed by Control authorities", () => {
    const markup = renderToStaticMarkup(
      <SettingsNavigation
        activeSection="appearance"
        locale="zh"
        onBack={vi.fn()}
        onSectionChange={vi.fn()}
      />,
    );

    expect(markup).not.toContain("键盘快捷键");
    expect(markup).not.toContain("应用快照");
    expect(markup).not.toContain("工作树");
    expect(markup).not.toContain("MCP 服务器");
    expect(markup).toContain("模型接入");
    expect(markup).toContain("外观");
    expect(markup).toContain("账号");
    expect(markup).toMatchSnapshot();
  });
});
