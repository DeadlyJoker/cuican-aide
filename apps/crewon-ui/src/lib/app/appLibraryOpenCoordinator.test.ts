import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import type {
  AgentConfig,
  LibraryItem,
  LibraryKind,
  LibraryPanel,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import type { AppLibraryOpenCoordinatorParams } from "./appLibraryOpenCoordinator";
import type { createAppLibraryOpenHandlers } from "./handlers/appLibraryOpenHandlers";

const libraryOpenHandlerSpy = vi.hoisted(() => ({
  lastParams: null as Parameters<typeof createAppLibraryOpenHandlers>[0] | null,
  create: vi.fn(
    (params: Parameters<typeof createAppLibraryOpenHandlers>[0]) => {
      libraryOpenHandlerSpy.lastParams = params;
      return {
        openLibrary: vi.fn(async (_kind: LibraryKind) => undefined),
        openLibraryItem: vi.fn(async (_item: LibraryItem) => undefined),
      };
    },
  ),
}));

vi.mock("./handlers/appLibraryOpenHandlers", () => ({
  createAppLibraryOpenHandlers: libraryOpenHandlerSpy.create,
}));

const { createAppLibraryOpenCoordinator } = await import(
  "./appLibraryOpenCoordinator"
);

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function createParams(
  overrides: Partial<AppLibraryOpenCoordinatorParams> = {},
): AppLibraryOpenCoordinatorParams {
  return {
    automationAuthority: "legacy",
    connectionHint: "Connected",
    createBackendAgentConfig: async () => ({}) as AgentConfig,
    cwd: "/repo",
    ensureOfficeThread: async (
      _panel: LibraryPanel,
      _workspaceOverride?: OfficeWorkspace,
      _forceNew?: boolean,
    ) => null,
    getClient: () => null,
    isConnected: true,
    isDemo: false,
    isDemoPreview: false,
    isUnsupportedRpcError: () => false,
    libraryLoadRequestRef: { current: 0 },
    loadAgentLibraryItems: async () => ({ items: [] }),
    loadToolLibraryItems: async () => [],
    locale: "en",
    optionalBackendWorkspace: async () => null,
    readAutomationRunItems: async () => [],
    readKnowledgeData: async () => ({ memories: [], sources: [] }),
    refreshToolActionFromBackend: async (action) => action,
    resolveBackendCwd: async () => "/repo",
    selectedThreadId: null,
    setAppView: () => {},
    setCapabilityDockOpen: () => {},
    setInspectorOpen: () => {},
    setLibraryPanel: () => {},
    setNotice: () => {},
    setThreads: () => {},
    storedAutomationItems: async () => [],
    writeAgentConfig: async () => null,
    ...overrides,
  };
}

function capturedParams(): Parameters<typeof createAppLibraryOpenHandlers>[0] {
  const params = libraryOpenHandlerSpy.lastParams;
  if (!params) {
    throw new Error("createAppLibraryOpenHandlers was not called");
  }
  return params;
}

describe("app library open coordinator", () => {
  beforeEach(() => {
    libraryOpenHandlerSpy.lastParams = null;
    vi.clearAllMocks();
  });

  it("wires current client and library load request helpers", async () => {
    const goals: unknown[] = [];
    const currentClient = client({
      async setThreadGoal(threadId, goal, tokenBudget) {
        goals.push({ goal, threadId, tokenBudget });
        return null as unknown as Awaited<
          ReturnType<AppServerClient["setThreadGoal"]>
        >;
      },
    });
    const libraryLoadRequestRef = { current: 0 };

    createAppLibraryOpenCoordinator(
      createParams({
        getClient: () => currentClient,
        libraryLoadRequestRef,
      }),
    );
    const params = capturedParams();

    const isCurrentFirstLoad = params.beginLibraryLoad();
    expect(libraryLoadRequestRef.current).toBe(1);
    expect(isCurrentFirstLoad()).toBe(true);

    params.markLibraryLoad();
    expect(libraryLoadRequestRef.current).toBe(2);
    expect(isCurrentFirstLoad()).toBe(false);

    await params.setThreadGoal("thread-1", "Goal", undefined);
    expect(params.client).toBe(currentClient);
    expect(goals).toEqual([
      { goal: "Goal", threadId: "thread-1", tokenBudget: null },
    ]);
  });
});
