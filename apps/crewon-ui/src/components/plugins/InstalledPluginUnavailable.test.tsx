import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginUiLoaderError } from "../../lib/plugins/pluginUiValidation";
import { InstalledPluginUnavailable } from "./InstalledPluginUnavailable";

describe("plugin unavailability diagnostics", () => {
  it("keeps an actionable protocol code folded and does not render an exception message", () => {
    const markup = renderToStaticMarkup(
      <InstalledPluginUnavailable
        error={new PluginUiLoaderError("plugin_ui_mount_expired")}
        locale="zh"
        onRetry={() => undefined}
      />,
    );
    expect(markup).toContain(
      'data-plugin-error-code="plugin_ui_mount_expired"',
    );
    expect(markup).toContain("<details><summary>诊断信息</summary>");
    expect(markup).not.toContain("<details open");
  });

  it.each([
    new Error("secret arbitrary error"),
    new PluginUiLoaderError("https://example.test/private?token=secret"),
    new PluginUiLoaderError("x".repeat(120)),
  ])(
    "does not expose arbitrary errors, URLs or unbounded protocol values",
    (error) => {
      const markup = renderToStaticMarkup(
        <InstalledPluginUnavailable
          error={error}
          locale="zh"
          onRetry={() => undefined}
        />,
      );
      expect(markup).not.toContain("data-plugin-error-code");
      expect(markup).not.toContain("secret");
      expect(markup).not.toContain("<details");
    },
  );
});
