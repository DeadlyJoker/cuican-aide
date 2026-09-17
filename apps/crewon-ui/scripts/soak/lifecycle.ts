import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type LifecycleEvent =
  | "entry"
  | "window-created"
  | "window-close"
  | "window-closed"
  | "window-unresponsive"
  | "window-responsive"
  | "renderer-gone"
  | "child-process-gone"
  | "before-quit"
  | "will-quit"
  | "quit"
  | "process-exit"
  | "control-show"
  | "control-hide"
  | "control-reload"
  | "control-shutdown";

type LifecycleDetails = {
  windowId?: number;
  exitCode?: number;
  reason?: string;
};

/** Diagnostic entry only: fixed counters and the latest 64 events, never payloads. */
export function createSoakLifecycle(root: string) {
  const filename = join(root, "lifecycle.json");
  const recent: object[] = [];
  const counts: Partial<Record<LifecycleEvent, number>> = {};
  let total = 0;
  return (event: LifecycleEvent, details: LifecycleDetails = {}) => {
    const entry = {
      sequence: ++total,
      at: new Date().toISOString(),
      event,
      ...(Number.isSafeInteger(details.windowId)
        ? { windowId: details.windowId }
        : {}),
      ...(Number.isSafeInteger(details.exitCode)
        ? { exitCode: details.exitCode }
        : {}),
      ...(details.reason ? { reason: details.reason.slice(0, 64) } : {}),
    };
    counts[event] = (counts[event] ?? 0) + 1;
    recent.push(entry);
    if (recent.length > 64) recent.shift();
    const value = JSON.stringify({ pid: process.pid, total, counts, recent });
    if (Buffer.byteLength(value) > 32 * 1024)
      throw new Error("soak_lifecycle_size_guard");
    writeFileSync(`${filename}.tmp`, value, { mode: 0o600 });
    renameSync(`${filename}.tmp`, filename);
  };
}
