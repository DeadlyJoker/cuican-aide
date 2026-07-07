import { describe, expect, it } from "vitest";

import type { AppServerNotification } from "../app-server/appServer";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type {
  LibraryItem,
  LibraryPanel,
  OfficeConfig,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import {
  handleTurnCompletionAppNotification,
  type AutomationRunTurnRecord,
  type OfficeRunTurnRecord,
} from "./appTurnCompletionNotificationHandler";

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    status: "completed",
    items: [],
    ...overrides,
  } as Turn;
}

function thread(): Thread {
  return {
    id: "thread-1",
    turns: [],
  } as unknown as Thread;
}

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    activity: {
      approvals: [],
      artifacts: [],
      budget: [],
      budgetCapUsd: 8,
      runs: [],
      trace: [],
    },
    backendStatus: "connected",
    goal: "Ship cleaner frontend",
    members: [],
    messages: [],
    tasks: [],
    ...overrides,
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("turn completion app notification handler", () => {
  it("updates base turn state for completed turns", () => {
    let threads = [
      thread(),
      { id: "member-thread-1", turns: [] } as unknown as Thread,
    ];
    let streamingTextByThread: Record<string, string> = {
      "thread-1": "streaming",
    };
    let activeTurnByThread: Record<string, string> = {
      "thread-1": "turn-1",
      "other": "turn-2",
    };

    const handled = handleTurnCompletionAppNotification({
      automationRunsByTurn: {},
      getLibraryPanel: () => null,
      listThreadTurns: async () => null,
      locale: "en",
      notification: {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn() },
      } as AppServerNotification,
      officeRunsByTurn: {},
      readAutomationRunItems: async () => [],
      setActiveTurnByThread: (updater) => {
        activeTurnByThread = updater(activeTurnByThread);
      },
      setLibraryPanel: () => {},
      setNotice: () => {},
      setStreamingTextByThread: (updater) => {
        streamingTextByThread = updater(streamingTextByThread);
      },
      setThreads: (updater) => {
        threads = updater(threads);
      },
      syncAutomationRun: async () => {},
      syncOfficeRun: async () => null,
      unixNow: () => 123,
    });

    expect(handled).toBe(true);
    expect(threads[0]?.turns).toEqual([turn()]);
    expect(streamingTextByThread).toEqual({ "thread-1": "" });
    expect(activeTurnByThread).toEqual({ other: "turn-2" });
  });

  it("refreshes full thread turns after completed notifications", async () => {
    const fullTurn = turn({
      items: [
        {
          id: "item-1",
          type: "agentMessage",
          text: "Full response",
          phase: null,
          memoryCitation: null,
        },
      ],
    });
    let threads = [
      thread(),
      { id: "member-thread-1", turns: [] } as unknown as Thread,
    ];

    handleTurnCompletionAppNotification({
      automationRunsByTurn: {},
      getLibraryPanel: () => null,
      listThreadTurns: async () => [fullTurn],
      locale: "en",
      notification: {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn({ items: [] }) },
      } as AppServerNotification,
      officeRunsByTurn: {},
      readAutomationRunItems: async () => [],
      setActiveTurnByThread: () => {},
      setLibraryPanel: () => {},
      setNotice: () => {},
      setStreamingTextByThread: () => {},
      setThreads: (updater) => {
        threads = updater(threads);
      },
      syncAutomationRun: async () => {},
      syncOfficeRun: async () => null,
      unixNow: () => 123,
    });
    await flushAsyncWork();

    expect(threads[0]?.turns).toEqual([fullTurn]);
  });

  it("syncs matching automation runs and clears their tracking record", async () => {
    const automationRunsByTurn: Record<string, AutomationRunTurnRecord> = {
      "turn-1": {
        filePath: "/repo/.crewon/automation/run.json",
        runId: "run-1",
        threadId: "thread-1",
      },
    };
    const syncCalls: Array<{
      completedAt: number | null;
      filePath: string;
      status: string;
    }> = [];
    const items: LibraryItem[] = [{ title: "Run", meta: "Completed" }];
    let libraryPanel: LibraryPanel | null = {
      kind: "automation",
      title: "Automation",
      subtitle: "Every morning",
      body: "Existing body",
      items: [],
      actions: [
        {
          id: "run-automation",
          label: "Run",
          automationThreadId: "thread-1",
        },
      ],
    };

    handleTurnCompletionAppNotification({
      automationRunsByTurn,
      getLibraryPanel: () => libraryPanel,
      listThreadTurns: async () => null,
      locale: "en",
      notification: {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn({ completedAt: null }) },
      } as AppServerNotification,
      officeRunsByTurn: {},
      readAutomationRunItems: async () => items,
      setActiveTurnByThread: () => {},
      setLibraryPanel: (updater) => {
        libraryPanel = updater(libraryPanel);
      },
      setNotice: () => {},
      setStreamingTextByThread: () => {},
      setThreads: () => {},
      syncAutomationRun: async (filePath, status, completedAt) => {
        syncCalls.push({ completedAt, filePath, status });
      },
      syncOfficeRun: async () => null,
      unixNow: () => 456,
    });
    await flushAsyncWork();

    expect(syncCalls).toEqual([
      {
        completedAt: 456,
        filePath: "/repo/.crewon/automation/run.json",
        status: "completed",
      },
    ]);
    expect(automationRunsByTurn).toEqual({});
    expect(libraryPanel?.items).toBe(items);
    expect(libraryPanel?.body).toContain("run-1");
  });

  it("syncs matching office runs using full turns and the current office panel", async () => {
    const recordConfig: OfficeConfig = {
      title: "Saved office",
      subtitle: "Saved subtitle",
      workspace: workspace({ threadId: "thread-1" }),
    };
    const syncedConfig: OfficeConfig = {
      title: "Current office",
      subtitle: "Current subtitle",
      workspace: {
        ...workspace({ threadId: "thread-1" }),
        activity: {
          approvals: [],
          artifacts: [],
          budget: [],
          budgetCapUsd: 8,
          runs: [{ id: "run-1", title: "Done", status: "completed" }],
          trace: [],
        },
      },
    };
    const officeRunsByTurn: Record<string, OfficeRunTurnRecord> = {
      "turn-1": {
        config: recordConfig,
        cwd: "/repo",
        runId: "run-1",
        threadId: "thread-1",
      },
    };
    const fullTurn = turn({ id: "turn-1", status: "completed" });
    const syncCalls: Array<{
      configTitle: string;
      turnId: string;
    }> = [];
    let libraryPanel: LibraryPanel | null = {
      kind: "office",
      title: "Current office",
      subtitle: "Current subtitle",
      items: [],
      workspace: workspace({ threadId: "thread-1" }),
    };

    handleTurnCompletionAppNotification({
      automationRunsByTurn: {},
      getLibraryPanel: () => libraryPanel,
      listThreadTurns: async () => [fullTurn],
      locale: "en",
      notification: {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn() },
      } as AppServerNotification,
      officeRunsByTurn,
      readAutomationRunItems: async () => [],
      setActiveTurnByThread: () => {},
      setLibraryPanel: (updater) => {
        libraryPanel = updater(libraryPanel);
      },
      setNotice: () => {},
      setStreamingTextByThread: () => {},
      setThreads: () => {},
      syncAutomationRun: async () => {},
      syncOfficeRun: async (_record, config, completedTurn) => {
        syncCalls.push({
          configTitle: config.title,
          turnId: completedTurn.id,
        });
        return syncedConfig;
      },
      unixNow: () => 123,
    });
    await flushAsyncWork();

    expect(syncCalls).toEqual([
      { configTitle: "Current office", turnId: "turn-1" },
    ]);
    expect(officeRunsByTurn).toEqual({});
    expect(libraryPanel?.workspace?.activity?.runs).toEqual([
      { id: "run-1", title: "Done", status: "completed" },
    ]);
  });

  it("auto-dispatches safe office delegations after syncing an office run", async () => {
    const recordConfig: OfficeConfig = {
      title: "Saved office",
      subtitle: "Saved subtitle",
      workspace: workspace({ threadId: "office-thread-1" }),
    };
    const syncedConfig: OfficeConfig = {
      title: "Current office",
      subtitle: "Current subtitle",
      workspace: {
        ...workspace({ threadId: "office-thread-1" }),
        activity: {
          approvals: [],
          artifacts: [],
          budget: [],
          budgetCapUsd: 8,
          runs: [
            {
              id: "run-1",
              title: "Synced",
              status: "running",
              delegations: [
                {
                  id: "delegation-safe",
                  member: "Verifier",
                  status: "queued",
                  task: "Verify evidence",
                },
              ],
            },
          ],
          trace: [],
        },
      },
    };
    const dispatchedConfig: OfficeConfig = {
      ...syncedConfig,
      workspace: {
        ...syncedConfig.workspace,
        activity: {
          ...syncedConfig.workspace.activity,
          runs: [
            {
              id: "run-1",
              title: "Synced",
              status: "running",
              delegations: [
                {
                  id: "delegation-safe",
                  member: "Verifier",
                  status: "running",
                  task: "Verify evidence",
                  threadId: "member-thread-1",
                  turnId: "turn-member-1",
                },
              ],
            },
          ],
        },
      },
    };
    const officeRunsByTurn: Record<string, OfficeRunTurnRecord> = {
      "turn-1": {
        config: recordConfig,
        cwd: "/repo",
        runId: "run-1",
        threadId: "office-thread-1",
      },
    };
    const fullTurn = turn({ id: "turn-1", status: "completed" });
    let activeTurnByThread: Record<string, string> = {};
    let threads = [
      thread(),
      { id: "member-thread-1", turns: [] } as unknown as Thread,
    ];
    let libraryPanel: LibraryPanel | null = {
      kind: "office",
      title: "Current office",
      subtitle: "Current subtitle",
      items: [],
      workspace: workspace({ threadId: "office-thread-1" }),
    };

    handleTurnCompletionAppNotification({
      automationRunsByTurn: {},
      autoDispatchNextOfficeDelegation: async (record, config) => {
        expect(record.runId).toBe("run-1");
        expect(config).toBe(syncedConfig);
        return {
          config: dispatchedConfig,
          delegationId: "delegation-safe",
          filePath: "/repo/.crewon/offices/current.json",
          runId: "run-1",
          threadId: "member-thread-1",
          turn: {
            id: "turn-member-1",
            items: [],
            status: "inProgress",
          } as unknown as Turn,
        };
      },
      getLibraryPanel: () => libraryPanel,
      listThreadTurns: async () => [fullTurn],
      locale: "en",
      notification: {
        method: "turn/completed",
        params: { threadId: "office-thread-1", turn: turn() },
      } as AppServerNotification,
      officeRunsByTurn,
      readAutomationRunItems: async () => [],
      setActiveTurnByThread: (updater) => {
        activeTurnByThread = updater(activeTurnByThread);
      },
      setLibraryPanel: (updater) => {
        libraryPanel = updater(libraryPanel);
      },
      setNotice: () => {},
      setStreamingTextByThread: () => {},
      setThreads: (updater) => {
        threads = updater(threads);
      },
      syncAutomationRun: async () => {},
      syncOfficeRun: async () => syncedConfig,
      unixNow: () => 123,
    });
    await flushAsyncWork();

    expect(officeRunsByTurn).toEqual({
      "turn-member-1": {
        config: dispatchedConfig,
        cwd: "/repo",
        runId: "run-1",
        threadId: "office-thread-1",
        turnThreadId: "member-thread-1",
      },
    });
    expect(activeTurnByThread).toEqual({
      "member-thread-1": "turn-member-1",
    });
    expect(
      threads.find((candidate) => candidate.id === "member-thread-1")?.turns,
    ).toEqual([{ id: "turn-member-1", items: [], status: "inProgress" }]);
    expect(
      libraryPanel?.workspace?.activity?.runs?.[0]?.delegations?.[0],
    ).toMatchObject({
      id: "delegation-safe",
      status: "running",
      turnId: "turn-member-1",
    });
  });

  it("syncs member delegation turns back into the current office panel", async () => {
    const recordConfig: OfficeConfig = {
      title: "Saved office",
      subtitle: "Saved subtitle",
      workspace: workspace({ threadId: "office-thread-1" }),
    };
    const syncedConfig: OfficeConfig = {
      title: "Current office",
      subtitle: "Current subtitle",
      workspace: {
        ...workspace({ threadId: "office-thread-1" }),
        activity: {
          approvals: [],
          artifacts: [],
          budget: [],
          budgetCapUsd: 8,
          runs: [
            {
              id: "run-1",
              title: "Review",
              status: "running",
              delegations: [
                {
                  id: "delegation-1",
                  member: "Reviewer",
                  status: "completed",
                  task: "Review member sync",
                  threadId: "member-thread-1",
                  turnId: "turn-member-1",
                },
              ],
            },
          ],
          trace: [],
        },
      },
    };
    const officeRunsByTurn: Record<string, OfficeRunTurnRecord> = {
      "turn-member-1": {
        config: recordConfig,
        cwd: "/repo",
        runId: "run-1",
        threadId: "office-thread-1",
      },
    };
    const fullTurn = turn({ id: "turn-member-1", status: "completed" });
    const syncCalls: Array<{
      configTitle: string;
      listedThreadId: string;
      recordThreadId: string;
      turnId: string;
    }> = [];
    let listedThreadId = "";
    let libraryPanel: LibraryPanel | null = {
      kind: "office",
      title: "Current office",
      subtitle: "Current subtitle",
      items: [],
      workspace: workspace({ threadId: "office-thread-1" }),
    };

    handleTurnCompletionAppNotification({
      automationRunsByTurn: {},
      getLibraryPanel: () => libraryPanel,
      listThreadTurns: async (threadId) => {
        listedThreadId = threadId;
        return [fullTurn];
      },
      locale: "en",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "member-thread-1",
          turn: turn({ id: "turn-member-1" }),
        },
      } as AppServerNotification,
      officeRunsByTurn,
      readAutomationRunItems: async () => [],
      setActiveTurnByThread: () => {},
      setLibraryPanel: (updater) => {
        libraryPanel = updater(libraryPanel);
      },
      setNotice: () => {},
      setStreamingTextByThread: () => {},
      setThreads: () => {},
      syncAutomationRun: async () => {},
      syncOfficeRun: async (record, config, completedTurn) => {
        syncCalls.push({
          configTitle: config.title,
          listedThreadId,
          recordThreadId: record.threadId,
          turnId: completedTurn.id,
        });
        return syncedConfig;
      },
      unixNow: () => 123,
    });
    await flushAsyncWork();

    expect(syncCalls).toEqual([
      {
        configTitle: "Current office",
        listedThreadId: "member-thread-1",
        recordThreadId: "office-thread-1",
        turnId: "turn-member-1",
      },
    ]);
    expect(officeRunsByTurn).toEqual({});
    expect(
      libraryPanel?.workspace?.activity?.runs?.[0]?.delegations?.[0],
    ).toMatchObject({
      id: "delegation-1",
      status: "completed",
      threadId: "member-thread-1",
    });
  });

  it("leaves other notifications for other handlers", () => {
    const handled = handleTurnCompletionAppNotification({
      automationRunsByTurn: {},
      getLibraryPanel: () => null,
      listThreadTurns: async () => null,
      locale: "en",
      notification: {
        method: "warning",
        params: { message: "Careful", threadId: null },
      } as AppServerNotification,
      officeRunsByTurn: {},
      readAutomationRunItems: async () => [],
      setActiveTurnByThread: () => {},
      setLibraryPanel: () => {},
      setNotice: () => {},
      setStreamingTextByThread: () => {},
      setThreads: () => {},
      syncAutomationRun: async () => {},
      syncOfficeRun: async () => null,
      unixNow: () => 123,
    });

    expect(handled).toBe(false);
  });
});
