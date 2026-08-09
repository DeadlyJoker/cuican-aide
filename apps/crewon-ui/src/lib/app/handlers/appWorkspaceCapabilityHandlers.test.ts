import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../../app-server/appServer";
import type { AppWorkspaceCapabilityHandlersParams } from "./appWorkspaceCapabilityHandlers";
import type {
  AttachWorkspaceContextActionParams,
  LoadBrowserAppsActionParams,
  ReadWorkspaceDiffActionParams,
  ReadWorkspaceFilesActionParams,
  RunTerminalStatusActionParams,
} from "../../capability/workspaceCapabilityActions";

const workspaceActionSpy = vi.hoisted(() => ({
  attachParams: null as AttachWorkspaceContextActionParams | null,
  browserParams: null as LoadBrowserAppsActionParams | null,
  diffParams: null as ReadWorkspaceDiffActionParams | null,
  filesParams: null as ReadWorkspaceFilesActionParams | null,
  terminalParams: null as RunTerminalStatusActionParams | null,
  attach: vi.fn(async (params: AttachWorkspaceContextActionParams) => {
    workspaceActionSpy.attachParams = params;
  }),
  browser: vi.fn(async (params: LoadBrowserAppsActionParams) => {
    workspaceActionSpy.browserParams = params;
  }),
  diff: vi.fn(async (params: ReadWorkspaceDiffActionParams) => {
    workspaceActionSpy.diffParams = params;
  }),
  files: vi.fn(async (params: ReadWorkspaceFilesActionParams) => {
    workspaceActionSpy.filesParams = params;
  }),
  terminal: vi.fn(async (params: RunTerminalStatusActionParams) => {
    workspaceActionSpy.terminalParams = params;
  }),
}));

vi.mock("../../capability/workspaceCapabilityActions", () => ({
  attachWorkspaceContextAction: workspaceActionSpy.attach,
  loadBrowserAppsAction: workspaceActionSpy.browser,
  readWorkspaceDiffAction: workspaceActionSpy.diff,
  readWorkspaceFilesAction: workspaceActionSpy.files,
  runTerminalStatusAction: workspaceActionSpy.terminal,
}));

const { createAppWorkspaceCapabilityHandlers } = await import(
  "./appWorkspaceCapabilityHandlers"
);

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function createParams(
  overrides: Partial<AppWorkspaceCapabilityHandlersParams> = {},
): AppWorkspaceCapabilityHandlersParams {
  return {
    appendTerminalOutputLine: () => {},
    busyToolId: null,
    client: client(),
    getTerminalProcessId: () => "process-1",
    isConnected: true,
    isDemo: false,
    isDemoPreview: false,
    locale: "en",
    resolveBackendCwd: async () => "/repo",
    selectedThreadId: "thread-1",
    setBusyToolId: () => {},
    setCapabilityDockOpen: () => {},
    setCapabilityPanel: () => {},
    setTerminalProcessId: () => {},
    terminalCommand: "git status --short",
    ...overrides,
  };
}

describe("app workspace capability handlers", () => {
  beforeEach(() => {
    workspaceActionSpy.attachParams = null;
    workspaceActionSpy.browserParams = null;
    workspaceActionSpy.diffParams = null;
    workspaceActionSpy.filesParams = null;
    workspaceActionSpy.terminalParams = null;
    vi.clearAllMocks();
  });

  it("wires terminal action with command and terminal process accessors", async () => {
    let terminalProcessId: string | null = "process-1";
    const setTerminalProcessId = vi.fn((processId: string | null) => {
      terminalProcessId = processId;
    });
    const handlers = createAppWorkspaceCapabilityHandlers(
      createParams({
        getTerminalProcessId: () => terminalProcessId,
        setTerminalProcessId,
      }),
    );

    await handlers.runTerminalStatus();
    const params = workspaceActionSpy.terminalParams;
    if (!params) {
      throw new Error("terminal action was not called");
    }
    params.setTerminalProcessId("process-2");

    expect(params.terminalCommand).toBe("git status --short");
    expect(params.terminalProcessId()).toBe("process-2");
    expect(setTerminalProcessId).toHaveBeenCalledWith("process-2");
  });

  it("wires diff, file, and attach-context actions with shared workspace dependencies", async () => {
    const setCapabilityDockOpen = vi.fn();
    const setCapabilityPanel = vi.fn();
    const handlers = createAppWorkspaceCapabilityHandlers(
      createParams({ setCapabilityDockOpen, setCapabilityPanel }),
    );

    await handlers.readWorkspaceDiff();
    await handlers.readWorkspaceFiles();
    await handlers.attachWorkspaceContext();

    expect(workspaceActionSpy.diffParams).toMatchObject({
      busyToolId: null,
      isConnected: true,
      isDemo: false,
      locale: "en",
      setCapabilityPanel,
    });
    expect(workspaceActionSpy.filesParams).toMatchObject({
      busyToolId: null,
      isConnected: true,
      isDemo: false,
      locale: "en",
      setCapabilityPanel,
    });
    expect(workspaceActionSpy.attachParams).toMatchObject({
      setCapabilityDockOpen,
      setCapabilityPanel,
    });
  });

  it("wires browser app loading with demo preview and selected thread context", async () => {
    const handlers = createAppWorkspaceCapabilityHandlers(
      createParams({
        busyToolId: "web",
        isDemoPreview: true,
        selectedThreadId: "thread-2",
      }),
    );

    await handlers.loadBrowserApps();

    expect(workspaceActionSpy.browserParams).toMatchObject({
      busyToolId: "web",
      isDemoPreview: true,
      selectedThreadId: "thread-2",
    });
  });

  it("passes the same client and backend cwd resolver to every action", async () => {
    const currentClient = client();
    const resolveBackendCwd = vi.fn(async () => "/repo");
    const handlers = createAppWorkspaceCapabilityHandlers(
      createParams({ client: currentClient, resolveBackendCwd }),
    );

    await handlers.runTerminalStatus();
    await handlers.readWorkspaceDiff();
    await handlers.readWorkspaceFiles();
    await handlers.attachWorkspaceContext();
    await handlers.loadBrowserApps();

    expect(workspaceActionSpy.terminalParams?.client).toBe(currentClient);
    expect(workspaceActionSpy.diffParams?.client).toBe(currentClient);
    expect(workspaceActionSpy.filesParams?.client).toBe(currentClient);
    expect(workspaceActionSpy.attachParams?.client).toBe(currentClient);
    expect(workspaceActionSpy.browserParams?.client).toBe(currentClient);
    expect(workspaceActionSpy.terminalParams?.resolveBackendCwd).toBe(
      resolveBackendCwd,
    );
    expect(workspaceActionSpy.diffParams?.resolveBackendCwd).toBe(
      resolveBackendCwd,
    );
    expect(workspaceActionSpy.filesParams?.resolveBackendCwd).toBe(
      resolveBackendCwd,
    );
    expect(workspaceActionSpy.attachParams?.resolveBackendCwd).toBe(
      resolveBackendCwd,
    );
    expect(workspaceActionSpy.browserParams?.resolveBackendCwd).toBe(
      resolveBackendCwd,
    );
  });
});
