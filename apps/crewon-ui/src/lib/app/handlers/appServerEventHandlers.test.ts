import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";

import type { AppServerClient } from "../../app-server/appServer";
import type { AccountStatus } from "../appStatusTypes";
import type { AppServerEventHandlersParams } from "./appServerEventHandlers";
import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type { LibraryPanel } from "../../domain/crewonDomain";
import type { LocalNotificationHandlerParams } from "../appLocalNotificationHandler";
import type { RefreshNotificationHandlerParams } from "../appRefreshNotificationHandler";
import type { ThreadNotificationHandlerParams } from "../appThreadNotificationHandler";
import type { TurnCompletionNotificationHandlerParams } from "../appTurnCompletionNotificationHandler";
import type { IncomingServerRequestHandlerParams } from "../../server-request/serverRequestHandler";

const notificationSpy = vi.hoisted(() => ({
  incomingParams: null as IncomingServerRequestHandlerParams | null,
  localParams: null as LocalNotificationHandlerParams | null,
  refreshParams: null as RefreshNotificationHandlerParams | null,
  threadParams: null as ThreadNotificationHandlerParams | null,
  turnParams: null as TurnCompletionNotificationHandlerParams | null,
  localHandled: false,
  refreshHandled: false,
  threadHandled: false,
  turnHandled: false,
  incoming: vi.fn((params: IncomingServerRequestHandlerParams) => {
    notificationSpy.incomingParams = params;
  }),
  local: vi.fn((params: LocalNotificationHandlerParams) => {
    notificationSpy.localParams = params;
    return notificationSpy.localHandled;
  }),
  refresh: vi.fn((params: RefreshNotificationHandlerParams) => {
    notificationSpy.refreshParams = params;
    return notificationSpy.refreshHandled;
  }),
  thread: vi.fn((params: ThreadNotificationHandlerParams) => {
    notificationSpy.threadParams = params;
    return notificationSpy.threadHandled;
  }),
  turn: vi.fn((params: TurnCompletionNotificationHandlerParams) => {
    notificationSpy.turnParams = params;
    return notificationSpy.turnHandled;
  }),
}));

const refreshActionSpy = vi.hoisted(() => ({
  account: vi.fn(),
  goal: vi.fn(),
  library: vi.fn(),
  reloadThreads: vi.fn(),
  settings: vi.fn(),
  thread: vi.fn(),
}));

const turnActionSpy = vi.hoisted(() => ({
  autoDispatch: vi.fn(async () => null),
  listTurns: vi.fn(async () => []),
  syncOffice: vi.fn(async () => null),
}));

vi.mock("../appLocalNotificationHandler", () => ({
  handleLocalAppNotification: notificationSpy.local,
}));

vi.mock("../appRefreshNotificationHandler", () => ({
  handleRefreshAppNotification: notificationSpy.refresh,
}));

vi.mock("../appThreadNotificationHandler", () => ({
  handleThreadAppNotification: notificationSpy.thread,
}));

vi.mock("../appTurnCompletionNotificationHandler", () => ({
  handleTurnCompletionAppNotification: notificationSpy.turn,
}));

vi.mock("../../server-request/serverRequestHandler", () => ({
  handleIncomingServerRequest: notificationSpy.incoming,
}));

vi.mock("../appNotificationRefreshActions", () => ({
  refreshAccountFromClientAction: refreshActionSpy.account,
  refreshSelectedThreadGoalFromClientAction: refreshActionSpy.goal,
  refreshThreadFromClientAction: refreshActionSpy.thread,
  refreshVisibleLibraryAction: refreshActionSpy.library,
  refreshVisibleSettingsAction: refreshActionSpy.settings,
  reloadThreadsFromClientAction: refreshActionSpy.reloadThreads,
}));

vi.mock("../appTurnCompletionActions", () => ({
  autoDispatchNextOfficeDelegationFromClientAction: turnActionSpy.autoDispatch,
  listThreadTurnsFromClientAction: turnActionSpy.listTurns,
  syncOfficeRunFromClientAction: turnActionSpy.syncOffice,
}));

const { createAppServerEventHandlers } = await import(
  "./appServerEventHandlers"
);

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function createParams(
  overrides: Partial<AppServerEventHandlersParams> = {},
): AppServerEventHandlersParams {
  const currentClient = client();
  return {
    automationRunsByTurn: () => ({
      "turn-1": { filePath: "automation.json", runId: "run-1", threadId: "t1" },
    }),
    capabilityPanel: () => ({ title: "Capability" }),
    client: () => currentClient,
    currentAppView: () => "library",
    currentSettingsSection: () => "config",
    libraryPanel: () => ({
      kind: "agents",
      items: [],
      subtitle: "Library",
      title: "Agents",
    }),
    locale: () => "en",
    officeRunsByTurn: () => ({
      "turn-2": {
        config: {
          title: "Office",
          subtitle: "Runtime",
          workspace: {
            goal: "Ship",
            members: [],
            messages: [],
            tasks: [],
          },
        },
        cwd: "/repo",
        runId: "office-run-1",
        threadId: "office-thread-1",
      },
    }),
    openLibrary: () => {},
    openThreadSettingsPanel: () => {},
    readAutomationRunItems: async () => [],
    refreshComposerSlashCommands: () => {},
    refreshSettingsSection: () => {},
    selectedThreadId: () => "thread-1",
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
    showArchivedThreads: () => true,
    syncAutomationRun: async () => {},
    terminalProcessId: () => "terminal-1",
    unixNow: () => 123,
    ...overrides,
  };
}

describe("app server event handlers", () => {
  beforeEach(() => {
    notificationSpy.incomingParams = null;
    notificationSpy.localParams = null;
    notificationSpy.refreshParams = null;
    notificationSpy.threadParams = null;
    notificationSpy.turnParams = null;
    notificationSpy.localHandled = false;
    notificationSpy.refreshHandled = false;
    notificationSpy.threadHandled = false;
    notificationSpy.turnHandled = false;
    vi.clearAllMocks();
  });

  it("short-circuits after local notifications are handled", () => {
    notificationSpy.localHandled = true;
    const handlers = createAppServerEventHandlers(createParams());

    handlers.handleNotification({ method: "warning" } as never);

    expect(notificationSpy.local).toHaveBeenCalledOnce();
    expect(notificationSpy.localParams).toMatchObject({
      locale: "en",
      selectedThreadId: "thread-1",
      terminalProcessId: "terminal-1",
    });
    expect(notificationSpy.refresh).not.toHaveBeenCalled();
    expect(notificationSpy.thread).not.toHaveBeenCalled();
    expect(notificationSpy.turn).not.toHaveBeenCalled();
  });

  it("wires refresh notification callbacks to current App context", () => {
    const currentClient = client();
    const setAccountStatus = vi.fn();
    const openLibrary = vi.fn();
    const refreshComposerSlashCommands = vi.fn();
    const refreshSettingsSection = vi.fn();
    notificationSpy.refreshHandled = true;
    notificationSpy.refresh.mockImplementationOnce((params) => {
      notificationSpy.refreshParams = params;
      params.refreshAccount();
      params.refreshComposerSlashCommands();
      params.refreshVisibleLibrary("agents");
      params.refreshVisibleSettings(["config"]);
      return true;
    });

    const handlers = createAppServerEventHandlers(
      createParams({
        client: () => currentClient,
        openLibrary,
        refreshComposerSlashCommands,
        refreshSettingsSection,
        setAccountStatus,
      }),
    );

    handlers.handleNotification({ method: "account/updated" } as never);

    expect(refreshActionSpy.account).toHaveBeenCalledWith({
      client: currentClient,
      setAccountStatus,
    });
    expect(refreshComposerSlashCommands).toHaveBeenCalledOnce();
    expect(refreshActionSpy.library).toHaveBeenCalledWith({
      appView: "library",
      kind: "agents",
      libraryPanel: expect.objectContaining({ kind: "agents" }),
      openLibrary,
    });
    expect(refreshActionSpy.settings).toHaveBeenCalledWith({
      appView: "library",
      refreshSettingsSection,
      sections: ["config"],
      settingsSection: "config",
    });
  });

  it("wires thread notifications to refresh and reload helpers", () => {
    const currentClient = client();
    const setThreadGoal = vi.fn();
    const openThreadSettingsPanel = vi.fn();
    notificationSpy.threadHandled = true;
    notificationSpy.thread.mockImplementationOnce((params) => {
      notificationSpy.threadParams = params;
      params.openThreadSettingsPanel();
      params.refreshSelectedThreadGoal("thread-1");
      params.refreshThread("thread-2");
      params.reloadThreads();
      params.setThreadGoal({ objective: "Goal" } as ThreadGoal);
      return true;
    });

    const handlers = createAppServerEventHandlers(
      createParams({
        client: () => currentClient,
        openThreadSettingsPanel,
        setThreadGoal,
      }),
    );

    handlers.handleNotification({ method: "thread/goal/updated" } as never);

    expect(openThreadSettingsPanel).toHaveBeenCalledOnce();
    expect(refreshActionSpy.goal).toHaveBeenCalledWith({
      client: currentClient,
      setThreadGoal,
      threadId: "thread-1",
    });
    expect(refreshActionSpy.thread).toHaveBeenCalledWith({
      client: currentClient,
      setThreads: expect.any(Function),
      threadId: "thread-2",
    });
    expect(refreshActionSpy.reloadThreads).toHaveBeenCalledWith({
      archived: true,
      client: currentClient,
      setThreads: expect.any(Function),
    });
    expect(setThreadGoal).toHaveBeenCalledWith({ objective: "Goal" });
  });

  it("wires turn completion helpers with current run records and client", async () => {
    const currentClient = client();
    notificationSpy.turnHandled = true;
    const syncAutomationRun = vi.fn(async () => {});
    notificationSpy.turn.mockImplementationOnce((params) => {
      notificationSpy.turnParams = params;
      return true;
    });
    const handlers = createAppServerEventHandlers(
      createParams({ client: () => currentClient, syncAutomationRun }),
    );

    handlers.handleNotification({ method: "turn/completed" } as never);
    const params = notificationSpy.turnParams;
    if (!params) {
      throw new Error("turn handler was not called");
    }
    await params.listThreadTurns("thread-1");
    await params.syncOfficeRun(
      {
        config: {
          title: "Office",
          subtitle: "Runtime",
          workspace: {
            goal: "Ship",
            members: [],
            messages: [],
            tasks: [],
          },
        },
        cwd: "/repo",
        runId: "office-run-1",
        threadId: "office-thread-1",
      },
      {
        title: "Office",
        subtitle: "Runtime",
        workspace: {
          goal: "Ship",
          members: [],
          messages: [],
          tasks: [],
        },
      },
      { id: "turn-1" } as never,
    );
    await params.autoDispatchNextOfficeDelegation?.(
      {
        config: {
          title: "Office",
          subtitle: "Runtime",
          workspace: {
            goal: "Ship",
            members: [],
            messages: [],
            tasks: [],
          },
        },
        cwd: "/repo",
        runId: "office-run-1",
        threadId: "office-thread-1",
      },
      {
        title: "Office",
        subtitle: "Runtime",
        workspace: {
          goal: "Ship",
          members: [],
          messages: [],
          tasks: [],
        },
      },
    );

    expect(params.automationRunsByTurn).toEqual({
      "turn-1": { filePath: "automation.json", runId: "run-1", threadId: "t1" },
    });
    expect(params.officeRunsByTurn["turn-2"]?.runId).toBe("office-run-1");
    expect(params.syncAutomationRun).toBe(syncAutomationRun);
    expect(params.unixNow()).toBe(123);
    expect(turnActionSpy.listTurns).toHaveBeenCalledWith(
      currentClient,
      "thread-1",
    );
    expect(turnActionSpy.syncOffice).toHaveBeenCalledWith({
      client: currentClient,
      config: expect.objectContaining({ title: "Office" }),
      locale: "en",
      record: expect.objectContaining({ runId: "office-run-1" }),
      turn: { id: "turn-1" },
    });
    expect(turnActionSpy.autoDispatch).toHaveBeenCalledWith({
      client: currentClient,
      config: expect.objectContaining({ title: "Office" }),
      locale: "en",
      record: expect.objectContaining({ runId: "office-run-1" }),
    });
  });

  it("applies office run updated notifications to the visible office panel", () => {
    let libraryPanel: LibraryPanel | null = {
      kind: "office",
      title: "Office",
      subtitle: "Runtime",
      items: [],
      workspace: {
        goal: "Old goal",
        threadId: "office-thread-1",
        backendStatus: "connected",
        members: [],
        messages: [],
        tasks: [],
        activity: {
          approvals: [],
          artifacts: [],
          budget: [],
          budgetCapUsd: 0,
          runs: [],
          trace: [],
        },
      },
    };
    const handlers = createAppServerEventHandlers(
      createParams({
        libraryPanel: () => libraryPanel,
        setLibraryPanel: (updater) => {
          libraryPanel = updater(libraryPanel);
        },
      }),
    );

    handlers.handleNotification({
      method: "office/run/updated",
      params: {
        cwd: "/repo",
        filePath: "/repo/.crewon/offices/office.json",
        reason: "autoDispatchCompletion",
        sourceThreadId: "member-thread-1",
        sourceTurnId: "turn-member-1",
        config: {
          title: "Office",
          subtitle: "Runtime",
          workspace: {
            goal: "Ship",
            threadId: "office-thread-1",
            backendStatus: "connected",
            members: [],
            messages: [],
            tasks: [],
            activity: {
              approvals: [],
              artifacts: [],
              budget: [],
              budgetCapUsd: 0,
              runs: [
                {
                  id: "office-run-1",
                  title: "Updated run",
                  status: "completed",
                  resultPreview: "Auto-dispatch finished",
                },
              ],
              trace: [],
            },
          },
        },
      },
    } as never);

    expect(libraryPanel?.workspace?.goal).toBe("Ship");
    expect(libraryPanel?.workspace?.activity?.runs?.[0]).toMatchObject({
      id: "office-run-1",
      resultPreview: "Auto-dispatch finished",
    });
    expect(notificationSpy.turn).not.toHaveBeenCalled();
  });

  it("wires incoming server requests through direct App state setters", () => {
    let capabilityPanel: CapabilityPanel | null = null;
    let approvalRequest: unknown = null;
    const setCapabilityDockOpen = vi.fn();
    const setInspectorOpen = vi.fn();
    const handlers = createAppServerEventHandlers(
      createParams({
        setCapabilityDockOpen,
        setCapabilityPanel: (updater) => {
          capabilityPanel = updater(capabilityPanel);
        },
        setInspectorOpen,
        setPendingApprovalRequest: (updater) => {
          approvalRequest = updater(null);
        },
      }),
    );

    handlers.handleServerRequest({
      id: 1,
      method: "approval/request",
    } as never);
    const params = notificationSpy.incomingParams;
    if (!params) {
      throw new Error("incoming request handler was not called");
    }
    params.setCapabilityPanel({ title: "Request" });
    params.setPendingApprovalRequest({
      id: 1,
      method: "approval/request",
      params: {},
    });

    expect(params.locale).toBe("en");
    expect(setCapabilityDockOpen).toBe(params.setCapabilityDockOpen);
    expect(setInspectorOpen).toBe(params.setInspectorOpen);
    expect(capabilityPanel).toEqual({ title: "Request" });
    expect(approvalRequest).toEqual({
      id: 1,
      method: "approval/request",
      params: {},
    });
  });
});
