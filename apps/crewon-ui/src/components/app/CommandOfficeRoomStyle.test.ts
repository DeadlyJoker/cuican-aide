// @ts-expect-error Vitest runs this snapshot in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("command Office room style", () => {
  it("snapshots the scoped Team catalog redesign without changing room layout", () => {
    const styles = readFileSync(
      new URL("../../styles/team-workspace.css", import.meta.url),
      "utf8",
    );
    expect(styles).toContain("repeat(auto-fill, minmax(min(360px, 100%), 1fr))");
    expect(styles).toContain("@container page-stack (max-width: 560px)");
    expect(styles).toContain("@media (max-height: 700px)");
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("prefers-reduced-motion");
    expect(styles).not.toContain(".office-room-inline");
    expect(styles).not.toContain(".workflow-room-inline");
    expect(styles).toMatchSnapshot();
  });
  it("keeps the member-settings pointer target below the narrow account overlay", () => {
    const styles = readFileSync(
      new URL("../../styles/app.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/*\n * The authenticated account pill becomes a fixed top-right overlay at 840px.";
    const start = styles.indexOf(marker);
    const end = styles.indexOf("@media (max-width: 720px)", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(styles.slice(start, end).trim()).toMatchInlineSnapshot(`
      "/*
       * The authenticated account pill becomes a fixed top-right overlay at 840px.
       * Between 721px and 840px the Control Office header otherwise stays on one row,
       * placing its member-settings button underneath that pill. Move only this
       * header's actions to row two; the existing <=720px layout already does so.
       */
      @media (min-width: 721px) and (max-width: 840px) {
        .control-office-chat-room .office-top {
          grid-template-columns: auto minmax(0, 1fr);
          gap: 10px;
        }

        .control-office-chat-room .office-top-actions {
          grid-column: 1 / -1;
          grid-row: 2;
          justify-content: flex-end;
        }
      }"
    `);
  });

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

    expect(contract).toContain(".control-office-chat-composer");
    expect(contract).toContain("width: min(720px, calc(100% - 48px));");
    expect(contract).toContain("calc((100% - 720px) / 2)");
    expect(contract).toContain('.office-bubble:not([data-self="true"])');
    expect(contract).toContain("margin: 0 auto 20px;");
    expect(contract).not.toContain(
      ".control-office-chat-composer\n  .composer-state-row",
    );
    expect(contract).toContain("width: min(100%, 1000px);");
    expect(contract).toContain("grid-template-columns: 40px minmax(0, 1fr);");
    expect(contract).toContain("background: transparent;");
    expect(contract).toMatchSnapshot();
  });

  it("snapshots the design-aligned Workflow list and room contract", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const listStart = styles.indexOf(".shell-page-view .workflow-list {");
    const listEnd = styles.indexOf(
      ".shell-page-view .team-mode-panel {",
      listStart,
    );
    const roomStart = styles.indexOf(
      ".shell-page-view.workflow-room-active .team-workflow-shell {",
    );
    const roomEnd = styles.indexOf(".office-kanban-board {", roomStart);

    expect(listStart).toBeGreaterThanOrEqual(0);
    expect(listEnd).toBeGreaterThan(listStart);
    expect(roomStart).toBeGreaterThanOrEqual(0);
    expect(roomEnd).toBeGreaterThan(roomStart);

    const list = styles.slice(listStart, listEnd).trim();
    const room = styles.slice(roomStart, roomEnd).trim();

    expect(room).toContain("calc((100% - 720px) / 2)");
    expect(room).toContain("width: min(720px, calc(100% - 48px));");
    expect(room).toContain("margin: 10px auto 20px;");
    expect(room).not.toContain("max-width: min(820px, 100%);");

    expect({ list, room }).toMatchSnapshot();
  });

  it("snapshots the design-aligned Team page polish", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Team page polish stays inside the original catalog layout and neutral system. */";
    const start = styles.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);
    const contract = styles.slice(start).trim();

    expect(contract).toContain(".team-mode-summary");
    expect(contract).toContain(".expert-team-entry-policy");
    expect(contract).not.toContain(".team-page-hero");
    expect(contract).not.toContain("linear-gradient");
    expect(contract).toMatchSnapshot();
  });
});
