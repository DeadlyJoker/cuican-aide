// @ts-expect-error Vitest reads saved styles in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("preserves the original desktop sidebar grid without a navigation overlay", () => {
  const styles = readFileSync(
    new URL("./ShortDramaPluginPreview.css", import.meta.url),
    "utf8",
  );
  expect(styles).not.toMatch(
    /position:\s*(?:absolute|fixed)|background:|z-index:|padding:/,
  );
  expect(styles).toContain("232px minmax(0, 1fr)");
  expect(styles).toContain("0 minmax(0, 1fr)");
  expect(styles).toMatchSnapshot();
});
