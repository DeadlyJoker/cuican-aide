import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getDemoThreads } from "../../lib/demo/demoData";
import { projectTaskDetail } from "../../lib/task-detail/taskDetailProjection";
import { recordedTaskChanges } from "../../lib/task-detail/recordedTaskChanges";
import { ComposerTaskChangesPreview } from "./ComposerTaskChanges";
import { ComposerProgressPill } from "./ComposerProgressPill";
const thread = getDemoThreads("zh")[0]!;
const details = recordedTaskChanges(
  thread,
  projectTaskDetail({ thread, locale: "zh", linkedThreads: [] }).changes,
);
describe("task change surfaces", () => {
  it("renders per-file hover snippets and counts", () => {
    const markup = renderToStaticMarkup(
      <ComposerTaskChangesPreview details={details} locale="zh" />,
    );
    expect(markup).toContain("+function renderMessageContent");
    expect(markup).toContain("app.css");
    expect(markup).toMatchSnapshot();
  });
  it("makes changes independent of the proposed Plan status", () => {
    const markup = renderToStaticMarkup(
      <ComposerProgressPill
        locale="zh"
        running={false}
        summary={{
          hasProposedPlan: true,
          fileChanges: null,
          plan: null,
          runPlan: null,
          runId: "demo-run",
        }}
        taskChanges={{ files: 2, additions: 4, deletions: 2 }}
        changeDetails={details}
        onOpenChanges={() => {}}
      />,
    );
    expect(markup).toContain("计划已生成");
    expect(markup).toContain('aria-label="查看任务改动"');
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toMatchSnapshot();
  });
});
