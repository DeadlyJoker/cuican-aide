import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSoakLifecycle } from "./lifecycle.ts";

it("bounds event retention and preserves shutdown order with exact counters", () => {
  const root = mkdtempSync(join(tmpdir(), "crewon-soak-lifecycle-"));
  try {
    const record = createSoakLifecycle(root);
    for (let index = 0; index < 100; index++)
      record("window-responsive", { windowId: 1 });
    record("renderer-gone", { exitCode: 9, reason: "界".repeat(500) });
    record("control-shutdown");
    record("before-quit");
    record("window-close");
    record("window-closed");
    record("will-quit");
    record("quit", { exitCode: 0 });
    record("process-exit", { exitCode: 0 });
    const bytes = readFileSync(join(root, "lifecycle.json"));
    const value = JSON.parse(bytes.toString());
    expect(bytes.length).toBeLessThan(32 * 1024);
    expect(value.recent).toHaveLength(64);
    expect(value.total).toBe(108);
    expect(value.counts["window-responsive"]).toBe(100);
    expect(value.recent[0].sequence).toBe(45);
    expect(value.recent.at(-8).reason).toHaveLength(64);
    expect(
      value.recent.slice(-7).map((entry: { event: string }) => entry.event),
    ).toEqual([
      "control-shutdown",
      "before-quit",
      "window-close",
      "window-closed",
      "will-quit",
      "quit",
      "process-exit",
    ]);
    expect(value.recent.at(-1).exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
