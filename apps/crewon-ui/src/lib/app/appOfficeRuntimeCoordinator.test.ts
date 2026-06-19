import type { Thread } from "@crewon-protocol/v2/Thread";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import type {
  LibraryPanel,
  OfficeConfig,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import type { OfficeRunTurnRecord } from "../office/officeRunPanel";
import type { AppOfficeRuntimeCoordinatorParams } from "./appOfficeRuntimeCoordinator";
import type { createAppOfficeRuntimeHandlers } from "./handlers/appOfficeRuntimeHandlers";

const officeRuntimeHandlerSpy = vi.hoisted(() => ({
  lastParams: null as Parameters<typeof createAppOfficeRuntimeHandlers>[0] | null,
  create: vi.fn((params: Parameters<typeof createAppOfficeRuntimeHandlers>[0]) => {
    officeRuntimeHandlerSpy.lastParams = params;
    return {
      ensureOfficeThread: vi.fn(async () => null),
      handleOfficeRunCancel: vi.fn(async () => undefined),
      handleOfficeRunRetry: vi.fn(async () => undefined),
      sendOfficeMessage: vi.fn(async () => undefined),
    };
  }),
}));

vi.mock("./handlers/appOfficeRuntimeHandlers", () => ({
  createAppOfficeRuntimeHandlers: officeRuntimeHandlerSpy.create,
}));

const { createAppOfficeRuntimeCoordinator } = await import(
  "./appOfficeRuntimeCoordinator"
);

function panel(): LibraryPanel {
  return {
    kind: "office",
    items: [],
    subtitle: "Runtime",
    title: "Office",
  };
}

function config(): OfficeConfig {
  return {
    subtitle: "Runtime",
    title: "Office",
    workspace: {
      goal: "Ship it",
      members: [],
      messages: [],
      tasks: [],
    },
  };
}

function createParams(
  overrides: Partial<AppOfficeRuntimeCoordinatorParams> = {},
): AppOfficeRuntimeCoordinatorParams {
  return {
    client: null as AppServerClient | null,
    isConnected: true,
    isMissingThreadError: () => false,
    libraryPanelRef: { current: null },
    locale: "en",
    officeRunByTurnRef: { current: {} },
    persistOfficeMessage: async () => null,
    persistOfficeWorkspace: async (
      _panel: Pick<LibraryPanel, "title" | "subtitle">,
      _workspace: OfficeWorkspace,
      _threadId?: string | null,
    ) => null,
    resolveBackendCwd: async () => "/repo",
    setActiveTurnByThread: () => {},
    setLibraryPanel: () => {},
    setNotice: () => {},
    setThreads: () => {},
    startBackendDomainThread: async () => null as Thread | null,
    ...overrides,
  };
}

function capturedParams(): Parameters<typeof createAppOfficeRuntimeHandlers>[0] {
  const params = officeRuntimeHandlerSpy.lastParams;
  if (!params) {
    throw new Error("createAppOfficeRuntimeHandlers was not called");
  }
  return params;
}

describe("app office runtime coordinator", () => {
  beforeEach(() => {
    officeRuntimeHandlerSpy.lastParams = null;
    vi.clearAllMocks();
  });

  it("wires library panel and office run record refs", () => {
    const currentPanel = panel();
    const officeRunByTurnRef = { current: {} as Record<string, OfficeRunTurnRecord> };

    createAppOfficeRuntimeCoordinator(
      createParams({
        libraryPanelRef: { current: currentPanel },
        officeRunByTurnRef,
      }),
    );
    const params = capturedParams();
    const record: OfficeRunTurnRecord = {
      config: config(),
      cwd: "/repo",
      runId: "run-1",
      threadId: "thread-1",
    };

    expect(params.getLibraryPanel()).toBe(currentPanel);
    params.recordOfficeRunTurn("turn-1", record);
    expect(officeRunByTurnRef.current).toEqual({ "turn-1": record });
  });
});
