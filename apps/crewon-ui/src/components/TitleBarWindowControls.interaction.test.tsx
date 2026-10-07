// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TitleBarWindowControls } from "./TitleBarWindowControls";

it("dispatches actual button clicks through the native bridge", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const controls = {
    close: vi.fn().mockResolvedValue(undefined),
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(window, "crewonDesktop", {
    configurable: true,
    value: { version: 1, window: controls },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<TitleBarWindowControls desktopOnly platform="mac" />);
    });
    for (const action of ["minimize", "zoom", "close"]) {
      const button = container.querySelector<HTMLButtonElement>(
        `[data-window-action="${action}"]`,
      )!;
      expect(button.disabled).toBe(false);
      await act(async () => {
        button.click();
      });
    }
    expect(controls.minimize).toHaveBeenCalledOnce();
    expect(controls.toggleMaximize).toHaveBeenCalledOnce();
    expect(controls.close).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "crewonDesktop");
  }
});
