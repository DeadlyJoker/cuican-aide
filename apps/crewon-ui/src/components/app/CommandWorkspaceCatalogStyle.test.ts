// @ts-expect-error Vitest runs this snapshot in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("command workspace catalog style", () => {
  it("snapshots the shared auto-fill capability catalog", () => {
    const styles = readFileSync(
      new URL("../../styles/app.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Agents, skills, services, and knowledge share one auto-fill catalog grid. */";
    const endMarker = "@media (max-width: 980px)";
    const start = styles.indexOf(marker);
    const end = styles.indexOf(endMarker, start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const contract = styles.slice(start, end).trim();

    expect(contract).toContain(".capability-catalog[data-catalog-filter]");
    expect(contract).toContain(
      "grid-template-columns: repeat(auto-fill, minmax(248px, 1fr))",
    );
    expect(contract).toMatchSnapshot();
  });

  it("snapshots the compact knowledge header and card density", () => {
    const styles = readFileSync(
      new URL("../../styles/app.css", import.meta.url),
      "utf8",
    );
    const start = styles.indexOf(
      "/* Knowledge keeps its title, filters, search, and refresh action on one 64px row. */",
    );
    const end = styles.indexOf(".catalog-resource-dialog {", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const contract = styles.slice(start, end).trim();

    expect(contract).toContain("min-height: 64px");
    expect(contract).toContain(
      "grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))",
    );
    expect(contract).toContain("min-height: 146px");
    expect(contract).toMatchSnapshot();
  });
});
