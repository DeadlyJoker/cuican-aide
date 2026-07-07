import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
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
  lastParams: null as
    | Parameters<typeof createAppOfficeRuntimeHandlers>[0]
    | null,
  create: vi.fn(
    (params: Parameters<typeof createAppOfficeRuntimeHandlers>[0]) => {
      officeRuntimeHandlerSpy.lastParams = params;
      return {
        ensureOfficeThread: vi.fn(async () => null),
        decideOfficeMemory: vi.fn(async () => null),
        handleOfficeDelegationCancel: vi.fn(async () => undefined),
        handleOfficeDelegationDispatch: vi.fn(async () => undefined),
        handleOfficeDelegationDispatchNext: vi.fn(async () => undefined),
        handleOfficeDelegationRetry: vi.fn(async () => undefined),
        handleOfficeRunCancel: vi.fn(async () => undefined),
        handleOfficeRunRetry: vi.fn(async () => undefined),
        handleOfficeVerificationCancel: vi.fn(async () => undefined),
        handleOfficeVerificationRetry: vi.fn(async () => undefined),
        listOfficeMemories: vi.fn(async () => null),
        previewOfficeMemberContext: vi.fn(async () => null),
        recordOfficeRunTurn: vi.fn(),
        sendOfficeMessage: vi.fn(async () => undefined),
      };
    },
  ),
}));

vi.mock("./handlers/appOfficeRuntimeHandlers", () => ({
  createAppOfficeRuntimeHandlers: officeRuntimeHandlerSpy.create,
}));

const { createAppOfficeRuntimeCoordinator } = await import(
  "./appOfficeRuntimeCoordinator"
);

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

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

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    completedAt: 2,
    durationMs: 1,
    error: null,
    id: "turn-1",
    items: [],
    itemsView: "full",
    startedAt: 1,
    status: "completed",
    ...overrides,
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

function capturedParams(): Parameters<
  typeof createAppOfficeRuntimeHandlers
>[0] {
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
    vi.useRealTimers();
  });

  it("wires library panel and office run record refs", () => {
    const currentPanel = panel();
    const officeRunByTurnRef = {
      current: {} as Record<string, OfficeRunTurnRecord>,
    };

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

  it("does not schedule duplicate completion syncs for the same office turn", async () => {
    vi.useFakeTimers();
    const officeRunByTurnRef = {
      current: {} as Record<string, OfficeRunTurnRecord>,
    };
    const readThreads: string[] = [];

    createAppOfficeRuntimeCoordinator(
      createParams({
        client: client({
          async readThread(threadId) {
            readThreads.push(threadId);
            return {
              id: threadId,
              turns: [turn({ id: "turn-1", status: "inProgress" })],
            } as Thread;
          },
        }),
        officeRunByTurnRef,
      }),
    );
    const params = capturedParams();
    const record: OfficeRunTurnRecord = {
      config: config(),
      cwd: "/repo",
      runId: "run-1",
      threadId: "office-thread",
      turnThreadId: "turn-thread",
    };

    params.recordOfficeRunTurn("turn-1", record);
    params.recordOfficeRunTurn("turn-1", record);

    await vi.advanceTimersByTimeAsync(100);

    expect(readThreads).toEqual(["turn-thread"]);
  });

  it("syncs completed office runs when completion notifications win the race", async () => {
    vi.useFakeTimers();
    const officeRunByTurnRef = {
      current: {} as Record<string, OfficeRunTurnRecord>,
    };
    const syncedConfig = config();
    syncedConfig.workspace = {
      ...syncedConfig.workspace,
      activity: {
        approvals: [],
        artifacts: [],
        runs: [
          {
            id: "run-1",
            resultPreview: "done",
            status: "completed",
            title: "Run",
            turnId: "turn-1",
          },
        ],
      },
      threadId: "office-thread",
    };
    let libraryPanel: LibraryPanel | null = {
      ...panel(),
      workspace: {
        ...config().workspace,
        activity: {
          approvals: [],
          artifacts: [],
          runs: [
            {
              id: "run-1",
              status: "running",
              title: "Run",
              turnId: "turn-1",
            },
          ],
        },
        threadId: "office-thread",
      },
    };
    const syncCalls: unknown[] = [];
    let activeTurnByThread: Record<string, string> = {};
    let threads: Thread[] = [
      { id: "member-thread", turns: [] } as unknown as Thread,
    ];
    const dispatchCalls: unknown[] = [];

    createAppOfficeRuntimeCoordinator(
      createParams({
        client: client({
          async readThread(threadId) {
            expect(threadId).toBe("turn-thread");
            return {
              id: "turn-thread",
              turns: [turn({ id: "turn-1" })],
            } as Thread;
          },
          async syncOfficeRunConfig(cwd, officeConfig, turnArg, syncParams) {
            syncCalls.push({ cwd, officeConfig, syncParams, turn: turnArg });
            return {
              config: syncedConfig,
              filePath: "/repo/.crewon/offices/office.json",
            };
          },
          async dispatchNextOfficeDelegationConfig(
            cwd,
            officeConfig,
            runId,
            params,
          ) {
            dispatchCalls.push({ cwd, officeConfig, params, runId });
            return {
              config: {
                ...syncedConfig,
                workspace: {
                  ...syncedConfig.workspace,
                  activity: {
                    ...syncedConfig.workspace.activity,
                    runs: [
                      {
                        id: "run-1",
                        status: "running",
                        title: "Run",
                        delegations: [
                          {
                            id: "delegation-1",
                            member: "Verifier",
                            status: "running",
                            task: "Verify",
                            threadId: "member-thread",
                            turnId: "turn-member",
                          },
                        ],
                      },
                    ],
                  },
                },
              },
              delegationId: "delegation-1",
              filePath: "/repo/.crewon/offices/office.json",
              runId,
              threadId: "member-thread",
              turn: { id: "turn-member", status: "inProgress" },
            } as never;
          },
        }),
        libraryPanelRef: {
          get current() {
            return libraryPanel;
          },
          set current(nextPanel) {
            libraryPanel = nextPanel;
          },
        },
        officeRunByTurnRef,
        setActiveTurnByThread: (updater) => {
          activeTurnByThread = updater(activeTurnByThread);
        },
        setLibraryPanel: (updater) => {
          libraryPanel = updater(libraryPanel);
        },
        setThreads: (updater) => {
          threads = updater(threads);
        },
      }),
    );
    const params = capturedParams();
    params.recordOfficeRunTurn("turn-1", {
      config: config(),
      cwd: "/repo",
      runId: "run-1",
      threadId: "office-thread",
      turnThreadId: "turn-thread",
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(syncCalls).toHaveLength(1);
    expect(dispatchCalls).toEqual([
      {
        cwd: "/repo",
        officeConfig: syncedConfig,
        params: {
          clientUserMessageId: expect.stringMatching(
            /^office-auto-delegation-/,
          ),
          dispatchPolicy: "auto",
          locale: "en",
        },
        runId: "run-1",
      },
    ]);
    expect(officeRunByTurnRef.current["turn-member"]).toMatchObject({
      cwd: "/repo",
      runId: "run-1",
      threadId: "office-thread",
      turnThreadId: "member-thread",
    });
    expect(activeTurnByThread).toEqual({ "member-thread": "turn-member" });
    expect(
      threads.find((thread) => thread.id === "member-thread")?.turns,
    ).toEqual([{ id: "turn-member", status: "inProgress" }]);
    expect(libraryPanel?.workspace?.activity?.runs?.[0]).toMatchObject({
      id: "run-1",
      status: "running",
    });
  });
});
