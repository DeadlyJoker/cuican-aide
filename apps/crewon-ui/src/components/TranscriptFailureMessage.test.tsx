import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TranscriptFailureMessage } from "./TranscriptMessage";

describe("model failure presentation", () => {
  it.each(["zh", "en"] as const)(
    "keeps a failed task admission separate from a model failure in %s",
    (locale) => {
      const markup = renderToStaticMarkup(
        <TranscriptFailureMessage
          crewonLabel="CrewON"
          locale={locale}
          error={{
            message: "control_api_transport_unavailable",
            codexErrorInfo: null,
            additionalDetails: null,
          }}
        />,
      );
      expect(markup).toContain(
        locale === "zh" ? "工作台连接中断" : "Workspace connection interrupted",
      );
      expect(markup).toContain(
        locale === "zh" ? "重试原请求" : "retry the original request",
      );
      expect(markup).not.toContain(
        locale === "zh" ? "模型连接失败" : "Model connection failed",
      );
      expect(markup).toContain(
        "<code>control_api_transport_unavailable</code>",
      );
    },
  );
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
      `<details class="failure-details"><summary>错误详情</summary><code>${message}</code></details>`,
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
  it.each([
    "installed_plugin_request_authority_unavailable",
    "project_conversation_execution_unavailable",
    "project_asset_stage_execution_unavailable",
    "project_media_input_stage_execution_unavailable",
  ])("shows plugin service failure separately for %s", (message) => {
    const markup = renderToStaticMarkup(
      <TranscriptFailureMessage
        crewonLabel="CrewON"
        locale="zh"
        error={{ message, codexErrorInfo: null, additionalDetails: null }}
      />,
    );
    expect(markup).toContain("插件执行暂不可用");
    expect(markup).toContain("执行服务尚未准备好");
    expect(markup).not.toContain("模型连接失败");
    expect(markup).toContain(`<code>${message}</code>`);
  });
});
