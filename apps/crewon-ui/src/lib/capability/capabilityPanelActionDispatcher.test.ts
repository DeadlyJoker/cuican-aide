import type { Thread } from "@crewon-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "./capabilityPanelTypes";
import {
  handleCapabilityPanelActionDispatch,
  type CapabilityPanelActionDispatcherParams,
} from "./capabilityPanelActionDispatcher";
import { encodeCapabilityActionPayload } from "../server-request/serverRequestPresentation";

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    agentNickname: null,
    agentRole: null,
    clientVersion: "test",
    createdAt: 1,
    cwd: "/repo",
    ephemeral: false,
    forkedFromId: null,
    gitInfo: null,
    id: "thread-1",
    modelProvider: "openai",
    name: "Thread",
    parentThreadId: null,
    path: null,
    preview: "Thread preview",
    sessionId: "session-1",
    source: "unknown",
    status: { type: "idle" },
    threadSource: null,
    turns: [],
    updatedAt: 1,
    ...overrides,
  };
}

function baseParams(
  overrides: Partial<CapabilityPanelActionDispatcherParams> = {},
): CapabilityPanelActionDispatcherParams {
  let panel: CapabilityPanel | null = { title: "Panel", body: "Ready" };
  return {
    actionId: "unknown-action",
    activeFileWatch: null,
    busyToolId: null,
    capabilityPanel: panel,
    client: null,
    confirm: () => true,
    createThread: async () => thread(),
    cwd: "/repo",
    fieldValue: () => "",
    isConnected: true,
    isDemo: false,
    isDemoPreview: false,
    locale: "en",
    loadBrowserApps: () => {},
    openPluginPath: () => {},
    openThreadSettingsPanel: () => {},
    pendingApprovalRequest: null,
    pendingContextFile: null,
    pendingDynamicToolRequest: null,
    pendingExternalSecretRequest: null,
    pendingMcpElicitationRequest: null,
    pendingUserInputRequest: null,
    previewAwareThreadId: "thread-1",
    readWorkspaceFiles: () => {},
    refreshAccountPanel: () => {},
    refreshComputerControlSettingsPanel: async () => {},
    refreshEnvironmentSettingsPanel: async () => {},
    refreshMcpSettingsPanel: async () => {},
    refreshWorktreesSettingsPanel: async () => {},
    resolveBackendCwd: async () => "/repo",
    selectedThread: thread(),
    selectedThreadId: "thread-1",
    setAccountStatus: () => {},
    setActiveFileWatch: () => {},
    setActiveTurnByThread: () => {},
    setBusyToolId: () => {},
    setCapabilityPanel: (panelOrUpdater) => {
      panel =
        typeof panelOrUpdater === "function"
          ? panelOrUpdater(panel)
          : panelOrUpdater;
    },
    setNotice: () => {},
    setPendingApprovalRequest: () => {},
    setPendingDynamicToolRequest: () => {},
    setPendingExternalSecretRequest: () => {},
    setPendingMcpElicitationRequest: () => {},
    setPendingUserInputRequest: () => {},
    setSelectedThreadId: () => {},
    setStreamingTextByThread: () => {},
    setThreadGoal: () => {},
    setThreads: () => {},
    settingsRefreshHandlers: {
      appearance: () => {},
      appSnapshots: () => {},
      browserApps: () => {},
      computerControl: () => {},
      config: () => {},
      connections: () => {},
      environment: () => {},
      git: () => {},
      hooks: () => {},
      integrations: () => {},
      keyboard: () => {},
      mcpSettings: () => {},
      modelProviders: () => {},
      personalization: () => {},
      worktrees: () => {},
    },
    settingsSaveHandlers: {
      appearance: () => {},
      config: () => {},
      personalization: () => {},
    },
    terminalCommand: "",
    terminalProcessId: null,
    threadId: "thread-1",
    ...overrides,
  };
}

describe("capability panel action dispatcher", () => {
  it("returns false for unknown actions", () => {
    expect(handleCapabilityPanelActionDispatch(baseParams())).toBe(false);
  });

  it("does not fall back to legacy lifecycle mutations for an explicit Control cohort", async () => {
    let legacyMutationCalled = false;
    let panel: CapabilityPanel | null = { title: "Panel", body: "Ready" };

    const handled = handleCapabilityPanelActionDispatch(
      baseParams({
        actionId: "compact-thread",
        client: {
          compactThread: async () => {
            legacyMutationCalled = true;
          },
        } as never,
        isDemo: true,
        threadLifecycleClient: null,
        threadLifecycleConnected: true,
        threadLifecycleControlConfigured: true,
        setCapabilityPanel: (panelOrUpdater) => {
          panel =
            typeof panelOrUpdater === "function"
              ? panelOrUpdater(panel)
              : panelOrUpdater;
        },
      }),
    );
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(handled).toBe(true);
    expect(legacyMutationCalled).toBe(false);
    expect(panel).toMatchObject({
      error: "thread_compaction_unavailable",
    });
    expect(panel?.body).not.toContain("(demo)");
  });

  it("handles demo thread settings save before backend save handlers", () => {
    let panel: CapabilityPanel | null = {
      title: "Session settings",
      body: "Ready",
    };
    let saved = false;

    const handled = handleCapabilityPanelActionDispatch(
      baseParams({
        actionId: "save-thread-settings",
        isDemo: true,
        setCapabilityPanel: (panelOrUpdater) => {
          panel =
            typeof panelOrUpdater === "function"
              ? panelOrUpdater(panel)
              : panelOrUpdater;
        },
        settingsSaveHandlers: {
          appearance: () => {},
          config: () => {},
          personalization: () => {},
        },
      }),
    );

    expect(handled).toBe(true);
    expect(saved).toBe(false);
    expect(panel).toMatchObject({
      body: "Session settings saved (demo). With app-server connected this calls thread/settings/update.",
      title: "Session settings",
    });
  });

  it("routes settings refresh actions", () => {
    const refreshed: string[] = [];

    const handled = handleCapabilityPanelActionDispatch(
      baseParams({
        actionId: "refresh-config",
        settingsRefreshHandlers: {
          appearance: () => {},
          appSnapshots: () => {},
          browserApps: () => {},
          computerControl: () => {},
          config: () => {
            refreshed.push("config");
          },
          connections: () => {},
          environment: () => {},
          git: () => {},
          hooks: () => {},
          integrations: () => {},
          keyboard: () => {},
          mcpSettings: () => {},
          modelProviders: () => {},
          personalization: () => {},
          worktrees: () => {},
        },
      }),
    );

    expect(handled).toBe(true);
    expect(refreshed).toEqual(["config"]);
  });

  it("does not send legacy Goal mutations after the composer cutover", () => {
    const notices: string[] = [];
    let legacyMutationCalled = false;

    const handled = handleCapabilityPanelActionDispatch(
      baseParams({
        actionId: "save-thread-goal",
        client: {
          setThreadGoal: async () => {
            legacyMutationCalled = true;
            return { goal: null };
          },
        } as never,
        setNotice: (notice) => notices.push(notice.text),
      }),
    );

    expect(handled).toBe(true);
    expect(legacyMutationCalled).toBe(false);
    expect(notices).toEqual([
      "Goals moved to the conversation composer. Edit, pause, or clear them there.",
    ]);
  });

  it("routes plugin path actions", () => {
    const openedPaths: string[] = [];
    const actionId = `open-plugin-path:${encodeCapabilityActionPayload({
      path: "/repo/plugin",
    })}`;

    const handled = handleCapabilityPanelActionDispatch(
      baseParams({
        actionId,
        openPluginPath: (path) => {
          openedPaths.push(path);
        },
      }),
    );

    expect(handled).toBe(true);
    expect(openedPaths).toEqual(["/repo/plugin"]);
  });
});
