import { describe, expect, it, vi } from "vitest";

import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type { LibraryPanel } from "../../domain/crewonDomain";
import type { AppCapabilityPanelHandlersParams } from "./appCapabilityPanelHandlers";
import type { CapabilityPanelActionDispatcherParams } from "../../capability/capabilityPanelActionDispatcher";
import type { CapabilityPanelItemActionParams } from "../../capability/capabilityPanelItemActions";

const dispatchSpy = vi.hoisted(() => ({
  lastParams: null as CapabilityPanelActionDispatcherParams | null,
  dispatch: vi.fn((params: CapabilityPanelActionDispatcherParams) => {
    dispatchSpy.lastParams = params;
    return true;
  }),
}));

const itemActionSpy = vi.hoisted(() => ({
  lastParams: null as CapabilityPanelItemActionParams | null,
  handle: vi.fn(async (params: CapabilityPanelItemActionParams) => {
    itemActionSpy.lastParams = params;
  }),
}));

vi.mock("../../capability/capabilityPanelActionDispatcher", () => ({
  handleCapabilityPanelActionDispatch: dispatchSpy.dispatch,
}));

vi.mock("../../capability/capabilityPanelItemActions", () => ({
  handleCapabilityPanelItemAction: itemActionSpy.handle,
}));

const { createAppCapabilityPanelHandlers } = await import(
  "./appCapabilityPanelHandlers"
);

function capturedDispatchParams(): CapabilityPanelActionDispatcherParams {
  const params = dispatchSpy.lastParams;
  if (!params) {
    throw new Error("dispatcher was not called");
  }
  return params;
}

function capturedItemParams(): CapabilityPanelItemActionParams {
  const params = itemActionSpy.lastParams;
  if (!params) {
    throw new Error("item action was not called");
  }
  return params;
}

function createParams(
  overrides: Partial<AppCapabilityPanelHandlersParams> = {},
): AppCapabilityPanelHandlersParams {
  return {
    activeFileWatch: null,
    busyToolId: null,
    capabilityPanel: {
      title: "Settings",
      fields: [{ id: "model", label: "Model", value: " gpt-5 " }],
    },
    client: null,
    confirm: () => true,
    createThread: async () => null,
    cwd: "/repo",
    isConnected: true,
    isDemo: false,
    isDemoPreview: false,
    loadBrowserApps: () => {},
    locale: "en",
    openThreadSettingsPanel: () => {},
    pendingApprovalRequest: null,
    pendingContextFile: null,
    pendingDynamicToolRequest: null,
    pendingExternalSecretRequest: null,
    pendingMcpElicitationRequest: null,
    pendingUserInputRequest: null,
    readWorkspaceFiles: () => {},
    refreshAccountPanel: () => {},
    refreshComputerControlSettingsPanel: async () => {},
    refreshEnvironmentSettingsPanel: async () => {},
    refreshMcpSettingsPanel: async () => {},
    refreshWorktreesSettingsPanel: async () => {},
    resolveBackendCwd: async () => "/repo",
    selectedThread: null,
    selectedThreadId: "thread-1",
    setAccountStatus: () => {},
    setActiveFileWatch: () => {},
    setActiveTurnByThread: () => {},
    setBusyToolId: () => {},
    setCapabilityPanel: () => {},
    setComposerFocusSignal: () => {},
    setComposerValue: () => {},
    setLibraryPanel: () => {},
    setNotice: () => {},
    setPendingApprovalRequest: () => {},
    setPendingComposerMentions: () => {},
    setPendingContextFile: () => {},
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
      personalization: () => {},
      worktrees: () => {},
    },
    settingsSaveHandlers: {
      appearance: () => {},
      config: () => {},
      personalization: () => {},
    },
    terminalCommand: "pwd",
    terminalProcessId: "process-1",
    ...overrides,
  };
}

describe("app capability panel handlers", () => {
  it("wires action dispatch with derived thread ids and trimmed field values", () => {
    const confirm = vi.fn(() => true);
    const handlers = createAppCapabilityPanelHandlers(createParams({ confirm }));

    handlers.handleCapabilityPanelAction("save-config");

    const params = capturedDispatchParams();
    expect(params.actionId).toBe("save-config");
    expect(params.confirm).toBe(confirm);
    expect(params.fieldValue("model")).toBe("gpt-5");
    expect(params.threadId).toBe("thread-1");
    expect(params.previewAwareThreadId).toBe("thread-1");
  });

  it("omits preview-aware thread id for demo threads while demo preview is active", () => {
    const handlers = createAppCapabilityPanelHandlers(
      createParams({ isDemoPreview: true, selectedThreadId: "demo-thread-1" }),
    );

    handlers.handleCapabilityPanelAction("open-thread-settings");

    const params = capturedDispatchParams();
    expect(params.threadId).toBeNull();
    expect(params.previewAwareThreadId).toBeNull();
  });

  it("opens plugin paths through the item handler", async () => {
    const handlers = createAppCapabilityPanelHandlers(createParams());

    handlers.handleCapabilityPanelAction("open-plugin-path");
    capturedDispatchParams().openPluginPath("/repo/plugins/github");
    await Promise.resolve();

    expect(capturedItemParams().item).toEqual({
      kind: "directory",
      label: "github",
      path: "/repo/plugins/github",
    });
  });

  it("forwards capability panel items with shared App state dependencies", async () => {
    const setComposerValue = vi.fn();
    const item = { label: "README.md", path: "/repo/README.md" };
    const handlers = createAppCapabilityPanelHandlers(
      createParams({ setComposerValue }),
    );

    await handlers.handleCapabilityPanelItem(item);

    const params = capturedItemParams();
    expect(params.item).toBe(item);
    expect(params.setComposerValue).toBe(setComposerValue);
  });

  it("updates capability and library panel fields together", () => {
    let capabilityPanel: CapabilityPanel | null = {
      title: "Capability",
      fields: [{ id: "shared", label: "Shared", value: "old" }],
    };
    let libraryPanel: LibraryPanel | null = {
      kind: "tools",
      title: "Tools",
      subtitle: "Library",
      items: [],
      fields: [{ id: "shared", label: "Shared", value: "old" }],
    };
    const handlers = createAppCapabilityPanelHandlers(
      createParams({
        setCapabilityPanel: (panelOrUpdater) => {
          capabilityPanel =
            typeof panelOrUpdater === "function"
              ? panelOrUpdater(capabilityPanel)
              : panelOrUpdater;
        },
        setLibraryPanel: (updater) => {
          libraryPanel = updater(libraryPanel);
        },
      }),
    );

    handlers.handleCapabilityPanelFieldChange("shared", "new");

    expect(capabilityPanel?.fields).toEqual([
      { id: "shared", label: "Shared", value: "new" },
    ]);
    expect(libraryPanel?.fields).toEqual([
      { id: "shared", label: "Shared", value: "new" },
    ]);
  });
});
