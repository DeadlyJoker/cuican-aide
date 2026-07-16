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

  it("snapshots the assistant and home conversation alignment contract", () => {
    const conversationStyles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Assistant uses the same real thread transcript and composer as the home chat. */";
    const endMarker =
      "/* Three-scene command home: Scene controls the task contract; execution target is independent. */";
    const contract = conversationStyles
      .slice(
        conversationStyles.indexOf(marker),
        conversationStyles.indexOf(endMarker),
      )
      .trim();

    expect(contract).toMatchSnapshot();
  });

  it("snapshots the markdown table sizing contract", () => {
    const appStyles = readFileSync(
      new URL("../../styles/app.css", import.meta.url),
      "utf8",
    );
    const marker = ".markdown-content table {";
    const baseContract = appStyles
      .slice(appStyles.indexOf(marker), appStyles.indexOf(".markdown-content th,"))
      .trim();
    const commandMarker = `.message[data-kind="agentMessage"]
  .markdown-content
  table {`;
    const commandStart = appStyles.indexOf(commandMarker);
    const commandEnd = appStyles.indexOf("\n}", commandStart) + 2;
    const commandContract = appStyles
      .slice(commandStart, commandEnd)
      .trim();

    expect({ baseContract, commandContract }).toMatchSnapshot();
  });
});
