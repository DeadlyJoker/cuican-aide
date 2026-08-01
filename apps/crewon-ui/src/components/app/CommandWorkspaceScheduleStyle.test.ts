// @ts-expect-error Vitest runs this snapshot in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("command workspace schedule style", () => {
  it("snapshots the spacious desktop calendar contract", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Personal schedule: calm, content-first planning with visible delivery and run history. */";
    const endMarker = ".schedule-alert {";
    const start = styles.indexOf(marker);
    const end = styles.indexOf(endMarker, start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const contract = styles.slice(start, end).trim();

    expect(contract).toContain(
      '.screen-shell.command-screen .shell-page-view[data-shell-view="schedule"]',
    );
    expect(contract).toContain(".page-stack.schedule-page");
    expect(contract).toContain("gap: clamp(20px, 1.6vw, 28px)");
    expect(contract).toContain("justify-content: flex-end");
    expect(contract).not.toContain(".schedule-heading");
    expect(contract).toContain("min-height: 620px");
    expect(contract).toContain("min-height: clamp(62px, 5.2vw, 76px)");
    expect(contract).toMatchSnapshot();
  });
});
