import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  createTerminalActionHandlers,
  terminalActionForActionId,
  type TerminalActionHandlersParams,
} from "./terminalActions";
import type { NoticeState } from "../shared/noticeState";

async function flushAsyncAction() {
  await Promise.resolve();
  await Promise.resolve();
}

function baseParams(
  overrides: Partial<TerminalActionHandlersParams> = {},
): TerminalActionHandlersParams {
  let panel: CapabilityPanel | null = {
    title: "Terminal",
    commandInput: true,
    body: "Ready",
    fields: [{ id: "terminal-stdin", label: "Input", value: "hello" }],
  };
  return {
    busyToolId: null,
    client: {
      async runThreadShellCommand() {},
      async terminateCommand() {},
      async writeCommandInput() {},
    },
    command: "npm test",
    confirm: () => true,
    isConnected: true,
    isDemo: false,
    locale: "en",
    processId: "proc-1",
    setCapabilityPanel: (updater) => {
      panel = updater(panel);
    },
    setNotice: () => {},
    stdinValue: "hello",
    threadId: "thread-1",
    ...overrides,
  };
}

describe("terminal actions", () => {
  it("maps terminal action ids", () => {
    expect(terminalActionForActionId("send-terminal-input")).toBe("sendInput");
    expect(terminalActionForActionId("send-terminal-to-thread")).toBe(
      "sendToThread",
    );
    expect(terminalActionForActionId("stop-terminal")).toBe("stop");
    expect(terminalActionForActionId("refresh-account")).toBeNull();
  });

  it("sends terminal input and clears the input field", async () => {
    let panel: CapabilityPanel | null = {
      title: "Terminal",
      commandInput: true,
      body: "Ready",
      fields: [{ id: "terminal-stdin", label: "Input", value: "hello\\n" }],
    };
    const inputs: string[] = [];
    const handlers = createTerminalActionHandlers(
      baseParams({
        client: {
          async runThreadShellCommand() {},
          async terminateCommand() {},
          async writeCommandInput(_processId, input) {
            inputs.push(input);
          },
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        stdinValue: "hello\\n",
      }),
    );

    handlers.sendInput();
    await flushAsyncAction();

    expect(inputs).toEqual(["hello\n"]);
    expect(panel).toEqual({
      title: "Terminal",
      commandInput: true,
      body: "Ready\n[input sent]",
      fields: [{ id: "terminal-stdin", label: "Input", value: "" }],
    });
  });

  it("sends terminal commands to the selected thread", async () => {
    let panel: CapabilityPanel | null = {
      title: "Terminal",
      body: "Ready",
    };
    let notice: NoticeState | null = null;
    const commands: Array<{ command: string; threadId: string }> = [];
    const confirmations: string[] = [];
    const handlers = createTerminalActionHandlers(
      baseParams({
        client: {
          async runThreadShellCommand(threadId, command) {
            commands.push({ command, threadId });
          },
          async terminateCommand() {},
          async writeCommandInput() {},
        },
        command: "  npm test  ",
        confirm: (message) => {
          confirmations.push(message);
          return true;
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setNotice: (nextNotice) => {
          notice = nextNotice;
        },
      }),
    );

    handlers.sendToThread();
    await flushAsyncAction();

    expect(confirmations).toEqual([
      "Send this command to the current session: npm test",
    ]);
    expect(commands).toEqual([{ command: "npm test", threadId: "thread-1" }]);
    expect(notice).toEqual({
      text: "Command sent to the current session",
      tone: "success",
    });
    expect(panel).toEqual({
      title: "Terminal",
      body: "Sent to session: npm test",
      error: undefined,
    });
  });

  it("shows missing thread feedback before sending to a thread", () => {
    let panel: CapabilityPanel | null = {
      title: "Terminal",
      body: "Ready",
    };
    let called = false;
    const handlers = createTerminalActionHandlers(
      baseParams({
        isConnected: false,
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        confirm: () => {
          called = true;
          return true;
        },
      }),
    );

    handlers.sendToThread();

    expect(called).toBe(false);
    expect(panel).toEqual({
      title: "Terminal",
      body: "Ready",
      error: "Select a real session first",
    });
  });

  it("marks terminal stop as in progress", () => {
    let panel: CapabilityPanel | null = {
      title: "Terminal",
      body: "Ready",
    };
    const stopped: string[] = [];
    const handlers = createTerminalActionHandlers(
      baseParams({
        client: {
          async runThreadShellCommand() {},
          async terminateCommand(processId) {
            stopped.push(processId);
          },
          async writeCommandInput() {},
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
    );

    handlers.stop();

    expect(stopped).toEqual(["proc-1"]);
    expect(panel).toEqual({
      title: "Terminal",
      actions: undefined,
      body: "Ready\nStopping...",
    });
  });
});
