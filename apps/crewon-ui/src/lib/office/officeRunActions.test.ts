import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type {
  LibraryPanel,
  OfficeConfig,
  OfficeRunActivity,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import {
  handleOfficeDelegationCancelAction,
  handleOfficeDelegationDispatchAction,
  handleOfficeDelegationDispatchNextAction,
  handleOfficeDelegationRetryAction,
  handleOfficeRunCancelAction,
  handleOfficeRunRetryAction,
  handleOfficeVerificationCancelAction,
  handleOfficeVerificationRetryAction,
} from "./officeRunActions";
import type { OfficeRunTurnRecord } from "./officeRunPanel";

type CapturedOfficeRunState = {
  activeTurns: Record<string, string>;
  libraryPanel: LibraryPanel | null;
  messagesSent: string[];
  notice: NoticeState | null;
  runRecords: Record<string, OfficeRunTurnRecord>;
  threads: Thread[];
};

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "office-thread",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Preview",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    clientVersion: "test",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Office",
    turns: [],
    ...overrides,
  };
}

function run(overrides: Partial<OfficeRunActivity> = {}): OfficeRunActivity {
  return {
    id: "run-1",
    title: "Summarize office",
    status: "running",
    threadId: "office-thread",
    turnId: "turn-1",
    requestText: "Summarize office",
    ...overrides,
  };
}

function activity(runs: OfficeRunActivity[] = [run()]) {
  return {
    trace: [],
    approvals: [],
    budget: [],
    budgetCapUsd: 0,
    artifacts: [],
    runs,
  };
}

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Coordinate work",
    threadId: "office-thread",
    backendStatus: "connected",
    members: [],
    messages: [],
    tasks: [],
    activity: activity(),
    ...overrides,
  };
}

function officeConfig(workspaceConfig: OfficeWorkspace): OfficeConfig {
  return {
    title: "Office",
    subtitle: "Workspace",
    workspace: workspaceConfig,
  };
}

function panel(workspaceConfig: OfficeWorkspace = workspace()): LibraryPanel {
  return {
    kind: "office",
    title: "Office",
    subtitle: "Workspace",
    items: [],
    workspace: workspaceConfig,
  };
}

function runResponse(config = officeConfig(workspace())) {
  return {
    filePath: "/offices/office.json",
    config,
    threadId: "office-thread",
    runId: "run-2",
    turn: turn({ id: "turn-2" }),
  };
}

function delegationDispatchResponse(config = officeConfig(workspace())) {
  return {
    ...runResponse(config),
    delegationId: "delegation-1",
  };
}

function delegationRetryResponse(config = officeConfig(workspace())) {
  return {
    ...runResponse(config),
    delegationId: "delegation-retry",
    retryOfDelegationId: "delegation-1",
  };
}

function verificationRetryResponse(config = officeConfig(workspace())) {
  return {
    ...runResponse(config),
    automationId: "nightly-smoke",
    automationRunFilePath: "/automation-runs/nightly-smoke.json",
    automationRunId: "automation-run-retry",
    retryOfAutomationTurnId: "automation-turn-old",
    threadId: "automation-thread",
    turn: turn({ id: "automation-turn-retry" }),
    verificationCheckId: "verification-1",
  };
}

function state(
  initialPanel: LibraryPanel | null = panel(),
): CapturedOfficeRunState {
  return {
    activeTurns: {},
    libraryPanel: initialPanel,
    messagesSent: [],
    notice: null,
    runRecords: {},
    threads: [thread()],
  };
}

describe("office run actions", () => {
  it("cancels backend office runs and updates the panel", async () => {
    const captured = state();
    const handled = await handleOfficeRunCancelAction({
      cancelOfficeRun: async () =>
        officeConfig(workspace({ activity: activity([]) })),
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      run: run(),
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
    });

    expect(handled).toBe(true);
    expect(captured.notice).toBeNull();
    expect(captured.libraryPanel?.workspace?.activity?.runs).toEqual([]);
  });

  it("warns when cancel is unavailable", async () => {
    const captured = state();
    const handled = await handleOfficeRunCancelAction({
      cancelOfficeRun: async () => null,
      isConnected: false,
      locale: "en",
      panel: () => captured.libraryPanel,
      run: run({ turnId: undefined }),
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
    });

    expect(handled).toBe(true);
    expect(captured.notice).toEqual({
      text: "Only active backend office runs can be canceled",
      tone: "warning",
    });
  });

  it("rolls back optimistic cancel state on failure", async () => {
    const captured = state();
    const handled = await handleOfficeRunCancelAction({
      cancelOfficeRun: async () => {
        throw new Error("cancel failed");
      },
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      run: run(),
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
    });

    expect(handled).toBe(true);
    expect(captured.notice).toEqual({
      text: "cancel failed",
      tone: "warning",
    });
    expect(captured.libraryPanel?.workspace?.activity?.runs?.[0]?.status).toBe(
      "running",
    );
  });

  it("cancels a backend office delegation and syncs the panel", async () => {
    const captured = state();
    const nextWorkspace = workspace({ activity: activity([]) });
    const calls: unknown[] = [];
    const delegation = {
      id: "delegation-1",
      member: "Reviewer",
      task: "Review state",
      status: "running",
      threadId: "member-thread",
      turnId: "member-turn",
    };
    const handled = await handleOfficeDelegationCancelAction({
      cancelOfficeDelegation: async (panel, workspace, run, targetDelegation) => {
        calls.push({ panel, workspace, run, targetDelegation });
        return {
          cwd: "/workspace",
          response: {
            filePath: "/offices/office.json",
            config: officeConfig(nextWorkspace),
          },
        };
      },
      delegation,
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      run: run({ delegations: [delegation] }),
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
    });

    expect(handled).toBe(true);
    expect(calls).toMatchObject([
      {
        targetDelegation: { id: "delegation-1", turnId: "member-turn" },
      },
    ]);
    expect(captured.notice).toBeNull();
    expect(captured.libraryPanel?.workspace?.activity?.runs).toEqual([]);
  });

  it("cancels a backend office verification and syncs the panel", async () => {
    const captured = state();
    const nextWorkspace = workspace({ activity: activity([]) });
    const check = {
      check: "Run smoke",
      status: "pending",
      automationId: "smoke",
      automationThreadId: "automation-thread",
      automationTurnId: "automation-turn",
      dispatchStatus: "running",
    };
    const handled = await handleOfficeVerificationCancelAction({
      cancelOfficeVerification: async () => ({
        cwd: "/workspace",
        response: {
          filePath: "/offices/office.json",
          config: officeConfig(nextWorkspace),
        },
      }),
      check,
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      run: run({ verificationChecks: [check] }),
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
    });

    expect(handled).toBe(true);
    expect(captured.notice).toBeNull();
    expect(captured.libraryPanel?.workspace?.activity?.runs).toEqual([]);
  });

  it("retries backend office runs and records the turn", async () => {
    const captured = state();
    const handled = await handleOfficeRunRetryAction({
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeRun: async () => ({
        cwd: "/workspace",
        response: runResponse(),
      }),
      run: run(),
      sendOfficeMessage: async (text) => {
        captured.messagesSent.push(text);
      },
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "retry-id",
    });

    expect(handled).toBe(true);
    expect(captured.messagesSent).toEqual([]);
    expect(captured.runRecords).toEqual({
      "turn-2": {
        config: runResponse().config,
        cwd: "/workspace",
        runId: "run-2",
        threadId: "office-thread",
        turnThreadId: "office-thread",
      },
    });
    expect(captured.activeTurns).toEqual({ "office-thread": "turn-2" });
    expect(captured.threads[0]?.turns).toEqual([turn({ id: "turn-2" })]);
  });

  it("falls back to sending the office message when retry RPC is unsupported", async () => {
    const captured = state();
    const handled = await handleOfficeRunRetryAction({
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeRun: async () => ({ cwd: "/workspace", response: null }),
      run: run(),
      sendOfficeMessage: async (text) => {
        captured.messagesSent.push(text);
      },
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "retry-id",
    });

    expect(handled).toBe(true);
    expect(captured.messagesSent).toEqual(["Summarize office"]);
    expect(captured.runRecords).toEqual({});
  });

  it("blocks office run retry when the loop iteration limit is reached", async () => {
    const captured = state();
    let retryCalls = 0;
    const handled = await handleOfficeRunRetryAction({
      isConnected: false,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeRun: async () => {
        retryCalls += 1;
        return {
          cwd: "/workspace",
          response: runResponse(),
        };
      },
      run: run({
        status: "completed",
        loop: {
          iteration: 4,
          maxIterations: 4,
          review: {
            status: "needsReview",
          },
        },
      }),
      sendOfficeMessage: async (text) => {
        captured.messagesSent.push(text);
      },
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "retry-id",
    });

    expect(handled).toBe(true);
    expect(retryCalls).toBe(0);
    expect(captured.messagesSent).toEqual([]);
    expect(captured.notice).toEqual({
      text: "Office Loop iteration limit reached. Adjust the goal or start a new team run.",
      tone: "warning",
    });
  });

  it("dispatches runnable automation verification checks before manager retry", async () => {
    const captured = state();
    let dispatchCalls = 0;
    let retryCalls = 0;
    const handled = await handleOfficeRunRetryAction({
      dispatchNextOfficeVerification: async () => {
        dispatchCalls += 1;
        return {
          cwd: "/workspace",
          response: runResponse(),
        };
      },
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeRun: async () => {
        retryCalls += 1;
        return {
          cwd: "/workspace",
          response: runResponse(),
        };
      },
      run: run({
        status: "completed",
        loop: {
          review: {
            status: "needsReview",
            nextAction: "runVerificationChecks",
          },
        },
        verificationChecks: [
          {
            check: "Run smoke automation",
            status: "pending",
            automationId: "nightly-smoke",
          },
        ],
      }),
      sendOfficeMessage: async (text) => {
        captured.messagesSent.push(text);
      },
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "retry-id",
    });

    expect(handled).toBe(true);
    expect(dispatchCalls).toBe(1);
    expect(retryCalls).toBe(0);
    expect(captured.messagesSent).toEqual([]);
    expect(captured.runRecords).toEqual({
      "turn-2": {
        config: runResponse().config,
        cwd: "/workspace",
        runId: "run-2",
        threadId: "office-thread",
        turnThreadId: "office-thread",
      },
    });
    expect(captured.activeTurns).toEqual({ "office-thread": "turn-2" });
  });

  it("does not dispatch canceling automation verification checks", async () => {
    const captured = state();
    let dispatchCalls = 0;
    let retryCalls = 0;
    const handled = await handleOfficeRunRetryAction({
      dispatchNextOfficeVerification: async () => {
        dispatchCalls += 1;
        return {
          cwd: "/workspace",
          response: runResponse(),
        };
      },
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeRun: async () => {
        retryCalls += 1;
        return {
          cwd: "/workspace",
          response: runResponse(),
        };
      },
      run: run({
        status: "completed",
        loop: {
          review: {
            status: "needsReview",
            nextAction: "runVerificationChecks",
          },
        },
        verificationChecks: [
          {
            check: "Run smoke automation",
            status: "pending",
            automationId: "nightly-smoke",
            dispatchStatus: "canceling",
          },
        ],
      }),
      sendOfficeMessage: async (text) => {
        captured.messagesSent.push(text);
      },
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "retry-id",
    });

    expect(handled).toBe(true);
    expect(dispatchCalls).toBe(0);
    expect(retryCalls).toBe(1);
    expect(captured.notice).toBeNull();
    expect(captured.runRecords).toEqual({
      "turn-2": {
        config: runResponse().config,
        cwd: "/workspace",
        runId: "run-2",
        threadId: "office-thread",
        turnThreadId: "office-thread",
      },
    });
  });

  it("sends retry text directly when disconnected", async () => {
    const captured = state();
    const handled = await handleOfficeRunRetryAction({
      isConnected: false,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeRun: async () => ({
        cwd: "/workspace",
        response: runResponse(),
      }),
      run: run(),
      sendOfficeMessage: async (text) => {
        captured.messagesSent.push(text);
      },
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "retry-id",
    });

    expect(handled).toBe(true);
    expect(captured.messagesSent).toEqual(["Summarize office"]);
  });

  it("dispatches office delegations and records the member turn", async () => {
    const captured = state();
    const handled = await handleOfficeDelegationDispatchAction({
      delegation: {
        agentId: "agent-reviewer",
        member: "Reviewer",
        status: "queued",
        task: "Review reducer behavior",
      },
      dispatchOfficeDelegation: async () => ({
        cwd: "/workspace",
        response: delegationDispatchResponse(),
      }),
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      run: run(),
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "dispatch-id",
    });

    expect(handled).toBe(true);
    expect(captured.notice).toBeNull();
    expect(captured.runRecords).toEqual({
      "turn-2": {
        config: delegationDispatchResponse().config,
        cwd: "/workspace",
        runId: "run-2",
        threadId: "office-thread",
        turnThreadId: "office-thread",
      },
    });
    expect(captured.activeTurns).toEqual({ "office-thread": "turn-2" });
    expect(captured.threads[0]?.turns).toEqual([turn({ id: "turn-2" })]);
  });

  it("dispatches the next office delegation and records the member turn", async () => {
    const captured = state();
    const handled = await handleOfficeDelegationDispatchNextAction({
      dispatchNextOfficeDelegation: async () => ({
        cwd: "/workspace",
        response: delegationDispatchResponse(),
      }),
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      run: run(),
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "dispatch-next-id",
    });

    expect(handled).toBe(true);
    expect(captured.notice).toBeNull();
    expect(captured.runRecords).toEqual({
      "turn-2": {
        config: delegationDispatchResponse().config,
        cwd: "/workspace",
        runId: "run-2",
        threadId: "office-thread",
        turnThreadId: "office-thread",
      },
    });
    expect(captured.activeTurns).toEqual({ "office-thread": "turn-2" });
    expect(captured.threads[0]?.turns).toEqual([turn({ id: "turn-2" })]);
  });

  it("retries office delegations and records the member turn", async () => {
    const captured = state();
    const handled = await handleOfficeDelegationRetryAction({
      delegation: {
        id: "delegation-1",
        agentId: "agent-reviewer",
        member: "Reviewer",
        status: "failed",
        task: "Review reducer behavior",
      },
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeDelegation: async () => ({
        cwd: "/workspace",
        response: delegationRetryResponse(),
      }),
      run: run(),
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "delegation-retry-id",
    });

    expect(handled).toBe(true);
    expect(captured.notice).toBeNull();
    expect(captured.runRecords).toEqual({
      "turn-2": {
        config: delegationRetryResponse().config,
        cwd: "/workspace",
        runId: "run-2",
        threadId: "office-thread",
        turnThreadId: "office-thread",
      },
    });
    expect(captured.activeTurns).toEqual({ "office-thread": "turn-2" });
    expect(captured.threads[0]?.turns).toEqual([turn({ id: "turn-2" })]);
  });

  it("retries office verification checks and records the automation turn", async () => {
    const captured = state();
    captured.threads = [thread({ id: "automation-thread" })];
    const handled = await handleOfficeVerificationRetryAction({
      check: {
        itemId: "verification-1",
        automationId: "nightly-smoke",
        check: "Run smoke automation",
        dispatchStatus: "failed",
        status: "failed",
      },
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeVerification: async () => ({
        cwd: "/workspace",
        response: verificationRetryResponse(),
      }),
      run: run(),
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "verification-retry-id",
    });

    expect(handled).toBe(true);
    expect(captured.notice).toBeNull();
    expect(captured.runRecords).toEqual({
      "automation-turn-retry": {
        config: verificationRetryResponse().config,
        cwd: "/workspace",
        runId: "run-2",
        threadId: "automation-thread",
        turnThreadId: "automation-thread",
      },
    });
    expect(captured.activeTurns).toEqual({
      "automation-thread": "automation-turn-retry",
    });
    expect(captured.threads[0]?.turns).toEqual([
      turn({ id: "automation-turn-retry" }),
    ]);
  });

  it("warns when delegation dispatch is unavailable", async () => {
    const captured = state();
    const handled = await handleOfficeDelegationDispatchAction({
      delegation: {
        member: "Reviewer",
      },
      dispatchOfficeDelegation: async () => ({
        cwd: "/workspace",
        response: delegationDispatchResponse(),
      }),
      isConnected: false,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      run: run(),
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "dispatch-id",
    });

    expect(handled).toBe(true);
    expect(captured.notice).toEqual({
      text: "Only configured backend delegations can be dispatched",
      tone: "warning",
    });
    expect(captured.runRecords).toEqual({});
  });

  it("warns when delegation retry is unavailable", async () => {
    const captured = state();
    const handled = await handleOfficeDelegationRetryAction({
      delegation: {
        id: "delegation-1",
        member: "Reviewer",
        status: "running",
        task: "Review reducer behavior",
      },
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeDelegation: async () => ({
        cwd: "/workspace",
        response: delegationRetryResponse(),
      }),
      run: run(),
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "delegation-retry-id",
    });

    expect(handled).toBe(true);
    expect(captured.notice).toEqual({
      text: "Only failed or interrupted backend delegations can be retried",
      tone: "warning",
    });
    expect(captured.runRecords).toEqual({});
  });

  it("warns when verification retry is unavailable", async () => {
    const captured = state();
    const handled = await handleOfficeVerificationRetryAction({
      check: {
        itemId: "verification-1",
        automationId: "nightly-smoke",
        check: "Run smoke automation",
        dispatchStatus: "running",
        status: "pending",
      },
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeVerification: async () => ({
        cwd: "/workspace",
        response: verificationRetryResponse(),
      }),
      run: run(),
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "verification-retry-id",
    });

    expect(handled).toBe(true);
    expect(captured.notice).toEqual({
      text: "Only failed or interrupted automation verification checks can be retried",
      tone: "warning",
    });
    expect(captured.runRecords).toEqual({});
  });
});
