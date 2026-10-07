// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InstalledPluginTaskPanel } from "./InstalledPluginTaskPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("keeps routine controls collapsed and their draft intact, then reveals recovery without executing it", async () => {
  const container = document.createElement("div"),
    root = createRoot(container),
    retry = vi.fn();
  const render = async (needsAttention: boolean) =>
    act(async () =>
      root.render(
        <InstalledPluginTaskPanel locale="zh" needsAttention={needsAttention}>
          <input defaultValue="" />
          <button onClick={retry}>重试原请求</button>
        </InstalledPluginTaskPanel>,
      ),
    );
  try {
    await render(false);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    details.open = true;
    container.querySelector("input")!.value = "原任务";
    details.open = false;
    await render(true);
    expect(details.open).toBe(true);
    expect(container.querySelector("input")!.value).toBe("原任务");
    expect(retry).not.toHaveBeenCalled();
    expect(container.innerHTML).toMatchSnapshot();
    await act(async () => container.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
