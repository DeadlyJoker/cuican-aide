import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsNavigation } from "./SettingsNavigation";

describe("SettingsNavigation", () => {
  it("shows only settings backed by live configuration or runtime actions", () => {
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
    expect(markup).toMatchSnapshot();
  });
});
