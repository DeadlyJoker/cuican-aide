import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const instances: Array<{
    setBounds: ReturnType<typeof vi.fn>;
    setVisible: ReturnType<typeof vi.fn>;
    webContents: {
      close: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn>;
      loadURL: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
    };
  }> = [];

  class WebContentsView {
    setBounds = vi.fn();
    setVisible = vi.fn();
    webContents = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
      loadURL: vi.fn(async () => undefined),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };

    constructor() {
      instances.push(this);
    }
  }

  return {
    instances,
    openExternal: vi.fn(async () => undefined),
    WebContentsView,
  };
});

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  shell: { openExternal: electron.openExternal },
  WebContentsView: electron.WebContentsView,
}));

import { BrowserViewManager } from "./browserViews.ts";

describe("BrowserViewManager", () => {
  beforeEach(() => {
    electron.instances.length = 0;
    vi.clearAllMocks();
  });

  it("adds a newly created native view in a hidden state", async () => {
    const addChildView = vi.fn();
    const manager = new BrowserViewManager({
      contentView: {
        addChildView,
        removeChildView: vi.fn(),
      },
    } as never);

    await manager.create("browser-generation-1", "https://example.test/", {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });

    const view = electron.instances[0];
    expect(view?.setVisible).toHaveBeenCalledWith(false);
    expect(view?.setVisible.mock.invocationCallOrder[0]).toBeLessThan(
      addChildView.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
