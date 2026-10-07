import type { BrowserWindow } from "electron";

/** Restore the window that owns IPC; closing the last window already quits the app. */
export function bindDesktopWindowActivation({
  app,
  window,
  isQuitting,
}: {
  app: {
    on(event: "activate" | "second-instance", listener: () => void): unknown;
    removeListener(
      event: "activate" | "second-instance",
      listener: () => void,
    ): unknown;
  };
  window: Pick<
    BrowserWindow,
    "isDestroyed" | "isMinimized" | "restore" | "show" | "focus"
  >;
  isQuitting: () => boolean;
}): () => void {
  const activate = () => {
    // Cleanup is asynchronous. A Dock click in that interval must never create
    // a new renderer whose IPC handlers still belong to the destroyed window.
    if (isQuitting() || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  app.on("activate", activate);
  app.on("second-instance", activate);
  return () => {
    app.removeListener("activate", activate);
    app.removeListener("second-instance", activate);
  };
}
