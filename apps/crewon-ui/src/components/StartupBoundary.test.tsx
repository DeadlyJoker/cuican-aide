// @vitest-environment happy-dom
import { act, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { StartupBoundary } from "./StartupBoundary";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("keeps a visible recovery action when a downloaded workspace chunk rejects, without automatic reload", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const retry = vi.fn();
  const container = document.createElement("div"),
    root = createRoot(container);
  const BrokenWorkspace = lazy(async () => {
    throw new Error("chunk unavailable");
  });
  try {
    await act(async () => {
      root.render(
        <StartupBoundary onRetry={retry}>
          <Suspense fallback={<p role="status">正在打开工作台…</p>}>
            <BrokenWorkspace />
          </Suspense>
        </StartupBoundary>,
      );
    });
    expect(container.textContent).toContain("页面资源加载失败");
    expect(retry).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    consoleError.mockRestore();
  }
});
