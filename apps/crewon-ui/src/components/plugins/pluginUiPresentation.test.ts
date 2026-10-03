// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { readPluginUiTheme } from "./pluginUiPresentation";

describe("installed module appearance", () => {
  it("projects existing controls, spacing, dialogs and content font without mutating the host", () => {
    const host = document.createElement("div");
    host.dataset.theme = "dark";
    const values = {
      "--text": "#eeeeee",
      "--control-surface": "#303030",
      "--control-ring-strong": "#888888",
      "--space-6": "24px",
      "--radius-xl": "10px",
      "--shadow-modal": "0 18px 48px rgba(0,0,0,.48)",
      "--user-code-font": "monospace",
      "--private-host-value": "not part of the appearance contract",
    };
    for (const [name, value] of Object.entries(values))
      host.style.setProperty(name, value);
    document.body.append(host);
    const before = host.outerHTML;
    try {
      const painted = readPluginUiTheme(host, "light");
      expect(painted.mode).toBe("dark");
      expect(painted.tokens).toMatchObject({
        "--text": values["--text"],
        "--control-surface": values["--control-surface"],
        "--control-ring-strong": values["--control-ring-strong"],
        "--space-6": values["--space-6"],
        "--radius-xl": values["--radius-xl"],
        "--shadow-modal": values["--shadow-modal"],
        "--user-code-font": values["--user-code-font"],
      });
      expect(painted.tokens).not.toHaveProperty("--private-host-value");
      expect(Object.keys(painted.tokens).length).toBeLessThanOrEqual(64);
      expect(Object.isFrozen(painted.tokens)).toBe(true);
      expect(host.outerHTML).toBe(before);
      host.style.setProperty("--control-surface", "#fafafa");
      host.dataset.theme = "light";
      expect(readPluginUiTheme(host, "dark")).toMatchObject({
        mode: "light",
        tokens: { "--control-surface": "#fafafa" },
      });
      expect(painted.tokens["--control-surface"]).toBe("#303030");
    } finally {
      host.remove();
    }
  });
});
