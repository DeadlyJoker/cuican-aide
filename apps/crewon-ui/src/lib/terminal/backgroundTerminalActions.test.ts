import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { BackgroundTerminal } from "../app-server/appServer";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  backgroundTerminalActionForActionId,
  createBackgroundTerminalActionHandlers,
  showBackgroundTerminalsPanel,
  terminateBackgroundTerminal,
  type BackgroundTerminalActionHandlersParams,
} from "./backgroundTerminalActions";

async function flushAsyncAction() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function terminal(
  overrides: Partial<BackgroundTerminal> = {},
): BackgroundTerminal {
  return {
    itemId: "item-1",
    processId: "proc-1",
    command: "npm test",
    cwd: "/repo",
    osPid: 123,
    cpuPercent: null,
    rssKb: null,
    ...overrides,
  };
}

function baseParams(
  overrides: Partial<BackgroundTerminalActionHandlersParams> = {},
): BackgroundTerminalActionHandlersParams {
  let panel: CapabilityPanel | null = null;
  return {
    client: {
      async cleanBackgroundTerminals() {},
      async listBackgroundTerminals() {
        return { data: [terminal()] };
      },
      async terminateBackgroundTerminal() {
        return true;
      },
    },
    isConnected: true,
    isDemo: false,
    locale: "en",
    setBusyToolId: () => {},
    setCapabilityPanel: (panelOrUpdater) => {
      panel =
        typeof panelOrUpdater === "function"
          ? panelOrUpdater(panel)
          : panelOrUpdater;
    },
    threadId: "thread-1",
    ...overrides,
  };
}

describe("background terminal actions", () => {
  it("maps background terminal action ids", () => {
    expect(backgroundTerminalActionForActionId("refresh-background-terminals")).toBe(
      "refresh",
    );
    expect(backgroundTerminalActionForActionId("clean-background-terminals")).toBe(
      "clean",
    );
    expect(backgroundTerminalActionForActionId("start-terminal")).toBeNull();
  });

  it("refreshes background terminals", async () => {
    let panel: CapabilityPanel | null = null;
    const busyStates: Array<"terminal" | null> = [];
    const listed: string[] = [];
    const handlers = createBackgroundTerminalActionHandlers(
      baseParams({
        client: {
          async cleanBackgroundTerminals() {},
          async listBackgroundTerminals(threadId) {
            listed.push(threadId);
            return { data: [terminal({ processId: "proc-2" })] };
          },
          async terminateBackgroundTerminal() {
            return true;
          },
        },
        setBusyToolId: (toolId) => busyStates.push(toolId),
        setCapabilityPanel: (panelOrUpdater) => {
          panel =
            typeof panelOrUpdater === "function"
              ? panelOrUpdater(panel)
              : panelOrUpdater;
        },
      }),
    );

    handlers.refresh();
    await flushAsyncAction();

    expect(listed).toEqual(["thread-1"]);
    expect(busyStates).toEqual(["terminal", null]);
    expect(panel).toMatchObject({
      title: "Background terminals",
      subtitle: "1 background tasks",
    });
  });

  it("cleans before refreshing", async () => {
    const calls: string[] = [];
    const handlers = createBackgroundTerminalActionHandlers(
      baseParams({
        client: {
          async cleanBackgroundTerminals(threadId) {
            calls.push(`clean:${threadId}`);
          },
          async listBackgroundTerminals(threadId) {
            calls.push(`list:${threadId}`);
            return { data: [] };
          },
          async terminateBackgroundTerminal() {
            return true;
          },
        },
      }),
    );

    handlers.clean();
    await flushAsyncAction();

    expect(calls).toEqual(["clean:thread-1", "list:thread-1"]);
  });

  it("shows demo feedback without backend calls", () => {
    let panel: CapabilityPanel | null = {
      title: "Background terminals",
      body: "Ready",
    };
    let called = false;
    const handlers = createBackgroundTerminalActionHandlers(
      baseParams({
        client: {
          async cleanBackgroundTerminals() {},
          async listBackgroundTerminals() {
            called = true;
            return { data: [] };
          },
          async terminateBackgroundTerminal() {
            return true;
          },
        },
        isDemo: true,
        setCapabilityPanel: (panelOrUpdater) => {
          panel =
            typeof panelOrUpdater === "function"
              ? panelOrUpdater(panel)
              : panelOrUpdater;
        },
      }),
    );

    handlers.refresh();

    expect(called).toBe(false);
    expect(panel).toMatchObject({
      body: "Demo mode has no background terminals. Connect app-server to read real session tasks.",
    });
  });

  it("terminates a background terminal and refreshes the panel", async () => {
    let panel: CapabilityPanel | null = null;
    let notice: NoticeState | null = null;
    const calls: string[] = [];

    await terminateBackgroundTerminal({
      client: {
        async cleanBackgroundTerminals() {},
        async listBackgroundTerminals(threadId) {
          calls.push(`list:${threadId}`);
          return { data: [] };
        },
        async terminateBackgroundTerminal(threadId, processId) {
          calls.push(`terminate:${threadId}:${processId}`);
          return true;
        },
      },
      locale: "en",
      processId: "proc-1",
      setBusyToolId: () => {},
      setCapabilityPanel: (panelOrUpdater) => {
        panel =
          typeof panelOrUpdater === "function"
            ? panelOrUpdater(panel)
            : panelOrUpdater;
      },
      setNotice: (nextNotice) => {
        notice = nextNotice;
      },
      threadId: "thread-1",
    });

    expect(calls).toEqual(["terminate:thread-1:proc-1", "list:thread-1"]);
    expect(notice).toEqual({
      text: "Background process terminated",
      tone: "success",
    });
    expect(panel).toMatchObject({
      subtitle: "0 background tasks",
    });
  });

  it("can show background terminals directly", async () => {
    let panel: CapabilityPanel | null = null;

    await showBackgroundTerminalsPanel(
      {
        client: {
          async cleanBackgroundTerminals() {},
          async listBackgroundTerminals() {
            return { data: [terminal()] };
          },
          async terminateBackgroundTerminal() {
            return true;
          },
        },
        locale: "en",
        setBusyToolId: () => {},
        setCapabilityPanel: (panelOrUpdater) => {
          panel =
            typeof panelOrUpdater === "function"
              ? panelOrUpdater(panel)
              : panelOrUpdater;
        },
      },
      "thread-1",
    );

    expect(panel).toMatchObject({
      subtitle: "1 background tasks",
    });
  });
});
