// @ts-expect-error Vitest runs this snapshot in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("command workspace schedule style", () => {
  it("snapshots the spacious desktop calendar contract", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    // Anchor on the selector, not on prose: keying off a comment made this test
    // fail whenever the comment was reworded.
    const marker =
      '.screen-shell.command-screen .shell-page-view[data-shell-view="schedule"] {';
    const start = styles.indexOf(marker);
    // The calendar rules sit past the first .schedule-alert, so bound the slice
    // on the last one to cover the whole schedule section.
    const end = styles.lastIndexOf(".schedule-alert {");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const contract = styles.slice(start, end).trim();

    expect(contract).toContain(
      '.screen-shell.command-screen .shell-page-view[data-shell-view="schedule"]',
    );
    expect(contract).toContain(".page-stack.schedule-page");
    // The page inset and stack rhythm match the catalog pages rather than the
    // clamped values this page used to set for itself.
    expect(contract).toContain("padding: 10px 18px 36px");
    expect(contract).toContain("gap: 0");
    // Tabs left, actions right, on one row.
    expect(contract).toContain("justify-content: space-between");
    // The panel takes the leftover viewport height instead of stopping at 620px.
    expect(contract).toContain("min-height: 100%");
    expect(contract).toContain("flex: 1 1 auto");
    expect(contract).not.toContain(".schedule-heading");
    expect(contract).toContain("min-height: 620px");
    expect(contract).toContain("min-height: clamp(62px, 5.2vw, 76px)");
    expect(contract).toMatchSnapshot();
  });
});
