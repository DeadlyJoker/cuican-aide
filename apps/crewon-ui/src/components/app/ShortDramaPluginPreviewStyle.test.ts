// @ts-expect-error Vitest reads saved styles in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("preserves host colors when the preview navigation drawer opens", () => {
  const styles = readFileSync(
    new URL("./ShortDramaPluginPreview.css", import.meta.url),
    "utf8",
  );
  expect(styles).toMatchSnapshot();
});
