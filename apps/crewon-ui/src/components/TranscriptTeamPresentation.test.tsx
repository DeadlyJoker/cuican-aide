// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  TranscriptMessage,
  TranscriptStreamingMessage,
} from "./TranscriptMessage";
const labels = {
  commandLabel: "命令",
  crewonLabel: "CrewON",
  filesLabel: "文件",
  planLabel: "计划",
  reasoningLabel: "推理",
  youLabel: "你",
};
it("renders member findings and mentions without private delegation protocol", () => {
  const markup = renderToStaticMarkup(
    <TranscriptMessage
      locale="zh"
      itemLabels={labels}
      item={{
        id: "answer",
        type: "agentMessage",
        text: "苏算：运费684元。@姚客·客户服务 请核验。\n[[CrewON delegate:member-3]]",
        phase: "final_answer",
        memoryCitation: null,
      }}
    />,
  );
  expect(markup).toContain("运费684元");
  expect(markup).toContain("姚客·客户服务");
  expect(markup).not.toContain("CrewON delegate");
  expect(markup).toMatchSnapshot();
});
it.each([false, true])(
  "does not expose partial routing markers in live output (partial=%s)",
  (partial) => {
    const markup = renderToStaticMarkup(
      <TranscriptStreamingMessage
        crewonLabel="苏算"
        locale="zh"
        partial={partial}
        streamingText="运费684元。\n[[CrewON delegate:member-"
      />,
    );
    expect(markup).toContain("运费684元");
    expect(markup).not.toContain("CrewON delegate");
  },
);
