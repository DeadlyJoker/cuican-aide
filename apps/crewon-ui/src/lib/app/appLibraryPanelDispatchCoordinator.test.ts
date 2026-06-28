import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppLibraryPanelDispatchCoordinatorParams } from "./appLibraryPanelDispatchCoordinator";
import type { createAppLibraryPanelDispatchHandler } from "./handlers/appLibraryPanelDispatchHandler";

const libraryPanelDispatchSpy = vi.hoisted(() => ({
  lastParams: null as Parameters<
    typeof createAppLibraryPanelDispatchHandler
  >[0] | null,
  create: vi.fn(
    (params: Parameters<typeof createAppLibraryPanelDispatchHandler>[0]) => {
      libraryPanelDispatchSpy.lastParams = params;
      return vi.fn(async () => undefined);
    },
  ),
}));

vi.mock("./handlers/appLibraryPanelDispatchHandler", () => ({
  createAppLibraryPanelDispatchHandler: libraryPanelDispatchSpy.create,
}));

const { createAppLibraryPanelDispatchCoordinator } = await import(
  "./appLibraryPanelDispatchCoordinator"
);

function createParams(
  automationRunByTurnRef: AppLibraryPanelDispatchCoordinatorParams["automationRunByTurnRef"],
  recordOfficeRunTurn = vi.fn(),
): AppLibraryPanelDispatchCoordinatorParams {
  return {
    automationRunByTurnRef,
    recordOfficeRunTurn,
  } as unknown as AppLibraryPanelDispatchCoordinatorParams;
}

function capturedParams(): Parameters<typeof createAppLibraryPanelDispatchHandler>[0] {
  const params = libraryPanelDispatchSpy.lastParams;
  if (!params) {
    throw new Error("createAppLibraryPanelDispatchHandler was not called");
  }
  return params;
}

describe("app library panel dispatch coordinator", () => {
  beforeEach(() => {
    libraryPanelDispatchSpy.lastParams = null;
    vi.clearAllMocks();
  });

  it("wires automation run records into the app ref", () => {
    const automationRunByTurnRef = { current: {} };

    createAppLibraryPanelDispatchCoordinator(
      createParams(automationRunByTurnRef),
    );
    const params = capturedParams();
    const record = {
      filePath: "/repo/.crewon/automations/demo.json",
      runId: "run-1",
      threadId: "thread-1",
    };

    params.recordAutomationRunForTurn("turn-1", record);

    expect(automationRunByTurnRef.current).toEqual({ "turn-1": record });
  });

  it("forwards office run records through the app handler", () => {
    const automationRunByTurnRef = { current: {} };
    const recordOfficeRunTurn = vi.fn();

    createAppLibraryPanelDispatchCoordinator(
      createParams(automationRunByTurnRef, recordOfficeRunTurn),
    );
    const params = capturedParams();
    const record = {
      cwd: "/repo",
      runId: "office-run-1",
      threadId: "office-thread",
      config: {
        title: "Office",
        subtitle: "Workspace",
        workspace: { goal: "", members: [], messages: [], tasks: [] },
      },
    };

    params.recordOfficeRunTurn("turn-1", record);

    expect(recordOfficeRunTurn).toHaveBeenCalledWith("turn-1", record);
  });
});
