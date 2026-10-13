// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CommandWorkflowPanel } from "./CommandWorkflowPanel";
import type { CrewonWorkflowRecord } from "../../lib/workflow/crewonWorkflow";
const record: CrewonWorkflowRecord = {
  filePath: "control:workflow:w1",
  savedAt: "2026-10-13T00:00:00Z",
  config: {
    workflowId: "w1",
    name: "合同审阅流程",
    description: "复核合同",
    lead: "审阅员",
    status: "ready",
    resourceSource: "crewon",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    runs: [],
  },
};
it("opens the requested real Workflow without running it and does not reopen it after returning and catalog refresh", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const run = vi.fn();
  const open = { workflowId: "w1", revision: 1 };
  const render = (request = open, records = [record]) =>
    root.render(
      <CommandWorkflowPanel
        workflows={records}
        status="ready"
        openRequest={request}
        onRun={run}
        onCancel={vi.fn()}
        onResolveGate={vi.fn()}
        onReload={vi.fn()}
      />,
    );
  try {
    await act(async () => render({ workflowId: "missing", revision: 0 }));
    expect(container.querySelector("[data-workflow-room]")).toBeNull();
    await act(async () => render());
    expect(container.querySelector("[data-workflow-room]")).not.toBeNull();
    expect(run).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".workflow-room-top button")!
        .click(),
    );
    expect(container.querySelector("[data-workflow-room]")).toBeNull();
    await act(async () => render(open, [{ ...record }]));
    expect(container.querySelector("[data-workflow-room]")).toBeNull();
    await act(async () => render({ workflowId: "w1", revision: 2 }));
    expect(container.querySelector("[data-workflow-room]")).not.toBeNull();
    expect(run).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
