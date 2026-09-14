import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OfficeMessageMarkdown } from "./OfficeMessageMarkdown";

describe("OfficeMessageMarkdown", () => {
  it("preserves user-visible line requirements without requiring blank Markdown lines", () => {
    const markup = renderToStaticMarkup(
      <OfficeMessageMarkdown
        mentions={[]}
        text={[
          "DECISION: NO-GO",
          "CONFLICT: 摘要不一致",
          "GATE: 退款复测通过后发布",
          "UNRESOLVED: 缺少修复证据",
        ].join("\n")}
      />,
    );

    expect(markup).toMatchInlineSnapshot(
      `"<div class=\"markdown-content\"><p>DECISION: NO-GO<br/>\nCONFLICT: 摘要不一致<br/>\nGATE: 退款复测通过后发布<br/>\nUNRESOLVED: 缺少修复证据</p></div>"`,
    );
  });

  it("renders Markdown and highlights only visible Office members", () => {
    const markup = renderToStaticMarkup(
      <OfficeMessageMarkdown
        mentions={[
          { displayText: "@安全审查", id: "member-security" },
          {
            displayText: "@Alex（成员 2）",
            id: "member-alex-review",
          },
        ]}
        text={[
          "## 回归结果",
          "",
          "- **已通过**：@安全审查",
          "- 未知成员：@不存在",
          "- 重名成员：@Alex 与 @Alex（成员 2）",
          "",
          "行内代码 `@安全审查` 不应高亮。",
          "",
          "[@安全审查](https://example.com) 保持为普通链接。",
          "",
          "```text",
          "@安全审查",
          "```",
        ].join("\n")}
      />,
    );

    expect(markup).toContain("<h2>回归结果</h2>");
    expect(markup).toContain("<strong>已通过</strong>");
    expect(markup).toContain(
      '<span class="office-mention" data-member-id="member-security">@安全审查</span>',
    );
    expect(markup).toContain(
      '<span class="office-mention" data-member-id="member-alex-review">@Alex（成员 2）</span>',
    );
    expect(markup).toContain("未知成员：@不存在");
    expect(markup).toContain("重名成员：@Alex 与");
    expect(markup).toContain("<code>@安全审查</code>");
    expect(markup).toContain(
      '<a href="https://example.com" rel="noreferrer" target="_blank">@安全审查</a>',
    );
    expect(markup.match(/class="office-mention"/g)).toHaveLength(2);
    expect(markup).toMatchSnapshot();
  });
});
