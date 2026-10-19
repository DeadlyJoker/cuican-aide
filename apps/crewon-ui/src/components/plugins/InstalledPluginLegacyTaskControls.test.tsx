// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InstalledPluginTaskContextState } from "../../lib/plugins/useInstalledPluginTaskContext.types";
import { taskContextTask } from "../../lib/plugins/installedPluginTaskContext.test-support";
import { InstalledPluginLegacyTaskControls } from "./InstalledPluginLegacyTaskControls";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
function state(
  patch: Partial<InstalledPluginTaskContextState> = {},
): InstalledPluginTaskContextState {
  return {
    phase: "ready",
    error: null,
    thread: null,
    tasks: [],
    source: null,
    data: {},
    prepareThread: vi.fn(),
    refresh: vi.fn(),
    selectSource: vi.fn(),
    ...patch,
  };
}
async function render(value: InstalledPluginTaskContextState, open = vi.fn()) {
  await act(async () =>
    root.render(
      <InstalledPluginLegacyTaskControls
        state={value}
        locale="zh"
        onOpenTask={open}
      />,
    ),
  );
  return open;
}
it("keeps legacy navigation compact and prepares only after an explicit click", async () => {
  const value = state();
  await render(value);
  expect(value.prepareThread).not.toHaveBeenCalled();
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(container.textContent).toBe("创建任务");
  expect(container.innerHTML).toMatchSnapshot();
  await act(async () => container.querySelector("button")!.click());
  expect(value.prepareThread).toHaveBeenCalledOnce();
  expect(value.refresh).not.toHaveBeenCalled();
  expect(document.documentElement.getAttribute("style")).toBeNull();
});
it("opens the confirmed owning thread without displaying task or connection details", async () => {
  const value = state({
    thread: {
      threadId: "verified-legacy-thread",
      revision: 23,
      provisional: true,
    },
  });
  const open = await render(value);
  expect(container.textContent).toBe("打开任务");
  expect(container.innerHTML).toMatchSnapshot();
  await act(async () => container.querySelector("button")!.click());
  expect(open).toHaveBeenCalledWith("verified-legacy-thread");
  expect(value.prepareThread).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("verified-legacy-thread");
});
it("retains the original creation retry instead of replacing an uncertain intent with a refresh", async () => {
  const value = state({ phase: "uncertain", error: "unknown-result" });
  await render(value);
  expect(container.querySelector("button")!.textContent).toBe("重试创建任务");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "同一次请求",
  );
  expect(container.innerHTML).toMatchSnapshot();
  await act(async () => container.querySelector("button")!.click());
  expect(value.prepareThread).toHaveBeenCalledOnce();
  expect(value.refresh).not.toHaveBeenCalled();
});
it("retries a failed read without creating a replacement thread and blocks duplicate preparation", async () => {
  const value = state({ phase: "error", error: "read-failed" });
  await render(value);
  await act(async () => container.querySelector("button")!.click());
  expect(value.refresh).toHaveBeenCalledOnce();
  expect(value.prepareThread).not.toHaveBeenCalled();
  await render({ ...value, phase: "preparing", error: null });
  expect(container.querySelector("button")!.disabled).toBe(true);
  await act(async () => container.querySelector("button")!.click());
  expect(value.prepareThread).not.toHaveBeenCalled();
});
it("keeps read retry available for an already known thread and opens that same thread after recovery", async () => {
  const value = state({
    phase: "error",
    error: "read-failed",
    thread: {
      threadId: "verified-legacy-thread",
      revision: 23,
      provisional: true,
    },
  });
  const open = await render(value);
  expect(container.querySelector("button")!.textContent).toBe("重试读取任务");
  expect(container.querySelector("button")!.disabled).toBe(false);
  expect(container.innerHTML).toMatchSnapshot();
  await act(async () => container.querySelector("button")!.click());
  expect(value.refresh).toHaveBeenCalledOnce();
  expect(value.prepareThread).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  await render({ ...value, phase: "ready", error: null }, open);
  await act(async () => container.querySelector("button")!.click());
  expect(open).toHaveBeenCalledWith("verified-legacy-thread");
  expect(value.prepareThread).not.toHaveBeenCalled();
});

it("retains explicit generation source selection and ordered task navigation for legacy plugins", async () => {
  const task = taskContextTask();
  const value = state({
    thread: { threadId: task.threadId, revision: 2, provisional: false },
    tasks: [task],
  });
  const open = await render(value);
  const select = container.querySelector<HTMLSelectElement>(
    'select[aria-label="查询生成记录"]',
  )!;
  expect(select).not.toBeNull();
  expect(value.selectSource).not.toHaveBeenCalled();
  await act(async () => {
    select.value = JSON.stringify([
      task.runId,
      task.operations[0]!.operationId,
    ]);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(value.selectSource).toHaveBeenCalledWith({
    sourceRunId: task.runId,
    operationId: task.operations[0]!.operationId,
  });
  const list = container.querySelector('[aria-label="已受理任务"]')!;
  await act(async () => list.querySelector("button")!.click());
  expect(open).toHaveBeenCalledWith(task.threadId);
  expect(container.innerHTML).toMatchSnapshot();
  await render({ ...value, phase: "loading" });
  expect(container.querySelector("select")!.disabled).toBe(true);
  expect(container.querySelector('[aria-label="已受理任务"]')).not.toBeNull();
});
