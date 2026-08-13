import type { ConversationSummary } from "@crewon-ui-model/ConversationSummary";
import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import type { AccountStatus, GitRemoteDiffSummary } from "./appStatusTypes";
import {
  localizeDemoThreadsAction,
  syncDemoInspectorStateAction,
} from "./appDemoStateActions";

function thread(id: string, name: string): Thread {
  return {
    id,
    sessionId: `${id}-session`,
    forkedFromId: null,
    parentThreadId: null,
    preview: name,
    ephemeral: true,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "notLoaded" },
    path: null,
    cwd: "/repo",
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

describe("app demo state actions", () => {
  it("localizes existing demo seed threads only in demo mode", () => {
    let threads = [thread("demo-1", "Desktop UI architecture")];

    expect(
      localizeDemoThreadsAction({
        connectionState: "connected",
        locale: "zh",
        setThreads: (updater) => {
          threads = updater(threads);
        },
      }),
    ).toBe(false);
    expect(threads[0]?.name).toBe("Desktop UI architecture");

    expect(
      localizeDemoThreadsAction({
        connectionState: "demo",
        locale: "zh",
        setThreads: (updater) => {
          threads = updater(threads);
        },
      }),
    ).toBe(true);
    expect(threads[0]?.name).toBe("桌面端 UI 架构");
  });

  it("syncs demo inspector state when demo mode is active", () => {
    const accountStatuses: Array<AccountStatus | null> = [];
    const gitRemoteDiffs: Array<GitRemoteDiffSummary | null> = [];
    const conversationSummaries: Array<ConversationSummary | null> = [];
    const threadGoals: Array<ThreadGoalView | null> = [];

    expect(
      syncDemoInspectorStateAction({
        isDemo: true,
        locale: "en",
        selectedThread: thread("demo-1", "Demo"),
        selectedThreadId: "demo-1",
        setAccountStatus: (status) => {
          accountStatuses.push(status);
        },
        setConversationSummary: (summary) => {
          conversationSummaries.push(summary);
        },
        setGitRemoteDiff: (diff) => {
          gitRemoteDiffs.push(diff);
        },
        setThreadGoal: (goal) => {
          threadGoals.push(goal);
        },
      }),
    ).toBe(true);

    expect(accountStatuses[0]).toMatchObject({ requiresOpenaiAuth: false });
    expect(gitRemoteDiffs[0]).toMatchObject({ status: "ready", files: 6 });
    expect(conversationSummaries[0]).toMatchObject({
      conversationId: "demo-1",
    });
    expect(threadGoals[0]).toMatchObject({
      objective: "Ship a client-ready demo screenshot set today",
      status: "active",
    });
  });

  it("clears optional demo inspector data when no thread is selected", () => {
    let gitRemoteDiff: GitRemoteDiffSummary | null | undefined = undefined;
    let conversationSummary: ConversationSummary | null | undefined = undefined;
    let threadGoal: ThreadGoalView | null | undefined = undefined;

    syncDemoInspectorStateAction({
      isDemo: true,
      locale: "zh",
      selectedThread: null,
      selectedThreadId: null,
      setAccountStatus: () => {},
      setConversationSummary: (summary) => {
        conversationSummary = summary;
      },
      setGitRemoteDiff: (diff) => {
        gitRemoteDiff = diff;
      },
      setThreadGoal: (goal) => {
        threadGoal = goal;
      },
    });

    expect(gitRemoteDiff).toBeNull();
    expect(conversationSummary).toBeNull();
    expect(threadGoal).toBeNull();
  });

  it("ignores non-demo inspector syncs", () => {
    let called = false;

    expect(
      syncDemoInspectorStateAction({
        isDemo: false,
        locale: "en",
        selectedThread: thread("thread-1", "Real"),
        selectedThreadId: "thread-1",
        setAccountStatus: () => {
          called = true;
        },
        setConversationSummary: () => {
          called = true;
        },
        setGitRemoteDiff: () => {
          called = true;
        },
        setThreadGoal: () => {
          called = true;
        },
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});
