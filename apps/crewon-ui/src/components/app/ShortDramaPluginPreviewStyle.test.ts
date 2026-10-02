// @ts-expect-error Vitest reads saved styles in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

function styleImports(source: string): string[] {
  return Array.from(
    source.matchAll(/import\s+["']([^"']+\.css)["']/g),
    (match) => match[1].slice(match[1].lastIndexOf("/styles/")),
  );
}

it("loads the original host styles in the production entry's order", () => {
  const original = readFileSync(
    new URL("../../main.tsx", import.meta.url),
    "utf8",
  );
  const originalStyles = styleImports(original);
  expect(originalStyles).toHaveLength(6);
  for (const entry of [
    "../../../../../artifacts/short-drama-workbench-preview/preview.tsx",
    "../../../../../artifacts/installable-plugin-ui-preview/preview.tsx",
  ]) {
    const source = readFileSync(new URL(entry, import.meta.url), "utf8");
    expect(styleImports(source)).toEqual(originalStyles);
  }
});

it("adds no preview-specific CSS overrides to the existing shell", () => {
  const source = readFileSync(
    new URL("./ShortDramaPluginPreview.tsx", import.meta.url),
    "utf8",
  );
  expect(styleImports(source)).toEqual([]);
});
