import { getDesktopBridge } from "./desktopBridge";

/**
 * The shell rounds its own corners because the desktop window is undecorated.
 * A maximized or fullscreen window has no exposed corner, so the radius has to
 * come off, or macOS fullscreen shows the desktop through the four gaps.
 *
 * Reported as a document attribute rather than React state: the radius is
 * applied by several unrelated shells (title bar app, command workspace,
 * settings), and none of them should have to thread window geometry through
 * props to draw its own border.
 */
export type WindowCornerState = "maximized" | "windowed";

type ObservedWindow = {
  isFullscreen: () => Promise<boolean>;
  isMaximized: () => Promise<boolean>;
  onResized: (handler: () => void) => Promise<() => void>;
};

export async function readWindowCornerState(
  window: ObservedWindow,
): Promise<WindowCornerState> {
  const [maximized, fullscreen] = await Promise.all([
    window.isMaximized(),
    window.isFullscreen(),
  ]);
  return maximized || fullscreen ? "maximized" : "windowed";
}

/**
 * Starts reporting the corner state onto the document root and returns the
 * teardown. A no-op outside the desktop runtime, where a browser tab has no
 * window and the radius stays 0.
 */
export function observeWindowCornerState(params: {
  root?: HTMLElement;
  window?: ObservedWindow;
} = {}): () => void {
  const bridge = getDesktopBridge();
  if (bridge === null) {
    return () => {};
  }

  const root = params.root ?? document.documentElement;
  const observed =
    params.window ??
    ({
      isFullscreen: bridge.window.isFullscreen,
      isMaximized: bridge.window.isMaximized,
      onResized: async (handler: () => void) =>
        bridge.window.onBoundsChanged(handler),
    } satisfies ObservedWindow);
  let stopped = false;
  let unlisten: (() => void) | null = null;

  const report = () => {
    void readWindowCornerState(observed)
      .then((state) => {
        if (!stopped) {
          root.dataset.windowState = state;
        }
      })
      .catch(() => {
        // Losing the state only costs the corner radius, so a rounded window on
        // a maximized frame is preferable to tearing down the shell.
      });
  };

  report();
  void observed
    .onResized(report)
    .then((stop) => {
      if (stopped) {
        stop();
      } else {
        unlisten = stop;
      }
    })
    .catch(() => {});

  return () => {
    stopped = true;
    unlisten?.();
  };
}
