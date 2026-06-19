import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import type { AppView } from "../shared/appView";
import type { AppServerEventCoordinatorParams } from "./appServerEventCoordinator";
import type { createAppServerEventHandlers } from "./handlers/appServerEventHandlers";

const serverEventHandlerSpy = vi.hoisted(() => ({
  lastParams: null as Parameters<typeof createAppServerEventHandlers>[0] | null,
  create: vi.fn((params: Parameters<typeof createAppServerEventHandlers>[0]) => {
    serverEventHandlerSpy.lastParams = params;
    return {
      handleNotification: vi.fn(),
      handleServerRequest: vi.fn(),
    };
  }),
}));

vi.mock("./handlers/appServerEventHandlers", () => ({
  createAppServerEventHandlers: serverEventHandlerSpy.create,
}));

const { createAppServerEventCoordinator } = await import(
  "./appServerEventCoordinator"
);

function createParams(
  overrides: Partial<AppServerEventCoordinatorParams> = {},
): AppServerEventCoordinatorParams {
  return {
    appViewRef: { current: "chat" as AppView },
    automationRunByTurnRef: { current: {} },
    capabilityPanelRef: { current: null },
    clientRef: { current: null as AppServerClient | null },
    libraryPanelRef: { current: null },
    localeRef: { current: "en" },
    officeRunByTurnRef: { current: {} },
    openLibraryRef: { current: async () => undefined },
    openThreadSettingsPanelRef: { current: async () => undefined },
    readAutomationRunItems: async () => [],
    refreshSettingsSectionRef: { current: async () => undefined },
    selectedThreadIdRef: { current: null },
    setAccountStatus: () => {},
    setActiveFileWatch: () => {},
    setActiveTurnByThread: () => {},
    setCapabilityDockOpen: () => {},
    setCapabilityPanel: () => {},
    setInspectorOpen: () => {},
    setLibraryPanel: () => {},
    setNotice: () => {},
    setPendingApprovalRequest: () => {},
    setPendingDynamicToolRequest: () => {},
    setPendingExternalSecretRequest: () => {},
    setPendingMcpElicitationRequest: () => {},
    setPendingUserInputRequest: () => {},
    setSelectedThreadId: () => {},
    setStreamingTextByThread: () => {},
    setThreadGoal: () => {},
    setThreads: () => {},
    settingsSectionRef: { current: "account" },
    showArchivedThreadsRef: { current: false },
    syncAutomationRun: async () => undefined,
    terminalProcessIdRef: { current: null },
    ...overrides,
  };
}

function capturedParams(): Parameters<typeof createAppServerEventHandlers>[0] {
  const params = serverEventHandlerSpy.lastParams;
  if (!params) {
    throw new Error("createAppServerEventHandlers was not called");
  }
  return params;
}

describe("app server event coordinator", () => {
  beforeEach(() => {
    serverEventHandlerSpy.lastParams = null;
    vi.clearAllMocks();
  });

  it("wires event handler getters through current refs", async () => {
    const appViewRef = { current: "chat" as AppView };
    const selectedThreadIdRef = { current: null as string | null };
    const terminalProcessIdRef = { current: null as string | null };
    const opened: string[] = [];
    const refreshed: string[] = [];

    createAppServerEventCoordinator(
      createParams({
        appViewRef,
        openLibraryRef: {
          current: async (kind) => {
            opened.push(kind);
          },
        },
        refreshSettingsSectionRef: {
          current: async (section) => {
            refreshed.push(section);
          },
        },
        selectedThreadIdRef,
        terminalProcessIdRef,
      }),
    );
    const params = capturedParams();

    appViewRef.current = "library";
    selectedThreadIdRef.current = "thread-1";
    terminalProcessIdRef.current = "process-1";
    await params.openLibrary("agents");
    await params.refreshSettingsSection("config");

    expect(params.currentAppView()).toBe("library");
    expect(params.selectedThreadId()).toBe("thread-1");
    expect(params.terminalProcessId()).toBe("process-1");
    expect(opened).toEqual(["agents"]);
    expect(refreshed).toEqual(["config"]);
  });
});
