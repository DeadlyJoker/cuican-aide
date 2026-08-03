// @ts-expect-error Vitest runs this check in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  declaredProperties,
  findDeadRules,
  scanRules,
} from "../../styles/deadRuleScanner";

function readStyles(file: string): string {
  return readFileSync(new URL(`../../styles/${file}`, import.meta.url), "utf8");
}

const STYLE_FILES = [
  "app.css",
  "original-shell-overrides.css",
  "appearance.css",
  "neutral-scale.css",
];

/*
 * The shell stylesheets grew by stacking overrides, so the same selector could
 * appear three or four times with only the last copy taking effect. Dead copies
 * are worse than clutter: the next person edits the one they find first and
 * sees nothing change. These tests fail when a fully shadowed rule reappears.
 */
describe("stylesheet dead rules", () => {
  it.each(STYLE_FILES)("leaves no fully shadowed rule in %s", (file) => {
    const dead = findDeadRules(readStyles(file)).map(
      ({ line, selector, properties }) =>
        `L${line} ${selector} [${properties.join(", ")}]`,
    );

    expect(dead).toEqual([]);
  });
});

/*
 * The scanner guards 27k lines of CSS, so it needs its own coverage: a first
 * attempt at this check used a plain regex, mistook a comment for a selector,
 * and corrupted the file it was meant to protect.
 */
describe("dead rule scanner", () => {
  it("keeps a comment out of the following selector", () => {
    const rules = scanRules("/* note */\n.a {\n  color: red;\n}\n");

    expect(rules.map((rule) => rule.selector)).toEqual([".a"]);
  });

  it("ignores braces and semicolons inside comments and strings", () => {
    const source = `.a {\n  /* } tricky { */\n  content: "; }";\n  color: red;\n}\n.b {\n  gap: 1px;\n}\n`;
    const rules = scanRules(source);

    expect(rules.map((rule) => rule.selector)).toEqual([".a", ".b"]);
  });

  it("reads property names without tripping over function values", () => {
    const props = declaredProperties(
      'background: url("a;b.png"); font: var(--x, 1px);',
    );

    expect([...props].sort()).toEqual(["background", "font"]);
  });

  it("reports a rule whose every property is redeclared later", () => {
    const dead = findDeadRules(
      ".a {\n  color: red;\n}\n.b {\n  gap: 0;\n}\n.a {\n  color: blue;\n}\n",
    );

    expect(dead).toEqual([{ selector: ".a", line: 1, properties: ["color"] }]);
  });

  it("keeps a rule that still owns one property", () => {
    const dead = findDeadRules(
      ".a {\n  color: red;\n  gap: 1px;\n}\n.a {\n  color: blue;\n}\n",
    );

    expect(dead).toEqual([]);
  });

  it("treats a media query override as live, not dead", () => {
    const dead = findDeadRules(
      ".a {\n  width: 10px;\n}\n@media (max-width: 860px) {\n  .a {\n    width: 100%;\n  }\n}\n",
    );

    expect(dead).toEqual([]);
  });

  it("keeps the same selector under two breakpoints", () => {
    const dead = findDeadRules(
      "@media (max-width: 1180px) {\n  .a {\n    width: 90%;\n  }\n}\n@media (max-width: 860px) {\n  .a {\n    width: 100%;\n  }\n}\n",
    );

    expect(dead).toEqual([]);
  });

  it("still catches a duplicate inside one breakpoint", () => {
    const dead = findDeadRules(
      "@media (max-width: 860px) {\n  .a {\n    width: 90%;\n  }\n  .a {\n    width: 100%;\n  }\n}\n",
    );

    expect(dead).toEqual([{ selector: ".a", line: 2, properties: ["width"] }]);
  });

  it("never compares steps from different keyframes", () => {
    const dead = findDeadRules(
      "@keyframes x {\n  to {\n    opacity: 1;\n  }\n}\n@keyframes y {\n  to {\n    opacity: 0;\n  }\n}\n",
    );

    expect(dead).toEqual([]);
  });
});
