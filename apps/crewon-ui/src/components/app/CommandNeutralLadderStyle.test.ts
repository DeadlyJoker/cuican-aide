// @ts-expect-error Vitest runs this snapshot in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readStyles(file: string): string {
  return readFileSync(new URL(`../../styles/${file}`, import.meta.url), "utf8");
}

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing start marker: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `missing end marker: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to).trim();
}

describe("command shell neutral ladder", () => {
  it("snapshots the light grey ladder sampled from the agent window", () => {
    const contract = sliceBetween(
      readStyles("app.css"),
      "  /*\n   * Neutral grey ladder sampled from the Cursor agent window.",
      "  --office:",
    );

    expect(contract).toMatchSnapshot();
  });

  it("snapshots the dark ladder that keeps rail, canvas, and cards distinct", () => {
    const contract = sliceBetween(
      readStyles("app.css"),
      "  /*\n   * Mirrors the light ladder:",
      "  --office:",
    );

    expect(contract).toMatchSnapshot();
  });

  it("snapshots the radius scale", () => {
    const contract = sliceBetween(
      readStyles("app.css"),
      "  --radius-xs:",
      "  /* spacing scale",
    );

    expect(contract).toMatchSnapshot();
  });
});

describe("conversation surfaces follow the theme", () => {
  it("snapshots the code and tool output contract", () => {
    const contract = sliceBetween(
      readStyles("app.css"),
      "/*\n * Code and tool output sit on the same grey ladder",
      ".screen-shell.command-screen .command-thread-room .markdown-content > pre code,",
    );

    expect(contract).toMatchSnapshot();
  });

  it("snapshots the diff row contract for both themes", () => {
    const contract = sliceBetween(
      readStyles("app.css"),
      "/*\n * Diff rows are the one place chromatic colour",
      ".file-read-body {",
    );

    expect(contract).toMatchSnapshot();
  });

  it("snapshots the composer surface contract", () => {
    const contract = sliceBetween(
      readStyles("app.css"),
      "/*\n * Final word on the thread composer;",
      ".screen-shell.command-screen .thread-command-input .composer-state-row {",
    );

    expect(contract).toMatchSnapshot();
  });
});

describe("command shell light locals", () => {
  it("snapshots the sampled sidebar and control tokens", () => {
    const contract = sliceBetween(
      readStyles("original-shell-overrides.css"),
      "/*\n * Command shell locals for the light theme",
      ":root[data-theme=\"light\"]\n  .command-shell-route",
    );

    expect(contract).toMatchSnapshot();
  });

  it("snapshots the narrow-width hero reset that keeps the composer on screen", () => {
    const contract = sliceBetween(
      readStyles("original-shell-overrides.css"),
      "/*\n * Below 860px the shell drops the hero out of absolute positioning",
      ".screen-shell.command-screen .command-thread-room .message-list,",
    );

    expect(contract).toMatchSnapshot();
  });

  it("snapshots the user turn lifting off the canvas in both themes", () => {
    const contract = sliceBetween(
      readStyles("original-shell-overrides.css"),
      "/*\n * The user's own turn lifts off the canvas",
      ':root[data-theme="light"] .command-workbench',
    );

    expect(contract).toMatchSnapshot();
  });
});

describe("command shell dark locals", () => {
  it("snapshots the reference-matched sidebar material and states", () => {
    const contract = sliceBetween(
      readStyles("original-shell-overrides.css"),
      "/*\n * Dark command-sidebar material sampled from the attached desktop reference.",
      ':root:not([data-theme="light"]) .workspace-remove-dialog {',
    );

    expect(contract).toMatchSnapshot();
  });
});

/*
 * Weight is asserted as a distribution rather than a snapshot: the scale is a
 * cross-file rule, so counting the values catches a stray 590 or 650 wherever it
 * is introduced, which a snapshot of any single block would miss.
 */
describe("type weight scale", () => {
  const STEPS = new Set(["400", "500", "600", "700"]);

  function weightsIn(file: string): string[] {
    return Array.from(readStyles(file).matchAll(/font-weight:\s*(\d{3})\b/g)).map(
      (match) => match[1],
    );
  }

  it("keeps every declared weight on the four-step scale", () => {
    const files = ["app.css", "original-shell-overrides.css", "appearance.css"];
    const offenders = files.flatMap((file) =>
      weightsIn(file)
        .filter((weight) => !STEPS.has(weight))
        .map((weight) => `${file}: ${weight}`),
    );

    expect(offenders).toEqual([]);
  });

  it("uses every step in the scale so the hierarchy stays readable", () => {
    const declared = new Set(
      ["app.css", "original-shell-overrides.css", "appearance.css"].flatMap(
        weightsIn,
      ),
    );

    expect([...declared].sort()).toEqual(["400", "500", "600", "700"]);
  });
});

/*
 * A hover that animates two properties on different clocks reads as a flicker:
 * the composer buttons used to fade their background over 150ms while shifting
 * transform over 80ms. Durations are therefore asserted per declaration, since
 * the bug lives in the mismatch rather than in any single value.
 */
describe("transition timing", () => {
  /*
   * A deliberate stagger (an expander whose height opens slower than its content
   * fades) opts out by carrying a `staggered-transition:` comment, so the intent
   * lives next to the rule instead of as an exception list in this test.
   */
  function transitionBlocks(file: string): string[] {
    return Array.from(
      readStyles(file).matchAll(
        /(\/\*[^*]*staggered-transition:[^]*?\*\/\s*)?transition:\s*([^;}]+)[;}]/g,
      ),
    )
      .filter((match) => !match[1])
      .map((match) => match[2].replace(/\s+/g, " ").trim());
  }

  function durationsOf(block: string): string[] {
    return Array.from(block.matchAll(/(\d*\.?\d+)(m?s)/g), (match) => {
      const value = Number(match[1]);
      return String(match[2] === "s" ? value * 1000 : value);
    });
  }

  it("gives every property in one transition the same duration", () => {
    const files = ["app.css", "original-shell-overrides.css"];
    const offenders = files.flatMap((file) =>
      transitionBlocks(file)
        .filter((block) => new Set(durationsOf(block)).size > 1)
        .map((block) => `${file}: ${block}`),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps transform off the composer control transitions", () => {
    // These controls must not shift on hover; only their colours may change.
    const block = sliceBetween(
      readStyles("app.css"),
      ".screen-shell.command-screen .icon-action {",
      "}",
    );

    expect(block).not.toContain("transform");
  });
});
