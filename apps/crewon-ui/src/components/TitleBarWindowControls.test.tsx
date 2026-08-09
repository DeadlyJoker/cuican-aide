import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  invokeWindowControl,
  TitleBarWindowControls,
} from "./TitleBarWindowControls";

const tauriGlobal = globalThis as typeof globalThis & { isTauri?: boolean };
let previousTauriFlag: boolean | undefined;

describe("TitleBarWindowControls", () => {
  beforeEach(() => {
    previousTauriFlag = tauriGlobal.isTauri;
    tauriGlobal.isTauri = true;
  });

  afterEach(() => {
    if (previousTauriFlag === undefined) {
      delete tauriGlobal.isTauri;
    } else {
      tauriGlobal.isTauri = previousTauriFlag;
    }
  });

  it("renders real macOS controls for the command workspace", () => {
    const markup = renderToStaticMarkup(
      <TitleBarWindowControls
        desktopOnly
        locale="zh"
        platform="mac"
        variant="command"
      />,
    );

    expect(markup).toMatchInlineSnapshot(
      `"<div aria-label="窗口控制" class="window-controls traffic" data-window-controls="native" data-window-platform="mac" role="group"><button aria-label="关闭窗口" class="traffic-light close" data-window-action="close" title="关闭窗口" type="button"><svg aria-hidden="true" class="traffic-light-glyph" viewBox="0 0 12 12"><path d="M4 4 8 8 M8 4 4 8"></path></svg></button><button aria-label="最小化窗口" class="traffic-light minimize" data-window-action="minimize" title="最小化窗口" type="button"><svg aria-hidden="true" class="traffic-light-glyph" viewBox="0 0 12 12"><path d="M3.6 6 H8.4"></path></svg></button><button aria-label="缩放窗口" class="traffic-light zoom" data-window-action="zoom" title="缩放窗口" type="button"><svg aria-hidden="true" class="traffic-light-glyph" viewBox="0 0 12 12"><path d="M6 3.6 V8.4 M3.6 6 H8.4"></path></svg></button></div>"`,
    );
  });

  it("maps each control to its native window operation", async () => {
    const window = {
      close: vi.fn().mockResolvedValue(undefined),
      minimize: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(undefined),
    };

    await invokeWindowControl("close", window);
    await invokeWindowControl("minimize", window);
    await invokeWindowControl("zoom", window);

    expect({
      close: window.close.mock.calls.length,
      minimize: window.minimize.mock.calls.length,
      zoom: window.toggleMaximize.mock.calls.length,
    }).toEqual({ close: 1, minimize: 1, zoom: 1 });
  });
});
