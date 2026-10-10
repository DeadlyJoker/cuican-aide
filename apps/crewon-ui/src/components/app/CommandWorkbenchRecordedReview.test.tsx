import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getDemoThreads } from "../../lib/demo/demoData";
import { projectTaskDetail } from "../../lib/task-detail/taskDetailProjection";
import { recordedTaskChanges } from "../../lib/task-detail/recordedTaskChanges";
import { CommandWorkbenchReview } from "./CommandWorkbenchReview";
const thread = getDemoThreads("zh")[0]!;
const details = recordedTaskChanges(
  thread,
  projectTaskDetail({ thread, locale: "zh", linkedThreads: [] }).changes,
);
describe("recorded review", () => {
  it("renders recorded diffs without requiring a runtime refresh", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkbenchReview
        busyToolId="review"
        locale="zh"
        panel={null}
        recordedChanges={details}
        onRefresh={() => {}}
      />,
    );
    expect(markup).toContain("此对话的变更记录");
    expect(markup).toContain("+function renderMessageContent");
    expect(markup).not.toContain("刷新");
    expect(markup).toMatchSnapshot();
  });
  it("shows missing content explicitly", () => {
    const missing = {
      ...details,
      complete: false,
      files: details.files.map((file) => ({ ...file, diff: null })),
    };
    const markup = renderToStaticMarkup(
      <CommandWorkbenchReview
        busyToolId={null}
        locale="zh"
        panel={null}
        recordedChanges={missing}
        onRefresh={() => {}}
      />,
    );
    expect(markup).toContain("未提供差异内容");
    expect(markup).toMatchSnapshot();
  });
});
