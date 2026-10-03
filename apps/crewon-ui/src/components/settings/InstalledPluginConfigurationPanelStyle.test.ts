// @ts-expect-error Vitest runs in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("installed plugin configuration settings presentation", () => {
  it("scopes original settings tokens, wrapping and narrow controls to the new panel", () => {
    const css = readFileSync(
      new URL("./InstalledPluginConfigurationPanel.css", import.meta.url),
      "utf8",
    );
    expect(css).toContain("var(--settings-fg)");
    expect(css).toContain("var(--settings-border)");
    expect(css).toContain("var(--settings-card-soft)");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("min-width: 0");
    expect(css).toContain("flex-wrap: wrap");
    expect(css).toContain("@media (max-width: 600px)");
    expect(css).toContain(":focus-visible");
    expect(css).not.toContain("position: fixed");
    expect(css).not.toContain("100vh");
    expect(css).not.toMatch(
      /(^|\n)(?:body|html|:root|\.screen-shell|\.command-sidebar)/u,
    );
    expect(css).toMatchSnapshot();
  });
});
