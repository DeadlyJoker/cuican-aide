import { describe, expect, it } from "vitest";

import type { BackgroundTerminal } from "../app-server/appServer";
import {
  backgroundTerminalLabel,
  backgroundTerminalsEmptyPanel,
  backgroundTerminalsErrorPanel,
  backgroundTerminalsLoadingPanel,
  backgroundTerminalsPanel,
  defaultCapabilityPanel,
  terminalCompletedPanel,
  terminalErrorPanel,
  terminalRunningPanel,
} from "./capabilityPanelText";

function terminal(overrides: Partial<BackgroundTerminal> = {}): BackgroundTerminal {
  return {
    itemId: "item-1",
    processId: "proc-1",
    command: "npm test",
    cwd: "/repo",
    osPid: 123,
    cpuPercent: 1.2,
    rssKb: 42_000,
    ...overrides,
  };
}

describe("capability panel text helpers", () => {
  it("builds default capability panel", () => {
    expect(defaultCapabilityPanel("zh")).toEqual({
      title: "能力",
    });
  });

  it("formats background terminals", () => {
    expect(backgroundTerminalLabel(terminal(), "en")).toBe(
      "npm test  pid 123 · cpu 1.2% · rss 41MB\ncwd /repo",
    );
    expect(backgroundTerminalsLoadingPanel("thread-1", "en")).toEqual({
      title: "Background terminals",
      subtitle: "thread-1",
      body: "Reading...",
    });
    expect(backgroundTerminalsEmptyPanel("zh")).toEqual({
      title: "后台终端",
      subtitle: "0 个后台任务",
      body: "当前会话没有后台终端。",
      actions: [{ id: "refresh-background-terminals", label: "刷新" }],
    });
  });

  it("builds background terminal result and error panels", () => {
    expect(
      backgroundTerminalsPanel({
        locale: "en",
        terminals: [terminal()],
        threadId: "thread-1",
      }),
    ).toEqual({
      title: "Background terminals",
      subtitle: "1 background tasks",
      body: "Click a task to terminate its process.",
      actions: [
        { id: "refresh-background-terminals", label: "Refresh" },
        { id: "clean-background-terminals", label: "Clean finished" },
      ],
      items: [
        {
          label: "npm test  pid 123 · cpu 1.2% · rss 41MB\ncwd /repo",
          action: {
            type: "background-terminal",
            threadId: "thread-1",
            processId: "proc-1",
          },
        },
      ],
    });
    expect(
      backgroundTerminalsErrorPanel({
        error: null,
        locale: "en",
        threadId: "thread-1",
      }),
    ).toEqual({
      title: "Background terminals",
      subtitle: "thread-1",
      error: "Unable to read background terminals",
    });
  });

  it("builds terminal panels", () => {
    expect(terminalRunningPanel("/repo", "en")).toEqual({
      title: "Terminal",
      subtitle: "/repo",
      commandInput: true,
      body: "Running...",
      fields: [
        {
          id: "terminal-stdin",
          label: "Input",
          placeholder: "Send to the running command; use \\n for newline",
          value: "",
        },
      ],
      actions: [
        { id: "send-terminal-to-thread", label: "Send to session" },
        { id: "refresh-background-terminals", label: "Background tasks" },
        { id: "send-terminal-input", label: "Send input", tone: "primary" },
        { id: "stop-terminal", label: "Stop", tone: "danger" },
      ],
    });
    expect(
      terminalCompletedPanel({
        command: "npm test",
        currentBody: "Running...",
        locale: "en",
        response: { stdout: "ok", stderr: null, exitCode: 0 },
      }),
    ).toEqual({
      title: "Terminal",
      subtitle: "npm test  exit 0",
      commandInput: true,
      body: "ok",
      actions: [
        { id: "send-terminal-to-thread", label: "Send to session" },
        { id: "refresh-background-terminals", label: "Background tasks" },
      ],
    });
    expect(
      terminalErrorPanel({ command: "npm test", error: null, locale: "en" }),
    ).toEqual({
      title: "Terminal",
      subtitle: "npm test",
      commandInput: true,
      error: "Command failed",
    });
  });

});
