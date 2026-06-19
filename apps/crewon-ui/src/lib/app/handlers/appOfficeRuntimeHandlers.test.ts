import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import type {
  LibraryPanel,
  OfficeMessage,
  OfficeRunActivity,
  OfficeWorkspace,
} from "../../domain/crewonDomain";
import type { AppOfficeRuntimeHandlersParams } from "./appOfficeRuntimeHandlers";
import type { EnsureOfficeThreadActionParams } from "../../office/officeThreadActions";
import type { OfficeMessageActionParams } from "../../office/officeMessageActions";
import type {
  OfficeRunCancelParams,
  OfficeRunRetryParams,
} from "../../office/officeRunActions";

const officeThreadSpy = vi.hoisted(() => ({
  lastParams: null as EnsureOfficeThreadActionParams | null,
  ensure: vi.fn(async (params: EnsureOfficeThreadActionParams) => {
    officeThreadSpy.lastParams = params;
    return "office-thread-1";
  }),
}));

const officeMessageSpy = vi.hoisted(() => ({
  lastParams: null as OfficeMessageActionParams | null,
  send: vi.fn(async (params: OfficeMessageActionParams) => {
    officeMessageSpy.lastParams = params;
    return true;
  }),
}));

const officeRunActionSpy = vi.hoisted(() => ({
  cancelParams: null as OfficeRunCancelParams | null,
  retryParams: null as OfficeRunRetryParams | null,
  cancel: vi.fn(async (params: OfficeRunCancelParams) => {
    officeRunActionSpy.cancelParams = params;
    return true;
  }),
  retry: vi.fn(async (params: OfficeRunRetryParams) => {
    officeRunActionSpy.retryParams = params;
    return true;
  }),
}));

const officeBackendSpy = vi.hoisted(() => ({
  cancel: vi.fn(async () => null),
  retry: vi.fn(async () => null),
  run: vi.fn(async () => null),
}));

vi.mock("../../office/officeThreadActions", () => ({
  ensureOfficeThreadAction: officeThreadSpy.ensure,
}));

vi.mock("../../office/officeMessageActions", () => ({
  sendOfficeMessageAction: officeMessageSpy.send,
}));

vi.mock("../../office/officeRunActions", () => ({
  handleOfficeRunCancelAction: officeRunActionSpy.cancel,
  handleOfficeRunRetryAction: officeRunActionSpy.retry,
}));

vi.mock("../../domain/domainOfficeBackend", () => ({
  cancelAppOfficeRun: officeBackendSpy.cancel,
  retryAppOfficeRun: officeBackendSpy.retry,
  runAppOfficeMessage: officeBackendSpy.run,
}));

const { createAppOfficeRuntimeHandlers } = await import(
  "./appOfficeRuntimeHandlers"
);

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Ship it",
    members: [],
    messages: [],
    tasks: [],
    ...overrides,
  };
}

function panel(overrides: Partial<LibraryPanel> = {}): LibraryPanel {
  return {
    kind: "office",
    items: [],
    subtitle: "Runtime",
    title: "Office",
    workspace: workspace({ threadId: "thread-1" }),
    ...overrides,
  };
}

function run(overrides: Partial<OfficeRunActivity> = {}): OfficeRunActivity {
  return {
    id: "run-1",
    status: "running",
    title: "Run",
    turnId: "turn-1",
    ...overrides,
  };
}

function thread(id = "office-thread-1"): Thread {
  return {
    id,
    name: "Office",
    status: { type: "loaded" },
    turns: [],
  } as unknown as Thread;
}

function createParams(
  overrides: Partial<AppOfficeRuntimeHandlersParams> = {},
): AppOfficeRuntimeHandlersParams {
  return {
    client: client(),
    getLibraryPanel: () => panel(),
    isConnected: true,
    isMissingThreadError: () => false,
    locale: "en",
    persistOfficeMessage: async () => null,
    persistOfficeWorkspace: async () => null,
    recordOfficeRunTurn: () => {},
    resolveBackendCwd: async () => "/repo",
    setActiveTurnByThread: () => {},
    setLibraryPanel: () => {},
    setNotice: () => {},
    setThreads: () => {},
    startBackendDomainThread: async () => thread(),
    uniqueOfficeRunId: () => "retry-1",
    ...overrides,
  };
}

function capturedEnsureParams(): EnsureOfficeThreadActionParams {
  const params = officeThreadSpy.lastParams;
  if (!params) {
    throw new Error("ensureOfficeThreadAction was not called");
  }
  return params;
}

function capturedMessageParams(): OfficeMessageActionParams {
  const params = officeMessageSpy.lastParams;
  if (!params) {
    throw new Error("sendOfficeMessageAction was not called");
  }
  return params;
}

describe("app office runtime handlers", () => {
  beforeEach(() => {
    officeThreadSpy.lastParams = null;
    officeMessageSpy.lastParams = null;
    officeRunActionSpy.cancelParams = null;
    officeRunActionSpy.retryParams = null;
    vi.clearAllMocks();
  });

  it("wires office thread creation through the current client and domain thread starter", async () => {
    const calls: unknown[] = [];
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({
        client: client({
          async readThread(threadId) {
            calls.push({ method: "readThread", threadId });
            return thread(threadId);
          },
          async renameThread(threadId, title) {
            calls.push({ method: "renameThread", threadId, title });
          },
          async setThreadGoal(threadId, goal, tokenBudget) {
            calls.push({ goal, method: "setThreadGoal", threadId, tokenBudget });
            return null as unknown as Awaited<
              ReturnType<AppServerClient["setThreadGoal"]>
            >;
          },
          async startTurn(threadId, text) {
            calls.push({ method: "startTurn", text, threadId });
            return null as unknown as Awaited<
              ReturnType<AppServerClient["startTurn"]>
            >;
          },
        }),
        startBackendDomainThread: async (source) => {
          calls.push({ method: "startBackendDomainThread", source });
          return thread("new-office-thread");
        },
      }),
    );

    const targetPanel = panel();
    const overrideWorkspace = workspace({ threadId: "override-thread" });
    await handlers.ensureOfficeThread(targetPanel, overrideWorkspace, true);
    const params = capturedEnsureParams();
    await params.readThread("existing-thread");
    await params.renameThread("new-office-thread", "Office");
    await params.setThreadGoal("new-office-thread", "Ship it", null);
    await params.startTurn("new-office-thread", "bind");
    await params.startOfficeThread();

    expect(params.forceNew).toBe(true);
    expect(params.panel).toBe(targetPanel);
    expect(params.workspaceOverride).toBe(overrideWorkspace);
    expect(calls).toEqual([
      { method: "readThread", threadId: "existing-thread" },
      {
        method: "renameThread",
        threadId: "new-office-thread",
        title: "Office",
      },
      {
        goal: "Ship it",
        method: "setThreadGoal",
        threadId: "new-office-thread",
        tokenBudget: null,
      },
      { method: "startTurn", text: "bind", threadId: "new-office-thread" },
      { method: "startBackendDomainThread", source: "office" },
    ]);
  });

  it("wires office messages to the current panel and backend run helper", async () => {
    const currentPanel = panel();
    const recordOfficeRunTurn = vi.fn();
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({
        client: null,
        getLibraryPanel: () => currentPanel,
        recordOfficeRunTurn,
      }),
    );

    await handlers.sendOfficeMessage("hello");
    const params = capturedMessageParams();
    const before = workspace({ threadId: "thread-1" });
    const message: OfficeMessage = {
      accent: "blue",
      author: "User",
      glyph: "U",
      text: "hello",
      time: "now",
    };
    await params.runOfficeMessage(
      currentPanel,
      before,
      message,
      "hello",
      "thread-1",
      before,
    );
    params.recordOfficeRunTurn("turn-1", {
      config: { title: "Office", subtitle: "Runtime", workspace: before },
      cwd: "/repo",
      runId: "run-1",
      threadId: "thread-1",
    });

    expect(params.panel).toBe(currentPanel);
    expect(recordOfficeRunTurn).toHaveBeenCalledOnce();
    expect(officeBackendSpy.run).toHaveBeenCalledWith({
      client: null,
      fallbackWorkspace: before,
      locale: "en",
      message,
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      text: "hello",
      threadId: "thread-1",
      workspaceBeforeMessage: before,
    });
  });

  it("wires office run cancel to the current panel provider and backend helper", async () => {
    const currentPanel = panel();
    const currentRun = run();
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({ client: null, getLibraryPanel: () => currentPanel }),
    );

    await handlers.handleOfficeRunCancel(currentRun);
    const params = officeRunActionSpy.cancelParams;
    if (!params) {
      throw new Error("cancel action was not called");
    }
    await params.cancelOfficeRun(currentPanel, currentPanel.workspace!, currentRun);

    expect(params.panel()).toBe(currentPanel);
    expect(params.run).toBe(currentRun);
    expect(officeBackendSpy.cancel).toHaveBeenCalledWith({
      client: null,
      locale: "en",
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      run: currentRun,
      workspace: currentPanel.workspace,
    });
  });

  it("wires office run retry with stable id generation and fallback sender", async () => {
    const currentPanel = panel();
    const currentRun = run({ requestText: "try again" });
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({ client: null, getLibraryPanel: () => currentPanel }),
    );

    await handlers.handleOfficeRunRetry(currentRun);
    const params = officeRunActionSpy.retryParams;
    if (!params) {
      throw new Error("retry action was not called");
    }
    await params.retryOfficeRun(
      currentPanel,
      currentPanel.workspace!,
      currentRun,
      "retry-1",
    );
    await params.sendOfficeMessage("fallback");

    expect(params.panel()).toBe(currentPanel);
    expect(params.uniqueId()).toBe("retry-1");
    expect(officeBackendSpy.retry).toHaveBeenCalledWith({
      clientUserMessageId: "retry-1",
      client: null,
      locale: "en",
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      run: currentRun,
      workspace: currentPanel.workspace,
    });
    expect(officeMessageSpy.send).toHaveBeenCalledTimes(1);
  });
});
