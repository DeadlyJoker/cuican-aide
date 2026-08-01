// @ts-expect-error Vitest runs this snapshot in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("command workspace catalog style", () => {
  it("snapshots the shared four-column capability catalog", () => {
    const styles = readFileSync(
      new URL("../../styles/app.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Agents, skills, services, and knowledge share one four-column catalog. */";
    const endMarker = "@media (max-width: 980px)";
    const start = styles.indexOf(marker);
    const end = styles.indexOf(endMarker, start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const contract = styles.slice(start, end).trim();

    expect(contract).toContain(".capability-catalog[data-catalog-filter]");
    expect(contract).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
    expect(contract).toMatchSnapshot();
  });
});
