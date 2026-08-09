import type { ReactNode } from "react";

import { detectPlatform, detectRuntimeSurface } from "../lib/platform";
import { TitleBarWindowControls } from "./TitleBarWindowControls";
import type { Locale } from "../lib/i18n";

/**
 * The single window chrome for the whole desktop app.
 *
 * Window controls used to be mounted per screen, so any route that forgot them
 * (the login gate, the connecting spinner) rendered a frameless window with no
 * way to close or drag it. Wrapping the router instead means a new screen cannot
 * regress: the frame is above every route rather than inside each one.
 *
 * Renders nothing in a browser tab, where the OS already owns the frame.
 *
 * Gated on the runtime surface rather than `isTauri()` so `?surface=desktop`
 * renders the frame in a browser too. Without that the chrome could only ever be
 * inspected by building and launching the desktop app.
 */
export function DesktopWindowFrame({
  children,
  locale = "zh",
}: {
  children: ReactNode;
  locale?: Locale;
}) {
  if (detectRuntimeSurface() !== "desktop") {
    return <>{children}</>;
  }

  return (
    <div className="desktop-window-frame">
      {/*
       * A frameless window has no system title bar to grab, so the app supplies
       * the drag surface. It spans the full width behind the controls, which sit
       * above it and take their own clicks.
       */}
      <div
        aria-hidden="true"
        className="desktop-window-drag-strip"
        data-tauri-drag-region=""
      />
      <div className="desktop-window-controls-slot">
        <TitleBarWindowControls
          locale={locale}
          platform={detectPlatform()}
          variant="command"
        />
      </div>
      {children}
    </div>
  );
}
