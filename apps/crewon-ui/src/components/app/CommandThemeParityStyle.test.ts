// @ts-expect-error Vitest runs this check in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const STYLE_FILES = ["app.css", "original-shell-overrides.css"] as const;

function readStyles(file: string): string {
  return readFileSync(new URL(`../../styles/${file}`, import.meta.url), "utf8");
}

/**
 * Declarations scoped to a theme may use literals: the author has supplied the
 * counterpart. Everything else must go through the neutral scale so both themes
 * read correctly from one declaration.
 */
function isThemeScoped(source: string, offset: number): boolean {
  const head = source.slice(0, offset);
  return head.lastIndexOf('data-theme="dark"') > head.lastIndexOf("\n}");
}

/** Code and scrollbar surfaces are dark in both themes, so their literals hold. */
function isAlwaysDarkSurface(source: string, offset: number): boolean {
  const context = source.slice(Math.max(0, offset - 400), offset);
  return ["markdown-code", "mermaid", "scrollbar"].some((hint) =>
    context.includes(hint),
  );
}

function offsetsOf(source: string, pattern: RegExp): number[] {
  const found: number[] = [];
  for (const match of source.matchAll(pattern)) {
    if (match.index !== undefined) found.push(match.index);
  }
  return found;
}

describe("theme parity", () => {
  it("keeps literal light backgrounds out of unscoped rules", () => {
    // A literal white background cannot follow the theme: dark mode kept these
    // panels pale while their text flipped, so cards read as blank boxes.
    const offenders: string[] = [];

    for (const file of STYLE_FILES) {
      const source = readStyles(file);
      // [^;] spans newlines, so multi-line gradient stacks are covered too.
      const pattern =
        /background(?:-color)?\s*:[^;]*(?:rgb\(\s*255\s+255\s+255|rgba?\(\s*255\s*,\s*255\s*,\s*255|#fff\b|#ffffff\b)[^;]*/gi;

      for (const offset of offsetsOf(source, pattern)) {
        if (isThemeScoped(source, offset)) continue;
        if (isAlwaysDarkSurface(source, offset)) continue;
        const line = source.slice(0, offset).split("\n").length;
        offenders.push(`${file}:${line}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("routes the auth screen surfaces through the neutral scale", () => {
    // The login screen shipped without a dark counterpart at all, so its card
    // stayed light while the heading followed the theme (1.27:1).
    const source = readStyles("app.css");

    for (const declaration of [
      ".crewon-auth-shell",
      ".crewon-auth-card header h2",
      ".crewon-auth-form label",
      ".crewon-auth-tabs",
    ]) {
      const start = source.indexOf(`${declaration} {`);
      expect(start, `missing rule: ${declaration}`).toBeGreaterThan(-1);
      const block = source.slice(start, source.indexOf("}", start));
      expect(block, `${declaration} still uses a literal colour`).not.toMatch(
        /#[0-9a-f]{3,6}\b/i,
      );
    }
  });

  it("gives the auth screen an explicit dark counterpart", () => {
    const source = readStyles("app.css");

    expect(source).toContain(
      ':root[data-theme="dark"] .crewon-auth-form input',
    );
  });

  it("sizes canvas grids against the container, not the viewport", () => {
    // The window stays wide while the canvas shrinks behind the workbench and
    // sidebar, so viewport queries never fired: three capability cards stayed
    // side by side in a half-width column and wrapped one character per line.
    const source = readStyles("original-shell-overrides.css");
    const offenders: string[] = [];

    for (const match of source.matchAll(
      /@media\s*\((?:max|min)-width:\s*\d+px\)\s*\{/g,
    )) {
      if (match.index === undefined) continue;
      // Read the query body, starting just past its opening brace.
      const from = match.index + match[0].length;
      let depth = 1;
      let cursor = from;
      while (depth > 0 && cursor < source.length) {
        if (source[cursor] === "{") depth += 1;
        else if (source[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      const body = source.slice(from, cursor);

      if (
        /\.(?:office-card-grid|team-office-capability-grid|team-capability-live-layout)\b/.test(
          body,
        )
      ) {
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`original-shell-overrides.css:${line}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps dark-scoped text on the light half of the scale", () => {
    // The scale inverts per theme, so `--n-200` is near-white in light but
    // near-black in dark. A dark-scoped rule that sets text from the light end
    // renders dark grey on the near-black canvas: the whole home screen read as
    // faint grey until these were mirrored.
    const offenders: string[] = [];

    for (const file of STYLE_FILES) {
      const source = readStyles(file);
      const pattern = /(?<!-)\bcolor\s*:\s*var\(--n-(\d+)\)/g;

      for (const match of source.matchAll(pattern)) {
        if (match.index === undefined) continue;
        if (Number(match[1]) > 400) continue;
        const head = source.slice(0, match.index);
        const close = head.lastIndexOf("\n}");
        const negated = head.lastIndexOf('not([data-theme="light"])');
        const dark = Math.max(head.lastIndexOf('data-theme="dark"'), negated);
        if (dark <= close) continue;
        const light = head.lastIndexOf('data-theme="light"');
        if (light > close && negated <= close) continue;
        // A rule that also sets its own background is a self-contained badge or
        // button, and inverting both together is deliberate.
        const ruleStart = head.lastIndexOf("{");
        const rule = source.slice(ruleStart, match.index);
        if (/background(?:-color)?\s*:\s*var\(--n-/.test(rule)) {
          continue;
        }
        const line = head.split("\n").length;
        offenders.push(`${file}:${line}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps dark-mode hairlines close to their surface", () => {
    // Borders and text pull in opposite directions: text needs contrast, a
    // hairline needs almost none. Driving dark-scoped borders from the scale
    // resolved --n-800 to oklch(83%), ringing every control in a near-white
    // outline against the near-black canvas.
    const offenders: string[] = [];

    for (const file of STYLE_FILES) {
      const source = readStyles(file);
      const pattern = /border(?:-[a-z]+)?\s*:[^;]*var\(--n-(\d+)\)/g;

      for (const match of source.matchAll(pattern)) {
        if (match.index === undefined) continue;
        // Steps at or above 600 resolve light in dark mode.
        if (Number(match[1]) < 600) continue;
        const head = source.slice(0, match.index);
        const close = head.lastIndexOf("\n}");
        const negated = head.lastIndexOf('not([data-theme="light"])');
        const dark = Math.max(head.lastIndexOf('data-theme="dark"'), negated);
        if (dark <= close) continue;
        const light = head.lastIndexOf('data-theme="light"');
        if (light > close && negated <= close) continue;
        offenders.push(`${file}:${head.split("\n").length}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("pins the workbench panel instead of letting the scale invert it", () => {
    // The workbench is a dark tool panel with explicit light-theme overrides.
    // Driving its baseline from the scale made dark mode resolve --n-1000 to
    // oklch(98%), rendering the panel near-white with dark text.
    const source = readStyles("original-shell-overrides.css");
    const start = source.indexOf(".command-workbench {");
    expect(start, "missing .command-workbench rule").toBeGreaterThan(-1);
    const baseline = source.slice(start, source.indexOf("}", start));

    expect(baseline).not.toMatch(/var\(--n-/);
    expect(baseline).toMatch(/background:\s*oklch\(/);
  });
});
