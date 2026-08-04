// @ts-expect-error Vitest runs this snapshot in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("command Office room style", () => {
  it("snapshots the Team card layout and responsive contract", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const cardMarker =
      "/* Keep Office card content inside the design artifact's fixed action slot. */";
    const responsiveMarker =
      "/* Match the design artifact's Team responsive density. */";
    const cardContract = styles
      .slice(
        styles.indexOf(cardMarker),
        styles.indexOf(".shell-page-view .team-office-shell.is-room-open"),
      )
      .trim();
    const responsiveContract = styles
      .slice(
        styles.indexOf(responsiveMarker),
        styles.indexOf(".shell-page-view .expert-member-stack {"),
      )
      .trim();

    expect({ cardContract, responsiveContract }).toMatchSnapshot();
  });

  it("snapshots the visible Office landing contract", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Keep Office visibly discoverable before real records are available. */";
    const endMarker =
      "/* Keep Office card content inside the design artifact's fixed action slot. */";
    const contract = styles
      .slice(styles.indexOf(marker), styles.indexOf(endMarker))
      .trim();

    expect(contract).toMatchSnapshot();
  });

  it("snapshots the Workflow and Experts live-runtime layout contract", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const marker = ".shell-page-view .team-capability-live-layout {";
    const endMarker = ".shell-page-view .expert-room-inline {";
    const start = styles.indexOf(marker);
    const end = styles.indexOf(endMarker, start);

    expect({ start, end }).toEqual({
      start: expect.any(Number),
      end: expect.any(Number),
    });
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const contract = styles.slice(start, end).trim();

    expect(contract).toContain(".team-capability-definition");
    expect(contract).toContain(".team-capability-run-panel");
    expect(contract).toContain(".team-capability-workspace");
    expect(contract).toContain(".expert-member-stack");
    // Canvas-relative: the window stays wide while the canvas shrinks behind
    // the workbench, so a viewport query never matched here.
    expect(contract).toContain("@container page-stack (max-width: 860px)");
    expect(contract).toMatchSnapshot();
  });

  it("snapshots the canonical Office workspace embedding contract", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Embed the canonical Office workspace inside Team without a second runtime. */";
    const endMarker = ".shell-page-view.office-room-active .office-room-top {";
    const contract = styles
      .slice(styles.indexOf(marker), styles.indexOf(endMarker))
      .trim();

    expect(contract).toMatchSnapshot();
  });

  it("snapshots the design-aligned Workflow list and room contract", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const listStart = styles.indexOf(".shell-page-view .workflow-list {");
    const listEnd = styles.indexOf(".shell-page-view .team-mode-panel {", listStart);
    const roomStart = styles.indexOf(
      ".shell-page-view.workflow-room-active .team-workflow-shell {",
    );
    const roomEnd = styles.indexOf(".workflow-execution-strip {", roomStart);

    expect(listStart).toBeGreaterThanOrEqual(0);
    expect(listEnd).toBeGreaterThan(listStart);
    expect(roomStart).toBeGreaterThanOrEqual(0);
    expect(roomEnd).toBeGreaterThan(roomStart);

    expect({
      list: styles.slice(listStart, listEnd).trim(),
      room: styles.slice(roomStart, roomEnd).trim(),
    }).toMatchSnapshot();
  });
});
