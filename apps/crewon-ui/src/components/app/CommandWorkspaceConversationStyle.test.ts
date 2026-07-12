// @ts-expect-error Vitest runs this snapshot in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("command workspace conversation style", () => {
  it("snapshots the compact Codex-inspired transcript contract", () => {
    const conversationStyles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Keep active conversations close to Codex's quiet transcript hierarchy. */";
    const contract = conversationStyles
      .slice(conversationStyles.indexOf(marker))
      .trim();

    expect(contract).toMatchSnapshot();
  });
});
