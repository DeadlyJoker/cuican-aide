import { describe, expect, it } from "vitest";

import {
  appendAppMentionToken,
  appMentionInfo,
  removeComposerMentionToken,
  upsertPendingComposerMention,
} from "./composerMentions";

describe("composer mention helpers", () => {
  it("builds app mention paths and tokens", () => {
    expect(appMentionInfo("browser", "Browser Tools")).toEqual({
      path: "app://browser",
      token: "$browser-tools",
    });
    expect(appMentionInfo("empty", "!?")).toEqual({
      path: "app://empty",
      token: "$app",
    });
  });

  it("appends app mention tokens without duplicating them", () => {
    expect(appendAppMentionToken("", "$browser")).toBe("$browser ");
    expect(appendAppMentionToken("open settings", "$browser")).toBe(
      "$browser open settings",
    );
    expect(appendAppMentionToken("$browser open settings", "$browser")).toBe(
      "$browser open settings",
    );
  });

  it("upserts pending composer mentions by path", () => {
    const existing = [{ name: "Browser", path: "app://browser" }];

    expect(
      upsertPendingComposerMention(
        existing,
        { path: "app://browser", token: "$browser" },
        "Browser Tools",
      ),
    ).toBe(existing);
    expect(
      upsertPendingComposerMention(
        existing,
        { path: "app://terminal", token: "$terminal" },
        "Terminal",
      ),
    ).toEqual([
      { name: "Browser", path: "app://browser" },
      { name: "Terminal", path: "app://terminal", token: "$terminal" },
    ]);
  });

  it("preserves structured skill mention kind", () => {
    expect(
      upsertPendingComposerMention(
        [],
        {
          kind: "skill",
          path: "/repo/.crewon/skills/review/SKILL.md",
          token: "$review",
        },
        "review",
      ),
    ).toEqual([
      {
        kind: "skill",
        name: "review",
        path: "/repo/.crewon/skills/review/SKILL.md",
        token: "$review",
      },
    ]);
  });

  it("removes a resource token without rewriting surrounding content", () => {
    expect(
      removeComposerMentionToken(
        "检查 $code-review 和其他内容",
        "$code-review",
      ),
    ).toBe("检查 和其他内容");
    expect(removeComposerMentionToken("@产品知识库 继续", "@产品知识库")).toBe(
      "继续",
    );
    expect(
      removeComposerMentionToken("$plugin-creator\n", "$plugin-creator"),
    ).toBe("");
  });
});
