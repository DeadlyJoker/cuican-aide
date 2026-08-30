import { describe, expect, it, vi } from "vitest";

import { readWindowCornerState } from "./windowCornerState";

function stubWindow(state: { fullscreen: boolean; maximized: boolean }) {
  return {
    isFullscreen: vi.fn().mockResolvedValue(state.fullscreen),
    isMaximized: vi.fn().mockResolvedValue(state.maximized),
    onResized: vi.fn().mockResolvedValue(() => {}),
  };
}

describe("readWindowCornerState", () => {
  it("rounds only a window that still has an exposed corner", async () => {
    const states = await Promise.all([
      readWindowCornerState(stubWindow({ fullscreen: false, maximized: false })),
      readWindowCornerState(stubWindow({ fullscreen: false, maximized: true })),
      readWindowCornerState(stubWindow({ fullscreen: true, maximized: false })),
    ]);

    expect(states).toEqual(["windowed", "maximized", "maximized"]);
  });
});
