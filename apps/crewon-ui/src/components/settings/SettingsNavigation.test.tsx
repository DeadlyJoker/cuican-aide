import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsNavigation } from "./SettingsNavigation";

describe("SettingsNavigation", () => {
  it("shows only available settings with product-facing labels", () => {
    const markup = renderToStaticMarkup(
      <SettingsNavigation
        activeSection="config"
        locale="zh"
        onBack={vi.fn()}
        onSectionChange={vi.fn()}
      />,
    );

    expect(markup).not.toContain("键盘快捷键");
    expect(markup).not.toContain("应用快照");
    expect(markup).not.toContain("工作树");
    expect(markup).toContain("AI 模型");
    expect(markup).toContain("工具与服务");
    expect(markup).toContain("设备协助");
    expect(markup).not.toContain("Provider");
    expect(markup).not.toContain("MCP");
    expect(markup).not.toContain("Control");
    expect(markup).toMatchSnapshot();
  });
});
