import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";
import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  createThreadGoalActionHandlers,
  threadGoalActionForActionId,
  type ThreadGoalActionHandlersParams,
} from "./threadGoalActions";

async function flushAsyncAction() {
  await Promise.resolve();
  await Promise.resolve();
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
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
    name: null,
    turns: [],
    ...overrides,
  };
}

function goal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    threadId: "thread-1",
    objective: "Ship refactor",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function baseParams(
  overrides: Partial<ThreadGoalActionHandlersParams> = {},
): ThreadGoalActionHandlersParams {
  let panel: CapabilityPanel | null = {
    title: "Session settings",
    subtitle: "Goal",
    body: "Ready",
  };
  return {
    busyToolId: null,
    client: {
      async clearThreadGoal() {},
      async setThreadGoal() {
        return { goal: goal() };
      },
    },
    createThread: async () => thread(),
    fieldValue: (fieldId) =>
      fieldId === "thread-goal-objective" ? "Ship refactor" : "",
    isConnected: true,
    isDemo: false,
    locale: "en",
    openThreadSettingsPanel: () => {},
    setBusyToolId: () => {},
    setCapabilityPanel: (updater) => {
      panel = updater(panel);
    },
    setThreadGoal: () => {},
    threadId: "thread-1",
    ...overrides,
  };
}

describe("thread goal actions", () => {
  it("maps thread goal action ids", () => {
    expect(threadGoalActionForActionId("save-thread-goal")).toBe("save");
    expect(threadGoalActionForActionId("clear-thread-goal")).toBe("clear");
    expect(threadGoalActionForActionId("refresh-thread-history")).toBeNull();
  });

  it("handles demo goal actions locally", () => {
    let panel: CapabilityPanel | null = null;
    let currentGoal: ThreadGoal | null = goal();
    const handlers = createThreadGoalActionHandlers(
      baseParams({
        isDemo: true,
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setThreadGoal: (nextGoal) => {
          currentGoal = nextGoal;
        },
      }),
    );

    handlers.save();
    expect(panel).toEqual({
      title: "Session settings",
      subtitle: "Goal",
      body: "Goal saved (demo)\nShip refactor",
      actions: [
        {
          id: "clear-thread-goal",
          label: "Clear goal",
          tone: "danger",
        },
      ],
    });

    handlers.clear();
    expect(currentGoal).toBeNull();
    expect(panel).toEqual({
      title: "Session settings",
      subtitle: "Goal",
      body: "Goal cleared (demo)",
      actions: [
        {
          id: "save-thread-goal",
          label: "Set again",
          tone: "primary",
        },
      ],
    });
  });

  it("validates goal drafts before saving", async () => {
    let panel: CapabilityPanel | null = {
      title: "Session settings",
      subtitle: "Goal",
      body: "Ready",
    };
    let saved = false;
    const handlers = createThreadGoalActionHandlers(
      baseParams({
        client: {
          async clearThreadGoal() {},
          async setThreadGoal() {
            saved = true;
            return { goal: goal() };
          },
        },
        fieldValue: () => "",
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
    );

    handlers.save();
    await flushAsyncAction();

    expect(saved).toBe(false);
    expect(panel).toEqual({
      title: "Session settings",
      subtitle: "Goal",
      body: "Saving goal...",
      error: "Goal cannot be empty",
    });
  });

  it("creates a thread before saving when no thread id exists", async () => {
    let panel: CapabilityPanel | null = {
      title: "Session settings",
      subtitle: "Goal",
      body: "Ready",
    };
    let currentGoal: ThreadGoal | null = null;
    const createdPrompts: string[] = [];
    const saves: Array<{ objective: string; threadId: string }> = [];
    const handlers = createThreadGoalActionHandlers(
      baseParams({
        client: {
          async clearThreadGoal() {},
          async setThreadGoal(threadId, objective) {
            saves.push({ objective, threadId });
            return { goal: goal({ objective, threadId }) };
          },
        },
        createThread: async (initialPrompt) => {
          createdPrompts.push(initialPrompt ?? "");
          return thread({ id: "thread-created" });
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setThreadGoal: (nextGoal) => {
          currentGoal = nextGoal;
        },
        threadId: null,
      }),
    );

    handlers.save();
    expect(panel).toMatchObject({
      body: "Saving goal...",
      error: undefined,
    });

    await flushAsyncAction();

    expect(createdPrompts).toEqual(["Ship refactor"]);
    expect(saves).toEqual([
      { objective: "Ship refactor", threadId: "thread-created" },
    ]);
    expect(currentGoal).toEqual(goal({ threadId: "thread-created" }));
    expect(panel).toEqual({
      title: "Session settings",
      subtitle: "Goal",
      body: "Goal saved",
      error: undefined,
    });
  });

  it("clears an existing backend goal", async () => {
    let panel: CapabilityPanel | null = {
      title: "Session settings",
      subtitle: "Goal",
      body: "Ready",
    };
    let currentGoal: ThreadGoal | null = goal();
    const clearedThreads: string[] = [];
    const handlers = createThreadGoalActionHandlers(
      baseParams({
        client: {
          async clearThreadGoal(threadId) {
            clearedThreads.push(threadId);
          },
          async setThreadGoal() {
            return { goal: goal() };
          },
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setThreadGoal: (nextGoal) => {
          currentGoal = nextGoal;
        },
      }),
    );

    handlers.clear();
    await flushAsyncAction();

    expect(clearedThreads).toEqual(["thread-1"]);
    expect(currentGoal).toBeNull();
    expect(panel).toMatchObject({
      body: "Goal cleared",
    });
  });

  it("opens thread settings when clearing without a backend thread", async () => {
    let currentGoal: ThreadGoal | null = goal();
    let opened = false;
    const handlers = createThreadGoalActionHandlers(
      baseParams({
        openThreadSettingsPanel: () => {
          opened = true;
        },
        setThreadGoal: (nextGoal) => {
          currentGoal = nextGoal;
        },
        threadId: null,
      }),
    );

    handlers.clear();
    await flushAsyncAction();

    expect(currentGoal).toBeNull();
    expect(opened).toBe(true);
  });
});
