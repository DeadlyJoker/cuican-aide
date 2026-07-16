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
});
