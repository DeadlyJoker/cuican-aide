// @ts-expect-error Vitest runs this check in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const startMarker =
  "/* Mermaid live previews keep one stable canvas while streamed source evolves. */";
const endMarker = "/* End Mermaid live previews. */";

function mermaidStyles(): string {
  const source = readFileSync(
    new URL("../styles/app.css", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + endMarker.length);
}

describe("Mermaid transcript styles", () => {
  it("keeps the preview compact, stable, responsive, and motion-safe", () => {
    const styles = mermaidStyles();
    const allStyles = readFileSync(
      new URL("../styles/app.css", import.meta.url),
      "utf8",
    );

    expect(styles).toContain("width: min(100%, 720px)");
    expect(styles).toContain("min-height: 180px");
    expect(styles).toContain("mermaid-placeholder-shimmer");
    expect(styles).toContain("prefers-reduced-motion: reduce");
    expect(styles).toContain("max-height: calc(100dvh - 48px)");
    expect(styles).toContain("env(safe-area-inset-top)");
    expect(styles).not.toContain("min-width: min(920px, 100%)");
    expect(styles).not.toContain("backdrop-filter");
    expect(allStyles).toContain("@container command-canvas (max-width: 620px)");
    expect(allStyles).not.toContain("min-width: min(560px, 100%)");
    expect(allStyles).not.toContain("background: rgba(99, 199, 232, 0.045)");
    expect(styles).toMatchSnapshot();
  });
});
