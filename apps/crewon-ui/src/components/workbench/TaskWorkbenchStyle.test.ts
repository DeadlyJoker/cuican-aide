// @ts-expect-error Vitest runs in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workbench output style", () => {
  it("keeps standalone previews bounded and accessible without inline reply controls", () => {
    const css = readFileSync(
      new URL("./TaskWorkbenchPanel.css", import.meta.url),
      "utf8",
    );
    expect(css).not.toContain("workbench-inline-action");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("max-width: 100%");
    expect(css).toContain(".task-workbench-list > button:hover");
    expect(css).toContain(".task-document-preview button:focus-visible");
    expect(css).toMatchSnapshot();
  });
});
