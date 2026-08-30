// @ts-expect-error Vitest runs this check in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const marker =
  "/* Sidebar task signals keep full titles discoverable without widening the rail. */";
const endMarker = "/* End sidebar task signals. */";

function taskSignalStyles(): string {
  const source = readFileSync(
    new URL("../../styles/original-shell-overrides.css", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(marker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + endMarker.length);
}

describe("command sidebar task styles", () => {
  it("keeps compact signals, hover details, and both theme palettes together", () => {
    const styles = taskSignalStyles();

    expect(styles).toContain("text-overflow: ellipsis");
    expect(styles).toContain("@keyframes command-sidebar-task-pulse");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain(':root[data-theme="light"]');
    expect(styles).toContain(':root[data-theme="dark"]');
    expect(styles).toContain("--command-task-tooltip-bg: #fffefa");
    expect(styles).toContain("--command-task-tooltip-bg: #4b4b4c");
  });
});
