import { describe, expect, it } from "vitest";

import {
  contextFileComposerBlock,
  contextFileThreadPrompt,
} from "./contextFilePrompt";

describe("context file prompt helpers", () => {
  it("builds composer context blocks with localized copy", () => {
    expect(
      contextFileComposerBlock({
        path: "/repo/README.md",
        text: "Project notes",
        locale: "en",
      }),
    ).toBe(
      [
        "Use this workspace context file: /repo/README.md",
        "",
        "```markdown",
        "Project notes",
        "```",
      ].join("\n"),
    );

    expect(
      contextFileComposerBlock({
        path: "/repo/README.md",
        text: "",
        locale: "zh",
      }),
    ).toContain("文件为空");
  });

  it("builds thread prompts and truncates long content", () => {
    expect(
      contextFileThreadPrompt({
        path: "/repo/notes.md",
        text: "abcdef",
        locale: "en",
        maxChars: 4,
      }),
    ).toBe(
      [
        "The user sent this workspace file from the right sidebar as context. Read it and use it in follow-up answers: /repo/notes.md",
        "",
        "```markdown",
        "abcd",
        "...",
        "```",
      ].join("\n"),
    );
  });
});
