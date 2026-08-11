// @ts-expect-error Vitest runs this snapshot in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Command Workspace operations rail style", () => {
  it("snapshots wide, narrow, and fullscreen canvas layout behavior", () => {
    const styles = readFileSync(
      new URL("../../styles/app.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Workspace operations stay in the selected Command thread, never a new page. */";
    const endMarker =
      "/* End selected Command thread Workspace operation rail. */";
    const start = styles.indexOf(marker);
    const end = styles.indexOf(endMarker, start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const contract = styles.slice(start, end + endMarker.length).trim();

    expect(contract).toContain(
      "grid-template-columns: minmax(0, 1fr) minmax(280px, 340px)",
    );
    expect(contract).toContain("@container command-canvas (max-width: 900px)");
    expect(contract).toContain("grid-template-rows: minmax(0, 1fr) auto");
    expect(contract).toContain("max-height: 152px");
    expect(contract).not.toContain("@media");
    expect(contract).toMatchSnapshot();
  });
});
