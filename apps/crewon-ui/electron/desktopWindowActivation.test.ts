import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { bindDesktopWindowActivation } from "./desktopWindowActivation.ts";

function fixture() {
  const app = new EventEmitter();
  const state = { destroyed: false, minimized: false, quitting: false };
  const window = {
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    restore: vi.fn(() => {
      state.minimized = false;
    }),
    show: vi.fn(),
    focus: vi.fn(),
  };
  const dispose = bindDesktopWindowActivation({
    app,
    window,
    isQuitting: () => state.quitting,
  });
  return { app, state, window, dispose };
}

describe("desktop window activation", () => {
  it.each(["activate", "second-instance"])(
    "%s restores the original minimized window",
    (event) => {
      const { app, state, window } = fixture();
      state.minimized = true;
      app.emit(event);
      expect(state.minimized).toBe(false);
      expect(window.restore).toHaveBeenCalledOnce();
      expect(window.show).toHaveBeenCalledOnce();
      expect(window.focus).toHaveBeenCalledOnce();
    },
  );

  it.each(["activate", "second-instance"])(
    "%s cannot reopen an unbound window during close/quit",
    (event) => {
      for (const phase of ["destroyed", "quitting"] as const) {
        const { app, state, window } = fixture();
        state[phase] = true;
        app.emit(event);
        expect(window.restore).not.toHaveBeenCalled();
        expect(window.show).not.toHaveBeenCalled();
        expect(window.focus).not.toHaveBeenCalled();
      }
    },
  );

  it("focuses an existing window and removes both handlers on shutdown", () => {
    const { app, window, dispose } = fixture();
    app.emit("activate");
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalledOnce();
    dispose();
    app.emit("activate");
    app.emit("second-instance");
    expect(window.focus).toHaveBeenCalledOnce();
  });
});
