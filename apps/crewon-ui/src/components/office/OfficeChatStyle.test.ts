// @ts-expect-error Vitest runs this snapshot in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function cssRule(styles: string, selector: string) {
  const start = styles.indexOf(selector);
  const end = styles.indexOf("\n}", start) + 2;
  return styles.slice(start, end).trim();
}

describe("Office chat style", () => {
  it("snapshots the quiet bubble and plain mention contract", () => {
    const styles = readFileSync(
      new URL("../../styles/app.css", import.meta.url),
      "utf8",
    );

    expect({
      chatHeader: cssRule(styles, ".control-office-chat-room .office-top {"),
      chatMember: cssRule(styles, ".control-office-chat-members > span {"),
      chatMemberStack: cssRule(styles, ".control-office-chat-members {"),
      chatTitle: cssRule(
        styles,
        ".control-office-chat-room .office-top-title h1 {",
      ),
      memberBubble: cssRule(styles, ".office-bubble-body {"),
      mention: cssRule(styles, ".office-mention {"),
      settingsButton: cssRule(
        styles,
        ".office-top-actions .control-office-member-settings-button {",
      ),
      selfBubble: cssRule(
        styles,
        '.office-bubble[data-self="true"] .office-bubble-body {',
      ),
      selfMention: cssRule(
        styles,
        '.office-bubble[data-self="true"] .office-mention {',
      ),
    }).toMatchSnapshot();
  });
});
