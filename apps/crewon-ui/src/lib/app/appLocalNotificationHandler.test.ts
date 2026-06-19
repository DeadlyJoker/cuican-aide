import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
};

function handleNotification(
  notification: AppServerNotification,
  stateOverrides: Partial<CapturedLocalNotificationState> = {},
): { handled: boolean; state: CapturedLocalNotificationState } {
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
    ...stateOverrides,
  };

  const handled = handleLocalAppNotification({
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
    setThreads: () => {},
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
