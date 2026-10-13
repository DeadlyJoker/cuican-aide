// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
  CommandTeamSidebar,
  type TeamSidebarGroup,
  type TeamSidebarMode,
} from "./CommandTeamSidebar";
const office = vi.fn(),
  workflow = vi.fn(),
  experts = vi.fn(),
  create = vi.fn();
const groups: readonly TeamSidebarGroup[] = [
  {
    mode: "office",
    status: "ready",
    entries: [{ id: "office-1", title: "暴雨履约办公室", onOpen: office }],
    onCreate: create,
  },
  {
    mode: "workflow",
    status: "ready",
    entries: [{ id: "workflow-1", title: "合同审阅流程", onOpen: workflow }],
  },
  {
    mode: "experts",
    status: "ready",
    entries: [{ id: "expert-1", title: "合同风险专家团", onOpen: experts }],
  },
];
it("snapshots category counts, real team entries and the current creation action", () => {
  expect(
    renderToStaticMarkup(
      <CommandTeamSidebar
        groups={groups}
        mode="office"
        locale="zh"
        onSelectMode={vi.fn()}
      />,
    ),
  ).toMatchSnapshot();
});
it("searches all types and opens the exact existing team without creating or running anything", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mode: TeamSidebarMode = "office";
  const render = () =>
    root.render(
      <CommandTeamSidebar
        groups={groups}
        mode={mode}
        locale="zh"
        onSelectMode={(next) => {
          mode = next;
          render();
        }}
      />,
    );
  try {
    await act(async () => render());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".command-team-entry")!
        .click(),
    );
    expect(office).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "合同");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("暴雨履约办公室");
    expect(container.textContent).toContain("合同审阅流程");
    expect(container.textContent).toContain("合同风险专家团");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".command-team-entry")]
        .find((b) => b.textContent === "合同审阅流程")!
        .click();
    });
    expect(workflow).toHaveBeenCalledTimes(1);
    expect(experts).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
