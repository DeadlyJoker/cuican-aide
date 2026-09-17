import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { projectWorkflowWorkbench } from "../../lib/workbench/taskWorkbenchProjection";
import { workflowFixture } from "../../lib/workbench/taskWorkbenchFixture";
import {
  TaskWorkbenchActionsContext,
  TaskWorkbenchScope,
  WorkbenchMarkdownLink,
  WorkbenchVisibilityContext,
  updateWorkbenchPublication,
} from "./TaskWorkbenchContext";
import {
  TaskWorkbenchPanel,
  WorkbenchDocumentPreview,
} from "./TaskWorkbenchPanel";

const snapshot = projectWorkflowWorkbench(workflowFixture, "试点复盘通知");
const actions = {
  publish: vi.fn(),
  reveal: vi.fn(),
  browse: vi.fn(() => true),
};
describe("TaskWorkbenchPanel", () => {
  it("snapshots actionable task outputs and the safe read-only preview", () => {
    const markup = renderToStaticMarkup(
      <TaskWorkbenchActionsContext.Provider value={actions}>
        <TaskWorkbenchPanel snapshot={snapshot} locale="zh" />
        <WorkbenchDocumentPreview
          document={snapshot.documents[0]!}
          snapshot={snapshot}
          locale="zh"
        />
      </TaskWorkbenchActionsContext.Provider>,
    );
    expect(markup).toContain("阶段产物 · 待核对");
    expect(markup).toContain("核验结论 · 非成稿");
    expect(markup).toContain("定位原消息");
    expect(markup).toContain("不是已保存文件");
    expect(markup).toContain("在工作台打开");
    expect(markup).toMatchSnapshot();
  });
  it("disables linkage for hidden rooms while preserving ordinary external links", () => {
    const render = (visible: boolean) =>
      renderToStaticMarkup(
        <TaskWorkbenchActionsContext.Provider value={actions}>
          <WorkbenchVisibilityContext.Provider value={visible}>
            <TaskWorkbenchScope snapshot={snapshot}>
              <WorkbenchMarkdownLink href="https://example.com/">
                资料页
              </WorkbenchMarkdownLink>
            </TaskWorkbenchScope>
          </WorkbenchVisibilityContext.Provider>
        </TaskWorkbenchActionsContext.Provider>,
      );
    expect(render(true)).toContain("在工作台打开");
    expect(render(false)).not.toContain("在工作台");
    expect(render(false)).toContain('target="_blank"');
  });
  it("does not let late old-source cleanup clear the new task", () => {
    const a = Symbol("a"),
      b = Symbol("b");
    const old = updateWorkbenchPublication(null, a, snapshot);
    const next = updateWorkbenchPublication(old, b, {
      ...snapshot,
      scopeId: "workflow:b",
    });
    expect(updateWorkbenchPublication(next, a, null)).toBe(next);
    expect(updateWorkbenchPublication(next, b, null)).toBeNull();
    expect(updateWorkbenchPublication(old, a, snapshot)).toBe(old);
  });
});
