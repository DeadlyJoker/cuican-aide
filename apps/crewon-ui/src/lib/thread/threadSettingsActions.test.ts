import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { Turn } from "@crewon-ui-model/v2/Turn";
import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  createThreadSettingsActionHandlers,
  threadSettingsActionForActionId,
  type ThreadSettingsActionHandlersParams,
} from "./threadSettingsActions";

async function flushAsyncAction() {
  await Promise.resolve();
  await Promise.resolve();
}

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: null,
    ...overrides,
  };
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
    turns: [turn()],
    ...overrides,
  };
}

function baseParams(
  overrides: Partial<ThreadSettingsActionHandlersParams> = {},
): ThreadSettingsActionHandlersParams {
  let panel: CapabilityPanel | null = {
    title: "Session settings",
    body: "Ready",
  };
  let threads = [thread()];
  return {
    busyToolId: null,
    client: {
      async listThreadTurns() {
        return [turn({ id: "turn-2" })];
      },
      async updateThreadSettings() {},
    },
    fieldValue: (fieldId) =>
      fieldId === "thread-settings-model" ? "gpt-5" : "",
    isConnected: true,
    isDemo: false,
    locale: "en",
    selectedThread: threads[0],
    setBusyToolId: () => {},
    setCapabilityPanel: (updater) => {
      panel = updater(panel);
    },
    setThreads: (updater) => {
      threads = updater(threads);
    },
    threadId: "thread-1",
    ...overrides,
  };
}

describe("thread settings actions", () => {
  it("maps thread settings action ids", () => {
    expect(threadSettingsActionForActionId("save-thread-settings")).toBe(
      "saveSettings",
    );
    expect(threadSettingsActionForActionId("refresh-thread-history")).toBe(
      "refreshHistory",
    );
    expect(threadSettingsActionForActionId("refresh-account")).toBeNull();
  });

  it("shows a validation error when no thread settings are selected", () => {
    let panel: CapabilityPanel | null = {
      title: "Session settings",
      body: "Ready",
    };
    let updates = 0;
    const handlers = createThreadSettingsActionHandlers(
      baseParams({
        fieldValue: () => "",
        client: {
          async listThreadTurns() {
            return [];
          },
          async updateThreadSettings() {
            updates += 1;
          },
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
    );

    handlers.saveSettings();

    expect(updates).toBe(0);
    expect(panel).toEqual({
      title: "Session settings",
      body: "Ready",
      error: "No session settings selected",
    });
  });

  it("saves thread settings and clears busy state", async () => {
    let panel: CapabilityPanel | null = {
      title: "Session settings",
      body: "Ready",
    };
    const busyStates: Array<string | null> = [];
    const updates: unknown[] = [];
    const handlers = createThreadSettingsActionHandlers(
      baseParams({
        client: {
          async listThreadTurns() {
            return [];
          },
          async updateThreadSettings(_threadId, settings) {
            updates.push(settings);
          },
        },
        setBusyToolId: (toolId) => busyStates.push(toolId),
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
    );

    handlers.saveSettings();
    expect(panel).toMatchObject({
      body: "Saving session settings...",
      error: undefined,
    });

    await flushAsyncAction();

    expect(updates).toEqual([
      {
        approvalPolicy: null,
        model: "gpt-5",
        sandboxMode: null,
      },
    ]);
    expect(busyStates).toEqual(["sidechat", null]);
    expect(panel).toMatchObject({
      body: "Session settings saved for future turns.\nModel: gpt-5",
      error: undefined,
    });
  });

  it("shows demo feedback for history refresh", () => {
    let panel: CapabilityPanel | null = {
      title: "History",
      body: "Ready",
      error: "old",
    };
    const handlers = createThreadSettingsActionHandlers(
      baseParams({
        isDemo: true,
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
    );

    handlers.refreshHistory();

    expect(panel).toEqual({
      title: "History",
      body: "Session history refreshed (demo). With app-server connected this calls thread/turns/list.",
      error: undefined,
    });
  });

  it("refreshes thread history and updates threads", async () => {
    let panel: CapabilityPanel | null = {
      title: "History",
      body: "Ready",
    };
    let threads = [thread()];
    const busyStates: Array<string | null> = [];
    const nextTurns = [turn({ id: "turn-2" }), turn({ id: "turn-3" })];
    const handlers = createThreadSettingsActionHandlers(
      baseParams({
        client: {
          async listThreadTurns() {
            return nextTurns;
          },
          async updateThreadSettings() {},
        },
        setBusyToolId: (toolId) => busyStates.push(toolId),
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setThreads: (updater) => {
          threads = updater(threads);
        },
      }),
    );

    handlers.refreshHistory();
    expect(panel).toMatchObject({
      body: "Reading paged session history...",
      error: undefined,
    });

    await flushAsyncAction();

    expect(threads[0]?.turns).toEqual(nextTurns);
    expect(busyStates).toEqual(["sidechat", null]);
    expect(panel).toEqual({
      title: "History",
      body: "Refreshed 2 turns through thread/turns/list.",
      error: undefined,
    });
  });
});
