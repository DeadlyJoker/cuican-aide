import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";
import { describe, expect, it, vi } from "vitest";

import type { AccountStatus } from "./appStatusTypes";
import type { LibraryPanel } from "../domain/crewonDomain";
import {
  refreshAccountFromClientAction,
  refreshSelectedThreadGoalFromClientAction,
  refreshThreadFromClientAction,
  refreshVisibleLibraryAction,
  refreshVisibleSettingsAction,
  reloadThreadsFromClientAction,
  runSelectedThreadGoalEffectAction,
} from "./appNotificationRefreshActions";

function thread(id: string, name = id): Thread {
  return {
    id,
    sessionId: `${id}-session`,
    forkedFromId: null,
    parentThreadId: null,
    preview: name,
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "notLoaded" },
    path: null,
    cwd: "/tmp/project",
    clientVersion: "0.1.0",
    source: "appServer",
    threadSource: "app_server",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name,
    turns: [],
  };
}

function threadGoal(): ThreadGoal {
  return {
    threadId: "thread-1",
    objective: "Ship",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("app notification refresh actions", () => {
  it("refreshes account status from the client", async () => {
    const accountStatus: AccountStatus = {
      account: null,
      requiresOpenaiAuth: true,
    };
    let refreshedAccount: AccountStatus | null = null;

    refreshAccountFromClientAction({
      client: {
        async getAccount() {
          return accountStatus;
        },
      },
      setAccountStatus: (status) => {
        refreshedAccount = status;
      },
    });
    await settlePromises();

    expect(refreshedAccount).toEqual(accountStatus);
  });

  it("upserts a refreshed thread", async () => {
    let threads = [thread("thread-1", "Old"), thread("thread-2", "Other")];

    refreshThreadFromClientAction({
      client: {
        async readThread() {
          return thread("thread-1", "New");
        },
      },
      setThreads: (updater) => {
        threads = updater(threads);
      },
      threadId: "thread-1",
    });
    await settlePromises();

    expect(threads).toEqual([thread("thread-1", "New"), thread("thread-2", "Other")]);
  });

  it("reloads threads with the archived flag", async () => {
    const listThreads = vi.fn(async () => [thread("archived")]);
    let threads: Thread[] = [];

    reloadThreadsFromClientAction({
      archived: true,
      client: { listThreads },
      setThreads: (nextThreads) => {
        threads = nextThreads;
      },
    });
    await settlePromises();

    expect(listThreads).toHaveBeenCalledWith(true);
    expect(threads).toEqual([thread("archived")]);
  });

  it("refreshes the selected thread goal", async () => {
    const goal = threadGoal();
    let refreshedGoal: ThreadGoal | null = null;

    refreshSelectedThreadGoalFromClientAction({
      client: {
        async getThreadGoal() {
          return { goal };
        },
      },
      setThreadGoal: (nextGoal) => {
        refreshedGoal = nextGoal;
      },
      threadId: "thread-1",
    });
    await settlePromises();

    expect(refreshedGoal).toEqual(goal);
  });

  it("refreshes selected thread goal from the client", async () => {
    const goal = threadGoal();
    let refreshedGoal: ThreadGoal | null = null;

    runSelectedThreadGoalEffectAction({
      client: {
        async getThreadGoal(threadId) {
          expect(threadId).toBe("thread-1");
          return { goal };
        },
      },
      isConnected: true,
      isDemo: false,
      isDemoThreadSelected: false,
      selectedThreadId: "thread-1",
      setThreadGoal: (nextGoal) => {
        refreshedGoal = nextGoal;
      },
    });
    await settlePromises();

    expect(refreshedGoal).toEqual(goal);
  });

  it("clears selected thread goal when there is no backend thread", () => {
    let goal: ThreadGoal | null = threadGoal();

    const cleanup = runSelectedThreadGoalEffectAction({
      client: null,
      isConnected: false,
      isDemo: false,
      isDemoThreadSelected: false,
      selectedThreadId: "thread-1",
      setThreadGoal: (nextGoal) => {
        goal = nextGoal;
      },
    });

    expect(cleanup).toBeUndefined();
    expect(goal).toBeNull();
  });

  it("refreshes only the visible matching library", () => {
    const openLibrary = vi.fn();
    const panel: LibraryPanel = {
      kind: "agents",
      title: "Agents",
      subtitle: "Library",
      items: [],
    };

    refreshVisibleLibraryAction({
      appView: "library",
      kind: "agents",
      libraryPanel: panel,
      openLibrary,
    });
    refreshVisibleLibraryAction({
      appView: "settings",
      kind: "agents",
      libraryPanel: panel,
      openLibrary,
    });
    refreshVisibleLibraryAction({
      appView: "library",
      kind: "tools",
      libraryPanel: panel,
      openLibrary,
    });

    expect(openLibrary).toHaveBeenCalledTimes(1);
    expect(openLibrary).toHaveBeenCalledWith("agents");
  });

  it("refreshes only visible matching settings sections", () => {
    const refreshSettingsSection = vi.fn();

    refreshVisibleSettingsAction({
      appView: "settings",
      refreshSettingsSection,
      sections: ["browser", "connections"],
      settingsSection: "browser",
    });
    refreshVisibleSettingsAction({
      appView: "library",
      refreshSettingsSection,
      sections: ["browser"],
      settingsSection: "browser",
    });
    refreshVisibleSettingsAction({
      appView: "settings",
      refreshSettingsSection,
      sections: ["computer-control"],
      settingsSection: "browser",
    });

    expect(refreshSettingsSection).toHaveBeenCalledTimes(1);
    expect(refreshSettingsSection).toHaveBeenCalledWith("browser");
  });
});
