// @ts-expect-error Vitest runs this snapshot in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("settings layout contracts", () => {
  it("keeps task pack controls scoped and responsive", () => {
    const styles = readFileSync(
      new URL("./BundledTaskPackSettings.css", import.meta.url),
      "utf8",
    );
    expect(styles).toContain("@media (max-width: 600px)");
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("overflow-wrap: anywhere;");
    expect(styles).toMatchSnapshot();
  });
  it("keeps narrow notification controls below the fixed account pill", () => {
    const styles = readFileSync(
      new URL("../../styles/app.css", import.meta.url),
      "utf8",
    );
    const start = styles.indexOf(
      ".screen-shell.command-screen .settings-command-notice {",
    );
    const end = styles.indexOf(
      "/* The main command workspace follows the same global theme preference. */",
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const rules = styles.slice(start, end).trim();
    expect(rules).toContain("@media (max-width: 840px)");
    expect(rules).toContain("top: 52px;");
    expect(rules).toMatchSnapshot();
  });

  it("wraps authored capability explanations and scopes compact cards", () => {
    const styles = readFileSync(
      new URL("./SettingsSectionHelp.css", import.meta.url),
      "utf8",
    );
    expect(styles).toContain('[data-presentation="authored"]');
    expect(styles).toContain("white-space: normal;");
    expect(styles).toContain("overflow-wrap: anywhere;");
    expect(styles).toMatchSnapshot();
  });
});
