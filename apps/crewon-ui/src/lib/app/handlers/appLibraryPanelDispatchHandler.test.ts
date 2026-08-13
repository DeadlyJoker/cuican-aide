import type { ControlApiClient } from "@crewon/control-client";
import { describe, expect, it, vi } from "vitest";

import type { AppLibraryPanelDispatchHandlerParams } from "./appLibraryPanelDispatchHandler";
import { createAppLibraryPanelDispatchHandler } from "./appLibraryPanelDispatchHandler";

describe("app library Control Automation dispatch", () => {
  it("runs through Control and never needs a legacy client", async () => {
    const runAutomationNow = vi.fn(async () => ({
      automation: { automationId: "automation-1", threadId: "thread-1" },
      invocation: { automationId: "automation-1", runId: "run-1" },
      run: { runId: "run-1", threadId: "thread-1" },
    }));
    const setNotice = vi.fn();
    const handler = createAppLibraryPanelDispatchHandler({
      client: null,
      controlClient: {
        getThread: vi.fn(async () => ({
          thread: { threadId: "thread-1", status: "active", revision: 4 },
        })),
        runAutomationNow,
      } as unknown as ControlApiClient,
      locale: "en",
      setNotice,
    } as unknown as AppLibraryPanelDispatchHandlerParams);

    await expect(
      handler({
        id: "run-automation",
        label: "Run now",
        automationThreadId: "thread-1",
        controlAutomationId: "automation-1",
        controlAutomationRevision: 1,
      }),
    ).resolves.toBe(true);

    expect(runAutomationNow).toHaveBeenCalledWith(
      "automation-1",
      { expectedAutomationRevision: 1, expectedThreadRevision: 4 },
      expect.stringMatching(/^automation\.run-now:/u),
    );
    expect(setNotice).toHaveBeenCalledWith({
      text: "Automation started: run-1",
      tone: "success",
    });
  });
});
