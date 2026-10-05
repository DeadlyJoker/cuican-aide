// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { planningLaunchFixture } from "../../lib/plugins/projectPlanningLaunch.test-support";
import { ProjectPlanningLaunchActions } from "./ProjectPlanningLaunchActions";
import { createProjectPlanningLaunch } from "../../lib/plugins/projectPlanningLaunch";
import { createProjectPlanningLaunchIntentStore } from "../../lib/plugins/projectPlanningLaunchIntent";

describe("original conversation launch controls", () => {
  it("shows explicit creation/execution choices and defaults adoption to manual without writing on render", () => {
    const f = planningLaunchFixture(),
      html = renderToStaticMarkup(
        <ProjectPlanningLaunchActions
          proposal={f.proposal}
          launch={f.launch}
          locale="zh"
          onReview={vi.fn()}
          onWorkbench={vi.fn()}
        />,
      );
    expect(html).toContain("创建项目并关联会话");
    expect(html).toContain("创建并按计划执行");
    expect(html).toContain('<option value="manual" selected="">');
    expect(html).toMatchSnapshot();
    expect(f.calls).toHaveLength(0);
  });
  it("keeps creation usable when execution is unavailable", () => {
    const f = planningLaunchFixture(),
      html = renderToStaticMarkup(
        <ProjectPlanningLaunchActions
          proposal={{
            ...f.proposal,
            capability: { ...f.proposal.capability, executionReady: false },
          }}
          launch={f.launch}
          locale="zh"
          onReview={vi.fn()}
          onWorkbench={vi.fn()}
        />,
      );
    expect(html).toContain('class="button primary" disabled=""');
    expect(html).toContain("仍可创建项目");
  });
  it("uses the chosen explicit execution click, then displays the original plan and opens the workbench without creating a draft", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const f = planningLaunchFixture(),
      container = document.createElement("div"),
      root = createRoot(container),
      onReview = vi.fn(),
      onWorkbench = vi.fn();
    try {
      await act(async () =>
        root.render(
          <ProjectPlanningLaunchActions
            proposal={f.proposal}
            launch={f.launch}
            locale="zh"
            onReview={onReview}
            onWorkbench={onWorkbench}
          />,
        ),
      );
      expect(f.calls).toHaveLength(0);
      await act(async () => {
        const select = container.querySelector("select")!;
        select.value = "whenUnchanged";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>("button.primary")!.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(f.launch.snapshot(f.proposal).intent?.adoption).toBe(
        "whenUnchanged",
      );
      expect(container.textContent).toContain("文字计划：等待执行");
      expect(container.textContent).toContain("内容未变时自动采用并继续");
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((b) => b.textContent === "打开 AI 短剧工作台")!
          .click(),
      );
      expect(onWorkbench).toHaveBeenCalledOnce();
      expect(onReview).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("remounts an unresolved original request with observations only and retains a visible continuation choice", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const f = planningLaunchFixture();
    f.transport.invoke.mockImplementation(async (_lease, request) => {
      const out = await f.response(request);
      if (request.action.endsWith(".start")) throw new Error("lost");
      return out;
    });
    await expect(
      f.launch.confirm(f.proposal, { mode: "execute", adoption: "manual" }),
    ).rejects.toThrow("lost");
    const restored = createProjectPlanningLaunch(
        createProjectPlanningLaunchIntentStore(
          f.storage,
          "actual-account-original-api",
        ),
        f.transport,
      ),
      count = f.calls.length;
    const container = document.createElement("div"),
      root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ProjectPlanningLaunchActions
            proposal={f.proposal}
            launch={restored}
            locale="zh"
            onReview={vi.fn()}
            onWorkbench={vi.fn()}
          />,
        ),
      );
      for (
        let i = 0;
        i < 100 && restored.snapshot(f.proposal).phase === "working";
        i++
      )
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      expect(
        f.calls
          .slice(count)
          .every((c) => /\.(getBinding|getProject|get)$/u.test(c.action)),
      ).toBe(true);
      expect(container.textContent).toContain("继续原请求");
      expect(container.textContent).toContain("尚未确认完成");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
