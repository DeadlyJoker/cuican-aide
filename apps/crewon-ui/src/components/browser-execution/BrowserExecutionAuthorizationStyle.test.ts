// @ts-expect-error Vitest reads the stylesheet in Node; production excludes Node types.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps browser authorization controls scoped, responsive and keyboard-visible", () => {
  const css = readFileSync(
    new URL("./BrowserExecutionAuthorization.css", import.meta.url),
    "utf8",
  );
  expect(css).toContain("overflow-wrap: anywhere");
  expect(css).toContain("flex-wrap: wrap");
  expect(css).toContain("button:focus-visible");
  expect(css).toContain("var(--accent)");
  expect(css).toMatchSnapshot();
});
