import { Minus, Square, X } from "lucide-react";

import type { Locale } from "../lib/i18n";
import { requireDesktopBridge } from "../lib/desktop/desktopBridge";
import {
  detectRuntimeSurface,
  hasDesktopBridge,
  type PlatformKind,
} from "../lib/platform";

type WindowControlAction = "close" | "minimize" | "zoom";
type ControlledWindow = {
  close(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
};

export function invokeWindowControl(
  action: WindowControlAction,
  window: ControlledWindow = requireDesktopBridge().window,
): Promise<void> {
  switch (action) {
    case "close":
      return window.close();
    case "minimize":
      return window.minimize();
    case "zoom":
      return window.toggleMaximize();
  }
}

/*
 * macOS paints a glyph inside each light while the pointer is anywhere over the
 * group, so the lights read as buttons rather than decoration. The paths are
 * drawn in a 12x12 box to match the light itself; CSS owns the reveal.
 */
const macGlyphPaths: Record<WindowControlAction, string> = {
  close: "M4 4 8 8 M8 4 4 8",
  minimize: "M3.6 6 H8.4",
  zoom: "M6 3.6 V8.4 M3.6 6 H8.4",
};

const macOrder: readonly WindowControlAction[] = ["close", "minimize", "zoom"];
const windowsOrder: readonly WindowControlAction[] = [
  "minimize",
  "zoom",
  "close",
];
const windowsIcons: Record<WindowControlAction, typeof Minus> = {
  close: X,
  minimize: Minus,
  zoom: Square,
};

function controlLabels(locale: Locale): Record<
  WindowControlAction | "group",
  string
> {
  return locale === "zh"
    ? {
        close: "关闭窗口",
        group: "窗口控制",
        minimize: "最小化窗口",
        zoom: "缩放窗口",
      }
    : {
        close: "Close window",
        group: "Window controls",
        minimize: "Minimize window",
        zoom: "Zoom window",
      };
}

/**
 * The one window-control surface. Every shell (title bar, command sidebar,
 * settings sidebar) renders this so macOS and Windows stay consistent instead of
 * each screen hardcoding its own three dots.
 *
 * Outside the desktop runtime the same markup renders disabled, so one set of
 * styles covers both cases.
 */
export function TitleBarWindowControls({
  desktopOnly = false,
  locale = "zh",
  platform,
  variant = "titlebar",
}: {
  desktopOnly?: boolean;
  locale?: Locale;
  platform: PlatformKind;
  variant?: "command" | "titlebar";
}) {
  /*
   * Keyed to the runtime surface so `?surface=desktop` renders
   * the live chrome in a browser. The host call itself stays guarded in
   * `runAction`: there is a window to *draw* here, but not always one to move.
   */
  const interactive = detectRuntimeSurface() === "desktop";
  if (!interactive && desktopOnly) {
    return null;
  }

  /*
   * `web` means "neither macOS nor Windows": a browser tab has no window to
   * control, so it only reserves the space the title bar grid expects. Inside
   * the desktop runtime there *is* a window, and it needs a control set, so the
   * host OS decides which one.
   */
  if (platform === "web" && !interactive) {
    return (
      <div className="window-controls" aria-hidden="true">
        <span className="web-window-spacer" />
      </div>
    );
  }
  const resolvedPlatform =
    platform === "web"
      ? navigator.userAgent.toLowerCase().includes("mac")
        ? "mac"
        : "windows"
      : platform;

  const labels = controlLabels(locale);
  const runAction = (action: WindowControlAction) => {
    // `?surface=desktop` in a browser draws the chrome but has no window behind
    // it, so the call itself has to check for the real bridge.
    if (!hasDesktopBridge()) {
      return;
    }
    void invokeWindowControl(action).catch((error: unknown) => {
      console.error(`Failed to ${action} the desktop window`, error);
    });
  };

  /*
   * Only macOS gets traffic lights. Windows and Linux both get the square
   * button row, which is why this is a single check rather than a per-OS
   * lookup: "not mac" is the whole rule.
   */
  const isMac = resolvedPlatform === "mac";
  const order = isMac ? macOrder : windowsOrder;

  return (
    <div
      aria-hidden={interactive ? undefined : true}
      aria-label={interactive ? labels.group : undefined}
      className={variant === "command" ? "window-controls traffic" : "window-controls"}
      data-window-controls={interactive ? "native" : "static"}
      data-window-platform={isMac ? "mac" : "windows"}
      role={interactive ? "group" : undefined}
    >
      {order.map((action) => {
        const Icon = windowsIcons[action];
        return isMac ? (
          <button
            key={action}
            aria-label={labels[action]}
            className={`traffic-light ${action}`}
            data-window-action={action}
            disabled={!interactive}
            tabIndex={interactive ? undefined : -1}
            title={labels[action]}
            type="button"
            onClick={interactive ? () => runAction(action) : undefined}
          >
            <svg
              aria-hidden="true"
              className="traffic-light-glyph"
              viewBox="0 0 12 12"
            >
              <path d={macGlyphPaths[action]} />
            </svg>
          </button>
        ) : (
          <button
            key={action}
            aria-label={labels[action]}
            className={
              action === "close" ? "window-button close-button" : "window-button"
            }
            data-window-action={action}
            disabled={!interactive}
            tabIndex={interactive ? undefined : -1}
            title={labels[action]}
            type="button"
            onClick={interactive ? () => runAction(action) : undefined}
          >
            <Icon size={action === "zoom" ? 12 : 14} />
          </button>
        );
      })}
    </div>
  );
}

export function DesktopWindowDragRegion() {
  if (detectRuntimeSurface() !== "desktop") {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className="command-window-drag-region"
      data-desktop-drag-region=""
    />
  );
}
