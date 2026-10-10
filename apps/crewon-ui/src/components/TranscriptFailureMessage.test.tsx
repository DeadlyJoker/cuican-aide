import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TranscriptFailureMessage } from "./TranscriptMessage";

describe("model failure presentation", () => {
  it.each([
    ["responses_provider_server_is_overloaded", "模型服务繁忙"],
    ["responses_provider_invalid_prompt", "模型请求被拒绝"],
  ])("distinguishes provider error %s", (message, title) => {
    const markup = renderToStaticMarkup(
      <TranscriptFailureMessage
        crewonLabel="CrewON"
        locale="zh"
        error={{ message, codexErrorInfo: null, additionalDetails: null }}
      />,
    );
    expect(markup).toContain(title);
    expect(markup).not.toContain("模型连接失败");
    expect(markup).toContain(
      `<details><summary>错误详情</summary><code>${message}</code></details>`,
    );
  });
  it("retains the existing connection failure behavior for other failures", () => {
    const markup = renderToStaticMarkup(
      <TranscriptFailureMessage
        crewonLabel="CrewON"
        locale="en"
        error={null}
      />,
    );
    expect(markup).toContain("Model connection failed");
    expect(markup).not.toContain("<details>");
  });
});
