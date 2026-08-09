/**
 * Asks the host OS for a workspace folder.
 *
 * A workspace is identified by an absolute local path, and the webview cannot
 * produce one. `<input webkitdirectory>` reports only paths relative to the
 * folder the user picked, and `showDirectoryPicker` hands back a handle with a
 * bare name -- neither can be bound to a thread `cwd`. So the sidebar used to
 * ask the user to type the path by hand, which is the one thing a desktop app
 * should never do.
 *
 * Tauri's dialog plugin runs the picker in Rust, where the absolute path is
 * already known, so this is desktop-only by nature. On web there is no such
 * path to be had and callers keep their manual-entry form.
 */

import { hasDesktopBridge } from "../platform";

/** Whether a native folder dialog exists on this surface. */
export function canPickWorkspaceFolder(): boolean {
  // The bridge check, not the runtime surface: `?surface=desktop` in a browser
  // draws desktop chrome with no IPC behind it, and offering the dialog there
  // would replace a form that works with a call that cannot.
  return hasDesktopBridge();
}

/**
 * Opens the OS folder dialog and resolves the chosen absolute path, or null when
 * the user cancelled or no native dialog is available.
 *
 * A failure to open is reported as a cancellation rather than thrown: the caller
 * has no better answer than "no folder was chosen", and a rejected promise here
 * would take down the sidebar over a dismissed dialog.
 */
export async function pickWorkspaceFolder(
  title?: string,
): Promise<string | null> {
  if (!canPickWorkspaceFolder()) {
    return null;
  }
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selection = await open({ directory: true, multiple: false, title });
    return typeof selection === "string" ? selection : null;
  } catch {
    return null;
  }
}
