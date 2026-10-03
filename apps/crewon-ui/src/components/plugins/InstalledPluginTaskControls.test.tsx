// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstalledPluginTaskControls } from "./InstalledPluginTaskControls";
import type { InstalledPluginTaskContextState } from "../../lib/plugins/useInstalledPluginTaskContext.types";
import { taskContextTask } from "../../lib/plugins/installedPluginTaskContext.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("installed module generic task controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  const callbacks = () => ({
    prepareThread: vi.fn(),
    refresh: vi.fn(),
    selectSource: vi.fn(),
    open: vi.fn(),
  });
  const state = (
    change: Partial<InstalledPluginTaskContextState> = {},
  ): InstalledPluginTaskContextState => ({
    phase: "ready",
    error: null,
    thread: null,
    tasks: [],
    source: null,
    data: {},
    ...callbacks(),
    ...change,
  });
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function render(
    value: InstalledPluginTaskContextState,
    open = vi.fn(),
  ) {
    await act(async () =>
      root.render(
        <InstalledPluginTaskControls
          state={value}
          locale="zh"
          onOpenTask={open}
        />,
      ),
    );
    return open;
  }
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent === label,
    )!;

  it("prepares a destination only after an explicit user action and keeps the original document appearance", async () => {
    const action = callbacks();
    const before = document.documentElement.outerHTML;
    await render(state(action));
    expect(action.prepareThread).not.toHaveBeenCalled();
    await act(async () => button("创建任务").click());
    expect(action.prepareThread).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute("style")).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    expect(before).toContain("<head>");
    expect(container.innerHTML).toMatchSnapshot();
  });

  it("offers an exact creation retry and prevents a refresh from replacing the unknown intent", async () => {
    const action = callbacks();
    await render(state({ ...action, phase: "uncertain", error: "uncertain" }));
    expect(button("刷新任务状态").disabled).toBe(true);
    await act(async () => button("重试创建任务").click());
    expect(action.prepareThread).toHaveBeenCalledTimes(1);
    expect(action.refresh).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "同一次请求",
    );
  });

  it("requires explicit source selection, deduplicates an original operation, and opens its verified owning thread", async () => {
    const action = callbacks();
    const original = taskContextTask();
    const query = {
      ...original,
      runId: "query-run",
      sourceRunId: original.runId,
    };
    const open = await render(
      state({
        ...action,
        thread: {
          threadId: original.threadId,
          revision: 8,
          provisional: false,
        },
        tasks: [query, original],
      }),
    );
    const select = container.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("");
    expect(select.options).toHaveLength(2);
    expect(action.selectSource).not.toHaveBeenCalled();
    await act(async () => {
      select.value = select.options[1].value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(action.selectSource).toHaveBeenCalledWith({
      sourceRunId: original.operations[0].sourceRunId,
      operationId: original.operations[0].operationId,
    });
    await act(async () => button("打开任务").click());
    expect(open).toHaveBeenCalledWith(original.threadId);
    expect(container.textContent).not.toContain("query-run");
    expect(container.innerHTML).toMatchSnapshot();
  });
});
