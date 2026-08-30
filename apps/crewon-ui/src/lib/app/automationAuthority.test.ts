import { describe, expect, it, vi } from "vitest";

import {
  controlAutomationLibraryPanel,
  selectAutomationAuthority,
  selectAutomationCompletionAuthority,
} from "./automationAuthority";

describe("Automation authority selection", () => {
  it("selects Control solely from configuration and exposes no legacy actions", () => {
    expect(selectAutomationAuthority(true)).toBe("control");
    expect(selectAutomationAuthority(false)).toBe("legacy");
    expect(controlAutomationLibraryPanel("zh")).toEqual(
      expect.objectContaining({
        actions: [],
        kind: "automation",
        subtitle: "日程安排已迁移到新版调度",
      }),
    );
  });

  it("freezes legacy completion polling and writes out of the Control cohort", async () => {
    const readAutomationRunItems = vi.fn(async () => []);
    const syncAutomationRun = vi.fn(async () => undefined);
    const bindings = selectAutomationCompletionAuthority({
      authority: "control",
      automationRunByTurnRef: {
        current: {
          "turn-1": {
            filePath: "legacy.json",
            runId: "run-1",
            threadId: "thread-1",
          },
        },
      },
      readAutomationRunItems,
      syncAutomationRun,
    });

    await bindings.readAutomationRunItems("thread-1");
    await bindings.syncAutomationRun("legacy.json", "completed", 1);

    expect(bindings.automationRunByTurnRef.current).toEqual({});
    expect(readAutomationRunItems).not.toHaveBeenCalled();
    expect(syncAutomationRun).not.toHaveBeenCalled();
  });
});
