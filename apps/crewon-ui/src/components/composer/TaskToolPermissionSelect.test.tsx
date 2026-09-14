// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TaskToolPermissionSelect } from "./TaskToolPermissionSelect";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each(["execution", "schedule"] as const)(
  "explains the complete %s task scope and offers only the two supported modes",
  async (scope) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    try {
      await act(async () =>
        root.render(
          <TaskToolPermissionSelect
            scope={scope}
            value="requestApproval"
            onChange={onChange}
          />,
        ),
      );
      expect(container.textContent).toContain("需要审批的工具操作暂停等待用户");
      expect(container.textContent).toContain(
        scope === "execution" ? "整个本次任务" : "每次日程任务",
      );
      expect(container.textContent).toContain("文件交付");
      expect(container.textContent).toContain("不仅是表格");
      expect(container.textContent).toContain("不替代浏览器或资源授权");
      expect(onChange).not.toHaveBeenCalled();
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[role="combobox"]')!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
          ),
      );
      expect(
        [...container.querySelectorAll('[role="option"]')].map((item) =>
          item.getAttribute("data-value"),
        ),
      ).toEqual(["requestApproval", "approveForMe"]);
      expect(container.textContent).toContain(
        scope === "execution"
          ? "CrewON 代为批准整个本次任务的工具操作"
          : "CrewON 代为批准每次日程任务的工具操作",
      );
      expect(container.innerHTML).not.toMatch(
        /fullAccess|full-access|完全访问|仅对检测到的风险/,
      );
      await act(async () =>
        container
          .querySelector<HTMLElement>('[data-value="approveForMe"]')!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          ),
      );
      expect(onChange).toHaveBeenCalledWith("approveForMe");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

it("keeps a frozen permission choice disabled", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <TaskToolPermissionSelect
          scope="execution"
          value="approveForMe"
          disabled
          onChange={vi.fn()}
        />,
      ),
    );
    expect(
      container.querySelector<HTMLButtonElement>('[role="combobox"]')!.disabled,
    ).toBe(true);
    expect(container.textContent).toContain(
      "CrewON 代为批准整个本次任务的工具操作",
    );
    expect(container.innerHTML).toMatchSnapshot();
  } finally {
    await act(async () => root.unmount());
  }
});
