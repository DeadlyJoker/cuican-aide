// @ts-expect-error Vitest reads the saved styles in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("inherits host appearance and stays inside the content pane", () => {
  const styles = readFileSync(
    new URL("./ShortDramaWorkbenchPreview.css", import.meta.url),
    "utf8",
  );
  expect(styles).not.toMatch(
    /position:\s*fixed|\binset\s*:|100[ds]?vh|drama-sidebar|olive|#[\da-f]{3,8}\b|\brgba?\(/i,
  );
  expect(styles).not.toMatch(
    /(?:^|\n)\s*(?:body|html|:root|\.command-|\.screen-shell)/,
  );
  expect(styles).toContain("font-family: inherit");
  expect(styles).toContain("var(--user-ui-font-size)");
  expect(styles).toContain("var(--control-surface)");
  expect(styles).toContain("var(--radius-md)");
  expect(styles).toContain("min-height: 0");
  expect(styles).toContain("overflow: auto");
});
