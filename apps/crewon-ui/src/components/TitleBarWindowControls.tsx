import { Minus, Square, X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { Locale } from "../lib/i18n";
import type { PlatformKind } from "../lib/platform";

type WindowControlAction = "close" | "minimize" | "zoom";
type ControlledWindow = Pick<
  ReturnType<typeof getCurrentWindow>,
  "close" | "minimize" | "toggleMaximize"
>;

export function invokeWindowControl(
  action: WindowControlAction,
  window = getCurrentWindow() as ControlledWindow,
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
  const desktopRuntime = isTauri();
  if (!desktopRuntime) {
    if (desktopOnly) {
      return null;
    }

    return (
      <div className="window-controls" aria-hidden="true">
        {platform === "mac" ? (
          <>
            <span className="traffic-light close" />
            <span className="traffic-light minimize" />
            <span className="traffic-light zoom" />
          </>
        ) : platform === "windows" ? (
          <>
            <button className="window-button" type="button" tabIndex={-1}>
              <Minus size={14} />
            </button>
            <button className="window-button" type="button" tabIndex={-1}>
              <Square size={12} />
            </button>
            <button
              className="window-button close-button"
              type="button"
              tabIndex={-1}
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <span className="web-window-spacer" />
        )}
      </div>
    );
  }

  const resolvedPlatform: PlatformKind =
    platform === "web"
      ? navigator.userAgent.toLowerCase().includes("win")
        ? "windows"
        : "mac"
      : platform;

  const labels =
    locale === "zh"
      ? {
          close: "关闭窗口",
          minimize: "最小化窗口",
          zoom: "缩放窗口",
          group: "窗口控制",
        }
      : {
          close: "Close window",
          minimize: "Minimize window",
          zoom: "Zoom window",
          group: "Window controls",
        };
  const className =
    variant === "command" ? "window-controls traffic" : "window-controls";
  const runAction = (action: WindowControlAction) => {
    void invokeWindowControl(action).catch((error: unknown) => {
      console.error(`Failed to ${action} the desktop window`, error);
    });
  };

  return (
    <div
      aria-label={labels.group}
      className={className}
      data-window-controls={variant === "command" ? "native" : undefined}
      role="group"
    >
      {resolvedPlatform === "mac" ? (
        <>
          <button
            aria-label={labels.close}
            className="traffic-light close"
            data-window-action="close"
            title={labels.close}
            type="button"
            onClick={() => runAction("close")}
          />
          <button
            aria-label={labels.minimize}
            className="traffic-light minimize"
            data-window-action="minimize"
            title={labels.minimize}
            type="button"
            onClick={() => runAction("minimize")}
          />
          <button
            aria-label={labels.zoom}
            className="traffic-light zoom"
            data-window-action="zoom"
            title={labels.zoom}
            type="button"
            onClick={() => runAction("zoom")}
          />
        </>
      ) : resolvedPlatform === "windows" ? (
        <>
          <button
            aria-label={labels.minimize}
            className="window-button"
            data-window-action="minimize"
            title={labels.minimize}
            type="button"
            onClick={() => runAction("minimize")}
          >
            <Minus size={14} />
          </button>
          <button
            aria-label={labels.zoom}
            className="window-button"
            data-window-action="zoom"
            title={labels.zoom}
            type="button"
            onClick={() => runAction("zoom")}
          >
            <Square size={12} />
          </button>
          <button
            aria-label={labels.close}
            className="window-button close-button"
            data-window-action="close"
            title={labels.close}
            type="button"
            onClick={() => runAction("close")}
          >
            <X size={14} />
          </button>
        </>
      ) : null}
    </div>
  );
}

export function DesktopWindowDragRegion() {
  if (!isTauri()) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className="command-window-drag-region"
      data-tauri-drag-region=""
    />
  );
}
