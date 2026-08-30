import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import type {
  LibraryPanel,
  OfficeMember,
  OfficeMessage,
  OfficeRunActivity,
  OfficeWorkspace,
} from "../../domain/crewonDomain";
import type { AppOfficeRuntimeHandlersParams } from "./appOfficeRuntimeHandlers";
import type { EnsureOfficeThreadActionParams } from "../../office/officeThreadActions";
import type { OfficeMessageActionParams } from "../../office/officeMessageActions";
import type {
  OfficeDelegationCancelParams,
  OfficeDelegationDispatchNextParams,
  OfficeDelegationDispatchParams,
  OfficeDelegationRetryParams,
  OfficeRunCancelParams,
  OfficeRunRetryParams,
  OfficeVerificationCancelParams,
  OfficeVerificationRetryParams,
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
    return { delivery: null, disposition: "clearOutbox" as const };
  }),
}));

const officeRunActionSpy = vi.hoisted(() => ({
  cancelParams: null as OfficeRunCancelParams | null,
  delegationCancelParams: null as OfficeDelegationCancelParams | null,
  dispatchNextParams: null as OfficeDelegationDispatchNextParams | null,
  dispatchParams: null as OfficeDelegationDispatchParams | null,
  delegationRetryParams: null as OfficeDelegationRetryParams | null,
  retryParams: null as OfficeRunRetryParams | null,
  verificationCancelParams: null as OfficeVerificationCancelParams | null,
  verificationRetryParams: null as OfficeVerificationRetryParams | null,
  cancel: vi.fn(async (params: OfficeRunCancelParams) => {
    officeRunActionSpy.cancelParams = params;
    return true;
  }),
  delegationCancel: vi.fn(async (params: OfficeDelegationCancelParams) => {
    officeRunActionSpy.delegationCancelParams = params;
    return true;
  }),
  dispatch: vi.fn(async (params: OfficeDelegationDispatchParams) => {
    officeRunActionSpy.dispatchParams = params;
    return true;
  }),
  dispatchNext: vi.fn(async (params: OfficeDelegationDispatchNextParams) => {
    officeRunActionSpy.dispatchNextParams = params;
    return true;
  }),
  delegationRetry: vi.fn(async (params: OfficeDelegationRetryParams) => {
    officeRunActionSpy.delegationRetryParams = params;
    return true;
  }),
  retry: vi.fn(async (params: OfficeRunRetryParams) => {
    officeRunActionSpy.retryParams = params;
    return true;
  }),
  verificationCancel: vi.fn(async (params: OfficeVerificationCancelParams) => {
    officeRunActionSpy.verificationCancelParams = params;
    return true;
  }),
  verificationRetry: vi.fn(async (params: OfficeVerificationRetryParams) => {
    officeRunActionSpy.verificationRetryParams = params;
    return true;
  }),
}));

const officeBackendSpy = vi.hoisted(() => ({
  cancelDelegation: vi.fn(async () => null),
  cancel: vi.fn(async () => null),
  cancelVerification: vi.fn(async () => null),
  decideMemory: vi.fn(async () => null),
  dispatch: vi.fn(async () => null),
  dispatchNext: vi.fn(async () => null),
  listMemories: vi.fn(async () => null),
  previewMemberContext: vi.fn(async () => null),
  retryDelegation: vi.fn(async () => null),
  retryVerification: vi.fn(async () => null),
  retry: vi.fn(async () => null),
  run: vi.fn(async () => null),
  submit: vi.fn(async () => null),
}));

vi.mock("../../office/officeThreadActions", () => ({
  ensureOfficeThreadAction: officeThreadSpy.ensure,
}));

vi.mock("../../office/officeMessageActions", () => ({
  sendOfficeMessageAction: officeMessageSpy.send,
}));

vi.mock("../../office/officeRunActions", () => ({
  handleOfficeDelegationCancelAction: officeRunActionSpy.delegationCancel,
  handleOfficeDelegationDispatchAction: officeRunActionSpy.dispatch,
  handleOfficeDelegationDispatchNextAction: officeRunActionSpy.dispatchNext,
  handleOfficeDelegationRetryAction: officeRunActionSpy.delegationRetry,
  handleOfficeRunCancelAction: officeRunActionSpy.cancel,
  handleOfficeRunRetryAction: officeRunActionSpy.retry,
  handleOfficeVerificationCancelAction: officeRunActionSpy.verificationCancel,
  handleOfficeVerificationRetryAction: officeRunActionSpy.verificationRetry,
}));

vi.mock("../../domain/domainOfficeBackend", () => ({
  cancelAppOfficeDelegation: officeBackendSpy.cancelDelegation,
  cancelAppOfficeRun: officeBackendSpy.cancel,
  cancelAppOfficeVerification: officeBackendSpy.cancelVerification,
  decideAppOfficeMemory: officeBackendSpy.decideMemory,
  dispatchAppOfficeDelegation: officeBackendSpy.dispatch,
  dispatchNextAppOfficeDelegation: officeBackendSpy.dispatchNext,
  listAppOfficeMemories: officeBackendSpy.listMemories,
  previewAppOfficeMemberContext: officeBackendSpy.previewMemberContext,
  retryAppOfficeDelegation: officeBackendSpy.retryDelegation,
  retryAppOfficeVerification: officeBackendSpy.retryVerification,
  retryAppOfficeRun: officeBackendSpy.retry,
  runAppOfficeMessage: officeBackendSpy.run,
  submitAppOfficeMessage: officeBackendSpy.submit,
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
    getActiveTurnByThread: () => ({}),
    getLibraryPanel: () => panel(),
    isConnected: true,
    isMissingThreadError: () => false,
    locale: "en",
    persistOfficeMessage: async () => null,
    recordOfficeRunTurn: () => {},
    resolveBackendCwd: async () => "/repo",
    setActiveTurnByThread: () => {},
    setLibraryPanel: () => {},
    setNotice: () => {},
    setThreads: () => {},
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
    officeRunActionSpy.delegationCancelParams = null;
    officeRunActionSpy.dispatchNextParams = null;
    officeRunActionSpy.dispatchParams = null;
    officeRunActionSpy.delegationRetryParams = null;
    officeRunActionSpy.retryParams = null;
    officeRunActionSpy.verificationCancelParams = null;
    officeRunActionSpy.verificationRetryParams = null;
    vi.clearAllMocks();
  });

  it("wires Office manager provisioning through the server-owned ensure RPC", async () => {
    const calls: unknown[] = [];
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({
        client: client({
          async readThread(threadId) {
            calls.push({ method: "readThread", threadId });
            return thread(threadId);
          },
          async ensureOfficeManagerConfig(cwd, officeRecordId, revision) {
            calls.push({
              cwd,
              method: "ensureOfficeManagerConfig",
              officeRecordId,
              revision,
            });
            return {
              config: {
                subtitle: "Runtime",
                title: "Office",
                workspace: workspace({
                  recordId: officeRecordId,
                  recordRevision: "revision-2",
                  threadId: "new-office-thread",
                }),
              },
              filePath: "/repo/.crewon/offices/office.json",
              status: "created",
              threadId: "new-office-thread",
            };
          },
        }),
      }),
    );

    const targetPanel = panel();
    const overrideWorkspace = workspace({ threadId: "override-thread" });
    await handlers.ensureOfficeThread(targetPanel, overrideWorkspace, true);
    const params = capturedEnsureParams();
    await params.readThread("existing-thread");
    await params.ensureOfficeManager("office-record", "revision-1");

    expect(params.forceNew).toBe(true);
    expect(params.panel).toBe(targetPanel);
    expect(params.workspaceOverride).toBe(overrideWorkspace);
    expect(calls).toEqual([
      { method: "readThread", threadId: "existing-thread" },
      {
        cwd: "/repo",
        method: "ensureOfficeManagerConfig",
        officeRecordId: "office-record",
        revision: "revision-1",
      },
    ]);
  });

  it("wires office messages to the current panel and backend run helper", async () => {
    const currentPanel = panel();
    const officeWorkspace = workspace({
      members: [
        {
          accent: "blue",
          glyph: "R",
          memberId: "member-reviewer",
          name: "Reviewer",
          role: "Reviewer",
          status: "idle",
        },
      ],
      threadId: "thread-1",
    });
    const recordOfficeRunTurn = vi.fn();
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({
        client: null,
        getLibraryPanel: () => currentPanel,
        recordOfficeRunTurn,
      }),
    );

    await handlers.sendOfficeMessage("hello", "message-1");
    const params = capturedMessageParams();
    await expect(
      params.confirmLegacyOfficeIdle(workspace({ threadId: "thread-1" })),
    ).resolves.toBe("deny");
    const before = officeWorkspace;
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
      "message-1",
    );
    await params.submitOfficeMessage(
      currentPanel,
      before,
      "hello @Reviewer",
      "message-1",
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
      clientUserMessageId: "message-1",
      fallbackWorkspace: before,
      locale: "en",
      message,
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      text: "hello",
      threadId: "thread-1",
      workspaceBeforeMessage: before,
    });
    expect(officeBackendSpy.submit).toHaveBeenCalledWith({
      client: null,
      clientUserMessageId: "message-1",
      locale: "en",
      mentions: [{ memberId: "member-reviewer" }],
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      text: "hello @Reviewer",
      workspace: before,
    });
  });

  it("preserves a palette-selected canonical member ID for duplicate names", async () => {
    const currentPanel = panel();
    const duplicateNameWorkspace = workspace({
      members: [
        {
          accent: "blue",
          glyph: "A",
          memberId: "member-reviewer",
          name: "Alex",
          role: "Reviewer",
          status: "idle",
        },
        {
          accent: "green",
          glyph: "A",
          memberId: "member-builder",
          name: "Alex",
          role: "Builder",
          status: "idle",
        },
      ],
      threadId: "thread-1",
    });
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({ client: null, getLibraryPanel: () => currentPanel }),
    );

    await handlers.sendOfficeMessage(
      "请 @Alex（Builder） 实现",
      "message-duplicate",
      [{ memberId: "member-builder" }],
    );
    await capturedMessageParams().submitOfficeMessage(
      currentPanel,
      duplicateNameWorkspace,
      "请 @Alex（Builder） 实现",
      "message-duplicate",
    );

    expect(officeBackendSpy.submit).toHaveBeenLastCalledWith({
      client: null,
      clientUserMessageId: "message-duplicate",
      locale: "en",
      mentions: [{ memberId: "member-builder" }],
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      text: "请 @Alex（Builder） 实现",
      workspace: duplicateNameWorkspace,
    });
  });

  it("wires exact active-turn and thread reads into legacy idle confirmation", async () => {
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({
        client: client({
          readThread: async () =>
            ({
              status: { type: "idle" },
              turns: [],
            }) as unknown as Thread,
        }),
        getActiveTurnByThread: () => ({ "thread-1": "turn-active" }),
      }),
    );

    await handlers.sendOfficeMessage("hello", "message-1");
    await expect(
      capturedMessageParams().confirmLegacyOfficeIdle(
        workspace({ threadId: "thread-1" }),
      ),
    ).resolves.toBe("deny");
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
    await params.cancelOfficeRun(
      currentPanel,
      currentPanel.workspace!,
      currentRun,
    );

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

  it("wires office delegation cancel to the backend helper", async () => {
    const currentPanel = panel();
    const currentRun = run();
    const delegation = {
      id: "delegation-1",
      member: "Reviewer",
      status: "running",
      task: "Review reducer behavior",
      threadId: "member-thread",
      turnId: "member-turn",
    };
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({ client: null, getLibraryPanel: () => currentPanel }),
    );

    await handlers.handleOfficeDelegationCancel(currentRun, delegation);
    const params = officeRunActionSpy.delegationCancelParams;
    if (!params) {
      throw new Error("delegation cancel action was not called");
    }
    await params.cancelOfficeDelegation(
      currentPanel,
      currentPanel.workspace!,
      currentRun,
      delegation,
    );

    expect(params.panel()).toBe(currentPanel);
    expect(params.run).toBe(currentRun);
    expect(params.delegation).toBe(delegation);
    expect(officeBackendSpy.cancelDelegation).toHaveBeenCalledWith({
      client: null,
      delegation,
      locale: "en",
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      run: currentRun,
      workspace: currentPanel.workspace,
    });
  });

  it("wires office verification cancel to the backend helper", async () => {
    const currentPanel = panel();
    const currentRun = run();
    const check = {
      check: "Run smoke",
      status: "pending",
      automationId: "smoke",
      automationThreadId: "automation-thread",
      automationTurnId: "automation-turn",
      dispatchStatus: "running",
    };
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({ client: null, getLibraryPanel: () => currentPanel }),
    );

    await handlers.handleOfficeVerificationCancel(currentRun, check);
    const params = officeRunActionSpy.verificationCancelParams;
    if (!params) {
      throw new Error("verification cancel action was not called");
    }
    await params.cancelOfficeVerification(
      currentPanel,
      currentPanel.workspace!,
      currentRun,
      check,
    );

    expect(params.panel()).toBe(currentPanel);
    expect(params.run).toBe(currentRun);
    expect(params.check).toBe(check);
    expect(officeBackendSpy.cancelVerification).toHaveBeenCalledWith({
      check,
      client: null,
      locale: "en",
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      run: currentRun,
      workspace: currentPanel.workspace,
    });
  });

  it("wires office verification retry to the backend helper", async () => {
    const currentPanel = panel();
    const currentRun = run();
    const check = {
      itemId: "verification-1",
      check: "Run smoke",
      status: "failed",
      automationId: "smoke",
      dispatchStatus: "failed",
    };
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({ client: null, getLibraryPanel: () => currentPanel }),
    );

    await handlers.handleOfficeVerificationRetry(currentRun, check);
    const params = officeRunActionSpy.verificationRetryParams;
    if (!params) {
      throw new Error("verification retry action was not called");
    }
    await params.retryOfficeVerification(
      currentPanel,
      currentPanel.workspace!,
      currentRun,
      check,
      "verification-retry-1",
    );

    expect(params.panel()).toBe(currentPanel);
    expect(params.run).toBe(currentRun);
    expect(params.check).toBe(check);
    expect(params.uniqueId()).toBe("retry-1");
    expect(officeBackendSpy.retryVerification).toHaveBeenCalledWith({
      check,
      client: null,
      clientUserMessageId: "verification-retry-1",
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

  it("wires office delegation dispatch to the backend helper", async () => {
    const currentPanel = panel();
    const currentRun = run();
    const delegation = {
      agentId: "agent-reviewer",
      member: "Reviewer",
      status: "queued",
      task: "Review reducer behavior",
    };
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({ client: null, getLibraryPanel: () => currentPanel }),
    );

    await handlers.handleOfficeDelegationDispatch(currentRun, delegation);
    const params = officeRunActionSpy.dispatchParams;
    if (!params) {
      throw new Error("delegation dispatch action was not called");
    }
    await params.dispatchOfficeDelegation(
      currentPanel,
      currentPanel.workspace!,
      currentRun,
      delegation,
      "dispatch-1",
    );

    expect(params.panel()).toBe(currentPanel);
    expect(params.run).toBe(currentRun);
    expect(params.delegation).toBe(delegation);
    expect(params.uniqueId()).toBe("retry-1");
    expect(officeBackendSpy.dispatch).toHaveBeenCalledWith({
      agentId: "agent-reviewer",
      client: null,
      clientUserMessageId: "dispatch-1",
      locale: "en",
      member: "Reviewer",
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      run: currentRun,
      task: "Review reducer behavior",
      workspace: currentPanel.workspace,
    });
  });

  it("wires office delegation retry to the backend helper", async () => {
    const currentPanel = panel();
    const currentRun = run();
    const delegation = {
      id: "delegation-1",
      agentId: "agent-reviewer",
      member: "Reviewer",
      status: "failed",
      task: "Review reducer behavior",
    };
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({ client: null, getLibraryPanel: () => currentPanel }),
    );

    await handlers.handleOfficeDelegationRetry(currentRun, delegation);
    const params = officeRunActionSpy.delegationRetryParams;
    if (!params) {
      throw new Error("delegation retry action was not called");
    }
    await params.retryOfficeDelegation(
      currentPanel,
      currentPanel.workspace!,
      currentRun,
      delegation,
      "retry-delegation-1",
    );

    expect(params.panel()).toBe(currentPanel);
    expect(params.run).toBe(currentRun);
    expect(params.delegation).toBe(delegation);
    expect(params.uniqueId()).toBe("retry-1");
    expect(officeBackendSpy.retryDelegation).toHaveBeenCalledWith({
      client: null,
      clientUserMessageId: "retry-delegation-1",
      delegation,
      locale: "en",
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      run: currentRun,
      workspace: currentPanel.workspace,
    });
  });

  it("wires next office delegation dispatch to the backend helper", async () => {
    const currentPanel = panel();
    const currentRun = run();
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({ client: null, getLibraryPanel: () => currentPanel }),
    );

    await handlers.handleOfficeDelegationDispatchNext(currentRun);
    const params = officeRunActionSpy.dispatchNextParams;
    if (!params) {
      throw new Error("next delegation dispatch action was not called");
    }
    await params.dispatchNextOfficeDelegation(
      currentPanel,
      currentPanel.workspace!,
      currentRun,
      "dispatch-next-1",
    );

    expect(params.panel()).toBe(currentPanel);
    expect(params.run).toBe(currentRun);
    expect(params.uniqueId()).toBe("retry-1");
    expect(officeBackendSpy.dispatchNext).toHaveBeenCalledWith({
      client: null,
      clientUserMessageId: "dispatch-next-1",
      locale: "en",
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      run: currentRun,
      workspace: currentPanel.workspace,
    });
  });

  it("wires office memory review calls to the backend helper", async () => {
    const currentPanel = panel();
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({ client: null, getLibraryPanel: () => currentPanel }),
    );

    await handlers.listOfficeMemories("pending", "24");
    await handlers.decideOfficeMemory("memory-1", "accepted");

    expect(officeBackendSpy.listMemories).toHaveBeenCalledWith({
      client: null,
      cursor: "24",
      limit: 24,
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      status: "pending",
      threadId: "thread-1",
      workspace: currentPanel.workspace,
    });
    expect(officeBackendSpy.decideMemory).toHaveBeenCalledWith({
      client: null,
      memoryId: "memory-1",
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      status: "accepted",
      threadId: "thread-1",
      workspace: currentPanel.workspace,
    });
  });

  it("wires office member context preview to the backend helper", async () => {
    const currentPanel = panel();
    const currentRun = run({ requestText: "Ship the office" });
    const member: OfficeMember = {
      accent: "green",
      agentId: "agent-reviewer",
      glyph: "R",
      name: "Reviewer",
      role: "Review readiness",
      status: "ready",
    };
    const handlers = createAppOfficeRuntimeHandlers(
      createParams({ client: null, getLibraryPanel: () => currentPanel }),
    );

    await handlers.previewOfficeMemberContext(currentRun, member);

    expect(officeBackendSpy.previewMemberContext).toHaveBeenCalledWith({
      agentId: "agent-reviewer",
      client: null,
      locale: "en",
      member: "Reviewer",
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      run: currentRun,
      task: "Run",
      workspace: currentPanel.workspace,
    });
  });
});
