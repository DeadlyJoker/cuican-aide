// @ts-expect-error Vitest runs in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("business extension panel style", () => {
  it("uses existing neutral tokens and keeps controls reachable at narrow widths", () => {
    const css = readFileSync(
      new URL("./BusinessExtensionPanel.css", import.meta.url),
      "utf8",
    );
    expect(css).toContain("var(--settings-fg, var(--text))");
    expect(css).toContain("var(--radius-lg)");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("flex-wrap: wrap");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).not.toContain("position: fixed");
    expect(css).not.toContain("min-height: 100vh");
    expect(css).toMatchSnapshot();
  });
});
