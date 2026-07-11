import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerNotification } from "../app-server/appServer";
import type {
  NoticeState,
  PendingApprovalRequest,
  PendingDynamicToolRequest,
  PendingExternalSecretRequest,
  PendingMcpElicitationRequest,
  PendingUserInputRequest,
} from "./appRuntimeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { ActiveFileWatch } from "../file/filePanelActions";
import { handleLocalAppNotification } from "./appLocalNotificationHandler";

beforeEach(() => {
  vi.stubGlobal("window", { atob });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type CapturedLocalNotificationState = {
  activeFileWatch: ActiveFileWatch | null;
  activeTurnByThread: Record<string, string>;
  capabilityPanel: CapabilityPanel | null;
  notice: NoticeState | null;
  pendingApprovalRequest: PendingApprovalRequest | null;
  pendingDynamicToolRequest: PendingDynamicToolRequest | null;
  pendingExternalSecretRequest: PendingExternalSecretRequest | null;
  pendingMcpElicitationRequest: PendingMcpElicitationRequest | null;
  pendingUserInputRequest: PendingUserInputRequest | null;
  selectedThreadId: string | null;
  streamingTextByThread: Record<string, string>;
  threads: Thread[];
};

type HandleNotificationOptions = Partial<CapturedLocalNotificationState> & {
  appendStreamingTextDelta?: (threadId: string, delta: string) => void;
};

function handleNotification(
  notification: AppServerNotification,
  options: HandleNotificationOptions = {},
): { handled: boolean; state: CapturedLocalNotificationState } {
  const { appendStreamingTextDelta, ...stateOverrides } = options;
  const state: CapturedLocalNotificationState = {
    activeFileWatch: { id: "watch-1", path: "/repo" },
    activeTurnByThread: {},
    capabilityPanel: { title: "Terminal", body: "Running...", commandInput: true },
    notice: null,
    pendingApprovalRequest: null,
    pendingDynamicToolRequest: null,
    pendingExternalSecretRequest: null,
    pendingMcpElicitationRequest: null,
    pendingUserInputRequest: null,
    selectedThreadId: "thread-1",
    streamingTextByThread: {},
    threads: [],
    ...stateOverrides,
  };

  const handled = handleLocalAppNotification({
    appendStreamingTextDelta,
    locale: "en",
    notification,
    selectedThreadId: state.selectedThreadId,
    terminalProcessId: "process-1",
    setActiveFileWatch: (updater) => {
      state.activeFileWatch = updater(state.activeFileWatch);
    },
    setActiveTurnByThread: (updater) => {
      state.activeTurnByThread = updater(state.activeTurnByThread);
    },
    setCapabilityPanel: (updater) => {
      state.capabilityPanel = updater(state.capabilityPanel);
    },
    setNotice: (notice) => {
      state.notice = notice;
    },
    setPendingApprovalRequest: (updater) => {
      state.pendingApprovalRequest = updater(state.pendingApprovalRequest);
    },
    setPendingDynamicToolRequest: (updater) => {
      state.pendingDynamicToolRequest = updater(state.pendingDynamicToolRequest);
    },
    setPendingExternalSecretRequest: (updater) => {
      state.pendingExternalSecretRequest = updater(
        state.pendingExternalSecretRequest,
      );
    },
    setPendingMcpElicitationRequest: (updater) => {
      state.pendingMcpElicitationRequest = updater(
        state.pendingMcpElicitationRequest,
      );
    },
    setPendingUserInputRequest: (updater) => {
      state.pendingUserInputRequest = updater(state.pendingUserInputRequest);
    },
    setSelectedThreadId: (updater) => {
      state.selectedThreadId = updater(state.selectedThreadId);
    },
    setStreamingTextByThread: (updater) => {
      state.streamingTextByThread = updater(state.streamingTextByThread);
    },
    setThreads: (updater) => {
      state.threads = updater(state.threads);
    },
  });

  return { handled, state };
}

describe("local app notification handler", () => {
  it("handles matching terminal output notifications", () => {
    const { handled, state } = handleNotification({
      method: "command/exec/outputDelta",
      params: {
        processId: "process-1",
        stream: "stdout",
        deltaBase64: btoa("done"),
        capReached: false,
      },
    } as AppServerNotification);

    expect(handled).toBe(true);
    expect(state.capabilityPanel).toEqual({
      title: "Terminal",
      body: "done",
      commandInput: true,
    });
  });

  it("ignores terminal output from another process after marking it handled", () => {
    const { handled, state } = handleNotification({
      method: "command/exec/outputDelta",
      params: {
        processId: "other-process",
        stream: "stdout",
        deltaBase64: btoa("done"),
        capReached: false,
      },
    } as AppServerNotification);

    expect(handled).toBe(true);
    expect(state.capabilityPanel?.body).toBe("Running...");
  });

  it("appends command execution output deltas into the active thread state", () => {
    const thread = {
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          status: "inProgress",
          durationMs: null,
          items: [
            {
              id: "command-1",
              type: "commandExecution",
              command: "pwd",
              cwd: "/repo",
              processId: null,
              source: "agent",
              status: "inProgress",
              commandActions: [],
              aggregatedOutput: "old",
              exitCode: null,
              durationMs: null,
            },
          ],
        },
      ],
    } as unknown as Thread;

    const { handled, state } = handleNotification(
      {
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-1",
          delta: " new",
        },
      } as AppServerNotification,
      { threads: [thread] },
    );

    expect(handled).toBe(true);
    expect(state.threads[0]?.turns[0]?.items[0]).toMatchObject({
      id: "command-1",
      type: "commandExecution",
      aggregatedOutput: "old new",
    });
  });

  it("appends MCP progress notifications into the active thread state", () => {
    const thread = {
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          status: "inProgress",
          durationMs: null,
          items: [
            {
              id: "mcp-1",
              type: "mcpToolCall",
              server: "filesystem",
              tool: "read_file",
              status: "inProgress",
              arguments: { path: "/repo/README.md" },
              pluginId: null,
              result: null,
              error: null,
              durationMs: null,
            },
          ],
        },
      ],
    } as unknown as Thread;

    const { handled, state } = handleNotification(
      {
        method: "item/mcpToolCall/progress",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "mcp-1",
          message: "Reading README.md",
        },
      } as AppServerNotification,
      { threads: [thread] },
    );

    expect(handled).toBe(true);
    expect(state.threads[0]?.turns[0]?.items[0]).toEqual({
      id: "mcp-1",
      type: "mcpToolCall",
      server: "filesystem",
      tool: "read_file",
      status: "inProgress",
      arguments: { path: "/repo/README.md" },
      pluginId: null,
      result: {
        content: [{ type: "text", text: "Reading README.md" }],
        structuredContent: null,
        _meta: null,
      },
      error: null,
      durationMs: null,
    });
  });

  it("keeps streaming text visible when an item completes before the turn finishes", () => {
    const completedMessage = {
      id: "agent-1",
      type: "agentMessage",
      text: "First paragraph is already complete.",
      phase: null,
      memoryCitation: null,
    };
    const thread = {
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          status: "inProgress",
          durationMs: null,
          items: [],
        },
      ],
    } as unknown as Thread;

    const { handled, state } = handleNotification(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: completedMessage,
        },
      } as AppServerNotification,
      {
        streamingTextByThread: {
          "thread-1": "First paragraph is already complete.",
        },
        threads: [thread],
      },
    );

    expect(handled).toBe(true);
    expect(state.streamingTextByThread).toEqual({
      "thread-1": "First paragraph is already complete.",
    });
    expect(state.threads[0]?.turns[0]?.items).toEqual([completedMessage]);
  });

  it("selects a streaming thread when the command home has no active thread", () => {
    const { handled, state } = handleNotification(
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-2",
          turnId: "turn-1",
          itemId: "agent-1",
          delta: "Live text",
        },
      } as AppServerNotification,
      {
        selectedThreadId: null,
      },
    );

    expect(handled).toBe(true);
    expect(state.selectedThreadId).toBe("thread-2");
    expect(state.streamingTextByThread).toEqual({ "thread-2": "Live text" });
  });

  it("routes agent message deltas through the streaming append buffer when available", () => {
    const appendStreamingTextDelta = vi.fn();
    const { handled, state } = handleNotification(
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-2",
          turnId: "turn-1",
          itemId: "agent-1",
          delta: "Live text",
        },
      } as AppServerNotification,
      {
        appendStreamingTextDelta,
        selectedThreadId: null,
      },
    );

    expect(handled).toBe(true);
    expect(state.selectedThreadId).toBe("thread-2");
    expect(appendStreamingTextDelta).toHaveBeenCalledWith(
      "thread-2",
      "Live text",
    );
    expect(state.streamingTextByThread).toEqual({});
  });

  it("selects a thread when process activity reaches the command home before text", () => {
    const thread = {
      id: "thread-2",
      turns: [
        {
          id: "turn-1",
          status: "inProgress",
          durationMs: null,
          items: [],
        },
      ],
    } as unknown as Thread;
    const commandItem = {
      id: "command-1",
      type: "commandExecution",
      command: "pwd",
      cwd: "/repo",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: "",
      exitCode: null,
      durationMs: null,
    };

    const { handled, state } = handleNotification(
      {
        method: "item/started",
        params: {
          threadId: "thread-2",
          turnId: "turn-1",
          item: commandItem,
          startedAtMs: 1,
        },
      } as AppServerNotification,
      {
        selectedThreadId: null,
        threads: [thread],
      },
    );

    expect(handled).toBe(true);
    expect(state.selectedThreadId).toBe("thread-2");
    expect(state.threads[0]?.turns[0]?.items).toEqual([commandItem]);
  });

  it("appends reasoning deltas into the active thread state", () => {
    const thread = {
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          status: "inProgress",
          durationMs: null,
          items: [
            {
              id: "reasoning-1",
              type: "reasoning",
              summary: [],
              content: [],
            },
          ],
        },
      ],
    } as unknown as Thread;

    const summaryPart = handleNotification(
      {
        method: "item/reasoning/summaryPartAdded",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          summaryIndex: 0,
        },
      } as AppServerNotification,
      { threads: [thread] },
    );
    const summaryDelta = handleNotification(
      {
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          summaryIndex: 0,
          delta: "Planning",
        },
      } as AppServerNotification,
      { threads: summaryPart.state.threads },
    );
    const contentDelta = handleNotification(
      {
        method: "item/reasoning/textDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          contentIndex: 0,
          delta: "Hidden details",
        },
      } as AppServerNotification,
      { threads: summaryDelta.state.threads },
    );

    expect(summaryPart.handled).toBe(true);
    expect(summaryDelta.handled).toBe(true);
    expect(contentDelta.handled).toBe(true);
    expect(contentDelta.state.threads[0]?.turns[0]?.items[0]).toEqual({
      id: "reasoning-1",
      type: "reasoning",
      summary: ["Planning"],
      content: ["Hidden details"],
    });
  });

  it("handles matching file watch notifications", () => {
    const { handled, state } = handleNotification({
      method: "fs/changed",
      params: {
        watchId: "watch-1",
        changedPaths: ["/repo/a.ts"],
      },
    } as AppServerNotification, {
      capabilityPanel: { title: "Files", body: "Existing" },
    });

    expect(handled).toBe(true);
    expect(state.capabilityPanel).toEqual({
      title: "Files",
      body: "Existing\n\nFile changes detected:\n/repo/a.ts",
      error: undefined,
    });
    expect(state.notice).toEqual({
      text: "File changed: /repo/a.ts",
      tone: "success",
    });
  });

  it("handles visible warning notifications", () => {
    const { handled, state } = handleNotification({
      method: "warning",
      params: { threadId: "thread-1", message: "Careful" },
    } as AppServerNotification);

    expect(handled).toBe(true);
    expect(state.notice).toEqual({ text: "Careful", tone: "warning" });
  });

  it("leaves backend refresh notifications for the app-level handler", () => {
    const { handled } = handleNotification({
      method: "account/updated",
      params: {},
    } as AppServerNotification);

    expect(handled).toBe(false);
  });
});
